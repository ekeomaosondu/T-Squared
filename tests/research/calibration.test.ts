import { describe, expect, it } from 'vitest';
import { Decimal, D, ZERO } from '@/src/book/decimal';
import {
  CALIBRATION_V0,
  isKilled,
  mayPlaceProbe,
  premiumForProbe,
  worstCaseExposure,
  type AccountState,
} from '@/src/research/calibration/riskEnvelope';
import {
  assessEligibility,
  chooseDwellMs,
  chooseSide,
  classify,
  DWELL_CHOICES_MS,
  selectNext,
  stratumId,
  type Candidate,
} from '@/src/research/calibration/marketSelector';
import { LevelActivityTracker } from '@/src/research/calibration/levelActivity';
import { MarketStateStore } from '@/src/research/engine/marketState';
import { delta, MARKET, resetOrdinals, snapshot, trade } from './fixtures';

const emptyAccount = (over: Partial<AccountState> = {}): AccountState => ({
  restingByMarket: new Map(),
  positionByMarket: new Map(),
  premiumAtRiskByMarket: new Map(),
  probesInFlight: new Map(),
  seriesInFlight: new Map(),
  fillsToday: 0,
  ordersToday: 0,
  ...over,
});

describe('calibration risk envelope', () => {
  it('allows a first probe inside every limit', () => {
    const d = mayPlaceProbe(CALIBRATION_V0, emptyAccount(), 'M', 'S', D('0.40'));
    expect(d.allowed).toBe(true);
  });

  it('counts a resting order as exposure before it fills', () => {
    // A resting order is a commitment: by the time it fills there is no
    // opportunity to decline. Counting exposure only afterwards would let the
    // account exceed the cap for as long as it takes to be filled.
    const state = emptyAccount({
      premiumAtRiskByMarket: new Map([['A', D('4.80')]]),
    });
    expect(worstCaseExposure(state, D('0.40')).toFixed(2)).toBe('5.20');
    const d = mayPlaceProbe(CALIBRATION_V0, state, 'B', 'S', D('0.40'));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('max_worst_case_exposure');
  });

  it('caps total resting probes', () => {
    const state = emptyAccount({
      restingByMarket: new Map([
        ['A', 1],
        ['B', 1],
      ]),
    });
    expect(mayPlaceProbe(CALIBRATION_V0, state, 'C', 'S', D('0.10')).reason).toBe(
      'max_resting_orders',
    );
  });

  it('caps one probe per market and one per series', () => {
    const perMarket = emptyAccount({ restingByMarket: new Map([['A', 1]]) });
    expect(mayPlaceProbe(CALIBRATION_V0, perMarket, 'A', 'S', D('0.10')).reason).toBe(
      'max_resting_per_market',
    );

    // One NY probe and one LAX probe at a time, so the two observations stay
    // independent rather than both describing the same city's flow.
    const perSeries = emptyAccount({ seriesInFlight: new Map([['KXHIGHNY', 1]]) });
    expect(mayPlaceProbe(CALIBRATION_V0, perSeries, 'A', 'KXHIGHNY', D('0.10')).reason).toBe(
      'max_probes_per_series',
    );
  });

  it('refuses to add to a market already at its position limit', () => {
    const state = emptyAccount({ positionByMarket: new Map([['A', D(1)]]) });
    expect(mayPlaceProbe(CALIBRATION_V0, state, 'A', 'S', D('0.10')).reason).toBe(
      'max_position_per_market',
    );
  });

  it('stops at the daily fill and order ceilings', () => {
    expect(
      mayPlaceProbe(CALIBRATION_V0, emptyAccount({ fillsToday: 50 }), 'A', 'S', D('0.1')).reason,
    ).toBe('max_fills_per_day');
    expect(
      mayPlaceProbe(CALIBRATION_V0, emptyAccount({ ordersToday: 200 }), 'A', 'S', D('0.1')).reason,
    ).toBe('max_new_orders_per_day');
  });

  it('kills on exposure or an oversized position', () => {
    expect(
      isKilled(CALIBRATION_V0, emptyAccount({ premiumAtRiskByMarket: new Map([['A', D('5.01')]]) }))
        .killed,
    ).toBe(true);
    expect(
      isKilled(CALIBRATION_V0, emptyAccount({ positionByMarket: new Map([['A', D(2)]]) })).killed,
    ).toBe(true);
    expect(isKilled(CALIBRATION_V0, emptyAccount()).killed).toBe(false);
  });

  it('prices the worst case as the premium paid, on either side', () => {
    // Buying YES at 0.40 risks 0.40. The offer is a NO buy at 0.60 and risks
    // 0.60. Both are bounded, which is what makes a five-dollar cap mean
    // something rather than being notional.
    expect(premiumForProbe(D('0.40'), 'bid', 1).toFixed(2)).toBe('0.40');
    expect(premiumForProbe(D('0.40'), 'ask', 1).toFixed(2)).toBe('0.60');
  });

  it('ships a v0 envelope that is genuinely tiny', () => {
    // A canary. Widening any of these should be a deliberate edit with a
    // reason, not something that drifts.
    expect(CALIBRATION_V0.orderSize).toBe(1);
    expect(CALIBRATION_V0.maxRestingOrders).toBe(2);
    expect(CALIBRATION_V0.maxRestingPerMarket).toBe(1);
    expect(CALIBRATION_V0.maxPositionPerMarket).toBe(1);
    expect(D(CALIBRATION_V0.maxWorstCaseExposureUsd).toFixed(2)).toBe('5.00');
    expect(CALIBRATION_V0.maxFillsPerDay).toBe(50);
    expect(CALIBRATION_V0.maxNewOrdersPerDay).toBe(200);
  });
});

describe('calibration market selection', () => {
  // A FRESH store per scenario. `view()` returns a live handle onto the
  // underlying book, so a shared store would have every case observing
  // whichever snapshot was applied last.
  const bookFor = (yesBids: [string, string][], noBids: [string, string][]) => {
    resetOrdinals();
    const store = new MarketStateStore();
    store.applySnapshot(snapshot(1_000, yesBids, noBids));
    return { store, view: store.view(MARKET)! };
  };

  const healthy = () => bookFor([['0.400000', '60.000000']], [['0.550000', '60.000000']]).view;

  const input = (over: Record<string, unknown> = {}) => ({
    marketTicker: MARKET,
    seriesTicker: 'KXHIGHNY',
    book: healthy(),
    state: undefined,
    recentTrades: 5,
    recentDeltas: 40,
    nowMs: 1_000_000,
    ...over,
  });

  it('accepts a healthy two-sided book in the price band', () => {
    const e = assessEligibility(input() as never, CALIBRATION_V0);
    expect(e.eligible).toBe(true);
    expect(e.stratum).toBeDefined();
  });

  it('refuses a book it cannot vouch for', () => {
    const { store, view } = bookFor([['0.400000', '60.000000']], [['0.550000', '60.000000']]);
    // Drive the level negative: MarketBook invalidates rather than clamping.
    store.applyDelta(delta(2_000, 'yes', '0.400000', '-99', '60'));
    expect(assessEligibility(input({ book: view }) as never, CALIBRATION_V0).reason).toBe(
      'book_invalid',
    );
  });

  it('refuses a one-sided book', () => {
    const { view } = bookFor([['0.400000', '60.000000']], []);
    expect(assessEligibility(input({ book: view }) as never, CALIBRATION_V0).reason).toBe(
      'not_two_sided',
    );
  });

  it('refuses the tails', () => {
    // YES bid 0.02, NO bid 0.95 -> YES ask 0.05, mid 0.035: far outside the band.
    const { view } = bookFor([['0.020000', '60.000000']], [['0.950000', '60.000000']]);
    expect(assessEligibility(input({ book: view }) as never, CALIBRATION_V0).reason).toBe(
      'mid_out_of_band',
    );
  });

  it('refuses a market about to close', () => {
    const e = assessEligibility(
      input({
        state: { state: 'OPEN', closeTimeMs: BigInt(1_000_000 + 60_000) },
      }) as never,
      CALIBRATION_V0,
    );
    expect(e.reason).toBe('too_close_to_close');
  });

  it('refuses a market nothing is happening in', () => {
    // A quiet market yields a censored observation with no information in it:
    // the queue never moves and we learn nothing about why.
    expect(assessEligibility(input({ recentDeltas: 1 }) as never, CALIBRATION_V0).reason).toBe(
      'no_recent_activity',
    );
  });

  it('refuses a market that is no longer open', () => {
    expect(
      assessEligibility(
        input({ state: { state: 'CLOSED_UNDETERMINED', closeTimeMs: null } }) as never,
        CALIBRATION_V0,
      ).reason,
    ).toBe('not_active');
  });

  it('classifies depth and flow into four strata', () => {
    expect(stratumId(classify(D(20), 0))).toBe('low_depth/low_flow');
    expect(stratumId(classify(D(20), 10))).toBe('low_depth/high_flow');
    expect(stratumId(classify(D(400), 0))).toBe('high_depth/low_flow');
    expect(stratumId(classify(D(400), 10))).toBe('high_depth/high_flow');
  });

  it('rotates to the least-sampled stratum rather than the deepest book', () => {
    // The instinct is to probe the most liquid contract because a fill is more
    // likely there. That instinct would produce a queue model that only
    // describes deep books.
    const candidates: Candidate[] = [
      {
        marketTicker: 'DEEP',
        seriesTicker: 'S',
        stratum: { depth: 'high_depth', flow: 'high_flow' },
        mid: D('0.5'),
        touchDepth: D(900),
      },
      {
        marketTicker: 'THIN',
        seriesTicker: 'S',
        stratum: { depth: 'low_depth', flow: 'low_flow' },
        mid: D('0.5'),
        touchDepth: D(10),
      },
    ];
    const sampled = new Map([['high_depth/high_flow', 12], ['low_depth/low_flow', 1]]);
    expect(selectNext(candidates, sampled, () => 0)!.marketTicker).toBe('THIN');
  });

  it('chooses a side by coin flip, not by expected fill', () => {
    expect(chooseSide(() => 0.1)).toBe('bid');
    expect(chooseSide(() => 0.9)).toBe('ask');
  });

  it('draws a dwell from the configured set', () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      expect(DWELL_CHOICES_MS).toContain(chooseDwellMs(() => r));
    }
  });
});

describe('level activity', () => {
  const tracker = new LevelActivityTracker();

  it('separates executed volume from withdrawals', () => {
    resetOrdinals();
    const key = tracker.watch(MARKET, 'bid', D('0.40'));

    tracker.onTrade(trade(1_000, '0.400000', '25', 'no'));
    tracker.onDelta(delta(1_001, 'yes', '0.400000', '-25', '100'));
    tracker.onDelta(delta(1_002, 'yes', '0.400000', '-10', '75'));
    tracker.onDelta(delta(1_003, 'yes', '0.400000', '40', '65'));

    const a = tracker.snapshot(key);
    // The 25 that traded is executed, not withdrawn; the following delta is
    // its consequence, not evidence of a cancellation. Counting it twice would
    // be absorbed by the fitted alpha.
    expect(a.executed.toFixed(0)).toBe('25');
    expect(a.removed.toFixed(0)).toBe('10');
    expect(a.added.toFixed(0)).toBe('40');
    expect(a.trades).toBe(1);
  });

  it('attributes a print to the side of the book the aggressor consumed', () => {
    resetOrdinals();
    const bid = tracker.watch(MARKET, 'bid', D('0.30'));
    const ask = tracker.watch(MARKET, 'ask', D('0.30'));

    // Taker bought YES at 0.30: consumed the YES ask, which is a NO bid at
    // 0.70. Only a probe resting on the ask side has volume ahead of it.
    tracker.onTrade(trade(2_000, '0.300000', '7', 'yes'));
    expect(tracker.snapshot(bid).executed.isZero()).toBe(true);
    expect(tracker.snapshot(ask).executed.toFixed(0)).toBe('7');
  });

  it('ignores levels it is not watching', () => {
    resetOrdinals();
    const key = tracker.watch(MARKET, 'bid', D('0.10'));
    tracker.onDelta(delta(3_000, 'yes', '0.900000', '-50', '80'));
    expect(tracker.snapshot(key).removed.isZero()).toBe(true);
  });

  it('forgets a level once the probe is done', () => {
    resetOrdinals();
    const key = tracker.watch(MARKET, 'bid', D('0.20'));
    tracker.unwatch(key);
    tracker.onDelta(delta(4_000, 'yes', '0.200000', '-5', '10'));
    expect(tracker.snapshot(key).removed.isZero()).toBe(true);
  });
});

describe('decimal guard', () => {
  it('keeps exposure arithmetic exact', () => {
    let total: Decimal = ZERO;
    for (let i = 0; i < 10; i++) total = total.plus(D('0.1'));
    expect(total.toString()).toBe('1');
  });
});
