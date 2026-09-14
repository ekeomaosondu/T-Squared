import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';
import { MemoryHistoricalDataSource } from '@/src/research/data/memorySource';
import { BacktestEngine, type CaptureGapPolicy } from '@/src/research/engine/backtestEngine';
import { BaseStrategy } from '@/src/research/strategy/strategy';
import type { StrategyContext } from '@/src/research/strategy/context';
import type { CaptureGapEvent, ResearchEvent } from '@/src/research/events/researchEvent';
import type { Fill } from '@/src/research/execution/executionAdapter';
import { TouchFillModel } from '@/src/research/execution/fills/touchFillModel';
import { ZeroFeeModel } from '@/src/research/portfolio/fees';
import { ZeroLatencyModel } from '@/src/research/execution/latencyModel';
import { MARKET, delta, gap, resetOrdinals, snapshot, trade } from './fixtures';

/**
 * A capture gap is an interval nobody was recording. The market kept trading;
 * we simply did not see it. Every one of these assertions exists to stop a
 * backtest from reading that silence as calm.
 */

const request = { datasetId: 'test', startTime: new Date(0), endTime: new Date(1_000_000) };

/** Quotes a bid whenever it has none, and records what it was told. */
class Quoter extends BaseStrategy {
  readonly name = 'quoter';
  readonly fills: Fill[] = [];
  readonly gaps: CaptureGapEvent[] = [];
  readonly resumes: { market: string; atMs: string }[] = [];
  readonly validityAtBookUpdate: { atMs: string; valid: boolean }[] = [];
  private seq = 0;
  private working: string | null = null;

  onBookUpdate(event: { marketTicker?: string }, ctx: StrategyContext): void {
    const state = ctx.state(event.marketTicker!);
    this.validityAtBookUpdate.push({
      atMs: ctx.clock.nowMs().toString(),
      valid: state?.valid ?? false,
    });
    if (!state?.valid || this.working !== null) return;
    this.working = `q${++this.seq}`;
    ctx.orders.submit({
      type: 'limit',
      marketTicker: event.marketTicker!,
      side: 'yes',
      action: 'buy',
      price: new Decimal('0.40'),
      quantity: new Decimal(10),
      clientOrderId: this.working,
    });
  }

  onOrderUpdate(update: { clientOrderId: string; status: string }): void {
    if (update.clientOrderId === this.working && update.status !== 'resting' && update.status !== 'pending') {
      this.working = null;
    }
  }

  onFill(fill: Fill): void {
    this.fills.push(fill);
  }

  onDataGap(event: CaptureGapEvent): void {
    this.gaps.push(event);
    this.working = null;
  }

  onDataResume(marketTicker: string, ctx: StrategyContext): void {
    this.resumes.push({ market: marketTicker, atMs: ctx.clock.nowMs().toString() });
  }
}

/** valid stream -> gap -> fresh recovery snapshot -> valid stream. */
function gappedStream(): ResearchEvent[] {
  resetOrdinals();
  return [
    snapshot(1_000, [['0.400000', '100.000000']], [['0.550000', '100.000000']]),
    delta(1_100, 'yes', '0.390000', '20', '0'),
    trade(1_200, '0.400000', '5', 'no'),

    // Coverage is lost here and restored at 9000.
    gap(2_000, 9_000),

    // A trade printed while we were blind. It must not fill anything: we have
    // no evidence about the book it happened in.
    trade(5_000, '0.400000', '500', 'no'),

    // Fresh exchange snapshot: coverage restored.
    snapshot(9_000, [['0.400000', '80.000000']], [['0.560000', '80.000000']], {
      seq: 500,
      source: 'ws_recovery',
    }),
    trade(9_500, '0.400000', '50', 'no'),
    trade(10_000, '0.400000', '50', 'no'),
  ];
}

async function run(policy: CaptureGapPolicy = 'skip_until_fresh_snapshot') {
  const strategy = new Quoter();
  const engine = new BacktestEngine({
    source: new MemoryHistoricalDataSource(gappedStream()),
    request,
    strategy,
    fillModel: new TouchFillModel(),
    feeModel: new ZeroFeeModel(),
    latency: new ZeroLatencyModel(),
    gapPolicy: policy,
    verifyCheckpoints: false,
  });
  return { strategy, result: await engine.run() };
}

describe('capture gaps', () => {
  it('tells the strategy, and names the markets affected', async () => {
    const { strategy } = await run();
    expect(strategy.gaps).toHaveLength(1);
    expect(strategy.gaps[0]!.affectedMarkets).toContain(MARKET);
    expect(strategy.gaps[0]!.startedAtMs).toBe(2_000n);
    expect(strategy.gaps[0]!.endedAtMs).toBe(9_000n);
  });

  it('invalidates the book rather than carrying it across the gap', async () => {
    const { result } = await run();
    expect(result.bookStats.gapsOpened).toBe(1);
    // Deltas arriving against an unseeded book are dropped, not applied.
    expect(result.bookStats.deltasDiverged).toBe(0);
  });

  it('produces no fill from a trade inside the gap', async () => {
    const { strategy } = await run();
    // Fills before the gap and after the recovery are legitimate; a fill from
    // the 500-lot print at 5000, while nobody was watching, is not.
    const duringGap = strategy.fills.filter(
      (f) => f.filledAtMs >= 2_000n && f.filledAtMs < 9_000n,
    );
    expect(duringGap).toHaveLength(0);
    expect(strategy.fills.some((f) => f.filledAtMs < 2_000n)).toBe(true);
  });

  it('cancels resting orders when coverage is lost', async () => {
    const { result } = await run();
    const cancelledByGap = result.orders.filter(
      (o) => o.status === 'cancelled' && o.terminalAtMs === 2_000n,
    );
    expect(cancelledByGap.length).toBeGreaterThan(0);
  });

  it('records the invalid interval and closes it at the fresh snapshot', async () => {
    const { result } = await run();
    expect(result.invalidIntervals).toHaveLength(1);
    expect(result.invalidIntervals[0]).toMatchObject({
      marketTicker: MARKET,
      fromMs: '2000',
      toMs: '9000',
      reason: 'capture_gap:restart',
    });
  });

  it('notifies the strategy when a fresh snapshot restores coverage', async () => {
    const { strategy } = await run();
    expect(strategy.resumes).toEqual([{ market: MARKET, atMs: '9000' }]);
  });

  it('resumes trading only after the fresh snapshot', async () => {
    const { strategy, result } = await run();
    expect(strategy.fills.length).toBeGreaterThan(0);
    const postGap = result.orders.filter((o) => o.submittedAtMs >= 9_000n);
    expect(postGap.length).toBeGreaterThan(0);
  });

  it('breaks the mid series at the gap so a markout cannot read across it', async () => {
    const { result } = await run();
    const series = result.midSeries.get(MARKET)!;
    // The mid in force during the blind interval is unknown, not the last one
    // we happened to see.
    expect(series.midAt(5_000)).toBeNull();
    expect(series.midAt(1_500)).not.toBeNull();
    expect(series.midAt(9_500)).not.toBeNull();
  });

  it('stops the run outright under the abort policy', async () => {
    await expect(run('abort')).rejects.toThrow(/nobody was recording/);
  });
});
