import type { MarketBook } from '@/src/book/book';
import { PRICE_DP, SIZE_DP, toNumeric } from '@/src/book/decimal';
import type { Sql } from '@/src/persistence/db';
import type { NormalizedRow } from '@/src/persistence/types';

/**
 * Order-book snapshot persistence.
 *
 * The raw YES/NO representation is stored exactly as the exchange expresses
 * it; the YES-side bid/ask figures alongside are derived convenience columns
 * and never replace it.
 */

export type SnapshotSource =
  | 'ws_initial'
  | 'ws_recovery'
  | 'local_materialized'
  | 'rest_validation'
  | 'session_handoff';

export interface SnapshotInput {
  book: MarketBook;
  source: SnapshotSource;
  sessionId?: string | null;
  streamId?: string | null;
  sid?: number | null;
  seq?: bigint | null;
  receivedAt: Date;
  receivedAtMs: bigint;
  marketId?: string | null;
  linkRawEvent?: boolean;
}

export function snapshotRow(input: SnapshotInput): NormalizedRow {
  const { book } = input;
  const canonical = book.serializeCanonical();
  const bbo = book.getYesBBO();

  const bestNo = book.noBidLevels()[0] ?? null;

  return {
    table: 'orderbook_snapshots',
    linkRawEvent: input.linkRawEvent ?? false,
    values: {
      market_ticker: book.marketTicker,
      market_id: input.marketId ?? null,
      session_id: input.sessionId ?? null,
      stream_id: input.streamId ?? null,
      source: input.source,
      sid: input.sid ?? null,
      seq: input.seq?.toString() ?? null,
      received_at: input.receivedAt,
      received_at_ms: input.receivedAtMs.toString(),

      // Raw JS values, not pre-stringified: the batch writer adds an explicit
      // ::jsonb cast, and a stringified value would be stored as a JSON string.
      yes_bids: canonical.yes_bids,
      no_bids: canonical.no_bids,

      yes_level_count: canonical.yes_bids.length,
      no_level_count: canonical.no_bids.length,

      best_yes_bid: toNumeric(bbo.bid, PRICE_DP),
      best_yes_bid_size: toNumeric(bbo.bidSize, SIZE_DP),
      best_no_bid: bestNo ? bestNo[0] : null,
      best_no_bid_size: bestNo ? bestNo[1] : null,
      best_yes_ask: toNumeric(bbo.ask, PRICE_DP),
      best_yes_ask_size: toNumeric(bbo.askSize, SIZE_DP),

      spread: toNumeric(bbo.spread, PRICE_DP),
      mid: toNumeric(bbo.mid, PRICE_DP),

      state_hash: book.getStateHash(),
    },
  };
}

export interface SnapshotRow {
  snapshot_id: string;
  market_ticker: string;
  source: SnapshotSource;
  session_id: string | null;
  stream_id: string | null;
  sid: number | null;
  seq: string | null;
  received_at: Date;
  received_at_ms: string;
  yes_bids: [string, string][];
  no_bids: [string, string][];
  state_hash: string;
}

/**
 * Nearest snapshot at or before `atMs` that can seed a replay.
 *
 * rest_validation snapshots are excluded: they are a second opinion recorded
 * for comparison, not part of the WebSocket-derived history.
 */
export async function findSeedSnapshot(
  sql: Sql,
  marketTicker: string,
  atMs: bigint,
): Promise<SnapshotRow | null> {
  const rows = await sql<SnapshotRow[]>`
    SELECT s.snapshot_id, s.market_ticker, s.source, s.session_id, s.stream_id,
           s.sid, s.seq, s.received_at, s.received_at_ms, s.yes_bids, s.no_bids,
           s.state_hash
      FROM orderbook_snapshots s
     WHERE s.market_ticker = ${marketTicker}
       AND s.received_at_ms <= ${atMs.toString()}
       AND s.source IN ('ws_initial', 'ws_recovery', 'session_handoff', 'local_materialized')
     ORDER BY s.received_at_ms DESC, s.snapshot_id DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listSnapshots(
  sql: Sql,
  marketTicker: string,
  fromMs: bigint,
  toMs: bigint,
  limit = 500,
): Promise<SnapshotRow[]> {
  return sql<SnapshotRow[]>`
    SELECT s.snapshot_id, s.market_ticker, s.source, s.session_id, s.stream_id,
           s.sid, s.seq, s.received_at, s.received_at_ms, s.yes_bids, s.no_bids,
           s.state_hash
      FROM orderbook_snapshots s
     WHERE s.market_ticker = ${marketTicker}
       AND s.received_at_ms >= ${fromMs.toString()}
       AND s.received_at_ms <= ${toMs.toString()}
     ORDER BY s.received_at_ms
     LIMIT ${Math.min(limit, 5000)}
  `;
}

export async function latestSnapshot(sql: Sql, marketTicker: string): Promise<SnapshotRow | null> {
  const rows = await sql<SnapshotRow[]>`
    SELECT s.snapshot_id, s.market_ticker, s.source, s.session_id, s.stream_id,
           s.sid, s.seq, s.received_at, s.received_at_ms, s.yes_bids, s.no_bids,
           s.state_hash
      FROM orderbook_snapshots s
     WHERE s.market_ticker = ${marketTicker}
     ORDER BY s.received_at_ms DESC, s.snapshot_id DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}
