import { Decimal, D, type DecimalInput } from '@/src/book/decimal';
import type { TwoSidedBbo } from '@/src/research/engine/marketState';
import type { MarketState, StrategyContext } from '@/src/research/strategy/context';
import {
  QuotingStrategy,
  type DesiredQuote,
  type QuotingParams,
} from '@/src/research/strategies/quotingStrategy';

/**
 * Strategy B: quote only the side that top-of-book imbalance favours.
 *
 *     I_k = (B_k - A_k) / (B_k + A_k)
 *
 * over the best k levels. Positive means more size resting on the bid, which
 * is conventionally read as buying pressure -- the next trade is more likely
 * to lift the offer than hit the bid.
 *
 * For a MAKER that reads as: when I_k is strongly positive, a resting bid is
 * relatively safe (the buyers are unlikely to sell into me) while a resting
 * offer is likely to be lifted by informed flow. So the policy is to keep the
 * quote on the favoured side and withdraw the other.
 *
 * The opposite reading is also defensible -- imbalance predicts the next MOVE,
 * so quoting into it is exactly how a maker gets run over -- which is why the
 * direction is a PARAMETER. `policy: 'quote_favoured'` keeps the side the
 * imbalance supports; `'quote_against'` inverts it; `'skew'` keeps both quotes
 * but steps the disfavoured one back. Running all three is how the question
 * gets answered from data instead of from folklore.
 */
export type ImbalancePolicy = 'quote_favoured' | 'quote_against' | 'skew';

export interface ImbalanceParams extends QuotingParams {
  /** Depth levels included in the imbalance. */
  k: number;
  /** |I_k| above which the filter engages. */
  threshold: DecimalInput;
  policy: ImbalancePolicy;
  /** Cents to step back the disfavoured quote under the `skew` policy. */
  skewCents: number;
}

export const IMBALANCE_DEFAULTS: Pick<ImbalanceParams, 'k' | 'threshold' | 'policy' | 'skewCents'> = {
  k: 3,
  threshold: '0.2',
  policy: 'quote_favoured',
  skewCents: 1,
};

export class ImbalanceMakerStrategy extends QuotingStrategy {
  readonly name = 'imbalance-maker';
  readonly version = '1';

  private readonly imbalance: typeof IMBALANCE_DEFAULTS;

  constructor(params: Partial<ImbalanceParams> = {}) {
    super(params);
    this.imbalance = {
      k: params.k ?? IMBALANCE_DEFAULTS.k,
      threshold: params.threshold ?? IMBALANCE_DEFAULTS.threshold,
      policy: params.policy ?? IMBALANCE_DEFAULTS.policy,
      skewCents: params.skewCents ?? IMBALANCE_DEFAULTS.skewCents,
    };
  }

  protected extraParameters(): Record<string, unknown> {
    return {
      k: this.imbalance.k,
      threshold: D(this.imbalance.threshold).toString(),
      policy: this.imbalance.policy,
      skewCents: this.imbalance.skewCents,
    };
  }

  protected desiredQuotes(
    state: MarketState,
    bbo: TwoSidedBbo,
    _ctx: StrategyContext,
  ): DesiredQuote {
    const bid = this.clampPrice(bbo.bid);
    const ask = this.clampPrice(bbo.ask);

    const imbalance: Decimal | null = state.book.imbalance(this.imbalance.k);
    // A zero denominator yields null, never zero. "No size on either side" is
    // not "perfectly balanced", and treating it as balanced would have the
    // strategy quoting both sides of an empty book.
    if (imbalance === null) return { bid: null, ask: null };

    const threshold = D(this.imbalance.threshold);
    if (imbalance.abs().lt(threshold)) return { bid, ask };

    const bidFavoured = imbalance.isPositive();

    switch (this.imbalance.policy) {
      case 'quote_favoured':
        return bidFavoured ? { bid, ask: null } : { bid: null, ask };
      case 'quote_against':
        return bidFavoured ? { bid: null, ask } : { bid, ask: null };
      case 'skew': {
        const step = D(this.imbalance.skewCents).div(100);
        return bidFavoured
          ? { bid, ask: ask === null ? null : this.clampPrice(ask.plus(step)) }
          : { bid: bid === null ? null : this.clampPrice(bid.minus(step)), ask };
      }
    }
  }
}
