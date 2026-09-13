import { createDb, type Sql } from '@/src/persistence/db';
import { migrate } from '@/src/persistence/migrate';
import { ensureRawPartitions } from '@/src/persistence/partitions';

/**
 * Per-suite test databases.
 *
 * Vitest runs test FILES in parallel, so DB-backed suites must not share a
 * database: one suite's TRUNCATE would otherwise delete another's fixtures
 * mid-run. Each suite therefore gets its own database, created on demand.
 *
 * Unavailability is a SKIP, not a failure, so the suite still runs on a machine
 * with no Postgres.
 */

const BASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://kalshi:kalshi@localhost:54329/kalshi_recorder_test';

function urlFor(suite: string): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${u.pathname.replace(/^\//, '')}_${suite}`;
  return u.toString();
}

function adminUrl(): string {
  const u = new URL(BASE_URL);
  u.pathname = '/postgres';
  return u.toString();
}

export async function testDbAvailable(): Promise<boolean> {
  try {
    const sql = createDb({ connectionString: adminUrl(), max: 1 });
    await sql`SELECT 1`;
    await sql.end({ timeout: 2 });
    return true;
  } catch {
    return false;
  }
}

async function ensureDatabase(suite: string): Promise<void> {
  const admin = createDb({ connectionString: adminUrl(), max: 1 });
  try {
    const name = new URL(urlFor(suite)).pathname.replace(/^\//, '');
    const existing = await admin<{ n: string }[]>`
      SELECT count(*) AS n FROM pg_database d WHERE d.datname = ${name}
    `;
    if (Number(existing[0]!.n) === 0) {
      // CREATE DATABASE cannot be parameterised or run in a transaction.
      await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end({ timeout: 2 });
  }
}

/** Connects to this suite's database, migrated and emptied. */
export async function freshTestDb(suite: string): Promise<Sql> {
  await ensureDatabase(suite);
  const sql = createDb({ connectionString: urlFor(suite), max: 4 });
  await migrate(sql);
  await truncateAll(sql);
  await ensureRawPartitions(sql, 7, 3);
  return sql;
}

/** Empties every recorded table, keeping the schema. */
export async function truncateAll(sql: Sql): Promise<void> {
  await sql.unsafe(`
    TRUNCATE raw_ingest_events, raw_archives, raw_partition_archive_state,
             orderbook_deltas, orderbook_snapshots, public_trades, ticker_updates,
             market_lifecycle_events, sequence_gaps, integrity_events,
             book_validations, ingest_health_minutes, book_samples,
             event_ladder_samples, event_ladder_sample_groups,
             subscription_streams, collector_sessions
    RESTART IDENTITY CASCADE
  `);
}
