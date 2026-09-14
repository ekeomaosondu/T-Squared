import { describe, expect, it } from 'vitest';
import { MarketBook } from '@/src/book/book';
import { D, ONE } from '@/src/book/decimal';
import {
  depthAhead,
  isBetterYesPrice,
  publicLevelFor,
  ticksFromTouch,
  yesPriceOfPublicLevel,
} from '@/src/book/ladder';

/**
 * The mapping between a YES-ladder order and Kalshi's published book is
 * load-bearing for every queue measurement, and the ask side inverts. This is
 * the proof, not an assumption: boundaries, both directions, and agreement
 * with MarketBook's own independent derivation.
 */

const PRICES = ['0.01', '0.15', '0.43', '0.50', '0.85', '0.99'];

describe('YES ladder to public book', () => {
  it('maps a bid to the YES ladder at the same price', () => {
    for (const p of PRICES) {
      expect(publicLevelFor('bid', p)).toEqual({ side: 'yes', price: D(p).toFixed(6) });
    }
  });

  it('maps an ask to the NO ladder at the complement', () => {
    for (const p of PRICES) {
      expect(publicLevelFor('ask', p)).toEqual({
        side: 'no',
        price: ONE.minus(D(p)).toFixed(6),
      });
    }
  });

  it('round-trips in both directions at every boundary', () => {
    for (const p of PRICES) {
      for (const side of ['bid', 'ask'] as const) {
        const level = publicLevelFor(side, p);
        expect(yesPriceOfPublicLevel(level.side, level.price)).toBe(D(p).toFixed(6));
      }
    }
  });

  it('agrees with MarketBook on which NO bid is which YES ask', () => {
    // MarketBook derives the YES ask ladder independently. If these two ever
    // disagree, one of them is inverting the complement.
    const noBids: [string, string][] = PRICES.map((p) => [
      ONE.minus(D(p)).toFixed(6),
      '10.000000',
    ]);
    const book = new MarketBook('M');
    book.replaceWithSnapshot({ yesBids: [], noBids });

    const derived = book.yesAskLevels().map(([price]) => price).sort();
    const mapped = noBids
      .map(([price]) => yesPriceOfPublicLevel('no', price))
      .sort();
    expect(derived).toEqual(mapped);
  });

  it('knows a better bid is higher and a better ask is lower', () => {
    // The trap: better YES asks are LOWER, which is HIGHER on the NO ladder.
    expect(isBetterYesPrice('bid', '0.40', '0.41')).toBe(true);
    expect(isBetterYesPrice('bid', '0.40', '0.39')).toBe(false);
    expect(isBetterYesPrice('ask', '0.40', '0.39')).toBe(true);
    expect(isBetterYesPrice('ask', '0.40', '0.41')).toBe(false);
    // Our own price is never "better" than itself.
    expect(isBetterYesPrice('bid', '0.40', '0.40')).toBe(false);
    expect(isBetterYesPrice('ask', '0.40', '0.40')).toBe(false);
  });
});

describe('depth ahead', () => {
  //  YES bids: 0.42 x 5, 0.41 x 10, 0.40 x 20, 0.39 x 40
  //  NO  bids: 0.55 x 7, 0.54 x 14, 0.53 x 21   (YES asks 0.45, 0.46, 0.47)
  const book = {
    yesBids: [
      ['0.420000', '5'],
      ['0.410000', '10'],
      ['0.400000', '20'],
      ['0.390000', '40'],
    ] as [string, string][],
    noBids: [
      ['0.550000', '7'],
      ['0.540000', '14'],
      ['0.530000', '21'],
    ] as [string, string][],
  };

  it('counts higher bids as ahead of a bid', () => {
    const ahead = depthAhead('bid', '0.40', book);
    expect(ahead.better.toString()).toBe('15'); // 5 at 0.42 + 10 at 0.41
    expect(ahead.sameLevel.toString()).toBe('20');
    expect(ahead.betterLevels).toBe(2);
  });

  it('counts lower asks as ahead of an ask, reading the NO ladder', () => {
    // Our YES ask at 0.46 is a NO bid at 0.54. Better YES asks are 0.45,
    // which is the NO bid at 0.55.
    const ahead = depthAhead('ask', '0.46', book);
    expect(ahead.better.toString()).toBe('7');
    expect(ahead.sameLevel.toString()).toBe('14');
    expect(ahead.betterLevels).toBe(1);
  });

  it('never counts the opposing ladder as queue ahead of us', () => {
    // A bid is not queued behind offers. Getting this wrong would report the
    // whole other side of the market as contracts ahead of the order.
    const ahead = depthAhead('bid', '0.42', book);
    expect(ahead.better.isZero()).toBe(true);
    expect(ahead.sameLevel.toString()).toBe('5');
  });

  it('is zero ahead at the top of the book', () => {
    expect(depthAhead('bid', '0.42', book).better.isZero()).toBe(true);
    // Best YES ask is 0.45, the NO bid at 0.55.
    expect(depthAhead('ask', '0.45', book).better.isZero()).toBe(true);
  });

  it('counts everything as ahead when we are far behind', () => {
    const ahead = depthAhead('bid', '0.30', book);
    expect(ahead.better.toString()).toBe('75'); // 5 + 10 + 20 + 40
    expect(ahead.sameLevel.isZero()).toBe(true);
  });
});

describe('distance from the touch', () => {
  it('is zero at the BBO and grows as the market moves away', () => {
    expect(ticksFromTouch('bid', '0.40', D('0.40'), D('0.45'))).toBe(0);
    expect(ticksFromTouch('bid', '0.40', D('0.41'), D('0.45'))).toBe(1);
    expect(ticksFromTouch('bid', '0.40', D('0.43'), D('0.45'))).toBe(3);
    // An ask is behind when the touch is LOWER than our price.
    expect(ticksFromTouch('ask', '0.45', D('0.40'), D('0.45'))).toBe(0);
    expect(ticksFromTouch('ask', '0.45', D('0.40'), D('0.43'))).toBe(2);
  });

  it('never reports a negative distance', () => {
    // If our own order is the touch, the difference can round to a tiny
    // negative; that is zero ticks behind, not minus one.
    expect(ticksFromTouch('bid', '0.41', D('0.40'), D('0.45'))).toBe(0);
  });

  it('is unknown when that side has no touch at all', () => {
    expect(ticksFromTouch('bid', '0.40', null, D('0.45'))).toBeNull();
  });
});
