#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { env } from '@/src/config/env';
import { datasetHealth, DEFAULT_THRESHOLDS } from '@/src/integrity/datasetHealth';
import { closeDb, db } from '@/src/persistence/db';
import { listCoverage } from '@/src/persistence/repositories/coverage';
import { verifyReplay } from '@/src/replay/replay';
import { logger } from '@/src/logging/logger';

/**
 * Daily lightweight integrity job.
 *
 *   npm run integrity              sampled replay (default)
 *   npm run integrity -- --full    replay every market in the window
 *   npm run integrity -- --sample 10 --hours 24
 *
 * Reports dataset health, sequence gaps and recoveries, ordinal holes, archive
 * status, latest heartbeat, validation-state counts and series coverage, then
 * replays a randomized sample of markets. Run --full weekly, or whenever
 * something here looks off.
 *
 * Exits non-zero on CRITICAL or on any replay mismatch, so it can be a cron
 * job that only speaks up when it matters.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };

  const full = argv.includes('--full');
  const sampleSize = Number(get('--sample') ?? 8);
  const hours = Number(get('--hours') ?? 24);

  const e = env();
  const sql = db();

  // ---- health ------------------------------------------------------------
  const health = await datasetHealth(sql, {
    ...DEFAULT_THRESHOLDS,
    heartbeatStaleMs: e.COLLECTOR_HEARTBEAT_STALE_MS,
    retentionEnabled: e.RAW_DB_RETENTION_ENABLED,
  });

  console.log(`\n=== dataset health: ${health.level} ===\n`);
  for (const c of health.checks) {
    console.log(`  ${c.level.padEnd(8)} ${c.name.padEnd(26)} ${c.detail}`);
  }

  // ---- series coverage ---------------------------------------------------
  const coverage = await listCoverage(sql);
  if (coverage.length > 0) {
    console.log('\n=== series coverage ===\n');
    for (const c of coverage) {
      console.log(
        `  ${c.series_ticker.padEnd(14)} ${c.status.padEnd(22)} ` +
          `markets=${String(c.markets_seen).padStart(3)}` +
          (c.first_subscribed_at ? ` since ${c.first_subscribed_at.toISOString().slice(0, 16)}` : ''),
      );
    }
  }

  // ---- capture gaps ------------------------------------------------------
  const gaps = (await sql`
    SELECT g.started_at, g.ended_at, g.duration_ms::text AS duration_ms_text, g.reason,
           g.prior_end_reason
      FROM capture_gaps g
     WHERE g.started_at > now() - make_interval(hours => ${hours})
     ORDER BY g.started_at DESC
  `) as unknown as {
    started_at: Date; ended_at: Date | null; duration_ms_text: string | null;
    reason: string; prior_end_reason: string | null;
  }[];

  if (gaps.length > 0) {
    console.log(`\n=== capture gaps (last ${hours}h) ===\n`);
    for (const g of gaps) {
      const secs = g.duration_ms_text === null ? 'ongoing' : `${Math.round(Number(g.duration_ms_text) / 1000)}s`;
      console.log(
        `  ${g.started_at.toISOString()}  ${String(g.reason).padEnd(9)} ${secs.padStart(9)}` +
          (g.prior_end_reason ? `  (prior end_reason: ${g.prior_end_reason})` : '  (prior session did not shut down cleanly)'),
      );
    }
    // Not a failure: a recorded gap is the system working. An UNrecorded one
    // would be the problem, and is what this table exists to prevent.
    console.log('\n  These intervals had no coverage. Absence of events there is not');
    console.log('  absence of market activity, and backtests must exclude them.');
  }

  // ---- archive -----------------------------------------------------------
  const archives = (await sql`
    SELECT s.partition_name, s.status, s.sealed_row_count, s.archived_row_count, s.verified_at
      FROM raw_partition_archive_state s
     ORDER BY s.partition_start DESC
     LIMIT 7
  `) as unknown as {
    partition_name: string; status: string;
    sealed_row_count: string | null; archived_row_count: string; verified_at: Date | null;
  }[];

  if (archives.length > 0) {
    console.log('\n=== archive status (most recent partitions) ===\n');
    for (const a of archives) {
      console.log(
        `  ${a.partition_name.padEnd(32)} ${a.status.padEnd(10)} ` +
          `${a.archived_row_count}/${a.sealed_row_count ?? '?'} rows` +
          (a.verified_at ? `  verified ${a.verified_at.toISOString().slice(0, 16)}` : ''),
      );
    }
  }

  // ---- replay ------------------------------------------------------------
  const since = Date.now() - hours * 3_600_000;
  const candidates = (await sql`
    SELECT DISTINCT d.market_ticker
      FROM orderbook_deltas d
     WHERE d.received_at > to_timestamp(${since / 1000})
     ORDER BY d.market_ticker
  `) as unknown as { market_ticker: string }[];

  // A randomized sample keeps the daily job cheap while still touching a
  // different part of the dataset each run; --full is the weekly sweep.
  const tickers = full
    ? candidates.map((c) => c.market_ticker)
    : shuffle(candidates.map((c) => c.market_ticker)).slice(0, sampleSize);

  const bounds = (await sql`
    SELECT min(s.received_at_ms) AS from_ms, max(s.received_at_ms) AS to_ms
      FROM orderbook_snapshots s
     WHERE s.received_at > to_timestamp(${since / 1000})
  `) as unknown as { from_ms: string | null; to_ms: string | null }[];

  let checked = 0;
  let matched = 0;
  const failures: string[] = [];

  if (bounds[0]?.from_ms && bounds[0].to_ms && tickers.length > 0) {
    console.log(`\n=== replay (${full ? 'full' : `sample of ${tickers.length}`}, last ${hours}h) ===\n`);

    for (const ticker of tickers) {
      const v = await verifyReplay(
        sql, ticker, BigInt(bounds[0].from_ms) - 1n, BigInt(bounds[0].to_ms), 100_000,
      );
      checked += v.checked;
      matched += v.matched;

      const ok = v.checked === 0 || v.matched === v.checked;
      if (!ok) failures.push(`${ticker} (${v.matched}/${v.checked})`);
      console.log(`  ${ticker.padEnd(28)} ${String(v.matched).padStart(5)}/${String(v.checked).padEnd(5)} ${ok ? 'exact' : 'MISMATCH'}`);
    }
  }

  console.log(
    `\n${matched}/${checked} snapshots reproduced exactly` +
      (failures.length ? `\nmismatches: ${failures.join(', ')}` : ''),
  );

  const replayFailed = checked > 0 && matched !== checked;
  const level = replayFailed ? 'CRITICAL' : health.level;

  console.log(`\n=== result: ${level} ===\n`);

  logger.info(
    {
      event: 'integrity_check',
      level,
      critical: health.critical,
      degraded: health.degraded,
      replayChecked: checked,
      replayMatched: matched,
    },
    `daily integrity check: ${level}`,
  );

  await closeDb();
  if (level === 'CRITICAL') process.exit(2);
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

main().catch(async (err) => {
  logger.error({ event: 'integrity_check_failed', err: String(err) }, 'integrity check failed');
  console.error(String(err));
  await closeDb().catch(() => {});
  process.exit(1);
});
