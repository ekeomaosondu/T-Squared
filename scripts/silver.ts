#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { env } from '@/src/config/env';
import { selectArchiveStore } from '@/src/persistence/archiveStore';
import { closeDb, db } from '@/src/persistence/db';
import { SilverExporter } from '@/src/persistence/silver';
import { MarketStateExporter } from '@/src/persistence/silverMarketState';
import { CalibrationExporter } from '@/src/persistence/silverCalibration';
import { logger } from '@/src/logging/logger';

/**
 * Silver layer CLI.
 *
 *   npm run silver                    export every completed UTC day
 *   npm run silver -- --day 2026-09-14
 *   npm run silver -- --expire        also expire verified days from Postgres
 *   npm run silver -- --status
 *   npm run silver -- --allow-shrink   permit replacing a larger existing file
 *   npm run silver -- --market-state   snapshot market definitions and results only
 *   npm run silver -- --calibration    export the execution-calibration dataset
 *
 * Exporting is safe to run repeatedly. Expiry is gated on every silver export
 * for the day being verified, and is off unless --expire is passed AND
 * NORMALIZED_RETENTION_ENABLED is true.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };

  const e = env();
  const sql = db();

  if (argv.includes('--status')) {
    const exports = await sql`
      SELECT e.trading_date, e.source_table, e.series_ticker, e.status,
             e.exported_row_count, pg_size_pretty(e.compressed_bytes) AS size
        FROM silver_exports e
       ORDER BY e.trading_date DESC, e.source_table, e.series_ticker
       LIMIT 40
    `;
    console.table(exports.map((r) => ({ ...r })));

    const expired = await sql`
      SELECT r.trading_date, r.expired_at, r.rows_deleted
        FROM normalized_retention r ORDER BY r.trading_date DESC LIMIT 10
    `;
    console.table(expired.map((r) => ({ ...r })));
    await closeDb();
    return;
  }

  const { store } = selectArchiveStore({
    blobToken: e.BLOB_READ_WRITE_TOKEN,
    mode: e.COLLECTOR_MODE,
    storage: e.ARCHIVE_STORAGE,
    s3: {
      bucket: e.ARCHIVE_BUCKET,
      endpoint: e.ARCHIVE_ENDPOINT,
      region: e.ARCHIVE_REGION,
      accessKeyId: e.ARCHIVE_ACCESS_KEY_ID,
      secretAccessKey: e.ARCHIVE_SECRET_ACCESS_KEY,
    },
  });

  const exporter = new SilverExporter({
    sql,
    store,
    datasetId: e.DATASET_ID,
    allowShrink: argv.includes('--allow-shrink'),
  });

  const marketState = new MarketStateExporter(sql, store, e.DATASET_ID);

  if (argv.includes('--market-state')) {
    const snapshot = await marketState.export(get('--snapshot-date'));
    console.log(
      `market state ${snapshot.snapshotDate}: ${snapshot.files.length} file(s), ` +
        `${snapshot.files.reduce((n, f) => n + f.rows, 0)} row(s), ${snapshot.failed.length} failed`,
    );
    for (const f of snapshot.failed) console.error(`  FAILED ${f.table}: ${f.error}`);
    await closeDb();
    process.exitCode = snapshot.failed.length > 0 ? 1 : 0;
    return;
  }

  if (argv.includes('--calibration')) {
    const out = await new CalibrationExporter(sql, store, e.DATASET_ID).export(get('--day'));
    for (const f of out.files) {
      console.log(`  ${f.date}  ${f.table.padEnd(32)} ${String(f.rows).padStart(7)} rows  ${(f.bytes / 1e3).toFixed(1)} kB`);
    }
    for (const f of out.failed) console.error(`  FAILED ${f.table}: ${f.error}`);
    await closeDb();
    process.exitCode = out.failed.length > 0 ? 1 : 0;
    return;
  }

  const explicit = get('--day');
  const days = explicit ? [explicit] : await exporter.completedDays();

  if (days.length === 0) {
    console.log('no completed UTC days to export yet (today is still accumulating)');
    await closeDb();
    return;
  }

  logger.info(
    { event: 'silver_start', store: store.kind, days, dataset_id: e.DATASET_ID },
    `exporting ${days.length} day(s) to the ${store.kind} research lake`,
  );

  let failed = 0;
  for (const day of days) {
    const result = await exporter.exportDay(day);
    failed += result.failed.length;

    for (const f of result.exported) {
      console.log(
        `  ${day}  ${f.table.padEnd(20)} ${String(f.series ?? 'unknown').padEnd(12)} ` +
          `${String(f.rows).padStart(8)} rows  ${(f.bytes / 1e6).toFixed(2)} MB`,
      );
    }
    for (const f of result.failed) console.log(`  ${day}  FAILED ${f.table}: ${f.error}`);

    if (argv.includes('--expire')) {
      // Only days older than the hot window are eligible; recent normalized
      // data stays in Postgres for debugging and live operation.
      const cutoff = new Date(Date.now() - e.NORMALIZED_RETENTION_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const withinHotWindow = day >= cutoff;

      const out = withinHotWindow
        ? { deleted: 0, reason: `within the ${e.NORMALIZED_RETENTION_DAYS}-day hot window` }
        : await exporter.expireDay(day, { enabled: e.NORMALIZED_RETENTION_ENABLED });
      console.log(
        out.deleted > 0
          ? `  ${day}  expired ${out.deleted} normalized row(s) from Postgres`
          : `  ${day}  not expired: ${out.reason}`,
      );
    }
  }

  // Always refresh the market-state snapshot alongside a day export. A
  // determination arrives after the trading it settles, so the freshest
  // snapshot is the one that can settle the oldest day.
  const snapshot = await marketState.export();
  console.log(
    `  ${snapshot.snapshotDate}  market_state          ` +
      `${String(snapshot.files.reduce((n, f) => n + f.rows, 0)).padStart(8)} rows in ` +
      `${snapshot.files.length} file(s)`,
  );
  failed += snapshot.failed.length;
  for (const f of snapshot.failed) console.log(`  FAILED ${f.table}: ${f.error}`);

  await closeDb();
  if (failed > 0) process.exit(2);
}

main().catch(async (err) => {
  logger.error({ event: 'silver_failed', err: String(err) }, 'silver export failed');
  console.error(String(err));
  await closeDb().catch(() => {});
  process.exit(1);
});
