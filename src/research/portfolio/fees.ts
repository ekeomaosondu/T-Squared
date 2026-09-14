import { Decimal, D, ONE, ZERO } from '@/src/book/decimal';
import type { HistoricalMarketState } from '@/src/research/data/marketDefinitions';
import {
  scheduleFor,
  type FeeScheduleEntry,
  type FeeScheduleFile,
} from '@/src/research/portfolio/feeSchedule';

/**
 * Trading fees, resolved per market from what the exchange actually said.
 *
 * Kalshi's general trading fee is quadratic in price rather than linear in
 * notional:
 *
 *     fee = ceil_to_cents( rate * multiplier * contracts * P * (1 - P) )
 *
 * That shape matters for a market maker. The fee peaks at 50c and falls to
 * almost nothing in the tails, so the same half-cent spread is profitable on a
 * 5c contract and a loss on a 50c one. A flat basis-point model -- the obvious
 * thing to reach for from equities -- gets the sign of that effect wrong and
 * would send a study looking for edge in exactly the wrong strikes.
 *
 * ---------------------------------------------------------------------------
 * What is known, and what is asserted
 * ---------------------------------------------------------------------------
 * The API supplies, per series, `fee_type` and `fee_multiplier`, and the
 * recorder captures both with the timestamp of the metadata that carried them.
 * It does NOT supply the coefficient, and it does not say whether the series
 * charges a maker fee. Kalshi's documentation is explicit that some markets
 * have maker fees and some do not.
 *
 * So the coefficient and the maker fee come from `config/feeSchedule.json`,
 * where a human asserts them with a source and a date. Until that entry is
 * marked verified, a fill's fee is UNKNOWN -- not zero. An unknown fee
 * propagates: the run reports `feeVerified: false` and net PnL as N/A, because
 * quietly assuming zero produces a number that looks like a result.
 *
 * Market-maker programme rebates are deliberately not part of this. They are a
 * property of the participant rather than of the market, and reporting
 * ordinary-member economics and hypothetical market-maker economics as the
 * same figure would overstate the second.
 */

export type Liquidity = 'maker' | 'taker';

export interface FeeContext {
  marketTicker: string;
  quantity: Decimal;
  /** Execution price in YES terms, 0..1. */
  yesPrice: Decimal;
  liquidity: Liquidity;
  /** The exchange's own record for this market, when the lake has one. */
  market: HistoricalMarketState | undefined;
  /** When the fill happened, for selecting the schedule then in force. */
  atMs: bigint;
}

/**
 * A fee, and whether we actually know it.
 *
 * `known: false` is not "zero". It means the run cannot state a net figure for
 * this fill, and the summary must degrade accordingly rather than round the
 * gap down to nothing.
 */
export interface FeeOutcome {
  amount: Decimal;
  known: boolean;
  reason?: string;
}

export interface FeeProvenance {
  model: string;
  /** True only if every fee applied in the run came from a verified source. */
  verified: boolean;
  source: string | null;
  feeType: string | null;
  feeMultiplier: string | null;
  baseRate: string | null;
  makerFeePerContract: string | null;
  effectiveAt: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  /** Distinct reasons a fee could not be verified, for the run summary. */
  unverifiedReasons: string[];
  /** Markets whose fee could not be resolved at all. */
  unresolvedMarkets: string[];
  makerRebateApplied: boolean;
}

export interface FeeModel {
  readonly name: string;
  fee(ctx: FeeContext): FeeOutcome;
  provenance(): FeeProvenance;
}

/**
 * Resolves each market's fee from its own series metadata plus the asserted
 * schedule for that fee type.
 */
export class KalshiHistoricalFeeModel implements FeeModel {
  readonly name = 'kalshi_historical';

  private readonly seen = new Map<string, FeeScheduleEntry | null>();
  private readonly reasons = new Set<string>();
  private readonly unresolved = new Set<string>();
  private anyUnverified = false;
  private lastEntry: FeeScheduleEntry | null = null;
  private lastFeeType: string | null = null;
  private lastMultiplier: Decimal | null = null;

  constructor(private readonly schedule: FeeScheduleFile) {}

  fee(ctx: FeeContext): FeeOutcome {
    const market = ctx.market;

    if (!market) {
      this.unresolved.add(ctx.marketTicker);
      this.reasons.add('no market_state record in the lake for this market');
      this.anyUnverified = true;
      return { amount: ZERO, known: false, reason: 'market_state_missing' };
    }
    if (!market.feeType) {
      this.unresolved.add(ctx.marketTicker);
      this.reasons.add('the exchange reported no fee_type for this series');
      this.anyUnverified = true;
      return { amount: ZERO, known: false, reason: 'fee_type_missing' };
    }

    const key = `${market.feeType}@${market.feeUpdatedAtMs ?? 'null'}`;
    let entry = this.seen.get(key);
    if (entry === undefined) {
      entry = scheduleFor(this.schedule, market.feeType, ctx.atMs);
      this.seen.set(key, entry);
    }

    if (!entry) {
      this.unresolved.add(ctx.marketTicker);
      this.reasons.add(
        `no schedule entry for fee_type "${market.feeType}" in config/feeSchedule.json`,
      );
      this.anyUnverified = true;
      return { amount: ZERO, known: false, reason: 'schedule_entry_missing' };
    }

    this.lastEntry = entry;
    this.lastFeeType = market.feeType;
    this.lastMultiplier = market.feeMultiplier;

    if (!entry.verified) {
      this.reasons.add(
        `schedule entry for "${entry.feeType}" is not marked verified (source ${entry.source})`,
      );
      this.anyUnverified = true;
      return { amount: ZERO, known: false, reason: 'schedule_entry_unverified' };
    }

    const multiplier = market.feeMultiplier ?? ONE;
    const raw =
      ctx.liquidity === 'taker'
        ? D(entry.baseRate)
            .mul(multiplier)
            .mul(ctx.quantity)
            .mul(ctx.yesPrice)
            .mul(ONE.minus(ctx.yesPrice))
        : D(entry.makerFeePerContract).mul(ctx.quantity);

    if (raw.lte(0)) return { amount: ZERO, known: true };
    const amount = entry.roundUpToCents ? raw.mul(100).ceil().div(100) : raw;
    return { amount, known: true };
  }

  provenance(): FeeProvenance {
    const entry = this.lastEntry;
    return {
      model: this.name,
      verified: !this.anyUnverified && entry !== null,
      source: entry?.source ?? null,
      feeType: this.lastFeeType,
      feeMultiplier: this.lastMultiplier?.toString() ?? null,
      baseRate: entry?.baseRate ?? null,
      makerFeePerContract: entry?.makerFeePerContract ?? null,
      effectiveAt: entry?.effectiveFrom ?? null,
      verifiedBy: entry?.verifiedBy ?? null,
      verifiedAt: entry?.verifiedAt ?? null,
      unverifiedReasons: [...this.reasons].sort(),
      unresolvedMarkets: [...this.unresolved].sort().slice(0, 20),
      makerRebateApplied: false,
    };
  }
}

/**
 * Exactly zero, and KNOWN to be zero.
 *
 * A deliberate counterfactual for isolating the effect of fees, not a stand-in
 * for an unknown one. Marked verified precisely so it cannot be confused with
 * the unresolved case, which reports a fee of zero and `known: false`.
 */
export class ZeroFeeModel implements FeeModel {
  readonly name = 'zero';
  fee(): FeeOutcome {
    return { amount: ZERO, known: true };
  }
  provenance(): FeeProvenance {
    return {
      model: 'zero',
      verified: true,
      source: 'deliberate counterfactual: fees excluded from this run',
      feeType: null,
      feeMultiplier: null,
      baseRate: '0',
      makerFeePerContract: '0',
      effectiveAt: null,
      verifiedBy: null,
      verifiedAt: null,
      unverifiedReasons: [],
      unresolvedMarkets: [],
      makerRebateApplied: false,
    };
  }
}
