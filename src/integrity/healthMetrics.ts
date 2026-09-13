import type { Sql } from '@/src/persistence/db';
import { partitionHealth, partitionsAhead } from '@/src/persistence/partitions';
import { logger } from '@/src/logging/logger';

/**
 * Per-minute ingest health.
 *
 * This is what makes "was this portion of the dataset trustworthy?" answerable
 * weeks later, so it is written unconditionally rather than only when something
 * looks wrong.
 *
 * Exchange-to-receive latency is computed ONLY from messages that carried a
 * usable exchange timestamp, and is not treated as true network latency:
 * Kalshi's timestamps are coarse in places, so this is an upper bound with
 * clock skew folded in.
 */

export interface MinuteAccumulator {
  minute: number;
  rawMessages: number;
  orderbookDeltas: number;
  trades: number;
  tickers: number;
  snapshots: number;
  sequenceGaps: number;
  validationMismatches: number;
  dbBatches: number;
  dbRowsWritten: number;
  dbErrors: number;
  reconnects: number;
  latencies: number[];
  wsConnected: boolean;
  trackedMarkets: number;
}

export function newMinuteAccumulator(minuteMs: number): MinuteAccumulator {
  return {
    minute: minuteMs,
    rawMessages: 0,
    orderbookDeltas: 0,
    trades: 0,
    tickers: 0,
    snapshots: 0,
    sequenceGaps: 0,
    validationMismatches: 0,
    dbBatches: 0,
    dbRowsWritten: 0,
    dbErrors: 0,
    reconnects: 0,
    latencies: [],
    wsConnected: false,
    trackedMarkets: 0,
  };
}

export function minuteOf(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000;
}

/** Only meaningful for messages that actually carried an exchange timestamp. */
export function recordLatency(acc: MinuteAccumulator, exchangeTsMs: bigint | null, receivedAtMs: bigint): void {
  if (exchangeTsMs === null) return;
  const delta = Number(receivedAtMs - exchangeTsMs);
  // Guard against clock skew producing nonsense; a negative value means the
  // exchange clock is ahead of ours, which is not a latency measurement.
  if (delta < 0 || delta > 600_000) return;
  acc.latencies.push(delta);
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
}

export interface FlushLatencies {
  avg: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export async function writeHealthMinute(
  sql: Sql,
  sessionId: string,
  acc: MinuteAccumulator,
  flush: FlushLatencies | null,
): Promise<void> {
  const sorted = [...acc.latencies].sort((a, b) => a - b);
  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;

  let ahead: number | null = null;
  try {
    ahead = await partitionsAhead(sql);
  } catch {
    // Reporting health must not fail because one of its inputs is unavailable.
  }

  await sql`
    INSERT INTO ingest_health_minutes (
      session_id, minute, ws_connected, tracked_market_count, raw_message_count,
      orderbook_delta_count, trade_count, ticker_count, snapshot_count,
      sequence_gap_count, validation_mismatch_count,
      db_batch_count, db_rows_written, db_error_count,
      avg_db_flush_ms, max_db_flush_ms,
      avg_exchange_to_receive_ms, p50_exchange_to_receive_ms,
      p95_exchange_to_receive_ms, p99_exchange_to_receive_ms,
      reconnect_count, partitions_ahead
    ) VALUES (
      ${sessionId}, ${new Date(acc.minute)}, ${acc.wsConnected}, ${acc.trackedMarkets},
      ${acc.rawMessages}, ${acc.orderbookDeltas}, ${acc.trades}, ${acc.tickers},
      ${acc.snapshots}, ${acc.sequenceGaps}, ${acc.validationMismatches},
      ${acc.dbBatches}, ${acc.dbRowsWritten}, ${acc.dbErrors},
      ${flush?.avg ?? null}, ${flush?.max ?? null},
      ${avg}, ${percentile(sorted, 0.5)}, ${percentile(sorted, 0.95)}, ${percentile(sorted, 0.99)},
      ${acc.reconnects}, ${ahead}
    )
    ON CONFLICT (session_id, minute) DO UPDATE SET
      ws_connected              = EXCLUDED.ws_connected,
      tracked_market_count      = EXCLUDED.tracked_market_count,
      raw_message_count         = ingest_health_minutes.raw_message_count + EXCLUDED.raw_message_count,
      orderbook_delta_count     = ingest_health_minutes.orderbook_delta_count + EXCLUDED.orderbook_delta_count,
      trade_count               = ingest_health_minutes.trade_count + EXCLUDED.trade_count,
      ticker_count              = ingest_health_minutes.ticker_count + EXCLUDED.ticker_count,
      snapshot_count            = ingest_health_minutes.snapshot_count + EXCLUDED.snapshot_count,
      sequence_gap_count        = ingest_health_minutes.sequence_gap_count + EXCLUDED.sequence_gap_count,
      validation_mismatch_count = ingest_health_minutes.validation_mismatch_count + EXCLUDED.validation_mismatch_count,
      db_batch_count            = ingest_health_minutes.db_batch_count + EXCLUDED.db_batch_count,
      db_rows_written           = ingest_health_minutes.db_rows_written + EXCLUDED.db_rows_written,
      db_error_count            = ingest_health_minutes.db_error_count + EXCLUDED.db_error_count,
      partitions_ahead          = EXCLUDED.partitions_ahead
  `;

  if (ahead !== null) {
    const health = partitionHealth(ahead);
    if (health !== 'healthy') {
      logger.error(
        { event: 'partition_health', partitionsAhead: ahead, health },
        `raw partition runway is ${health} (${ahead} day(s) ahead)`,
      );
    }
  }
}
