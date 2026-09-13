import { createDb, type Sql } from '@/src/persistence/db';
import { migrate } from '@/src/persistence/migrate';
import { ensureRawPartitions } from '@/src/persistence/partitions';

/**
 * Connects to a dedicated test database, separate from the development one, so
 * DB-backed tests are repeatable and never disturb a running collector.
 *
 * Skipped rather than failed when unavailable: the suite must still run on a
 * machine with no Postgres.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://kalshi:kalshi@localhost:54329/kalshi_recorder_test';

export async function testDbAvailable(): Promise<boolean> {
  try {
    const sql = createDb({ connectionString: TEST_DATABASE_URL, max: 1 });
    await sql`SELECT 1`;
    await sql.end({ timeout: 2 });
    return true;
  } catch {
    return false;
  }
}

export async function freshTestDb(): Promise<Sql> {
  const sql = createDb({ connectionString: TEST_DATABASE_URL, max: 4 });
  await migrate(sql);

  // Truncate rather than drop, so the schema survives between tests.
  await sql.unsafe(`
    TRUNCATE raw_ingest_events, raw_archives, raw_partition_archive_state,
             orderbook_deltas, orderbook_snapshots, public_trades, ticker_updates,
             market_lifecycle_events, sequence_gaps, integrity_events,
             book_validations, ingest_health_minutes, book_samples,
             event_ladder_samples, event_ladder_sample_groups,
             subscription_streams, collector_sessions
    RESTART IDENTITY CASCADE
  `);
  await ensureRawPartitions(sql, 7, 3);
  return sql;
}
