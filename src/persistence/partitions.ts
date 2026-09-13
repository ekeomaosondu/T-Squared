import { one, type Sql } from '@/src/persistence/db';
import { logger } from '@/src/logging/logger';

/**
 * Daily UTC partition maintenance for raw_ingest_events.
 *
 * This is the one operational dependency that partitioning introduces: if the
 * partition for "now" does not exist, INSERTs fail. That failure is deliberate
 * (there is no DEFAULT partition), so the job is run at startup and hourly,
 * and `partitions_ahead` is reported as a first-class health metric.
 */

export interface EnsuredPartition {
  partition_name: string;
  /** Aliased away from the source column name so it can never shadow it. */
  day_text: string;
  created: boolean;
}

export async function ensureRawPartitions(
  sql: Sql,
  daysAhead: number,
  daysBehind = 1,
): Promise<EnsuredPartition[]> {
  const rows = await sql<EnsuredPartition[]>`
    SELECT p.partition_name, p.day::text AS day_text, p.created
    FROM ensure_raw_ingest_partitions(${daysAhead}::int, ${daysBehind}::int) p
  `;

  const created = rows.filter((r) => r.created);
  if (created.length > 0) {
    logger.info(
      { event: 'raw_partitions_created', partitions: created.map((r) => r.partition_name) },
      'created raw_ingest_events partitions',
    );
  }
  return rows;
}

export type PartitionHealth = 'healthy' | 'warning' | 'critical' | 'at_risk' | 'broken';

/**
 * -1 means today's partition itself is missing, i.e. writes are failing now.
 */
export async function partitionsAhead(sql: Sql): Promise<number> {
  const rows = await sql<{ ahead: number }[]>`
    SELECT raw_ingest_partitions_ahead() AS ahead
  `;
  return Number(one(rows, 'raw_ingest_partitions_ahead').ahead);
}

export function partitionHealth(ahead: number): PartitionHealth {
  if (ahead < 0) return 'broken';
  if (ahead === 0) return 'at_risk';
  if (ahead === 1) return 'critical';
  if (ahead === 2) return 'warning';
  return 'healthy';
}

export interface PartitionInfo {
  partition_name: string;
  partition_start: Date;
  partition_end: Date;
  is_complete: boolean;
}

export async function partitionInventory(sql: Sql): Promise<PartitionInfo[]> {
  return sql<PartitionInfo[]>`
    SELECT partition_name, partition_start, partition_end, is_complete
    FROM raw_ingest_partition_inventory()
  `;
}
