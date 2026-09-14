import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';
import {
  applyFillToPosition,
  collateralRequired,
  newPosition,
  settlePosition,
  unrealizedPnl,
  voidPosition,
} from '@/src/research/portfolio/accounting';
import { KalshiHistoricalFeeModel, ZeroFeeModel } from '@/src/research/portfolio/fees';
import {
  loadFeeSchedule,
  parseFeeSchedule,
  scheduleFor,
  type FeeScheduleEntry,
  type FeeScheduleFile,
} from '@/src/research/portfolio/feeSchedule';
import type { HistoricalMarketState } from '@/src/research/data/marketDefinitions';

const D = (v: string | number) => new Decimal(v);

describe('binary-contract accounting', () => {
  it('averages entries and realizes on the closing portion', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    applyFillToPosition(p, D(10), D('0.50'), D(0));
    expect(p.quantity.toString()).toBe('20');
    expect(p.averageEntryPrice.toString()).toBe('0.45');

    const close = applyFillToPosition(p, D(-8), D('0.60'), D(0));
    // 8 contracts closed at 0.60 against an average of 0.45.
    expect(close.realizedDelta.toString()).toBe('1.2');
    expect(p.quantity.toString()).toBe('12');
    expect(p.averageEntryPrice.toString()).toBe('0.45');
  });

  it('realizes correctly on a short closed by a buy', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(-10), D('0.60'), D(0));
    expect(p.quantity.toString()).toBe('-10');
    const close = applyFillToPosition(p, D(10), D('0.55'), D(0));
    // Sold at 0.60, bought back at 0.55.
    expect(close.realizedDelta.toString()).toBe('0.5');
    expect(p.quantity.isZero()).toBe(true);
    expect(p.averageEntryPrice.isZero()).toBe(true);
  });

  it('flips through zero, closing the old position and opening the new one', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    const flip = applyFillToPosition(p, D(-25), D('0.50'), D(0));
    expect(flip.closedQuantity.toString()).toBe('10');
    expect(flip.realizedDelta.toString()).toBe('1'); // 10 * (0.50 - 0.40)
    expect(p.quantity.toString()).toBe('-15');
    // The new short is entered at the fill price, not blended with the old long.
    expect(p.averageEntryPrice.toString()).toBe('0.5');
  });

  it('settles a long at $1 and a short at $0 without a final mark', () => {
    const long = newPosition('M');
    applyFillToPosition(long, D(10), D('0.40'), D(0));
    const s1 = settlePosition(long, D(1));
    expect(s1.cashDelta.toString()).toBe('10');
    expect(s1.realizedDelta.toString()).toBe('6'); // 10 * (1 - 0.40)
    expect(long.quantity.isZero()).toBe(true);
    expect(long.resolution).toBe('SETTLED');

    const short = newPosition('M');
    applyFillToPosition(short, D(-10), D('0.40'), D(0));
    const s0 = settlePosition(short, D(0));
    expect(s0.cashDelta.toString()).toBe('0');
    expect(s0.realizedDelta.toString()).toBe('4'); // -10 * (0 - 0.40)
  });

  it('settles at the payout the exchange stated, not at one it inferred', () => {
    // Kalshi supplies settlement_value. A market that pays something other
    // than a clean dollar must settle at what was actually paid.
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    const applied = settlePosition(p, D('0.75'));
    expect(applied.cashDelta.toString()).toBe('7.5');
    expect(applied.realizedDelta.toString()).toBe('3.5'); // 10 * (0.75 - 0.40)
  });

  it('returns a voided market at cost rather than paying either side', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    const applied = voidPosition(p);
    // Paid 4, got 4 back: exactly zero, not a dollar in either direction.
    expect(applied.cashDelta.toString()).toBe('4');
    expect(applied.realizedDelta.isZero()).toBe(true);
    expect(p.resolution).toBe('VOIDED');
    expect(p.settlementPayout).toBeNull();
  });

  it('refuses to settle twice', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(1), D('0.5'), D(0));
    settlePosition(p, D(1));
    expect(() => settlePosition(p, D(0))).toThrow(/already settled/);
    expect(() => voidPosition(p)).toThrow(/already settled/);
  });

  it('collateralises a short at one dollar minus the sale price', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(-10), D('0.30'), D(0));
    // Selling YES at 0.30 is buying NO at 0.70; the capital at risk is 0.70.
    expect(collateralRequired(p).toString()).toBe('7');
  });

  it('reports a missing mark as null rather than as zero PnL', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    expect(unrealizedPnl(p, null)).toBeNull();
    expect(unrealizedPnl(p, D('0.45'))!.toString()).toBe('0.5');
  });

  it('keeps arithmetic exact where floating point would not', () => {
    const p = newPosition('M');
    for (let i = 0; i < 3; i++) applyFillToPosition(p, D(1), D('0.10'), D(0));
    applyFillToPosition(p, D(-3), D('0.30'), D(0));
    // 3 * (0.30 - 0.10) is exactly 0.6, not 0.6000000000000001.
    expect(p.realizedPnl.toString()).toBe('0.6');
  });
});

describe('Kalshi historical fees', () => {
  const schedule = (over: Partial<FeeScheduleEntry> = {}): FeeScheduleFile =>
    parseFeeSchedule({
      schedules: [
        {
          feeType: 'quadratic',
          baseRate: '0.07',
          makerFeePerContract: '0',
          roundUpToCents: true,
          effectiveFrom: '1970-01-01T00:00:00Z',
          source: 'test',
          verified: true,
          verifiedBy: 'test',
          verifiedAt: '2026-09-14T00:00:00Z',
          ...over,
        },
      ],
      makerRebate: null,
    });

  const market = (over: Partial<HistoricalMarketState> = {}): HistoricalMarketState => ({
    marketTicker: 'M',
    eventTicker: 'E',
    seriesTicker: 'S',
    state: 'OPEN',
    rawStatus: 'active',
    rawResult: null,
    yesSettlementValue: null,
    settlementBasis: 'none',
    notionalValue: D(1),
    isProvisional: false,
    closeTimeMs: null,
    settlementTimeMs: null,
    observedAtMs: null,
    strikeType: null,
    floorStrike: null,
    capStrike: null,
    feeType: 'quadratic',
    feeMultiplier: D(1),
    feeUpdatedAtMs: 1_000n,
    settlementSources: [],
    ...over,
  });

  // `market` is passed inside an options object rather than as a defaulted
  // parameter: an explicit `undefined` argument triggers the default, which
  // would make "no market record" untestable.
  const charge = (
    model: KalshiHistoricalFeeModel,
    price: string,
    opts: { liquidity?: 'maker' | 'taker'; market?: HistoricalMarketState } = {},
  ) =>
    model.fee({
      marketTicker: 'M',
      quantity: D(100),
      yesPrice: D(price),
      liquidity: opts.liquidity ?? 'taker',
      market: 'market' in opts ? opts.market : market(),
      atMs: 2_000n,
    });

  it('is quadratic in price and peaks at fifty cents', () => {
    const model = new KalshiHistoricalFeeModel(schedule());
    // 0.07 * 100 * 0.5 * 0.5 = 1.75
    expect(charge(model, '0.50').amount.toString()).toBe('1.75');
    // The tails are far cheaper: 0.07 * 100 * 0.05 * 0.95 = 0.3325 -> 0.34
    expect(charge(model, '0.05').amount.toString()).toBe('0.34');
    expect(charge(model, '0.05').amount.lt(charge(model, '0.50').amount)).toBe(true);
    expect(charge(model, '0.95').amount.equals(charge(model, '0.05').amount)).toBe(true);
  });

  it('scales by the fee multiplier the exchange reported', () => {
    const model = new KalshiHistoricalFeeModel(schedule());
    const full = charge(model, '0.50');
    const halved = charge(model, '0.50', { market: market({ feeMultiplier: D('0.5') }) });
    expect(halved.amount.toString()).toBe('0.88'); // 0.875 rounded up to the cent
    expect(halved.amount.lt(full.amount)).toBe(true);
  });

  it('rounds a fee up to the next cent', () => {
    const model = new KalshiHistoricalFeeModel(schedule());
    const fee = model.fee({
      marketTicker: 'M',
      quantity: D(1),
      yesPrice: D('0.50'),
      liquidity: 'taker',
      market: market(),
      atMs: 2_000n,
    });
    // 0.07 * 1 * 0.25 = 0.0175 -> 0.02
    expect(fee.amount.toString()).toBe('0.02');
  });

  it('applies a configured maker fee per contract', () => {
    const model = new KalshiHistoricalFeeModel(schedule({ makerFeePerContract: '0.0025' }));
    expect(charge(model, '0.50', { liquidity: 'maker' }).amount.toString()).toBe('0.25');
  });

  it('reports an UNKNOWN fee, not zero, when the schedule is unverified', () => {
    const model = new KalshiHistoricalFeeModel(schedule({ verified: false }));
    const fee = charge(model, '0.50');
    expect(fee.known).toBe(false);
    expect(fee.reason).toBe('schedule_entry_unverified');
    expect(model.provenance().verified).toBe(false);
    expect(model.provenance().unverifiedReasons.join(' ')).toMatch(/not marked verified/);
  });

  it('reports an unknown fee when the market has no record at all', () => {
    const model = new KalshiHistoricalFeeModel(schedule());
    const fee = charge(model, '0.50', { market: undefined });
    expect(fee.known).toBe(false);
    expect(fee.reason).toBe('market_state_missing');
    expect(model.provenance().unresolvedMarkets).toContain('M');
  });

  it('reports an unknown fee when the fee type has no schedule entry', () => {
    const model = new KalshiHistoricalFeeModel(schedule());
    const fee = charge(model, '0.50', { market: market({ feeType: 'flat' }) });
    expect(fee.known).toBe(false);
    expect(fee.reason).toBe('schedule_entry_missing');
  });

  it('reports an unknown fee when the exchange gave no fee type', () => {
    const model = new KalshiHistoricalFeeModel(schedule());
    const fee = charge(model, '0.50', { market: market({ feeType: null }) });
    expect(fee.known).toBe(false);
    expect(fee.reason).toBe('fee_type_missing');
  });

  it('selects the entry in force at the time of the fill', () => {
    const file = parseFeeSchedule({
      schedules: [
        {
          feeType: 'quadratic',
          baseRate: '0.07',
          makerFeePerContract: '0',
          roundUpToCents: true,
          effectiveFrom: '1970-01-01T00:00:00Z',
          source: 'old',
          verified: true,
          verifiedBy: 't',
          verifiedAt: null,
        },
        {
          feeType: 'quadratic',
          baseRate: '0.035',
          makerFeePerContract: '0',
          roundUpToCents: true,
          effectiveFrom: '2026-01-01T00:00:00Z',
          source: 'new',
          verified: true,
          verifiedBy: 't',
          verifiedAt: null,
        },
      ],
      makerRebate: null,
    });

    // A schedule change is a NEW entry, so re-running an old backtest keeps
    // charging the old rate rather than silently adopting today's.
    const before = scheduleFor(file, 'quadratic', BigInt(Date.parse('2025-06-01T00:00:00Z')));
    const after = scheduleFor(file, 'quadratic', BigInt(Date.parse('2026-06-01T00:00:00Z')));
    expect(before?.baseRate).toBe('0.07');
    expect(after?.baseRate).toBe('0.035');
  });

  it('does not conflate a deliberate zero with an unknown fee', () => {
    const zero = new ZeroFeeModel();
    expect(zero.fee().known).toBe(true);
    expect(zero.provenance().verified).toBe(true);
  });

  it('never applies a market-maker rebate by default', () => {
    // Ordinary-member economics and market-maker economics are different
    // claims; conflating them overstates the second.
    expect(new KalshiHistoricalFeeModel(schedule()).provenance().makerRebateApplied).toBe(false);
    expect(new ZeroFeeModel().provenance().makerRebateApplied).toBe(false);
  });
});

describe('the shipped fee schedule', () => {
  it('is currently UNVERIFIED, so runs must report net PnL as unavailable', async () => {
    // A canary. When someone verifies the schedule against Kalshi's published
    // document they should flip this expectation deliberately, not discover
    // later that a run had been quietly assuming a rate all along.
    const file = await loadFeeSchedule();
    const quadratic = file.schedules.find((s) => s.feeType === 'quadratic');
    expect(quadratic).toBeDefined();
    expect(quadratic!.verified).toBe(false);
    expect(quadratic!.source).toMatch(/kalshi/i);
  });
});
