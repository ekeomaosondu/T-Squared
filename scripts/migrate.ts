#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { closeDb, db } from '@/src/persistence/db';
import { migrate } from '@/src/persistence/migrate';
import { ensureRawPartitions, partitionHealth, partitionsAhead } from '@/src/persistence/partitions';
import { env } from '@/src/config/env';
import { logger } from '@/src/logging/logger';

async function main() {
  const sql = db();

  const result = await migrate(sql);
  logger.info(
    { event: 'migrations_complete', applied: result.applied.length, skipped: result.skipped.length },
    `applied ${result.applied.length} migration(s), ${result.skipped.length} already present`,
  );

  // Partitions must exist before the collector ever writes a raw event.
  await ensureRawPartitions(sql, env().RAW_PARTITION_AHEAD_DAYS);
  const ahead = await partitionsAhead(sql);
  logger.info(
    { event: 'partition_status', partitionsAhead: ahead, health: partitionHealth(ahead) },
    `raw partitions ahead: ${ahead} (${partitionHealth(ahead)})`,
  );

  await closeDb();
}

main().catch(async (err) => {
  logger.error({ event: 'migrate_failed', err: String(err) }, 'migration failed');
  await closeDb().catch(() => {});
  process.exit(1);
});
