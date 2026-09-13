import { one, type Sql } from '@/src/persistence/db';
import { partitionsAhead } from '@/src/persistence/partitions';

/**
 * One dataset-health status to alert on, instead of twenty metrics.
 *
 * CRITICAL means the dataset is being damaged or is no longer being collected,
 * and someone should look now. DEGRADED means something needs attention but
 * history is still being captured correctly.
 */

export type HealthLevel = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export interface HealthCheck {
  name: string;
  level: HealthLevel;
  detail: string;
}

export interface DatasetHealth {
  level: HealthLevel;
  checkedAt: string;
  critical: string[];
  degraded: string[];
  checks: HealthCheck[];
}

export interface HealthThresholds {
  /** A collector whose heartbeat is older than this is presumed dead. */
  heartbeatStaleMs: number;
  /** Partition runway below this many days ahead is critical. */
  minPartitionsAhead: number;
  /** Hours a completed partition may go unarchived before it is overdue. */
  archiveOverdueHours: number;
  /** Buffered rows above this suggest the writer is not keeping up. */
  maxBufferedRows: number;
  /** Whether destructive retention is currently enabled. */
  retentionEnabled: boolean;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  heartbeatStaleMs: 20_000,
  minPartitionsAhead: 2,
  archiveOverdueHours: 6,
  maxBufferedRows: 100_000,
  retentionEnabled: false,
};

const worst = (a: HealthLevel, b: HealthLevel): HealthLevel =>
  a === 'CRITICAL' || b === 'CRITICAL' ? 'CRITICAL' : a === 'DEGRADED' || b === 'DEGRADED' ? 'DEGRADED' : 'HEALTHY';

export async function datasetHealth(
  sql: Sql,
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
): Promise<DatasetHealth> {
  const checks: HealthCheck[] = [];
  const add = (name: string, level: HealthLevel, detail: string) => checks.push({ name, level, detail });

  // ---- collector liveness -------------------------------------------------
  const live = await sql<{ session_id: string; age_ms: string; buffered: string | null }[]>`
    SELECT c.session_id,
           (extract(epoch FROM (now() - c.last_heartbeat_at)) * 1000)::bigint::text AS age_ms,
           NULL AS buffered
      FROM collector_sessions c
     WHERE c.ended_at IS NULL
     ORDER BY c.last_heartbeat_at DESC NULLS LAST
     LIMIT 1
  `;

  if (live.length === 0) {
    add('collector_heartbeat', 'CRITICAL', 'no open collector session; nothing is being recorded');
  } else {
    const ageMs = Number(live[0]!.age_ms);
    if (ageMs > thresholds.heartbeatStaleMs) {
      add('collector_heartbeat', 'CRITICAL', `heartbeat is ${Math.round(ageMs / 1000)}s stale`);
    } else {
      add('collector_heartbeat', 'HEALTHY', `heartbeat ${Math.round(ageMs / 1000)}s ago`);
    }
  }

  // ---- raw durability -----------------------------------------------------
  // A hole means a frame was observed but never persisted.
  const holes = await sql<{ n: string }[]>`
    WITH o AS (
      SELECT r.ingest_ordinal,
             lag(r.ingest_ordinal) OVER (PARTITION BY r.session_id ORDER BY r.ingest_ordinal) AS prev
        FROM raw_ingest_events r
       WHERE r.received_at > now() - interval '24 hours'
         AND r.ingest_ordinal IS NOT NULL
    )
    SELECT count(*) AS n FROM o WHERE o.prev IS NOT NULL AND o.ingest_ordinal <> o.prev + 1
  `;
  const holeCount = Number(one(holes).n);
  add(
    'ingest_ordinal_contiguity',
    holeCount === 0 ? 'HEALTHY' : 'CRITICAL',
    holeCount === 0 ? 'no gaps between observation and durability (24h)' : `${holeCount} ordinal hole(s) in 24h`,
  );

  // ---- sequence recovery --------------------------------------------------
  const gaps = await sql<{ status: string; n: string }[]>`
    SELECT g.status, count(*) AS n
      FROM sequence_gaps g
     WHERE g.detected_at > now() - interval '24 hours'
     GROUP BY g.status
  `;
  const unrecovered = gaps
    .filter((g) => g.status !== 'recovered')
    .reduce((n, g) => n + Number(g.n), 0);
  const total = gaps.reduce((n, g) => n + Number(g.n), 0);

  add(
    'sequence_recovery',
    unrecovered === 0 ? 'HEALTHY' : 'CRITICAL',
    unrecovered === 0
      ? `${total} gap(s) in 24h, all recovered`
      : `${unrecovered} of ${total} gap(s) unrecovered`,
  );

  // ---- partition runway ---------------------------------------------------
  let ahead: number | null = null;
  try {
    ahead = await partitionsAhead(sql);
  } catch {
    ahead = null;
  }
  if (ahead === null) {
    add('partition_runway', 'CRITICAL', 'could not read partition runway');
  } else if (ahead < 0) {
    add('partition_runway', 'CRITICAL', "today's partition is missing; raw writes are failing");
  } else if (ahead < thresholds.minPartitionsAhead) {
    add('partition_runway', 'CRITICAL', `only ${ahead} day(s) of partitions ahead`);
  } else {
    add('partition_runway', 'HEALTHY', `${ahead} day(s) of partitions ahead`);
  }

  // ---- database writes ----------------------------------------------------
  const dbErrors = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM integrity_events e
     WHERE e.detected_at > now() - interval '1 hour'
       AND e.type IN ('db_write_failure', 'buffer_overflow', 'partition_missing')
  `;
  const errCount = Number(one(dbErrors).n);
  add(
    'database_writes',
    errCount === 0 ? 'HEALTHY' : 'CRITICAL',
    errCount === 0 ? 'no write failures in the last hour' : `${errCount} write failure(s) in the last hour`,
  );

  // ---- archive currency ---------------------------------------------------
  // Only meaningful once retention can delete: an unarchived partition that is
  // about to be dropped is the dangerous case.
  const overdue = await sql<{ n: string; names: string[] }[]>`
    SELECT count(*) AS n, coalesce(array_agg(s.partition_name), '{}') AS names
      FROM raw_partition_archive_state s
     WHERE s.partition_end < now() - make_interval(hours => ${thresholds.archiveOverdueHours})
       AND s.status NOT IN ('verified', 'detached', 'dropped')
  `;
  const overdueCount = Number(one(overdue).n);
  if (overdueCount === 0) {
    add('archive_currency', 'HEALTHY', 'no partitions overdue for archiving');
  } else {
    // Unarchived data is only CRITICAL when something could delete it.
    add(
      'archive_currency',
      thresholds.retentionEnabled ? 'CRITICAL' : 'DEGRADED',
      `${overdueCount} partition(s) overdue: ${one(overdue).names.slice(0, 3).join(', ')}` +
        (thresholds.retentionEnabled ? ' (retention is ENABLED)' : ' (retention disabled, so nothing can be lost)'),
    );
  }

  // ---- validation state ---------------------------------------------------
  const validations = await sql<{ match_kind: string | null; n: string }[]>`
    SELECT v.match_kind, count(*) AS n
      FROM book_validations v
     WHERE v.checked_at > now() - interval '1 hour'
     GROUP BY v.match_kind
  `;
  const confirmed = Number(validations.find((v) => v.match_kind === 'mismatch_confirmed')?.n ?? 0);
  const checked = validations.reduce((n, v) => n + Number(v.n), 0);
  add(
    'rest_validation',
    confirmed === 0 ? 'HEALTHY' : 'DEGRADED',
    checked === 0
      ? 'no REST validations in the last hour'
      : `${checked} checked, ${confirmed} confirmed mismatch(es)`,
  );

  // ---- series coverage ----------------------------------------------------
  const coverage = await sql<{ status: string; n: string }[]>`
    SELECT c.status, count(*) AS n FROM series_coverage c GROUP BY c.status
  `;
  const awaiting = Number(coverage.find((c) => c.status === 'awaiting_first_market')?.n ?? 0);
  const exercised = Number(coverage.find((c) => c.status === 'exercised')?.n ?? 0);
  add(
    'series_coverage',
    'HEALTHY',
    `${exercised} series exercised, ${awaiting} awaiting a first market`,
  );

  const level = checks.reduce<HealthLevel>((acc, c) => worst(acc, c.level), 'HEALTHY');

  return {
    level,
    checkedAt: new Date().toISOString(),
    critical: checks.filter((c) => c.level === 'CRITICAL').map((c) => `${c.name}: ${c.detail}`),
    degraded: checks.filter((c) => c.level === 'DEGRADED').map((c) => `${c.name}: ${c.detail}`),
    checks,
  };
}
