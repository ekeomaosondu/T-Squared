import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';
import { MidSeries, MidSeriesStore } from '@/src/research/metrics/midSeries';
import {
  computeMarkouts,
  markoutOf,
  summarizeMarkouts,
} from '@/src/research/metrics/markouts';
import type { SimulatedFill } from '@/src/research/execution/simulatedExchange';

const D = (v: string | number) => new Decimal(v);

function fill(over: Partial<SimulatedFill> = {}): SimulatedFill {
  return {
    fillId: 'f1',
    orderId: 'o1',
    clientOrderId: 'c1',
    marketTicker: 'M',
    side: 'yes',
    action: 'buy',
    yesAction: 'buy',
    price: D('0.40'),
    yesPrice: D('0.40'),
    quantity: D(10),
    liquidity: 'maker',
    reason: 'queue_depleted',
    fee: D(0),
    feeKnown: true,
    submittedAtMs: 900n,
    arrivedAtMs: 950n,
    filledAtMs: 1_000n,
    queueAheadAtEntry: D(0),
    queueAheadBeforeFill: D(0),
    fillModel: 'touch',
    bookStateHash: null,
    triggeringTradeId: null,
    midAtFill: D('0.425'),
    spreadAtFill: D('0.05'),
    depth1AtFill: D(100),
    imbalance1AtFill: D(0),
    ...over,
  };
}

describe('markout sign convention', () => {
  it('is positive when the market moves our way, on either side', () => {
    // Bought at 0.40, mid later 0.45: favourable.
    expect(markoutOf('buy', D('0.40'), D('0.45'))!.toFixed(2)).toBe('0.05');
    // Sold at 0.45, mid later 0.40: also favourable, also positive.
    expect(markoutOf('sell', D('0.45'), D('0.40'))!.toFixed(2)).toBe('0.05');
    // And negative in both directions when it goes against us.
    expect(markoutOf('buy', D('0.45'), D('0.40'))!.toFixed(2)).toBe('-0.05');
    expect(markoutOf('sell', D('0.40'), D('0.45'))!.toFixed(2)).toBe('-0.05');
  });

  it('is null, never zero, when the future price is unknown', () => {
    expect(markoutOf('buy', D('0.40'), null)).toBeNull();
  });
});

describe('mid series', () => {
  it('holds the last value in force between changes', () => {
    const s = new MidSeries();
    s.record(1_000n, D('0.40'), D('0.41'));
    s.record(2_000n, D('0.45'), D('0.46'));
    s.observe(3_000n);

    expect(s.midAt(999)).toBeNull();
    expect(s.midAt(1_000)!.toFixed(2)).toBe('0.40');
    expect(s.midAt(1_500)!.toFixed(2)).toBe('0.40');
    expect(s.midAt(2_000)!.toFixed(2)).toBe('0.45');
    expect(s.midAt(3_000)!.toFixed(2)).toBe('0.45');
  });

  it('refuses to extrapolate past the last instant it was watching', () => {
    const s = new MidSeries();
    s.record(1_000n, D('0.40'), D('0.41'));
    s.observe(2_000n);
    // Inside the observed window even though the mid never moved.
    expect(s.midAt(2_000)).not.toBeNull();
    // Past it: unknown, not "still 0.40".
    expect(s.midAt(2_001)).toBeNull();
  });

  it('separates being watched from the mid changing', () => {
    // A calm market is still an observed market. Bounding markouts by the last
    // CHANGE would drop the 30-second horizon for exactly the quiet markets a
    // maker does best in.
    const s = new MidSeries();
    s.record(1_000n, D('0.40'), D('0.40'));
    for (let t = 1_100; t <= 40_000; t += 100) s.observe(BigInt(t));
    expect(s.lastTimeMs).toBe(1_000);
    expect(s.observedUntilMs).toBe(40_000);
    expect(s.midAt(31_000)!.toFixed(2)).toBe('0.40');
  });

  it('records an unknown mid as unknown', () => {
    const s = new MidSeries();
    s.record(1_000n, D('0.40'), D('0.40'));
    s.record(2_000n, null, null); // coverage lost
    s.record(9_000n, D('0.42'), D('0.42'));
    expect(s.midAt(5_000)).toBeNull();
    expect(s.midAt(9_500)).toBeNull(); // not observed past 9000 yet
    s.observe(10_000n);
    expect(s.midAt(9_500)!.toFixed(2)).toBe('0.42');
  });

  it('keeps the last value when several events share a millisecond', () => {
    const s = new MidSeries();
    s.record(1_000n, D('0.40'), D('0.40'));
    s.record(1_000n, D('0.41'), D('0.41'));
    expect(s.length).toBe(1);
    expect(s.midAt(1_000)!.toFixed(2)).toBe('0.41');
  });
});

describe('markout computation', () => {
  const store = new MidSeriesStore();
  const series = store.for('M');
  series.record(1_000n, D('0.425'), D('0.425'));
  series.record(1_100n, D('0.435'), D('0.435')); // +1c at 100ms
  series.record(2_000n, D('0.415'), D('0.415')); // -1c by 1s
  series.observe(5_000n);

  it('measures the market at each horizon after the fill', () => {
    const [m] = computeMarkouts([fill()], store, 'mid', [100, 1_000]);
    // Bought at 0.40; mid was 0.435 at +100ms and 0.415 at +1s.
    expect(m!.markouts['100']).toBe('0.035000');
    expect(m!.markouts['1000']).toBe('0.015000');
    expect(m!.markoutDollars['100']).toBe('0.350000');
  });

  it('reports a horizon past the data as unobserved, never as zero', () => {
    const [m] = computeMarkouts([fill()], store, 'mid', [30_000]);
    expect(m!.markouts['30000']).toBeNull();

    const [summary] = summarizeMarkouts([m!], [30_000]);
    expect(summary!.observations).toBe(0);
    expect(summary!.unobserved).toBe(1);
    // A missing markout must not average in as zero: zero reads as "no adverse
    // selection", the most flattering possible error.
    expect(summary!.meanMarkout).toBeNull();
    expect(summary!.adverseRate).toBeNull();
  });

  it('summarizes mean and median over observed fills only', () => {
    const fills = [
      fill({ fillId: 'a', filledAtMs: 1_000n, yesPrice: D('0.40') }),
      fill({ fillId: 'b', filledAtMs: 1_000n, yesPrice: D('0.45') }),
      fill({ fillId: 'c', filledAtMs: 1_000n, yesPrice: D('0.50') }),
    ];
    const markouts = computeMarkouts(fills, store, 'mid', [100]);
    const [summary] = summarizeMarkouts(markouts, [100]);
    // Mid at +100ms is 0.435; markouts from the fill price are +0.035, -0.015,
    // -0.065.
    expect(summary!.observations).toBe(3);
    expect(summary!.meanMarkout).toBe('-0.01500000');
    expect(summary!.medianMarkout).toBe('-0.01500000');
  });

  it('separates the half-spread from the drift', () => {
    // All three fills happen at the same instant, so the market did the same
    // thing after each of them. Their TOTAL markouts differ only because they
    // paid different prices; their drift is identical. Conflating the two is
    // how a maker's structural half-spread gets mistaken for alpha.
    const fills = [
      fill({ fillId: 'a', filledAtMs: 1_000n, yesPrice: D('0.40') }),
      fill({ fillId: 'b', filledAtMs: 1_000n, yesPrice: D('0.45') }),
    ];
    const markouts = computeMarkouts(fills, store, 'mid', [100]);
    // Mid at the fill is 0.425, at +100ms it is 0.435: a one-cent drift our
    // way on a buy, for both.
    expect(markouts.map((m) => m.midDrift['100'])).toEqual(['0.010000', '0.010000']);
    expect(markouts.map((m) => m.markouts['100'])).toEqual(['0.035000', '-0.015000']);

    const [summary] = summarizeMarkouts(markouts, [100]);
    expect(summary!.meanMidDrift).toBe('0.01000000');
    // Favourable drift on both, so nothing was picked off -- even though one
    // of the two has a negative total markout.
    expect(summary!.adverseRate).toBe('0.000000');
  });

  it('reports adverse selection when the mid runs away from the fill', () => {
    const seller = fill({ fillId: 'd', filledAtMs: 1_000n, yesAction: 'sell', yesPrice: D('0.45') });
    const markouts = computeMarkouts([seller], store, 'mid', [100]);
    // Sold, and the mid rose from 0.425 to 0.435: against us.
    expect(markouts[0]!.midDrift['100']).toBe('-0.010000');
    const [summary] = summarizeMarkouts(markouts, [100]);
    expect(summary!.adverseRate).toBe('1.000000');
  });
});
