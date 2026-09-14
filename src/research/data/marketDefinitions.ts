import { Decimal, D } from '@/src/book/decimal';

/**
 * What the exchange says a market IS, and how it ended.
 *
 * Settlement is the difference between a backtest that reports a result and
 * one that reports a mark. A binary contract does not end at the last mid; it
 * ends at exactly $0 or $1, decided by an authority outside the order book.
 * Until that authority speaks, the position's value is genuinely unknown, and
 * the honest report says which of those two situations it is in.
 */

/**
 * Where a market stands.
 *
 * The specification for this module named four states. There are five: `VOIDED`
 * is real -- Kalshi cancels markets -- and folding it into either determined
 * state would book a payout that never happened, while folding it into
 * `CLOSED_UNDETERMINED` would leave a position outstanding forever that in
 * fact resolved at cost.
 */
export type MarketLifecycleState =
  | 'OPEN'
  | 'CLOSED_UNDETERMINED'
  | 'DETERMINED_YES'
  | 'DETERMINED_NO'
  | 'VOIDED';

/** How a determination was established. Recorded so a result can be audited. */
export type SettlementBasis =
  /** `settlement_value` from the exchange, the most direct statement. */
  | 'settlement_value'
  /** `result` from the exchange, mapped to a payout. */
  | 'result'
  /** Not determined. */
  | 'none';

export interface HistoricalMarketState {
  marketTicker: string;
  eventTicker: string | null;
  seriesTicker: string | null;

  state: MarketLifecycleState;
  /** Kalshi's own `status` string, preserved unmapped. */
  rawStatus: string | null;
  /** Kalshi's own `result` string, preserved unmapped. */
  rawResult: string | null;

  /** Payout per YES contract in dollars: 1, 0, or null when undetermined. */
  yesSettlementValue: Decimal | null;
  settlementBasis: SettlementBasis;
  /** Contract payout unit. Exchange-supplied; never assumed to be 1. */
  notionalValue: Decimal | null;
  /**
   * A provisional determination can still change. Settling on one produces a
   * result that may be revised, so it is recorded and surfaced rather than
   * treated as final.
   */
  isProvisional: boolean;

  closeTimeMs: bigint | null;
  settlementTimeMs: bigint | null;
  /** When the recorder first observed this state. Provenance, not authority. */
  observedAtMs: bigint | null;

  strikeType: string | null;
  floorStrike: Decimal | null;
  capStrike: Decimal | null;

  /** Per-series fee treatment, as the exchange reports it. */
  feeType: string | null;
  feeMultiplier: Decimal | null;
  /** When the series metadata carrying the fee treatment was last updated. */
  feeUpdatedAtMs: bigint | null;
  settlementSources: string[];
}

/**
 * Maps Kalshi's status and result onto a lifecycle state.
 *
 * Deliberately conservative. An unrecognised status is OPEN rather than
 * assumed terminal, and an unrecognised result leaves the market undetermined
 * rather than guessing a side. The cost of being wrong here is a fabricated
 * dollar per contract.
 */
export function resolveLifecycleState(
  status: string | null,
  result: string | null,
): MarketLifecycleState {
  const r = (result ?? '').trim().toLowerCase();
  const s = (status ?? '').trim().toLowerCase();

  if (r === 'yes') return 'DETERMINED_YES';
  if (r === 'no') return 'DETERMINED_NO';
  if (r === 'void' || r === 'voided' || r === 'cancelled' || r === 'canceled') return 'VOIDED';

  // A market can be settled or finalized while the result string is still
  // absent from the payload we happen to hold. That is undetermined DATA, not
  // an undetermined MARKET, and the two must not be conflated -- but neither
  // can we invent the side.
  if (s === 'closed' || s === 'determined' || s === 'settled' || s === 'finalized') {
    return 'CLOSED_UNDETERMINED';
  }
  return 'OPEN';
}

export function isDetermined(state: MarketLifecycleState): boolean {
  return state === 'DETERMINED_YES' || state === 'DETERMINED_NO' || state === 'VOIDED';
}

/**
 * The payout of one YES contract, in dollars.
 *
 * Prefers the exchange's own `settlement_value` over an inference from
 * `result`: it is the number Kalshi actually paid, it survives unusual
 * outcomes that the two-valued result string cannot express, and it is
 * denominated in the contract's own notional rather than in an assumed dollar.
 */
export function yesPayout(
  state: MarketLifecycleState,
  settlementValue: Decimal | null,
  notionalValue: Decimal | null,
): { value: Decimal | null; basis: SettlementBasis } {
  if (settlementValue !== null) {
    const notional = notionalValue ?? D(1);
    if (notional.isZero()) return { value: null, basis: 'none' };
    // Normalised to a 0..1 payout so the rest of the system stays in
    // probability space regardless of the contract's notional.
    return { value: settlementValue.div(notional), basis: 'settlement_value' };
  }
  if (state === 'DETERMINED_YES') return { value: D(1), basis: 'result' };
  if (state === 'DETERMINED_NO') return { value: D(0), basis: 'result' };
  return { value: null, basis: 'none' };
}
