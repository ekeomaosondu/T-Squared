import { Decimal, ZERO } from '@/src/book/decimal';

/**
 * Passive fill modelling.
 *
 * Kalshi publishes market-by-PRICE data: we see the total size resting at each
 * price, never the individual orders or their order in the queue. So when a
 * simulated resting order fills is genuinely unknown, and any single answer is
 * a modelling choice rather than a fact.
 *
 * The response is to make the choice explicit and to run every study under at
 * least two of them. If a conclusion survives both the optimistic and the
 * conservative model, it is about the strategy. If it does not, it is about
 * the fill assumption, and the honest report says so.
 *
 * ABSOLUTE simulated PnL from any of these must not be presented as ground
 * truth until the queue model has been calibrated against real Kalshi fills
 * and observed queue positions. Until then the trustworthy outputs are
 * relative comparisons and post-fill markouts.
 */

export type FillReason =
  | 'cross'
  | 'trade_through'
  | 'queue_depleted'
  | 'probabilistic_queue'
  /** The optimistic baseline: filled because a trade printed at our price. */
  | 'touch';

/**
 * Everything the model knows about one resting order's position in its queue.
 *
 * Sizes are in contracts and exact. `queueAhead` is an ESTIMATE and is named
 * so: it is the model's belief about how much volume must trade or leave
 * before this order is at the front.
 */
export interface QueueState {
  /** Displayed size at the level when the order reached the exchange. */
  displayedSizeAtEntry: Decimal;
  /** Estimated volume ahead of us at entry. */
  queueAheadAtEntry: Decimal;
  /** Current estimate. Never negative. */
  queueAhead: Decimal;
  /** Volume that has traded at this price since the order rested. */
  executedVolumeAtLevel: Decimal;
  /** Most recent displayed size seen at the level. */
  lastDisplayedSize: Decimal;
  /** When the order joined the level. */
  restedAtMs: bigint;
  /** Trades observed at the level since resting. */
  tradeCount: number;
  /**
   * Traded volume not yet reconciled against a displayed-size decrease.
   *
   * A trade removes size from the level, so the delta that follows it is not
   * evidence of a cancellation. Without this counter the same volume would be
   * credited twice -- once as a trade and once as a cancellation -- and every
   * queue estimate would drain about twice as fast as reality.
   */
  unreconciledTradeVolume: Decimal;
}

export function newQueueState(displayedSize: Decimal, queueAhead: Decimal, atMs: bigint): QueueState {
  return {
    displayedSizeAtEntry: displayedSize,
    queueAheadAtEntry: queueAhead,
    queueAhead,
    executedVolumeAtLevel: ZERO,
    lastDisplayedSize: displayedSize,
    restedAtMs: atMs,
    tradeCount: 0,
    unreconciledTradeVolume: ZERO,
  };
}

export interface TradeFillResult {
  /** How much of `remaining` fills. */
  filled: Decimal;
  reason: FillReason;
}

export interface FillModel {
  readonly name: string;
  describe(): Record<string, unknown>;

  /** Volume assumed to be ahead of an order joining a level of this size. */
  initialQueueAhead(displayedSize: Decimal): Decimal;

  /** The displayed size at the order's level changed. */
  onDisplayedSizeChange(state: QueueState, previous: Decimal, next: Decimal, atMs: bigint): void;

  /**
   * A trade printed at or through the order's price, on the side the order
   * rests on.
   *
   * @param tradeQty  size of the print
   * @param remaining unfilled quantity of our order
   * @param through   the print was at a price strictly better for the taker
   *                  than ours, so the market traded THROUGH our level
   */
  onTrade(
    state: QueueState,
    tradeQty: Decimal,
    remaining: Decimal,
    through: boolean,
    atMs: bigint,
  ): TradeFillResult;
}

/**
 * Shared queue bookkeeping.
 *
 * The three shipped models differ only in how much credit they give for
 * volume disappearing from the level, so they share this implementation and
 * vary two parameters. Keeping one implementation means a fix to the
 * reconciliation logic cannot apply to the conservative model and miss the
 * optimistic one, which is how two models silently stop being comparable.
 */
export abstract class QueueFillModel implements FillModel {
  abstract readonly name: string;

  protected constructor(
    /** Fraction of the entry level's displayed size assumed to be ahead of us. */
    protected readonly queueAheadFraction: Decimal,
    /**
     * Fraction of an UNEXPLAINED displayed-size decrease credited against our
     * queue. Zero is the conservative reading: a level shrinking tells us
     * somebody left, but not whether they were ahead of us or behind.
     */
    protected readonly cancelCreditRatio: Decimal,
  ) {}

  abstract describe(): Record<string, unknown>;

  initialQueueAhead(displayedSize: Decimal): Decimal {
    return displayedSize.mul(this.queueAheadFraction);
  }

  onDisplayedSizeChange(state: QueueState, previous: Decimal, next: Decimal, _atMs: bigint): void {
    state.lastDisplayedSize = next;

    const decrease = previous.minus(next);
    // Size added to the level joins BEHIND us and changes nothing.
    if (decrease.lte(0)) return;

    // Reconcile against recent trades first. See `unreconciledTradeVolume`.
    const explained = Decimal.min(decrease, state.unreconciledTradeVolume);
    state.unreconciledTradeVolume = state.unreconciledTradeVolume.minus(explained);

    const cancelled = decrease.minus(explained);
    if (cancelled.lte(0) || this.cancelCreditRatio.isZero()) return;

    const credit = cancelled.mul(this.cancelCreditRatio);
    state.queueAhead = Decimal.max(ZERO, state.queueAhead.minus(credit));
  }

  onTrade(
    state: QueueState,
    tradeQty: Decimal,
    remaining: Decimal,
    through: boolean,
    _atMs: bigint,
  ): TradeFillResult {
    state.tradeCount += 1;
    state.executedVolumeAtLevel = state.executedVolumeAtLevel.plus(tradeQty);
    state.unreconciledTradeVolume = state.unreconciledTradeVolume.plus(tradeQty);

    // The market traded at a price better for the taker than ours: everything
    // resting at our price, us included, was passed over. Nothing about the
    // queue protects us here.
    if (through) {
      return { filled: Decimal.min(remaining, tradeQty), reason: 'trade_through' };
    }

    // Volume ahead of us absorbs the print first.
    const consumedByQueue = Decimal.min(state.queueAhead, tradeQty);
    state.queueAhead = state.queueAhead.minus(consumedByQueue);

    const available = tradeQty.minus(consumedByQueue);
    if (available.lte(0)) return { filled: ZERO, reason: 'queue_depleted' };

    return {
      filled: Decimal.min(remaining, available),
      reason: state.queueAheadAtEntry.isZero() ? 'touch' : 'queue_depleted',
    };
  }
}
