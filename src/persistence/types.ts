/**
 * Row shapes handed to the batch writer.
 *
 * These mirror the SQL tables rather than the Kalshi wire format: parsing and
 * storage stay separate so a wire-format change does not ripple into the
 * persistence layer.
 */

export interface RawIngestEvent {
  sessionId: string;
  streamId?: string | null;

  /**
   * In-process counter assigned synchronously at socket receipt, before any
   * asynchronous work. Records the order this process OBSERVED frames.
   * Monotonic within a session; meaningless across sessions.
   *
   * `id` is provenance identity assigned at flush time and must never be used
   * for ordering.
   */
  ingestOrdinal: bigint;

  receivedAt: Date;
  receivedAtMs: bigint;
  recvMonotonicNs: bigint;

  channel?: string | null;
  messageType: string;

  sid?: number | null;
  seq?: bigint | null;

  marketTicker?: string | null;
  marketId?: string | null;

  exchangeTsMs?: bigint | null;

  /** SHA-256 of the raw frame, 32 raw bytes. */
  payloadHash: Buffer;
  /** The verbatim Kalshi message. */
  payload: unknown;

  parseVersion: number;
}

/** Tables the writer can batch into. */
export type NormalizedTable =
  | 'orderbook_deltas'
  | 'orderbook_snapshots'
  | 'public_trades'
  | 'ticker_updates'
  | 'market_lifecycle_events'
  | 'sequence_gaps'
  | 'integrity_events'
  | 'book_validations'
  | 'book_samples'
  | 'event_ladder_sample_groups'
  | 'event_ladder_samples'
  | 'orderflow_windows'
  | 'user_order_updates'
  | 'user_fills'
  | 'external_observations';

export interface NormalizedRow {
  table: NormalizedTable;
  /** Column name -> value, using SQL column names verbatim. */
  values: Record<string, unknown>;
  /**
   * When true, `raw_event_id` and `raw_event_received_at` are populated from
   * the raw event this row was derived from, after the raw insert returns ids.
   */
  linkRawEvent?: boolean;
}

/**
 * One message's worth of work: the raw capture plus everything normalised out
 * of it. The pair is written in a single transaction so a normalised row can
 * never exist without its raw provenance.
 */
export interface IngestUnit {
  raw: RawIngestEvent;
  normalized: NormalizedRow[];
}

export interface FlushStats {
  batches: number;
  rawRows: number;
  normalizedRows: number;
  durationMs: number;
  errors: number;
}
