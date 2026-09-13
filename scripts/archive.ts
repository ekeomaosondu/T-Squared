#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { env } from '@/src/config/env';
import { ArchiveWorker } from '@/src/persistence/archive';
import { selectArchiveStore } from '@/src/persistence/archiveStore';
import { closeDb, db } from '@/src/persistence/db';
import { logger } from '@/src/logging/logger';

/**
 * Archive CLI.
 *
 *   npm run archive               seal, archive and verify completed partitions
 *   npm run archive -- --status   report only, change nothing
 *
 * The destructive step (detach + drop) runs only when
 * RAW_DB_RETENTION_ENABLED=true AND the partition is verified AND its
 * retention floor has elapsed. All three, every time.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const statusOnly = argv.includes('--status');
  const e = env();
  const sql = db();

  if (statusOnly) {
    const rows = await sql`
      SELECT s.partition_name, s.status, s.sealed_row_count, s.archived_row_count,
             s.part_count, s.verified_at, s.dropped_at, s.last_error
        FROM raw_partition_archive_state s
       ORDER BY s.partition_start
    `;
    console.table(rows.map((r) => ({ ...r })));

    const parts = await sql`
      SELECT a.partition_name,
             count(*) AS parts,
             count(*) FILTER (WHERE a.verified_at IS NOT NULL) AS verified,
             sum(a.row_count) AS rows,
             pg_size_pretty(sum(a.compressed_bytes)) AS compressed,
             pg_size_pretty(sum(a.uncompressed_bytes)) AS uncompressed
        FROM raw_archives a
       GROUP BY a.partition_name
       ORDER BY a.partition_name
    `;
    console.table(parts.map((r) => ({ ...r })));
    await closeDb();
    return;
  }

  const { store } = selectArchiveStore({
    blobToken: e.BLOB_READ_WRITE_TOKEN,
    mode: e.COLLECTOR_MODE,
  });

  logger.info(
    {
      event: 'archive_run_start',
      store: store.kind,
      retentionEnabled: e.RAW_DB_RETENTION_ENABLED,
      retentionHours: e.RAW_DB_RETENTION_HOURS,
    },
    e.RAW_DB_RETENTION_ENABLED
      ? 'archiving; verified partitions past the retention floor WILL be dropped'
      : 'archiving; retention is disabled so nothing will be dropped',
  );

  const worker = new ArchiveWorker({
    sql,
    store,
    retentionHours: e.RAW_DB_RETENTION_HOURS,
    retentionEnabled: e.RAW_DB_RETENTION_ENABLED,
  });

  const result = await worker.run();
  console.log(JSON.stringify(result, null, 2));

  await closeDb();
  if (result.failed.length > 0) process.exit(2);
}

main().catch(async (err) => {
  logger.error({ event: 'archive_cli_failed', err: String(err) }, 'archive failed');
  await closeDb().catch(() => {});
  process.exit(1);
});
