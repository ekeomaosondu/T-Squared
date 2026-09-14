#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { execFileSync } from 'node:child_process';
import { env } from '@/src/config/env';
import { closeDb, db } from '@/src/persistence/db';

/**
 * Deployment acceptance gate.
 *
 *   npm run deploy:check
 *
 * Runs a real container lifecycle against the live exchange and asserts the
 * properties that must hold after ANY change to the image or entrypoint.
 *
 * This exists because the signal-forwarding bug was invisible to every other
 * test: the collector ran correctly, recorded correctly, and silently lost its
 * write buffer on every deploy. Only an actual stop/start reveals it.
 */

const IMAGE = 'kalshi-recorder:deploycheck';
const NAME = 'kx-deploycheck';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${detail}`);
};

const sh = (cmd: string, args: string[], allowFail = false): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return String((err as { stdout?: string }).stdout ?? '');
    throw err;
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The SHA the image should report, marked when the tree is dirty. */
function buildSha(): string {
  const sha = sh('git', ['rev-parse', 'HEAD']);
  return sh('git', ['status', '--porcelain'], true) ? `${sha}-dirty` : sha;
}

/**
 * Starts a container and REQUIRES it to still be running.
 *
 * Without this the gate reported false passes: the image failed to start, and
 * every check then read stale rows from a previous local session and passed.
 * A test that cannot fail is worse than no test.
 */
function runContainerOrThrow(name: string, extraEnv: Record<string, string>, settleMs = 12_000): void {
  runContainer(name, extraEnv);
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    const status = sh('docker', ['inspect', '-f', '{{.State.Running}}', name], true);
    if (status === 'true') return;
    if (status === 'false') {
      const logs = sh('docker', ['logs', '--tail', '20', name], true);
      throw new Error(`container ${name} exited immediately:\n${logs}`);
    }
  }
  throw new Error(`container ${name} did not report running within ${settleMs}ms`);
}

function runContainer(name: string, extraEnv: Record<string, string>): void {
  const args = ['run', '-d', '--name', name, '--network', 'host'];
  const e = env();
  const vars: Record<string, string> = {
    DATABASE_URL: e.DATABASE_URL,
    KALSHI_ENV: e.KALSHI_ENV,
    KALSHI_API_KEY_ID: process.env.KALSHI_API_KEY_ID ?? '',
    KALSHI_PRIVATE_KEY_PEM: process.env.KALSHI_PRIVATE_KEY_PEM ?? '',
    ARCHIVE_STORAGE: 'local',
    DATASET_ID: e.DATASET_ID,
    DEPLOY_BOUNDARY: 'true',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(vars)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE);
  sh('docker', args);
}

async function main(): Promise<void> {
  const sql = db();
  console.log('\n=== deployment acceptance gate ===\n');

  sh('docker', ['rm', '-f', NAME], true);
  sh('docker', ['rm', '-f', `${NAME}-nodb`], true);

  console.log('  building image...');
  // Built the same way `npm run deploy:fly` builds it, so the gate exercises
  // the real image rather than a variant that happens to lack provenance.
  sh('docker', ['build', '-q', '--build-arg', `GIT_COMMIT_SHA=${buildSha()}`, '-t', IMAGE, '.']);

  // A laptop collector would race the container for subscriptions.
  const laptop = sh('pgrep', ['-f', 'scripts/collector.ts'], true);
  if (laptop) {
    console.log('  stopping the local collector for the duration of the test');
    for (const pid of laptop.split('\n').filter(Boolean)) sh('kill', ['-TERM', pid], true);
    await sleep(8000);
  }

  // ---- 1. SIGTERM reaches the collector and the final batch flushes ------
  runContainerOrThrow(NAME, {});
  await sleep(45_000);

  const beforeRows = Number(
    (
      (await sql`
        SELECT count(*) AS n FROM raw_ingest_events r
         WHERE r.session_id = (SELECT c.session_id FROM collector_sessions c ORDER BY c.started_at DESC LIMIT 1)
      `) as unknown as { n: string }[]
    )[0]!.n,
  );

  sh('docker', ['stop', '-t', '30', NAME]);

  // Guard against passing on stale data from a previous session.
  const containerSession = (await sql`
    SELECT c.session_id, c.started_at FROM collector_sessions c ORDER BY c.started_at DESC LIMIT 1
  `) as unknown as { session_id: string; started_at: Date }[];
  if (Date.now() - containerSession[0]!.started_at.getTime() > 300_000) {
    throw new Error(
      'the newest collector session predates this test run; the container is not the one being measured',
    );
  }

  const stopped = (await sql`
    SELECT c.session_id, c.end_reason,
           (SELECT count(*) FROM raw_ingest_events r WHERE r.session_id = c.session_id) AS rows
      FROM collector_sessions c ORDER BY c.started_at DESC LIMIT 1
  `) as unknown as { session_id: string; end_reason: string | null; rows: string }[];

  const firstSession = stopped[0]!;
  check(
    'SIGTERM reaches the collector',
    firstSession.end_reason === 'sigterm',
    firstSession.end_reason === 'sigterm'
      ? "session closed with end_reason='sigterm'"
      : `end_reason=${firstSession.end_reason ?? 'NULL'} -- the signal was swallowed and buffered events were lost`,
  );
  check(
    'final batch flushed on shutdown',
    Number(firstSession.rows) >= beforeRows,
    `${beforeRows} rows before stop, ${firstSession.rows} after`,
  );

  // Provenance. The container has no .git, so unless the SHA is passed as a
  // build argument every production session records NULL here and a window of
  // the dataset cannot be tied to the code that produced it.
  const recordedSha = (
    (await sql`
      SELECT c.git_commit_sha FROM collector_sessions c
       WHERE c.session_id = ${firstSession.session_id}
    `) as unknown as { git_commit_sha: string | null }[]
  )[0]!.git_commit_sha;
  const expectedSha = buildSha();
  check(
    'session records the build commit',
    recordedSha === expectedSha,
    recordedSha === null
      ? 'git_commit_sha is NULL -- the image was built without --build-arg GIT_COMMIT_SHA'
      : `recorded ${recordedSha}, expected ${expectedSha}`,
  );

  // ---- 2 & 3. Restart begins from fresh snapshots, as a new epoch --------
  sh('docker', ['rm', '-f', NAME], true);
  await sleep(15_000); // a visible gap
  // Long enough for at least one materialised snapshot to land. The live grid
  // is 60s, so a shorter run leaves nothing for the replay check to verify
  // against and the check passes vacuously on 0/0.
  runContainerOrThrow(NAME, {});
  await sleep(80_000);

  const second = (await sql`
    SELECT c.session_id FROM collector_sessions c ORDER BY c.started_at DESC LIMIT 1
  `) as unknown as { session_id: string }[];
  const newSession = second[0]!.session_id;

  check(
    'restart creates a new session',
    newSession !== firstSession.session_id,
    `${firstSession.session_id.slice(0, 8)} -> ${newSession.slice(0, 8)}`,
  );

  // Every market must be re-seeded from an exchange snapshot before any delta
  // is applied; reusing stale in-memory state is the failure this catches.
  const unseeded = (await sql`
    SELECT count(*) AS n FROM (
      SELECT DISTINCT d.market_ticker
        FROM orderbook_deltas d
       WHERE d.session_id = ${newSession} AND d.applied
         AND NOT EXISTS (
           SELECT 1 FROM orderbook_snapshots s
            WHERE s.session_id = ${newSession}
              AND s.market_ticker = d.market_ticker
              AND s.source IN ('ws_initial', 'ws_recovery')
              AND s.received_at_ms <= d.received_at_ms
         )
    ) x
  `) as unknown as { n: string }[];

  check(
    'restart begins from fresh snapshots',
    Number(unseeded[0]!.n) === 0,
    Number(unseeded[0]!.n) === 0
      ? 'no delta applied before its market was re-snapshotted'
      : `${unseeded[0]!.n} market(s) applied deltas without a fresh snapshot`,
  );

  const gap = (await sql`
    SELECT g.reason, g.prior_end_reason, g.duration_ms::text AS duration_ms_text, g.ended_at
      FROM capture_gaps g
     WHERE g.end_session_id = ${newSession}
     ORDER BY g.started_at DESC LIMIT 1
  `) as unknown as {
    reason: string; prior_end_reason: string | null; duration_ms_text: string | null; ended_at: Date | null;
  }[];

  check(
    'deploy interval recorded as a capture gap',
    gap.length > 0 && gap[0]!.ended_at !== null,
    gap.length > 0
      ? `reason=${gap[0]!.reason}, ${Math.round(Number(gap[0]!.duration_ms_text ?? 0) / 1000)}s without coverage`
      : 'NO capture gap recorded -- a backtest would read this hole as a quiet market',
  );

  // ---- 4. /live is independent of the database --------------------------
  sh('docker', ['rm', '-f', NAME], true);
  runContainerOrThrow(`${NAME}-nodb`, {
    // Unreachable database: /live must still answer, /health must not.
    DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/nonexistent',
    HEALTH_PORT: '8091',
  });
  await sleep(20_000);

  const liveCode = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:8091/live'], true);
  const healthCode = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:8091/health'], true);

  check(
    '/live independent of database state',
    liveCode === '200',
    `HTTP ${liveCode || 'no response'} with an unreachable database`,
  );
  check(
    '/health reports database failure',
    healthCode === '503',
    `HTTP ${healthCode || 'no response'} -- CRITICAL when the database is unreachable`,
  );

  sh('docker', ['rm', '-f', `${NAME}-nodb`], true);

  // ---- 5. Replay remains exact across the deploy boundary ---------------
  const { verifyReplay } = await import('@/src/replay/replay');
  const bounds = (await sql`
    SELECT min(s.received_at_ms) AS from_ms, max(s.received_at_ms) AS to_ms
      FROM orderbook_snapshots s WHERE s.session_id = ${newSession}
  `) as unknown as { from_ms: string | null; to_ms: string | null }[];

  let replayDetail = 'no snapshots in the new session yet';
  let replayOk = false;

  if (bounds[0]?.from_ms && bounds[0].to_ms) {
    const tickers = ((await sql`
      SELECT DISTINCT d.market_ticker FROM orderbook_deltas d
       WHERE d.session_id = ${newSession} ORDER BY d.market_ticker LIMIT 6
    `) as unknown as { market_ticker: string }[]).map((r) => r.market_ticker);

    let checked = 0;
    let matched = 0;
    for (const t of tickers) {
      const v = await verifyReplay(sql, t, BigInt(bounds[0].from_ms) - 1n, BigInt(bounds[0].to_ms), 10_000);
      checked += v.checked;
      matched += v.matched;
    }
    replayOk = checked > 0 && matched === checked;
    replayDetail = `${matched}/${checked} snapshots reproduced exactly after the deploy boundary`;
  }
  // 0/0 is a FAIL, not a pass: it means there was nothing to verify, which
  // tells us nothing about whether replay survives the boundary.
  check('replay exact after the deploy boundary', replayOk, replayDetail);

  // ---- report -----------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n  ${failed.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed.length}/${checks.length} checks\n`);
  if (failed.length > 0) {
    console.log('  Do not deploy this image.\n');
  }

  await closeDb();
  if (failed.length > 0) process.exit(2);
}

main().catch(async (err) => {
  console.error('\ndeploy check failed:', err instanceof Error ? err.message : String(err), '\n');
  execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  await closeDb().catch(() => {});
  process.exit(1);
});
