import { describe, expect, it } from 'vitest';
import { MemoryHistoricalDataSource } from '@/src/research/data/memorySource';
import { runBacktest } from '@/src/research/engine/runBacktest';
import { makeFeeModel, makeFillModel, makeLatencyModel, makeStrategy } from '@/src/research/registry';
import { syntheticStream } from './fixtures';

/**
 * Reproducibility is the property that makes a backtest evidence rather than
 * an anecdote. Two runs of the same manifest must agree exactly -- not
 * approximately, not statistically.
 */

const request = { datasetId: 'test', startTime: new Date(0), endTime: new Date(1_000_000) };

/** Enough movement to make a quoting strategy work for a living. */
const busyStream = () => syntheticStream(400, 4242);

async function run(seed: number) {
  const events = busyStream();
  return runBacktest({
    source: new MemoryHistoricalDataSource(events),
    request,
    strategy: makeStrategy('join-bbo', { size: '10', maxInventory: '40', minSpreadCents: 1 }),
    fillModel: makeFillModel('conservative_queue'),
    feeModel: makeFeeModel('kalshi'),
    latency: makeLatencyModel(50),
    randomSeed: seed,
    verifyCheckpoints: false,
    now: () => new Date('2026-09-14T00:00:00.000Z'),
  });
}

const shape = (r: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify({
    orders: r.result.orders.map((o) => [
      o.clientOrderId,
      o.status,
      o.yesPrice.toFixed(6),
      o.filledQuantity.toFixed(6),
      o.effectiveAtMs.toString(),
      o.terminalAtMs?.toString() ?? null,
    ]),
    fills: r.result.fills.map((f) => [
      f.fillId,
      f.orderId,
      f.yesPrice.toFixed(6),
      f.quantity.toFixed(6),
      f.filledAtMs.toString(),
      f.reason,
      f.fee.toFixed(6),
    ]),
    equity: r.result.equityCurve,
    // `performance` is timing telemetry -- wall clock and RSS -- and is
    // deliberately excluded. It is the one part of a run that is SUPPOSED to
    // vary between executions; asserting on it would be asserting that the
    // machine was equally busy both times.
    summary: { ...r.summary, performance: undefined },
    markouts: r.markouts,
  });

describe('determinism', () => {
  it('produces identical orders, fills, positions and PnL on a rerun', async () => {
    const a = await run(1);
    const b = await run(1);
    expect(shape(b)).toBe(shape(a));
  });

  it('produces the same run key for the same inputs', async () => {
    const a = await run(1);
    const b = await run(1);
    expect(b.manifest.runKey).toBe(a.manifest.runKey);
    expect(b.manifest.runId).toBe(a.manifest.runId);
  });

  it('changes the run key when the seed changes', async () => {
    const a = await run(1);
    const b = await run(2);
    expect(b.manifest.runKey).not.toBe(a.manifest.runKey);
  });

  it('changes the run key when an assumption changes, and the assumption bites', async () => {
    const base = await run(1);

    const touch = await runBacktest({
      source: new MemoryHistoricalDataSource(busyStream()),
      request,
      strategy: makeStrategy('join-bbo', { size: '10', maxInventory: '40', minSpreadCents: 1 }),
      fillModel: makeFillModel('touch'),
      feeModel: makeFeeModel('kalshi'),
      latency: makeLatencyModel(50),
      randomSeed: 1,
      verifyCheckpoints: false,
      now: () => new Date('2026-09-14T00:00:00.000Z'),
    });

    expect(touch.manifest.runKey).not.toBe(base.manifest.runKey);
    // An invariant, not a coincidence: `touch` assumes the front of every
    // queue, so it can never fill LESS than the conservative model on the same
    // stream. If this ever inverts, one of the two models is wrong.
    expect(touch.summary.execution.fills).toBeGreaterThanOrEqual(
      base.summary.execution.fills,
    );
  });

  it('hashes the run key independently of key order in the parameters', async () => {
    const one = await runBacktest({
      source: new MemoryHistoricalDataSource(busyStream()),
      request,
      strategy: makeStrategy('join-bbo', { size: '10', maxInventory: '40' }),
      fillModel: makeFillModel('touch'),
      feeModel: makeFeeModel('zero'),
      latency: makeLatencyModel(0),
      verifyCheckpoints: false,
      now: () => new Date('2026-09-14T00:00:00.000Z'),
    });
    const two = await runBacktest({
      source: new MemoryHistoricalDataSource(busyStream()),
      request,
      strategy: makeStrategy('join-bbo', { maxInventory: '40', size: '10' }),
      fillModel: makeFillModel('touch'),
      feeModel: makeFeeModel('zero'),
      latency: makeLatencyModel(0),
      verifyCheckpoints: false,
      now: () => new Date('2026-09-14T00:00:00.000Z'),
    });
    expect(two.manifest.runKey).toBe(one.manifest.runKey);
  });

  it('records every assumption needed to reproduce the run', async () => {
    const { manifest } = await run(1);
    expect(manifest.datasetFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.fillModelParameters).toBeTruthy();
    expect(manifest.latencyModel).toBeTruthy();
    expect(manifest.feeModel).toBeTruthy();
    expect(manifest.strategyParameters).toBeTruthy();
    expect(manifest.captureGapPolicy).toBe('skip_until_fresh_snapshot');
    expect(manifest.engineVersion).toBeTruthy();
  });
});
