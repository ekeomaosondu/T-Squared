import { describe, expect, it } from 'vitest';
import { Decimal, D } from '@/src/book/decimal';
import { MemoryHistoricalDataSource } from '@/src/research/data/memorySource';
import { BacktestEngine } from '@/src/research/engine/backtestEngine';
import { BaseStrategy } from '@/src/research/strategy/strategy';
import type { StrategyContext } from '@/src/research/strategy/context';
import type { ResearchEvent } from '@/src/research/events/researchEvent';
import { TouchFillModel } from '@/src/research/execution/fills/touchFillModel';
import { ZeroFeeModel } from '@/src/research/portfolio/fees';
import { ZeroLatencyModel } from '@/src/research/execution/latencyModel';
import {
  resolveLifecycleState,
  yesPayout,
  type HistoricalMarketState,
} from '@/src/research/data/marketDefinitions';
import { MARKET, resetOrdinals, snapshot, trade } from './fixtures';

/**
 * Settlement is what turns a backtest result from a mark into a fact. These
 * tests pin the four ways a position can fail to settle, because collapsing
 * them is how a fixable data gap gets mistaken for an unfixable one.
 */

const request = { datasetId: 'test', startTime: new Date(0), endTime: new Date(1_000_000) };

function marketState(over: Partial<HistoricalMarketState> = {}): HistoricalMarketState {
  return {
    marketTicker: MARKET,
    eventTicker: 'KXHIGHNY-26SEP13',
    seriesTicker: 'KXHIGHNY',
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
    feeUpdatedAtMs: null,
    settlementSources: [],
    ...over,
  };
}

/** Buys 10 YES at 0.40 by crossing, then does nothing. */
class BuyOnce extends BaseStrategy {
  readonly name: string = 'buy-once';
  private done = false;
  onBookUpdate(_e: unknown, ctx: StrategyContext): void {
    if (this.done) return;
    this.done = true;
    ctx.orders.submit({
      type: 'limit',
      marketTicker: MARKET,
      side: 'yes',
      action: 'buy',
      price: new Decimal('0.60'),
      quantity: new Decimal(10),
      clientOrderId: 'buy',
    });
  }
}

function events(): ResearchEvent[] {
  resetOrdinals();
  return [
    // A YES ask at 0.40 (a NO bid at 0.60) with 10 resting, and a bid at 0.35
    // so the book stays two-sided and markable.
    snapshot(1_000, [['0.350000', '50.000000']], [['0.600000', '10.000000']]),
    trade(2_000, '0.400000', '1', 'yes'),
    snapshot(3_000, [['0.350000', '50.000000']], [['0.550000', '40.000000']], { seq: 9 }),
  ];
}

async function run(states: Map<string, HistoricalMarketState>) {
  const engine = new BacktestEngine({
    source: new MemoryHistoricalDataSource(events(), [], states),
    request,
    strategy: new BuyOnce(),
    fillModel: new TouchFillModel(),
    feeModel: new ZeroFeeModel(),
    latency: new ZeroLatencyModel(),
    verifyCheckpoints: false,
  });
  return engine.run();
}

describe('lifecycle resolution', () => {
  it('maps the exchange status and result onto a state', () => {
    expect(resolveLifecycleState('active', null)).toBe('OPEN');
    expect(resolveLifecycleState('closed', null)).toBe('CLOSED_UNDETERMINED');
    expect(resolveLifecycleState('closed', '')).toBe('CLOSED_UNDETERMINED');
    expect(resolveLifecycleState('settled', 'yes')).toBe('DETERMINED_YES');
    expect(resolveLifecycleState('settled', 'no')).toBe('DETERMINED_NO');
    expect(resolveLifecycleState('settled', 'void')).toBe('VOIDED');
  });

  it('refuses to guess a side it does not recognise', () => {
    // An unknown result must leave the market undetermined. The cost of
    // guessing is a fabricated dollar per contract.
    expect(resolveLifecycleState('settled', 'something_new')).toBe('CLOSED_UNDETERMINED');
    expect(resolveLifecycleState('some_new_status', null)).toBe('OPEN');
  });

  it('prefers the exchange settlement value over an inference from the result', () => {
    const fromValue = yesPayout('DETERMINED_NO', D('1'), D(1));
    // The result says NO but the exchange says it paid a dollar. The exchange
    // is what actually happened.
    expect(fromValue.value!.toString()).toBe('1');
    expect(fromValue.basis).toBe('settlement_value');

    const fromResult = yesPayout('DETERMINED_YES', null, D(1));
    expect(fromResult.value!.toString()).toBe('1');
    expect(fromResult.basis).toBe('result');
  });

  it('normalises the payout by the contract notional', () => {
    // Notional is exchange-supplied and must not be assumed to be a dollar.
    const payout = yesPayout('DETERMINED_YES', D('50'), D('100'));
    expect(payout.value!.toString()).toBe('0.5');
  });
});

describe('settlement in a run', () => {
  it('settles a determined market at the payout, not at the last mid', async () => {
    const result = await run(
      new Map([
        [
          MARKET,
          marketState({
            state: 'DETERMINED_YES',
            rawStatus: 'settled',
            rawResult: 'yes',
            yesSettlementValue: D(1),
            settlementBasis: 'settlement_value',
          }),
        ],
      ]),
    );

    expect(result.settlement.settled).toBe(1);
    // Bought 10 at 0.40, settled at 1.00.
    expect(result.portfolio.settlementPnl.toString()).toBe('6');
    // The mid at the end was 0.40, so a marked run would have said zero. The
    // difference between the two numbers is the whole point of settling.
    const last = result.equityCurve[result.equityCurve.length - 1]!;
    expect(last.unrealizedMarkPnl).toBe('0.000000');
    expect(last.grossPnl).toBe('6.000000');
  });

  it('settles a determined-no market at zero', async () => {
    const result = await run(
      new Map([
        [
          MARKET,
          marketState({
            state: 'DETERMINED_NO',
            rawResult: 'no',
            yesSettlementValue: D(0),
            settlementBasis: 'settlement_value',
          }),
        ],
      ]),
    );
    expect(result.settlement.settled).toBe(1);
    expect(result.portfolio.settlementPnl.toString()).toBe('-4');
  });

  it('returns a voided market at cost', async () => {
    const result = await run(
      new Map([[MARKET, marketState({ state: 'VOIDED', rawResult: 'void' })]]),
    );
    expect(result.settlement.voided).toBe(1);
    expect(result.portfolio.settlementPnl.isZero()).toBe(true);
    const last = result.equityCurve[result.equityCurve.length - 1]!;
    expect(last.grossPnl).toBe('0.000000');
  });

  it('distinguishes a run that ended early from a market awaiting a ruling', async () => {
    const stillOpen = await run(new Map([[MARKET, marketState({ state: 'OPEN' })]]));
    expect(stillOpen.settlement.openAtRunEnd).toBe(1);
    expect(stillOpen.settlement.awaitingDetermination).toBe(0);

    const closed = await run(
      new Map([[MARKET, marketState({ state: 'CLOSED_UNDETERMINED', rawStatus: 'closed' })]]),
    );
    // Trading is over and the exchange has not ruled. Extending the window
    // would not help; only waiting would.
    expect(closed.settlement.awaitingDetermination).toBe(1);
    expect(closed.settlement.openAtRunEnd).toBe(0);
  });

  it('reports a held market with no record in the lake as a pipeline gap', async () => {
    const result = await run(new Map());
    expect(result.settlement.noMarketState).toEqual([MARKET]);
    expect(result.settlement.settled).toBe(0);
  });

  it('flags a provisional determination as revisable', async () => {
    const result = await run(
      new Map([
        [
          MARKET,
          marketState({
            state: 'DETERMINED_YES',
            yesSettlementValue: D(1),
            settlementBasis: 'settlement_value',
            isProvisional: true,
          }),
        ],
      ]),
    );
    expect(result.settlement.settled).toBe(1);
    expect(result.settlement.provisional).toEqual([MARKET]);
  });

  it('records how each payout was established', async () => {
    const result = await run(
      new Map([
        [
          MARKET,
          marketState({
            state: 'DETERMINED_YES',
            yesSettlementValue: D(1),
            settlementBasis: 'settlement_value',
          }),
        ],
      ]),
    );
    expect(result.settlement.basisCounts).toEqual({ settlement_value: 1 });
  });

  it('never lets a determination reach the strategy', async () => {
    // Settlement is a fact from after the run window. If a strategy could see
    // it, every result would be perfect.
    let sawSettlement = false;
    class Peeker extends BuyOnce {
      readonly name = 'peeker';
      onStop(ctx: StrategyContext): void {
        // The only market information reachable from a context is the book.
        const state = ctx.state(MARKET);
        sawSettlement =
          state !== undefined && Object.keys(state).some((k) => /settle|result|determin/i.test(k));
      }
    }

    const engine = new BacktestEngine({
      source: new MemoryHistoricalDataSource(
        events(),
        [],
        new Map([[MARKET, marketState({ state: 'DETERMINED_YES', yesSettlementValue: D(1) })]]),
      ),
      request,
      strategy: new Peeker(),
      fillModel: new TouchFillModel(),
      feeModel: new ZeroFeeModel(),
      latency: new ZeroLatencyModel(),
      verifyCheckpoints: false,
    });
    await engine.run();
    expect(sawSettlement).toBe(false);
  });
});
