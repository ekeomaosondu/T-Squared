import { Decimal, D, ZERO, type DecimalInput } from '@/src/book/decimal';
import type { TwoSidedBbo } from '@/src/research/engine/marketState';
import type { MarketState, StrategyContext } from '@/src/research/strategy/context';
import {
  QuotingStrategy,
  type DesiredQuote,
  type QuotingParams,
} from '@/src/research/strategies/quotingStrategy';

/**
 * Strategy C: join the BBO, then lean against inventory.
 *
 * As a long position grows, the bid steps back and the offer steps forward, so
 * the quote that would add MORE length becomes less attractive and the one
 * that would reduce it becomes more attractive. Short inventory does the
 * mirror image.
 *
 *     skewCents = round( maxSkewCents * clamp(position / maxInventory, -1, 1) )
 *
 * Deliberately deterministic and linear. An Avellaneda-Stoikov reservation
 * price would be the sophisticated version, but it introduces a risk-aversion
 * parameter and a time-to-horizon term, and neither can be fitted before we
 * know what the simple version does. The linear skew is the control that makes
 * the sophisticated one worth measuring against.
 *
 * The expected effect is fewer fills and lower gross edge in exchange for
 * smaller mean inventory. Whether that is a good trade is exactly what the
 * comparison table is for.
 */
export interface InventorySkewParams extends QuotingParams {
  /** Maximum one-sided step, in cents, reached at full inventory. */
  maxSkewCents: number;
  /** Widen instead of shifting: also step the reducing side inward. */
  symmetric: boolean;
  /** Inventory at which the skew saturates. Defaults to maxInventory. */
  skewReferenceInventory?: DecimalInput;
}

export const INVENTORY_SKEW_DEFAULTS: Pick<InventorySkewParams, 'maxSkewCents' | 'symmetric'> = {
  maxSkewCents: 2,
  symmetric: true,
};

export class InventorySkewMakerStrategy extends QuotingStrategy {
  readonly name = 'inventory-skew-maker';
  readonly version = '1';

  private readonly skew: { maxSkewCents: number; symmetric: boolean; reference: Decimal };

  constructor(params: Partial<InventorySkewParams> = {}) {
    super(params);
    this.skew = {
      maxSkewCents: params.maxSkewCents ?? INVENTORY_SKEW_DEFAULTS.maxSkewCents,
      symmetric: params.symmetric ?? INVENTORY_SKEW_DEFAULTS.symmetric,
      reference: D(params.skewReferenceInventory ?? this.params.maxInventory),
    };
  }

  protected extraParameters(): Record<string, unknown> {
    return {
      maxSkewCents: this.skew.maxSkewCents,
      symmetric: this.skew.symmetric,
      skewReferenceInventory: this.skew.reference.toString(),
    };
  }

  protected desiredQuotes(
    state: MarketState,
    bbo: TwoSidedBbo,
    ctx: StrategyContext,
  ): DesiredQuote {
    const position = ctx.position(state.ticker);
    const reference = this.skew.reference;

    let ratio = ZERO;
    if (reference.gt(0)) {
      ratio = position.div(reference);
      if (ratio.gt(1)) ratio = D(1);
      if (ratio.lt(-1)) ratio = D(-1);
    }

    // Whole cents: Kalshi's tick. A fractional-cent skew would be rounded away
    // by the exchange and the strategy would believe in a step it never took.
    const stepCents = new Decimal(ratio.mul(this.skew.maxSkewCents).toFixed(0));
    const step = stepCents.abs().div(100);

    let bid: Decimal | null = bbo.bid;
    let ask: Decimal | null = bbo.ask;

    if (stepCents.isPositive()) {
      // Long: make the bid less attractive, the offer more attractive.
      bid = bid.minus(step);
      if (this.skew.symmetric) ask = ask.minus(step);
    } else if (stepCents.isNegative()) {
      // Short: mirror image.
      ask = ask.plus(step);
      if (this.skew.symmetric) bid = bid.plus(step);
    }

    // Never cross our own quotes past each other, and never quote through the
    // touch on the aggressive side -- that would be a taker order wearing a
    // maker's clothes, and it would show up as spurious "maker" fills.
    if (bid !== null && bid.gte(bbo.ask)) bid = null;
    if (ask !== null && ask.lte(bbo.bid)) ask = null;

    return {
      bid: bid === null ? null : this.clampPrice(this.toCentGrid(bid, 'down')),
      ask: ask === null ? null : this.clampPrice(this.toCentGrid(ask, 'up')),
    };
  }
}
