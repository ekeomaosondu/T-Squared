import { describe, expect, it } from 'vitest';
import { MarketBook } from '@/src/book/book';
import { MarketStateStore } from '@/src/research/engine/marketState';
import { snapshot, resetOrdinals, delta, MARKET } from './fixtures';
import type { Level } from '@/src/research/events/researchEvent';

/**
 * `MarketBookView.bbo()` scans the ladders instead of sorting them, because
 * the backtest asks for the BBO on every delta and sorting a fifty-level map
 * a few million times dominates a full-day run.
 *
 * That makes it the ONE place in the research platform with its own arithmetic
 * rather than the recorder's, so it gets its own equivalence proof. If these
 * two ever disagree, the fast path is wrong and every spread, mid, microprice
 * and markout computed from it is wrong with it.
 */

function randomBook(seed: number): { yesBids: Level[]; noBids: Level[] } {
  let state = seed >>> 0;
  const rnd = () => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 0x1_0000_0000;
  };

  const side = (lo: number, hi: number): Level[] => {
    const levels: Level[] = [];
    for (let c = lo; c <= hi; c++) {
      if (rnd() < 0.4) continue; // holes in the ladder
      levels.push([(c / 100).toFixed(6), (1 + Math.floor(rnd() * 900)).toFixed(6)]);
    }
    return levels;
  };

  return { yesBids: side(1, 49), noBids: side(1, 49) };
}

describe('MarketBookView.bbo agrees with MarketBook.getYesBBO', () => {
  it('matches on a thousand randomized ladders', () => {
    const store = new MarketStateStore();
    let compared = 0;

    for (let seed = 1; seed <= 1_000; seed++) {
      resetOrdinals();
      const { yesBids, noBids } = randomBook(seed);
      store.applySnapshot(snapshot(1_000 + seed, yesBids, noBids));

      const view = store.view(MARKET)!;
      const reference = new MarketBook(MARKET);
      reference.replaceWithSnapshot({ yesBids, noBids });

      const fast = view.bbo();
      const slow = reference.getYesBBO();

      const same = (a: { toFixed(n: number): string } | null, b: typeof a) =>
        (a === null ? null : a.toFixed(6)) === (b === null ? null : b.toFixed(6));

      expect(same(fast.bid, slow.bid), `seed ${seed} bid`).toBe(true);
      expect(same(fast.ask, slow.ask), `seed ${seed} ask`).toBe(true);
      expect(same(fast.bidSize, slow.bidSize), `seed ${seed} bidSize`).toBe(true);
      expect(same(fast.askSize, slow.askSize), `seed ${seed} askSize`).toBe(true);
      expect(same(fast.spread, slow.spread), `seed ${seed} spread`).toBe(true);
      expect(same(fast.mid, slow.mid), `seed ${seed} mid`).toBe(true);
      expect(
        same(view.microprice(), reference.getMicroprice()),
        `seed ${seed} microprice`,
      ).toBe(true);
      compared += 1;
    }

    expect(compared).toBe(1_000);
  });

  it('matches on one-sided and empty books', () => {
    const store = new MarketStateStore();

    for (const [yesBids, noBids] of [
      [[], []],
      [[['0.400000', '10.000000']] as Level[], []],
      [[], [['0.550000', '10.000000']] as Level[]],
    ] as [Level[], Level[]][]) {
      resetOrdinals();
      store.applySnapshot(snapshot(1_000, yesBids, noBids));
      const view = store.view(MARKET)!;
      const reference = new MarketBook(MARKET);
      reference.replaceWithSnapshot({ yesBids, noBids });

      const fast = view.bbo();
      const slow = reference.getYesBBO();
      expect(fast.bid?.toFixed(6) ?? null).toBe(slow.bid?.toFixed(6) ?? null);
      expect(fast.ask?.toFixed(6) ?? null).toBe(slow.ask?.toFixed(6) ?? null);
      // A one-sided book has no spread and no mid, and must not invent one.
      expect(fast.spread).toBeNull();
      expect(fast.mid).toBeNull();
      expect(view.microprice()).toBeNull();
    }
  });

  it('tracks the touch as deltas move it', () => {
    resetOrdinals();
    const store = new MarketStateStore();
    store.applySnapshot(
      snapshot(1_000, [['0.400000', '50.000000']], [['0.550000', '50.000000']]),
    );
    const view = store.view(MARKET)!;
    const reference = new MarketBook(MARKET);
    reference.replaceWithSnapshot({
      yesBids: [['0.400000', '50.000000']],
      noBids: [['0.550000', '50.000000']],
    });

    const steps: [('yes' | 'no'), string, string, string][] = [
      ['yes', '0.420000', '30', '0'],
      ['yes', '0.420000', '-30', '30'],
      ['no', '0.570000', '25', '0'],
      ['yes', '0.400000', '-50', '50'],
    ];

    for (const [side, price, change, pre] of steps) {
      store.applyDelta(delta(2_000, side, price, change, pre));
      reference.applyDelta({ side, price, delta: change });
      expect(view.bbo().bid?.toFixed(6) ?? null).toBe(
        reference.getYesBBO().bid?.toFixed(6) ?? null,
      );
      expect(view.bbo().ask?.toFixed(6) ?? null).toBe(
        reference.getYesBBO().ask?.toFixed(6) ?? null,
      );
    }
  });
});
