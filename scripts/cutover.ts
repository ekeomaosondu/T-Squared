#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { adminDatabaseUrl, env, gitCommitSha, redactDatabaseUrl } from '@/src/config/env';
import { closeDb, createDb, db } from '@/src/persistence/db';
import { migrate } from '@/src/persistence/migrate';
import { ensureRawPartitions, partitionsAhead } from '@/src/persistence/partitions';
import { logger } from '@/src/logging/logger';

/**
 * Production cutover to a new database.
 *
 *   npm run cutover -- --check      verify the target is ready (no changes)
 *   npm run cutover -- --record     record the outgoing local epoch
 *
 * Deliberately does NOT copy rows. The local-storage epoch ends and the new
 * epoch begins at a fresh collector session, which keeps provenance clean: a
 * session is already the unit replay treats as a hard boundary, so a dataset
 * that spans the move is honestly described rather than stitched.
 */

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: StepResult[] = [];
function step(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${detail}`);
}

/**
 * Records everything needed to describe the outgoing epoch afterwards.
 *
 * Reads the OUTGOING database explicitly. By the time this runs, DATABASE_URL
 * already points at the new target, so defaulting to it would report an empty
 * new database as though it were the epoch being closed.
 */
async function recordOutgoingEpoch(fromUrl: string | undefined): Promise<void> {
  const sql = fromUrl ? createDb({ connectionString: fromUrl, max: 2 }) : db();

  const rows = (await sql`
    SELECT c.session_id, c.mode, c.started_at, c.ended_at, c.end_reason,
           c.last_heartbeat_at, c.config_hash, c.git_commit_sha,
           c.messages_received, c.sequence_gaps, c.reconnect_count
      FROM collector_sessions c
     ORDER BY c.started_at DESC
     LIMIT 1
  `) as unknown as Record<string, unknown>[];

  const sessionId = rows[0]?.session_id as string | undefined;
  if (!sessionId) {
    console.log(
      '\nNo collector sessions in the source database.\n' +
        'If you meant to record the laptop epoch, pass it explicitly:\n' +
        '  npm run cutover -- --record --from postgres://kalshi:kalshi@localhost:54329/kalshi_recorder\n',
    );
    if (fromUrl) await sql.end({ timeout: 5 });
    else await closeDb();
    return;
  }

  const ordinal = (await sql`
    SELECT max(r.ingest_ordinal) AS last_ordinal, count(*) AS raw_rows
      FROM raw_ingest_events r
     WHERE r.session_id = ${sessionId}::uuid
  `) as unknown as { last_ordinal: string | null; raw_rows: string }[];

  const counts = (await sql`
    SELECT (SELECT count(*) FROM orderbook_deltas) AS deltas,
           (SELECT count(*) FROM public_trades) AS trades,
           (SELECT count(*) FROM orderbook_snapshots) AS snapshots,
           (SELECT count(*) FROM sequence_gaps) AS gaps
  `) as unknown as Record<string, string>[];

  console.log('\n=== outgoing epoch (local storage) ===\n');
  console.log(JSON.stringify({ session: rows[0], ...ordinal[0], totals: counts[0] }, null, 2));
  console.log(
    '\nThese rows are NOT migrated. The new epoch starts clean in the target ' +
      'database at a fresh collector session.\n',
  );

  if (fromUrl) await sql.end({ timeout: 5 });
  else await closeDb();
}

async function checkTarget(): Promise<void> {
  const e = env();
  const adminUrl = adminDatabaseUrl(e);

  console.log('\n=== cutover readiness ===\n');
  console.log(`  pooled (app)   ${redactDatabaseUrl(e.DATABASE_URL)}`);
  console.log(`  direct (admin) ${redactDatabaseUrl(adminUrl)}\n`);

  if (!e.DIRECT_DATABASE_URL) {
    // Neon's pooler is a transaction pooler: migrations, session-level
    // maintenance and DETACH PARTITION CONCURRENTLY need a direct connection.
    step(
      'direct url',
      false,
      'DIRECT_DATABASE_URL is unset; migrations and DETACH PARTITION CONCURRENTLY need a direct connection',
    );
  } else {
    step('direct url', true, 'configured separately from the pooled URL');
  }

  // --- migrations, through the DIRECT connection -------------------------
  const admin = createDb({ connectionString: adminUrl, max: 2 });
  try {
    const result = await migrate(admin);
    step('migrations', true, `${result.applied.length} applied, ${result.skipped.length} already present`);

    await ensureRawPartitions(admin, e.RAW_PARTITION_AHEAD_DAYS);
    const ahead = await partitionsAhead(admin);
    step('partitions', ahead >= 2, `${ahead} day(s) ahead`);

    // --- write/read smoke test -----------------------------------------
    const probe = await admin<{ ok: boolean }[]>`
      SELECT (now() IS NOT NULL AND current_setting('server_version_num')::int >= 150000) AS ok
    `;
    step('server', probe[0]?.ok === true, 'reachable, Postgres 15+');

    const tables = await admin<{ n: string }[]>`
      SELECT count(*) AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    step('schema', Number(tables[0]!.n) >= 20, `${tables[0]!.n} tables present`);

    const empty = await admin<{ n: string }[]>`SELECT count(*) AS n FROM raw_ingest_events`;
    step(
      'clean target',
      Number(empty[0]!.n) === 0,
      Number(empty[0]!.n) === 0
        ? 'no existing raw rows; the new epoch starts clean'
        : `${empty[0]!.n} raw rows already present -- confirm this is intended`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }

  // --- pooled path, used by the API and dashboard ------------------------
  if (e.DATABASE_URL && e.DATABASE_URL !== adminUrl) {
    const pooled = createDb({ connectionString: e.DATABASE_URL, max: 2 });
    try {
      const r = await pooled<{ n: string }[]>`SELECT count(*) AS n FROM collector_sessions`;
      step('pooled connection', true, `readable (${r[0]!.n} sessions)`);
    } catch (err) {
      step('pooled connection', false, String(err).slice(0, 120));
    } finally {
      await pooled.end({ timeout: 5 });
    }
  } else {
    step('pooled connection', true, 'same as direct (single-endpoint Postgres)');
  }

  console.log(`\n  git sha    ${gitCommitSha(e) ?? 'unknown'}`);
  console.log(`  dataset    ${e.DATASET_ID} (${e.DEPLOYMENT_ENV})`);
  console.log(`  retention  raw=${e.RAW_DB_RETENTION_ENABLED} normalized=${e.NORMALIZED_RETENTION_ENABLED}`);

  if (e.RAW_DB_RETENTION_ENABLED || e.NORMALIZED_RETENTION_ENABLED) {
    step(
      'retention off',
      false,
      'retention must stay OFF until one real partition passes archive -> restore -> replay',
    );
  } else {
    step('retention off', true, 'nothing can be deleted yet');
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(`\n  ${failed.length === 0 ? 'READY' : 'NOT READY'} -- ${steps.length - failed.length}/${steps.length} checks passed\n`);

  if (failed.length === 0) {
    console.log('Next:');
    console.log('  1. npm run cutover -- --record     record the outgoing epoch');
    console.log('  2. stop the local collector (SIGTERM; it flushes its buffer)');
    console.log('  3. npm run collector              starts a NEW session against the target');
    console.log('  4. npm run integrity              expect HEALTHY, zero gaps\n');
  }

  await closeDb().catch(() => {});
  if (failed.length > 0) process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--record')) {
    const i = argv.indexOf('--from');
    return recordOutgoingEpoch(i === -1 ? undefined : argv[i + 1]);
  }
  if (argv.includes('--check')) return checkTarget();

  console.error(
    'usage: npm run cutover -- --check | --record\n' +
      '  --check   verify the target database is ready (applies migrations)\n' +
      '  --record  print the outgoing epoch for the record before switching\n' +
      '            --from <url> reads a specific database; required once\n' +
      '            DATABASE_URL already points at the new target',
  );
  process.exit(1);
}

main().catch(async (err) => {
  logger.error({ event: 'cutover_failed', err: String(err) }, 'cutover check failed');
  console.error(String(err));
  await closeDb().catch(() => {});
  process.exit(1);
});
