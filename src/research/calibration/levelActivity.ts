import { Decimal, D, ONE, ZERO, canonicalPrice } from '@/src/book/decimal';
import type { BookDeltaEvent, TradeEvent } from '@/src/research/events/researchEvent';

/**
 * What happened at one price level while our order sat on it.
 *
 * This is the right-hand side of the model the whole experiment exists to
 * test. The exchange tells us how our queue position moved; this tells us what
 * the visible book did over the same interval, so the two can be compared:
 *
 *     dQ_hat = executed + alpha * removed
 *
 * The three quantities are kept SEPARATE rather than netted. A level that
 * shrank by fifty because fifty traded and a level that shrank by fifty
 * because someone withdrew fifty are the same net change and completely
 * different evidence -- distinguishing them is the entire point.
 *
 * Additions are tracked too, even though they join behind us under price-time
 * priority and cannot move our queue. They are what makes the displayed size
 * an unreliable proxy for queue-ahead, so a model that uses displayed size
 * needs them to know how wrong it is.
 */

export interface LevelActivity {
  /** Contracts that traded at this price. */
  executed: Decimal;
  /** Displayed size withdrawn, i.e. negative deltas not explained by trades. */
  removed: Decimal;
  /** Displayed size posted. Joins behind us; recorded because it distorts depth. */
  added: Decimal;
  /** Distinct prints at this price. */
  trades: number;
  /** Traded volume not yet reconciled against a displayed decrease. */
  unreconciledTradeVolume: Decimal;
}

const empty = (): LevelActivity => ({
  executed: ZERO,
  removed: ZERO,
  added: ZERO,
  trades: 0,
  unreconciledTradeVolume: ZERO,
});

/** The book ladder a probe rests on, in the exchange's own terms. */
export function ladderFor(side: 'bid' | 'ask', yesPrice: Decimal): {
  bookSide: 'yes' | 'no';
  bookPrice: string;
} {
  return side === 'bid'
    ? { bookSide: 'yes', bookPrice: canonicalPrice(yesPrice) }
    : { bookSide: 'no', bookPrice: canonicalPrice(ONE.minus(yesPrice)) };
}

export class LevelActivityTracker {
  private readonly watched = new Map<string, LevelActivity>();

  private static key(marketTicker: string, bookSide: string, bookPrice: string): string {
    return `${marketTicker}|${bookSide}|${bookPrice}`;
  }

  /** Begins counting at a level. Resets any prior count for it. */
  watch(marketTicker: string, side: 'bid' | 'ask', yesPrice: Decimal): string {
    const { bookSide, bookPrice } = ladderFor(side, yesPrice);
    const key = LevelActivityTracker.key(marketTicker, bookSide, bookPrice);
    this.watched.set(key, empty());
    return key;
  }

  unwatch(key: string): void {
    this.watched.delete(key);
  }

  snapshot(key: string): LevelActivity {
    const a = this.watched.get(key);
    return a ? { ...a } : empty();
  }

  /**
   * A displayed size change.
   *
   * A trade removes size from the level, so the delta that follows it is not
   * evidence of a withdrawal. Without reconciling the two, every trade would
   * be counted twice -- once as executed and again as removed -- and the
   * fitted alpha would absorb the error.
   */
  onDelta(event: BookDeltaEvent): void {
    const key = LevelActivityTracker.key(
      event.marketTicker,
      event.side,
      canonicalPrice(event.price),
    );
    const activity = this.watched.get(key);
    if (!activity) return;

    const change = D(event.deltaCount);
    if (change.isZero()) return;

    if (change.isPositive()) {
      activity.added = activity.added.plus(change);
      return;
    }

    const decrease = change.abs();
    const explained = Decimal.min(decrease, activity.unreconciledTradeVolume);
    activity.unreconciledTradeVolume = activity.unreconciledTradeVolume.minus(explained);
    activity.removed = activity.removed.plus(decrease.minus(explained));
  }

  /**
   * A print.
   *
   * Attributed to the side of the book the aggressor consumed. A taker buying
   * YES removes YES asks -- which are NO bids -- so only a probe resting on
   * the ask side has volume executed ahead of it.
   */
  onTrade(event: TradeEvent): void {
    if (event.takerOutcomeSide === null) return;
    const yesPrice = D(event.yesPrice);
    const bookSide = event.takerOutcomeSide === 'yes' ? 'no' : 'yes';
    const bookPrice =
      bookSide === 'yes' ? canonicalPrice(yesPrice) : canonicalPrice(ONE.minus(yesPrice));

    const key = LevelActivityTracker.key(event.marketTicker, bookSide, bookPrice);
    const activity = this.watched.get(key);
    if (!activity) return;

    const quantity = D(event.count);
    activity.executed = activity.executed.plus(quantity);
    activity.unreconciledTradeVolume = activity.unreconciledTradeVolume.plus(quantity);
    activity.trades += 1;
  }
}

/**
 * Rolling per-market activity, for stratification.
 *
 * Deliberately crude: a count over a recent window, not a rate estimate. The
 * strata only need to separate busy from quiet well enough to rotate between
 * them, and a more elaborate measure would invite tuning a threshold that has
 * no ground truth.
 */
export class RecentActivity {
  private readonly trades = new Map<string, number[]>();
  private readonly deltas = new Map<string, number[]>();

  constructor(private readonly windowMs: number = 120_000) {}

  private push(map: Map<string, number[]>, ticker: string, atMs: number): void {
    let times = map.get(ticker);
    if (!times) {
      times = [];
      map.set(ticker, times);
    }
    times.push(atMs);
    const cutoff = atMs - this.windowMs;
    // Timestamps arrive in order, so a prefix trim is enough.
    let drop = 0;
    while (drop < times.length && times[drop]! < cutoff) drop += 1;
    if (drop > 0) times.splice(0, drop);
  }

  private count(map: Map<string, number[]>, ticker: string, nowMs: number): number {
    const times = map.get(ticker);
    if (!times) return 0;
    const cutoff = nowMs - this.windowMs;
    let n = 0;
    for (let i = times.length - 1; i >= 0 && times[i]! >= cutoff; i--) n += 1;
    return n;
  }

  recordTrade(ticker: string, atMs: number): void {
    this.push(this.trades, ticker, atMs);
  }
  recordDelta(ticker: string, atMs: number): void {
    this.push(this.deltas, ticker, atMs);
  }
  tradesIn(ticker: string, nowMs: number): number {
    return this.count(this.trades, ticker, nowMs);
  }
  deltasIn(ticker: string, nowMs: number): number {
    return this.count(this.deltas, ticker, nowMs);
  }
}
