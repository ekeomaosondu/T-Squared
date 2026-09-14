import { Decimal, D, ONE, ZERO, canonicalPrice, type DecimalInput } from '@/src/book/decimal';

/**
 * The ONE place that maps a YES-ladder order onto Kalshi's public book.
 *
 * Kalshi publishes YES bids and NO bids. The V2 order API takes `bid` or `ask`
 * on the YES ladder. Those are different coordinate systems, and the
 * conversion had been re-derived independently in the level tracker, the book
 * view and the simulated exchange -- three chances to get a complement
 * backwards, in code whose whole output is a claim about queue position.
 *
 *     YES bid  at p   <->   public YES bid  at p
 *     YES ask  at p   <->   public NO  bid  at 1 - p
 *
 * "Better" means better FOR US, i.e. ahead of us in price priority:
 *
 *     for a YES bid at p    a higher YES bid       x > p
 *     for a YES ask at p    a lower YES ask        x < p
 *                           equivalently a HIGHER NO bid, since a NO bid at q
 *                           is a YES ask at 1 - q
 *
 * The inversion on the ask side is the trap: better YES asks are lower, which
 * is higher on the NO ladder. Everything here is proven in ladder.test.ts at
 * the boundaries, in both directions, and against MarketBook's own derivation.
 */

export type LadderSide = 'bid' | 'ask';
export type PublicSide = 'yes' | 'no';

export interface PublicLevel {
  /** Which of Kalshi's two published ladders the order rests on. */
  side: PublicSide;
  /** Canonical price on THAT ladder, which is not the YES price for an ask. */
  price: string;
}

/** Where a YES-ladder order physically sits in the public book. */
export function publicLevelFor(side: LadderSide, yesPrice: DecimalInput): PublicLevel {
  const p = D(yesPrice);
  return side === 'bid'
    ? { side: 'yes', price: canonicalPrice(p) }
    : { side: 'no', price: canonicalPrice(ONE.minus(p)) };
}

/** The inverse: the YES price of a level on one of the public ladders. */
export function yesPriceOfPublicLevel(side: PublicSide, price: DecimalInput): string {
  const p = D(price);
  return side === 'yes' ? canonicalPrice(p) : canonicalPrice(ONE.minus(p));
}

/** Is `other` ahead of `ours` in price priority, for an order on `side`? */
export function isBetterYesPrice(
  side: LadderSide,
  ours: DecimalInput,
  other: DecimalInput,
): boolean {
  const a = D(ours);
  const b = D(other);
  // A bid is better when it pays more; an ask is better when it asks less.
  return side === 'bid' ? b.gt(a) : b.lt(a);
}

/** A price ladder as `[price, size]` pairs, in either public coordinate system. */
export type Levels = Iterable<readonly [string, DecimalInput]>;

export interface AheadDepth {
  /** Contracts resting at strictly better prices than ours. */
  better: Decimal;
  /** Contracts displayed at our own price. Includes our order if it is shown. */
  sameLevel: Decimal;
  /** Distinct better price levels, for diagnostics. */
  betterLevels: number;
}

/**
 * Depth ahead of a YES-ladder order, computed from the public book.
 *
 * Takes BOTH published ladders because the caller should never have to decide
 * which one is relevant -- deciding that wrongly is the bug this module exists
 * to prevent.
 *
 * `better` is the quantity the simple "same-price displayed size" model omits.
 * A probe that does not reprice starts at the touch and can end up behind a
 * newly improved price, at which point everything at that better price is
 * ahead of it and none of it is at its own level.
 */
export function depthAhead(
  side: LadderSide,
  yesPrice: DecimalInput,
  book: { yesBids: Levels; noBids: Levels },
): AheadDepth {
  const ours = D(yesPrice);
  const ourLevel = publicLevelFor(side, ours);

  let better = ZERO;
  let sameLevel = ZERO;
  let betterLevels = 0;

  const scan = (levels: Levels, publicSide: PublicSide) => {
    for (const [price, size] of levels) {
      const qty = D(size);
      if (qty.lte(0)) continue;
      // Only the ladder our order rests on can hold interest ahead of it: the
      // other ladder is the opposing side of the market, not our queue.
      if (publicSide !== ourLevel.side) continue;

      const yes = D(yesPriceOfPublicLevel(publicSide, price));
      if (yes.equals(ours)) {
        sameLevel = sameLevel.plus(qty);
        continue;
      }
      if (isBetterYesPrice(side, ours, yes)) {
        better = better.plus(qty);
        betterLevels += 1;
      }
    }
  };

  scan(book.yesBids, 'yes');
  scan(book.noBids, 'no');

  return { better, sameLevel, betterLevels };
}

/**
 * Ticks between our price and the current touch on our side.
 *
 * Zero while we are at the BBO, one when a single better price has appeared,
 * and so on. A probe that never reprices drifts through these as the market
 * moves, and the drift is exactly when better-priced depth appears ahead of it.
 */
export function ticksFromTouch(
  side: LadderSide,
  yesPrice: DecimalInput,
  bestYesBid: Decimal | null,
  bestYesAsk: Decimal | null,
): number | null {
  const ours = D(yesPrice);
  const touch = side === 'bid' ? bestYesBid : bestYesAsk;
  if (touch === null) return null;
  const diff = side === 'bid' ? touch.minus(ours) : ours.minus(touch);
  // Kalshi quotes on a one-cent grid.
  return Math.max(0, Math.round(diff.mul(100).toNumber()));
}
