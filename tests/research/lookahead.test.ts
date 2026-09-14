import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';
import { MemoryHistoricalDataSource } from '@/src/research/data/memorySource';
import { BacktestEngine } from '@/src/research/engine/backtestEngine';
import { BaseStrategy } from '@/src/research/strategy/strategy';
import type { StrategyContext } from '@/src/research/strategy/context';
import type { ResearchEvent, TradeEvent } from '@/src/research/events/researchEvent';
import { TouchFillModel } from '@/src/research/execution/fills/touchFillModel';
import { ZeroFeeModel } from '@/src/research/portfolio/fees';
import { FixedLatencyModel, ZeroLatencyModel } from '@/src/research/execution/latencyModel';
import type { Fill } from '@/src/research/execution/executionAdapter';
import {
  MARKET,
  OPENING_SNAPSHOT_LEVELS,
  delta,
  resetOrdinals,
  snapshot,
  trade,
} from './fixtures';

/**
 * Lookahead is the failure that makes a backtest confidently wrong, and it
 * never announces itself: the equity curve simply looks excellent. These tests
 * pin the exact instants at which an order may and may not act.
 */

const request = {
  datasetId: 'test',
  startTime: new Date(0),
  endTime: new Date(1_000_000),
};

/** Submits one bid the first time it sees a trade, then never again. */
class BidOnFirstTrade extends BaseStrategy {
  readonly name = 'bid-on-first-trade';
  submittedAtMs: bigint | null = null;
  readonly fills: Fill[] = [];

  onTrade(event: TradeEvent, ctx: StrategyContext): void {
    if (this.submittedAtMs !== null) return;
    this.submittedAtMs = ctx.clock.nowMs();
    ctx.orders.submit({
      type: 'limit',
      marketTicker: event.marketTicker,
      side: 'yes',
      action: 'buy',
      price: new Decimal('0.40'),
      quantity: new Decimal(10),
      clientOrderId: 'c1',
    });
  }

  onFill(fill: Fill): void {
    this.fills.push(fill);
  }
}

async function run(events: ResearchEvent[], latencyMs: number) {
  const strategy = new BidOnFirstTrade();
  const engine = new BacktestEngine({
    source: new MemoryHistoricalDataSource(events),
    request,
    strategy,
    fillModel: new TouchFillModel(),
    feeModel: new ZeroFeeModel(),
    latency: latencyMs === 0 ? new ZeroLatencyModel() : FixedLatencyModel.uniform(latencyMs),
    verifyCheckpoints: false,
  });
  const result = await engine.run();
  return { strategy, result };
}

describe('lookahead', () => {
  it('cannot fill on the very event that triggered the order', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, OPENING_SNAPSHOT_LEVELS.yesBids, OPENING_SNAPSHOT_LEVELS.noBids),
      // The strategy reacts to this print. Even at zero latency the order
      // cannot be resting in time to be part of it.
      trade(2_000, '0.400000', '50', 'no'),
      trade(3_000, '0.400000', '50', 'no'),
    ];

    const { strategy } = await run(events, 0);
    expect(strategy.submittedAtMs).toBe(2_000n);
    expect(strategy.fills).toHaveLength(1);
    expect(strategy.fills[0]!.filledAtMs).toBe(3_000n);
  });

  it('does not activate an order before its latency has elapsed', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, OPENING_SNAPSHOT_LEVELS.yesBids, OPENING_SNAPSHOT_LEVELS.noBids),
      trade(2_000, '0.400000', '50', 'no'), // triggers the order; effective at 2100
      trade(2_050, '0.400000', '50', 'no'), // still in flight: must not fill
      trade(2_150, '0.400000', '50', 'no'), // now resting: this is the one
    ];

    const { strategy } = await run(events, 100);
    expect(strategy.fills).toHaveLength(1);
    expect(strategy.fills[0]!.arrivedAtMs).toBe(2_100n);
    expect(strategy.fills[0]!.filledAtMs).toBe(2_150n);
  });

  it('charges more latency for more fills to be missed', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, OPENING_SNAPSHOT_LEVELS.yesBids, OPENING_SNAPSHOT_LEVELS.noBids),
      trade(2_000, '0.400000', '2', 'no'),
      trade(2_100, '0.400000', '2', 'no'),
      trade(2_200, '0.400000', '2', 'no'),
      trade(2_300, '0.400000', '2', 'no'),
      trade(2_400, '0.400000', '2', 'no'),
    ];

    const fast = await run(events, 0);
    const slow = await run(events, 250);
    expect(fast.strategy.fills.length).toBeGreaterThan(slow.strategy.fills.length);
  });

  it('refuses an event stream that moves time backwards', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, OPENING_SNAPSHOT_LEVELS.yesBids, OPENING_SNAPSHOT_LEVELS.noBids),
      delta(3_000, 'yes', '0.390000', '10', '0'),
      delta(2_000, 'yes', '0.380000', '10', '0'),
    ];
    await expect(run(events, 0)).rejects.toThrow(/moved backwards/);
  });

  it('shows the strategy only the state that exists at its own clock', async () => {
    resetOrdinals();
    // The best bid improves at 2000 and again at 4000. At each callback the
    // strategy must see the state produced by events up to and including that
    // one, and nothing later.
    const events: ResearchEvent[] = [
      snapshot(1_000, [['0.400000', '100.000000']], [['0.550000', '100.000000']]),
      delta(2_000, 'yes', '0.410000', '25', '0'),
      delta(4_000, 'yes', '0.420000', '25', '0'),
    ];

    const seen: { atMs: string; bid: string }[] = [];
    class Observer extends BaseStrategy {
      readonly name = 'observer';
      onBookUpdate(_e: unknown, ctx: StrategyContext): void {
        const bid = ctx.state(MARKET)?.book.bbo().bid;
        seen.push({ atMs: ctx.clock.nowMs().toString(), bid: bid?.toFixed(2) ?? 'none' });
      }
    }

    const engine = new BacktestEngine({
      source: new MemoryHistoricalDataSource(events),
      request,
      strategy: new Observer(),
      fillModel: new TouchFillModel(),
      feeModel: new ZeroFeeModel(),
      latency: new ZeroLatencyModel(),
      verifyCheckpoints: false,
    });
    await engine.run();

    expect(seen).toEqual([
      { atMs: '1000', bid: '0.40' },
      { atMs: '2000', bid: '0.41' },
      { atMs: '4000', bid: '0.42' },
    ]);
  });

  it('fires a timer at its simulated due time, not on wall time', async () => {
    resetOrdinals();
    const fired: string[] = [];
    class Timed extends BaseStrategy {
      readonly name = 'timed';
      onStart(ctx: StrategyContext): void {
        ctx.scheduleAfter(1_500n, 'reprice');
      }
      onTimer(event: { label: string }, ctx: StrategyContext): void {
        fired.push(`${event.label}@${ctx.clock.nowMs()}`);
      }
    }

    const events: ResearchEvent[] = [
      snapshot(1_000, OPENING_SNAPSHOT_LEVELS.yesBids, OPENING_SNAPSHOT_LEVELS.noBids),
      delta(5_000, 'yes', '0.390000', '10', '0'),
    ];
    const engine = new BacktestEngine({
      source: new MemoryHistoricalDataSource(events),
      request,
      strategy: new Timed(),
      fillModel: new TouchFillModel(),
      feeModel: new ZeroFeeModel(),
      latency: new ZeroLatencyModel(),
      verifyCheckpoints: false,
    });
    await engine.run();

    // Scheduled at clock zero, before the first event, so it is due at 1500.
    expect(fired).toEqual(['reprice@1500']);
  });

  it('refuses to schedule a timer into the past', async () => {
    resetOrdinals();
    class BadTimer extends BaseStrategy {
      readonly name = 'bad-timer';
      onBookUpdate(_e: unknown, ctx: StrategyContext): void {
        ctx.scheduleAfter(-1n, 'rewind');
      }
    }
    const engine = new BacktestEngine({
      source: new MemoryHistoricalDataSource([
        snapshot(1_000, OPENING_SNAPSHOT_LEVELS.yesBids, OPENING_SNAPSHOT_LEVELS.noBids),
      ]),
      request,
      strategy: new BadTimer(),
      fillModel: new TouchFillModel(),
      feeModel: new ZeroFeeModel(),
      latency: new ZeroLatencyModel(),
      verifyCheckpoints: false,
    });
    await expect(engine.run()).rejects.toThrow(/lookahead/);
  });
});
