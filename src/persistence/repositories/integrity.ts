import type { Sql } from '@/src/persistence/db';
import type { NormalizedRow } from '@/src/persistence/types';
import { logger } from '@/src/logging/logger';

/**
 * Integrity and validation records.
 *
 * Anything anomalous is RECORDED. Nothing suspicious is ever deleted or
 * repaired -- research data must preserve reality, including anomalies.
 */

export type IntegrityType =
  | 'sequence_gap'
  | 'negative_level_quantity'
  | 'rest_snapshot_mismatch'
  | 'ticker_bbo_mismatch'
  | 'duplicate_trade_id'
  | 'invalid_decimal'
  | 'unexpected_schema'
  | 'db_write_failure'
  | 'ws_disconnect'
  | 'subscription_failure'
  | 'recovery_failure'
  | 'buffer_overflow'
  | 'partition_missing'
  | 'price_out_of_range'
  | 'crossed_book'
  | 'volume_decrease';

export type IntegritySeverity = 'info' | 'warning' | 'error' | 'critical';

export interface IntegrityEventInput {
  sessionId?: string | null;
  marketTicker?: string | null;
  type: IntegrityType;
  severity: IntegritySeverity;
  details: Record<string, unknown>;
  detectedAt?: Date;
}

/** Builds a batchable row; prefer this on the hot path. */
export function integrityRow(input: IntegrityEventInput): NormalizedRow {
  return {
    table: 'integrity_events',
    values: {
      session_id: input.sessionId ?? null,
      market_ticker: input.marketTicker ?? null,
      detected_at: input.detectedAt ?? new Date(),
      type: input.type,
      severity: input.severity,
      details: input.details,
    },
  };
}

/** Immediate write, for paths that must not wait for the next flush. */
export async function recordIntegrityEvent(sql: Sql, input: IntegrityEventInput): Promise<void> {
  await sql`
    INSERT INTO integrity_events (
      session_id, market_ticker, detected_at, type, severity, details
    ) VALUES (
      ${input.sessionId ?? null}, ${input.marketTicker ?? null},
      ${input.detectedAt ?? new Date()}, ${input.type}, ${input.severity},
      ${sql.json(input.details as never)}
    )
  `;
  const log = input.severity === 'critical' || input.severity === 'error' ? logger.error : logger.warn;
  log.call(
    logger,
    { event: 'integrity_event', type: input.type, severity: input.severity, market_ticker: input.marketTicker },
    `integrity event: ${input.type}`,
  );
}

export async function resolveIntegrityEvents(
  sql: Sql,
  ids: string[],
  resolution: string,
): Promise<void> {
  if (ids.length === 0) return;
  await sql`
    UPDATE integrity_events
       SET resolved_at = now(), resolution = ${resolution}
     WHERE id = ANY(${ids}::bigint[]) AND resolved_at IS NULL
  `;
}

export async function listRecentIntegrityEvents(
  sql: Sql,
  opts: { limit?: number; since?: Date; type?: string } = {},
) {
  const limit = Math.min(opts.limit ?? 100, 1000);
  return sql`
    SELECT id, session_id, market_ticker, detected_at, type, severity, details,
           resolved_at, resolution
      FROM integrity_events
     WHERE (${opts.since ?? null}::timestamptz IS NULL OR detected_at >= ${opts.since ?? null})
       AND (${opts.type ?? null}::text IS NULL OR type = ${opts.type ?? null})
     ORDER BY detected_at DESC
     LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Sequence gaps
// ---------------------------------------------------------------------------

export interface SequenceGapInput {
  sessionId: string;
  streamId: string;
  channel: string;
  sid?: number | null;
  expectedSeq: bigint | null;
  receivedSeq: bigint | null;
  affectedMarkets: string[];
  detectedAt?: Date;
}

export async function recordSequenceGap(sql: Sql, input: SequenceGapInput): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO sequence_gaps (
      session_id, stream_id, channel, sid, expected_seq, received_seq,
      detected_at, affected_markets, status
    ) VALUES (
      ${input.sessionId}, ${input.streamId}, ${input.channel}, ${input.sid ?? null},
      ${input.expectedSeq?.toString() ?? null}, ${input.receivedSeq?.toString() ?? null},
      ${input.detectedAt ?? new Date()},
      ${sql.json(input.affectedMarkets as never)}, 'detected'
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

export async function markGapRecovering(sql: Sql, gapId: string): Promise<void> {
  await sql`
    UPDATE sequence_gaps
       SET status = 'recovering', recovery_requested_at = now()
     WHERE id = ${gapId}::bigint
  `;
}

export async function markGapRecovered(
  sql: Sql,
  gapId: string,
  snapshotCount: number,
): Promise<void> {
  await sql`
    UPDATE sequence_gaps
       SET status = 'recovered',
           recovery_completed_at = now(),
           recovery_snapshot_count = ${snapshotCount}
     WHERE id = ${gapId}::bigint
  `;
}

export async function markGapFailed(sql: Sql, gapId: string, notes: string): Promise<void> {
  await sql`
    UPDATE sequence_gaps
       SET status = 'failed', notes = ${notes}
     WHERE id = ${gapId}::bigint
  `;
}

export async function countGapsSince(sql: Sql, since: Date): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM sequence_gaps WHERE detected_at >= ${since}
  `;
  return Number(rows[0]!.n);
}
