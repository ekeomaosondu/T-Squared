import { Decimal } from '@/src/book/decimal';

/**
 * Canonical research event model.
 *
 * One normalized union that a strategy consumes identically in BACKTEST,
 * SHADOW, PAPER and LIVE. Nothing here refers to Parquet, DuckDB, Postgres or
 * a WebSocket: the whole point is that a strategy cannot tell where its events
 * came from.
 *
 * ---------------------------------------------------------------------------
 * On time
 * ---------------------------------------------------------------------------
 * Two clocks exist and they are NOT interchangeable:
 *
 *   exchangeTimeMs  stamped by Kalshi, null when the frame carried none
 *   receiveTimeMs   when the collector's socket handler saw the frame
 *
 * The specification for this module asked for `eventTimeMs: bigint`. That is
 * not implementable honestly, because Kalshi does not stamp every frame: a
 * non-nullable exchange time would have to be back-filled from receive time on
 * the frames that lack one, which is exactly the silent substitution the same
 * specification forbids two lines later. So exchange time is nullable and
 * receive time is separate and always present.
 *
 * The simulation clock advances on receiveTimeMs, because that is the only
 * instant at which the information could actually have reached a trader.
 * Ordering also uses receive-side authority. Exchange time is carried through
 * for latency studies and must never be used to order the stream -- it would
 * let a strategy act on a frame before it could have been received.
 */

export type ResearchEventKind =
  | 'book_snapshot'
  | 'book_delta'
  | 'trade'
  | 'market_lifecycle'
  | 'capture_gap'
  | 'timer';

export interface BaseResearchEvent {
  readonly kind: ResearchEventKind;

  /** Exchange-stamped time. Null means the frame carried none; never imputed. */
  readonly exchangeTimeMs: bigint | null;
  /** Collector receipt time. Always present; the simulation clock follows this. */
  readonly receiveTimeMs: bigint;

  /** Collector session. `ingestOrdinal` is only comparable within one. */
  readonly sessionId: string;
  /**
   * The collector's in-process observation counter, assigned synchronously at
   * socket receipt. Monotonic within a session, meaningless across sessions.
   * Null for events the collector did not observe as a distinct frame
   * (synthetic timers, capture gaps).
   */
  readonly ingestOrdinal: bigint | null;

  /** Exchange subscription that carried the frame. `seq` is scoped to it. */
  readonly streamId: string | null;
  /** Exchange sequence, per-subscription and restarting on every reconnect. */
  readonly seq: bigint | null;

  readonly seriesTicker?: string;
  readonly eventTicker?: string;
  readonly marketTicker?: string;
}

/** A price/size pair, both exact. */
export type Level = readonly [price: string, size: string];

/**
 * A full book state from the exchange.
 *
 * Only frames the exchange actually sent appear here: `ws_initial`,
 * `ws_recovery` and `session_handoff`. The collector's own 60-second
 * `local_materialized` samples are NOT events -- replaying them would inject
 * state the market never published, and their whole purpose is to be a
 * derived, verifiable check on the reconstruction rather than an input to it.
 */
export interface BookSnapshotEvent extends BaseResearchEvent {
  readonly kind: 'book_snapshot';
  readonly marketTicker: string;
  readonly source: 'ws_initial' | 'ws_recovery' | 'session_handoff';
  readonly yesBids: readonly Level[];
  readonly noBids: readonly Level[];
  /** The collector's SHA-256 of this state, for cross-checking replay. */
  readonly stateHash: string | null;
}

export interface BookDeltaEvent extends BaseResearchEvent {
  readonly kind: 'book_delta';
  readonly marketTicker: string;
  readonly side: 'yes' | 'no';
  readonly price: string;
  readonly deltaCount: string;
  /**
   * Displayed size at this level before and after the change, as the RECORDER
   * observed them. Carried through rather than recomputed because queue
   * modelling needs to distinguish volume that traded away from volume that
   * was withdrawn, and `post = pre + delta` is the invariant the silver
   * contract already enforces on every row.
   */
  readonly preCount: string | null;
  readonly postCount: string | null;
  /**
   * Whether the RECORDER applied this delta. A delta it rejected is replayed
   * as rejected: applying it here would invent a book the recorder never
   * believed in, and the divergence would be silent.
   */
  readonly applied: boolean;
  readonly applyError: string | null;
}

export interface TradeEvent extends BaseResearchEvent {
  readonly kind: 'trade';
  readonly marketTicker: string;
  readonly tradeId: string;
  readonly yesPrice: string;
  readonly noPrice: string;
  readonly count: string;
  /**
   * Which contract the AGGRESSOR bought.
   *
   *   'yes'  the taker bought YES, lifting the YES ask -- so a resting YES
   *          SELL at that price is what got hit
   *   'no'   the taker bought NO, which is selling YES into the YES bid -- so
   *          a resting YES BUY is what got hit
   *
   * Null when the recorder could not determine it. A null must never be
   * guessed: passive fill attribution depends entirely on this field, and
   * assuming a side would manufacture fills that never happened.
   *
   * This is Kalshi's `taker_outcome_side`, not `taker_book_side`. The latter
   * reports 'bid'/'ask' and, in this dataset, is perfectly correlated with the
   * former, so it adds no information while inviting a sign error.
   */
  readonly takerOutcomeSide: 'yes' | 'no' | null;
  /** Kalshi's raw `taker_book_side` ('bid'/'ask'), preserved unmapped. */
  readonly takerBookSide: string | null;
  readonly isBlockTrade: boolean;
}

export interface MarketLifecycleEvent extends BaseResearchEvent {
  readonly kind: 'market_lifecycle';
  readonly marketTicker: string;
  readonly status: string;
  readonly result: string | null;
}

/**
 * An interval during which NO collector was listening.
 *
 * Distinct from a sequence gap: there the exchange sent frames we missed, here
 * nobody was watching at all. Emitted at the instant coverage was lost, so a
 * strategy learns about it at the same point in the stream a live process
 * would have noticed its socket die.
 */
export interface CaptureGapEvent extends BaseResearchEvent {
  readonly kind: 'capture_gap';
  readonly gapId: string;
  readonly startedAtMs: bigint;
  /** Null while the gap is still open at the end of the dataset. */
  readonly endedAtMs: bigint | null;
  readonly reason: 'deploy' | 'restart' | 'crash' | 'shutdown' | 'unknown';
  readonly affectedMarkets: readonly string[];
}

/** A strategy-scheduled callback, materialized into the event queue. */
export interface TimerEvent extends BaseResearchEvent {
  readonly kind: 'timer';
  readonly timerId: number;
  readonly label: string;
}

export type ResearchEvent =
  | BookSnapshotEvent
  | BookDeltaEvent
  | TradeEvent
  | MarketLifecycleEvent
  | CaptureGapEvent
  | TimerEvent;

/** Events that carry a market ticker. */
export type MarketEvent = BookSnapshotEvent | BookDeltaEvent | TradeEvent | MarketLifecycleEvent;

export function isMarketEvent(e: ResearchEvent): e is MarketEvent {
  return (
    e.kind === 'book_snapshot' ||
    e.kind === 'book_delta' ||
    e.kind === 'trade' ||
    e.kind === 'market_lifecycle'
  );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Rank of an event kind within a single observation position.
 *
 * Deltas and trades precede a snapshot that shares their position. A snapshot
 * at sequence N already INCLUDES the delta at sequence N, so applying the
 * delta and then the snapshot is idempotent, while the reverse order would
 * apply the delta a second time on top of state that already contains it and
 * corrupt the book.
 */
const KIND_RANK: Record<ResearchEventKind, number> = {
  capture_gap: 0,
  market_lifecycle: 1,
  book_delta: 2,
  trade: 3,
  book_snapshot: 4,
  timer: 5,
};

/**
 * The position of an event in the collector's observation order.
 *
 * `sessionRank` and `streamRank` are dense ranks by FIRST OBSERVED TIME, never
 * by UUID. Both identifiers are random, so ordering by them interleaves the
 * streams of a reconnected session arbitrarily -- invisible with one stream
 * and catastrophic after a reconnect, which is a bug this dataset has already
 * produced once.
 */
export interface OrderKey {
  readonly sessionRank: number;
  readonly receiveTimeMs: bigint;
  readonly ingestOrdinal: bigint | null;
  readonly streamRank: number;
  readonly seq: bigint | null;
  readonly kindRank: number;
  /** Deterministic final tiebreak so the order is total, not merely stable. */
  readonly tiebreak: string;
}

export function orderKeyOf(
  e: ResearchEvent,
  sessionRank: number,
  streamRank: number,
  tiebreak: string,
): OrderKey {
  return {
    sessionRank,
    receiveTimeMs: e.receiveTimeMs,
    ingestOrdinal: e.ingestOrdinal,
    streamRank,
    seq: e.seq,
    kindRank: KIND_RANK[e.kind],
    tiebreak,
  };
}

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Total order over observation positions.
 *
 *   1. session, by when the session began
 *   2. collector receive time
 *   3. ingest ordinal -- the collector's own observation counter
 *   4. stream, by when the stream began
 *   5. exchange sequence, within a stream
 *   6. event kind
 *   7. a stable identifier
 *
 * Steps 2 and 3 never disagree: both are assigned in the same synchronous
 * block at socket receipt, the ordinal first. Step 3 is skipped when either
 * side lacks an ordinal, which happens for snapshots and synthetic events.
 */
export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  if (a.sessionRank !== b.sessionRank) return a.sessionRank - b.sessionRank;

  const t = cmpBig(a.receiveTimeMs, b.receiveTimeMs);
  if (t !== 0) return t;

  if (a.ingestOrdinal !== null && b.ingestOrdinal !== null) {
    const o = cmpBig(a.ingestOrdinal, b.ingestOrdinal);
    if (o !== 0) return o;
  }

  if (a.streamRank !== b.streamRank) return a.streamRank - b.streamRank;

  if (a.seq !== null && b.seq !== null) {
    const s = cmpBig(a.seq, b.seq);
    if (s !== 0) return s;
  }

  if (a.kindRank !== b.kindRank) return a.kindRank - b.kindRank;

  return a.tiebreak < b.tiebreak ? -1 : a.tiebreak > b.tiebreak ? 1 : 0;
}

/** An event together with the position at which it was observed. */
export interface PositionedEvent {
  readonly key: OrderKey;
  readonly event: ResearchEvent;
}

// ---------------------------------------------------------------------------
// Small helpers shared by the engine and the strategies
// ---------------------------------------------------------------------------

export function tradePriceForSide(e: TradeEvent, side: 'yes' | 'no'): Decimal {
  return new Decimal(side === 'yes' ? e.yesPrice : e.noPrice);
}
