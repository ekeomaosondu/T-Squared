import { Decimal, D, ZERO } from '@/src/book/decimal';
import type { BookView } from '@/src/research/engine/marketState';
import type { HistoricalMarketState } from '@/src/research/data/marketDefinitions';
import type { CalibrationEnvelope } from '@/src/research/calibration/riskEnvelope';

/**
 * Chooses which market to probe next.
 *
 * The instinct is to probe the most liquid contract, because that is where a
 * fill is most likely. That instinct would ruin the dataset. A queue model
 * fitted only to deep, busy books learns the behaviour of deep, busy books,
 * and the strategies we care about quote across a whole ladder of strikes with
 * wildly different depth.
 *
 * So eligible markets are classified into depth and flow strata and the
 * selector ROTATES, preferring whichever stratum it has sampled least. That
 * deliberately gives up fill rate in exchange for coverage, which is the right
 * trade when the output is a model rather than a profit.
 */

export type DepthStratum = 'low_depth' | 'high_depth';
export type FlowStratum = 'low_flow' | 'high_flow';

export interface StratumKey {
  depth: DepthStratum;
  flow: FlowStratum;
}

export interface EligibilityInput {
  marketTicker: string;
  seriesTicker: string;
  book: BookView | undefined;
  state: HistoricalMarketState | undefined;
  /** Trades seen at this market over the recent window. */
  recentTrades: number;
  /** Book deltas seen over the recent window. */
  recentDeltas: number;
  nowMs: number;
}

export type IneligibleReason =
  | 'no_book'
  | 'book_invalid'
  | 'not_two_sided'
  | 'mid_out_of_band'
  | 'too_close_to_close'
  | 'not_active'
  | 'no_recent_activity'
  | 'no_touch_size';

export interface Eligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  mid?: Decimal;
  touchDepth?: Decimal;
  stratum?: StratumKey;
}

/** Contracts at the touch above which a level counts as deep. */
export const DEPTH_SPLIT = 100;
/** Trades in the recent window above which a market counts as busy. */
export const FLOW_SPLIT = 3;
/** How much recent book activity counts as "alive at all". */
export const MIN_RECENT_DELTAS = 5;

export function classify(touchDepth: Decimal, recentTrades: number): StratumKey {
  return {
    depth: touchDepth.gte(DEPTH_SPLIT) ? 'high_depth' : 'low_depth',
    flow: recentTrades >= FLOW_SPLIT ? 'high_flow' : 'low_flow',
  };
}

export function stratumId(key: StratumKey): string {
  return `${key.depth}/${key.flow}`;
}

export const ALL_STRATA: StratumKey[] = [
  { depth: 'low_depth', flow: 'low_flow' },
  { depth: 'low_depth', flow: 'high_flow' },
  { depth: 'high_depth', flow: 'low_flow' },
  { depth: 'high_depth', flow: 'high_flow' },
];

/**
 * Is this market safe and useful to probe right now?
 *
 * Every rejection is named. A run that placed three probes in an hour is only
 * interpretable next to the reasons it declined the rest, so the reason is
 * carried out rather than folded into a boolean.
 */
export function assessEligibility(
  input: EligibilityInput,
  envelope: CalibrationEnvelope,
): Eligibility {
  const { book, state } = input;

  if (!book) return { eligible: false, reason: 'no_book' };
  // Never probe against a book we cannot vouch for. During a gap or before a
  // seed the price we would join is fiction.
  if (!book.valid) return { eligible: false, reason: 'book_invalid' };

  if (state && state.state !== 'OPEN') return { eligible: false, reason: 'not_active' };

  const bbo = book.bbo();
  if (bbo.bid === null || bbo.ask === null || bbo.mid === null) {
    return { eligible: false, reason: 'not_two_sided' };
  }
  if (bbo.bidSize === null || bbo.ask === null || bbo.bidSize.lte(0)) {
    return { eligible: false, reason: 'no_touch_size' };
  }

  // The tails behave differently enough -- wider ticks relative to price, much
  // thinner books -- that mixing them in would confound the fit.
  if (bbo.mid.lt(D(envelope.minMid)) || bbo.mid.gt(D(envelope.maxMid))) {
    return { eligible: false, reason: 'mid_out_of_band', mid: bbo.mid };
  }

  // Close to expiry the book thins and the exchange's own behaviour changes.
  if (state?.closeTimeMs !== null && state?.closeTimeMs !== undefined) {
    const msToClose = Number(state.closeTimeMs) - input.nowMs;
    if (msToClose < envelope.minMsToClose) {
      return { eligible: false, reason: 'too_close_to_close', mid: bbo.mid };
    }
  }

  // A market nothing is happening in produces a censored observation with no
  // information in it: the queue never moves and we learn nothing about why.
  if (input.recentDeltas < MIN_RECENT_DELTAS) {
    return { eligible: false, reason: 'no_recent_activity', mid: bbo.mid };
  }

  const touchDepth = (bbo.bidSize ?? ZERO).plus(bbo.askSize ?? ZERO);
  return {
    eligible: true,
    mid: bbo.mid,
    touchDepth,
    stratum: classify(touchDepth, input.recentTrades),
  };
}

export interface Candidate {
  marketTicker: string;
  seriesTicker: string;
  stratum: StratumKey;
  mid: Decimal;
  touchDepth: Decimal;
  /** Times the touch MOVED in the recent window. */
  bboChanges: number;
}

/**
 * Picks the next market, preferring the least-sampled stratum.
 *
 * Ties are broken by a supplied random draw rather than by ticker order, so a
 * long run does not silently favour whichever strike happens to sort first.
 */
export function selectNext(
  candidates: readonly Candidate[],
  sampledByStratum: ReadonlyMap<string, number>,
  random: () => number,
  opts: { preferChurn?: boolean } = {},
): Candidate | null {
  if (candidates.length === 0) return null;

  let bestCount = Number.POSITIVE_INFINITY;
  let pool: Candidate[] = [];
  for (const candidate of candidates) {
    const count = sampledByStratum.get(stratumId(candidate.stratum)) ?? 0;
    if (count < bestCount) {
      bestCount = count;
      pool = [candidate];
    } else if (count === bestCount) {
      pool.push(candidate);
    }
  }

  // Stratum rotation still comes first; churn only breaks the tie WITHIN the
  // least-sampled stratum. Letting it override the rotation would trade one
  // selection bias for another.
  if (opts.preferChurn && pool.length > 1) {
    const most = Math.max(...pool.map((c) => c.bboChanges));
    if (most > 0) pool = pool.filter((c) => c.bboChanges === most);
  }

  return pool[Math.floor(random() * pool.length)] ?? null;
}

/** Dwell times, in milliseconds. Randomised so duration is not confounded. */
export const DWELL_CHOICES_MS = [10_000, 30_000, 60_000, 120_000] as const;

export function chooseDwellMs(random: () => number): number {
  return DWELL_CHOICES_MS[Math.floor(random() * DWELL_CHOICES_MS.length)]!;
}

/**
 * Bid or ask, by coin flip.
 *
 * Emphatically not "whichever side looks more likely to fill". Choosing the
 * side we expect to trade is how a calibration dataset ends up describing the
 * conditions under which we chose easy fills rather than the queue.
 */
export function chooseSide(random: () => number): 'bid' | 'ask' {
  return random() < 0.5 ? 'bid' : 'ask';
}
