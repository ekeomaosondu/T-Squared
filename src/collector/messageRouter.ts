import { sha256Bytes } from '@/src/book/hashing';
import type { RawFrame } from '@/src/kalshi/websocketClient';
import type { RawIngestEvent } from '@/src/persistence/types';

/**
 * Minimal parsing between "bytes arrived" and "raw event is queued".
 *
 * Everything here must be cheap. The raw record has to reach the durable-write
 * queue as close to socket receipt as possible; book reconstruction, feature
 * computation and validation all happen afterwards and must never be able to
 * delay or prevent the raw capture.
 */

/** Maps a message type to the channel it belongs to. */
export const TYPE_TO_CHANNEL: Record<string, string> = {
  orderbook_snapshot: 'orderbook_delta',
  orderbook_delta: 'orderbook_delta',
  trade: 'trade',
  ticker: 'ticker',
  ticker_v2: 'ticker',
  fill: 'fill',
  market_lifecycle_v2: 'market_lifecycle_v2',
  event_lifecycle: 'market_lifecycle_v2',
  event_fee_update: 'market_lifecycle_v2',
  market_position: 'market_positions',
  user_order: 'user_orders',
};

export function channelForType(messageType: string): string | null {
  return TYPE_TO_CHANNEL[messageType] ?? null;
}

/** Pulls the exchange timestamp, preferring ts_ms over the deprecated ts. */
export function exchangeTsMsOf(msg: unknown): bigint | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;

  if (typeof m.ts_ms === 'number' && Number.isFinite(m.ts_ms)) return BigInt(Math.round(m.ts_ms));

  // `ts` is seconds on trade/ticker and an RFC3339 string on orderbook_delta.
  if (typeof m.ts === 'number' && Number.isFinite(m.ts)) {
    return BigInt(m.ts < 1e11 ? Math.round(m.ts * 1000) : Math.round(m.ts));
  }
  if (typeof m.ts === 'string') {
    const parsed = Date.parse(m.ts);
    if (!Number.isNaN(parsed)) return BigInt(parsed);
  }
  return null;
}

function stringField(msg: unknown, key: string): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const v = (msg as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Builds the raw ingest row for a frame.
 *
 * The payload is the VERBATIM message. The hash is over the exact bytes we
 * received, not over a re-serialisation, so it can later prove that an archived
 * object matches what the socket delivered.
 */
export function toRawIngestEvent(
  frame: RawFrame,
  sessionId: string,
  streamId: string | null,
  parseVersion = 1,
): RawIngestEvent {
  const env = frame.envelope;
  const messageType = env?.type ?? 'unparseable';
  const msg = env?.msg;

  return {
    sessionId,
    streamId,
    receivedAt: frame.receivedAt,
    receivedAtMs: BigInt(frame.receivedAtMs),
    recvMonotonicNs: frame.recvMonotonicNs,
    channel: channelForType(messageType),
    messageType,
    sid: env?.sid ?? null,
    seq: env?.seq === undefined || env.seq === null ? null : BigInt(env.seq),
    marketTicker: stringField(msg, 'market_ticker'),
    marketId: stringField(msg, 'market_id'),
    exchangeTsMs: exchangeTsMsOf(msg),
    payloadHash: sha256Bytes(frame.text),
    // Store the parsed JSON when available so the column is queryable; fall
    // back to wrapping the raw text so an unparseable frame is still kept.
    payload: env ?? { __unparseable: true, text: frame.text, error: frame.parseError },
    parseVersion,
  };
}
