import type { TwoSidedBbo } from '@/src/research/engine/marketState';
import type { MarketState, StrategyContext } from '@/src/research/strategy/context';
import {
  QuotingStrategy,
  type DesiredQuote,
  type QuotingParams,
} from '@/src/research/strategies/quotingStrategy';

/**
 * Strategy A: join the BBO.
 *
 * Bid at the best bid, offer at the best ask, reprice when either moves. No
 * signal, no skew, no opinion about direction.
 *
 * This is the baseline every other strategy must beat, and it is deliberately
 * the dumbest thing that is still a market maker. Its job in the comparison is
 * to establish what the fill model, the latency assumption and the fee
 * schedule do on their own, so that a cleverer strategy's numbers can be read
 * as the effect of the cleverness rather than of the environment.
 *
 * Expect it to be adversely selected. That is the finding, not a bug: joining
 * the touch with no view means trading with whoever knows the price is about
 * to move.
 */
export class JoinBboStrategy extends QuotingStrategy {
  readonly name = 'join-bbo';
  readonly version = '1';

  constructor(params: Partial<QuotingParams> = {}) {
    super(params);
  }

  protected desiredQuotes(
    _state: MarketState,
    bbo: TwoSidedBbo,
    _ctx: StrategyContext,
  ): DesiredQuote {
    return { bid: this.clampPrice(bbo.bid), ask: this.clampPrice(bbo.ask) };
  }
}
