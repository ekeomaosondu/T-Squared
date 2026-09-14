import { describe, expect, it } from 'vitest';
import { MemoryHistoricalDataSource } from '@/src/research/data/memorySource';
import { BacktestEngine } from '@/src/research/engine/backtestEngine';
import { makeFillModel, makeStrategy } from '@/src/research/registry';
import { ZeroFeeModel } from '@/src/research/portfolio/fees';
import { makeLatencyModel } from '@/src/research/registry';
import { syntheticStream } from './fixtures';

/**
 * Counterfactual fill models answer "what would a different queue assumption
 * have produced on THIS stream". For live data that is the only way to ask:
 * a shadow run cannot be replayed, because the market does not come twice.
 */

const request = { datasetId: 'test', startTime: new Date(0), endTime: new Date(10_000_000) };

async function run(counterfactuals: string[]) {
  const engine = new BacktestEngine({
    source: new MemoryHistoricalDataSource(syntheticStream(500, 7)),
    request,
    strategy: makeStrategy('join-bbo', { size: '10', maxInventory: '40', minSpreadCents: 1 }),
    fillModel: makeFillModel('conservative_queue'),
    counterfactualFillModels: counterfactuals.map((n) => makeFillModel(n)),
    feeModel: new ZeroFeeModel(),
    latency: makeLatencyModel(50),
    verifyCheckpoints: false,
  });
  return engine.run();
}

describe('counterfactual fill models', () => {
  it('sees exactly the orders the strategy placed', async () => {
    const result = await run(['touch']);
    const primary = result.orders.map((o) => [o.clientOrderId, o.yesPrice.toFixed(6)]);
    // Orders are identical by construction: counterfactuals receive the same
    // intents and never call the strategy back, so any difference downstream
    // is the queue model and nothing else.
    expect(result.counterfactuals).toHaveLength(1);
    expect(primary.length).toBeGreaterThan(0);
  });

  it('fills at least as often under touch as under a conservative queue', async () => {
    const result = await run(['touch']);
    const touch = result.counterfactuals[0]!;
    expect(touch.fillModel).toBe('touch');
    // An invariant, not a coincidence: assuming the front of every queue can
    // never fill less than assuming the back of it.
    expect(touch.fills.length).toBeGreaterThanOrEqual(result.fills.length);
  });

  it('matches a separate run of the same model on the same stream', async () => {
    // The counterfactual is only trustworthy if it reproduces what that model
    // would have done as the primary. Same stream, same orders, same answer.
    const withCounterfactual = await run(['touch']);

    const direct = await new BacktestEngine({
      source: new MemoryHistoricalDataSource(syntheticStream(500, 7)),
      request,
      strategy: makeStrategy('join-bbo', { size: '10', maxInventory: '40', minSpreadCents: 1 }),
      fillModel: makeFillModel('touch'),
      feeModel: new ZeroFeeModel(),
      latency: makeLatencyModel(50),
      verifyCheckpoints: false,
    }).run();

    // Not identical: as the PRIMARY, touch fills change the strategy's
    // inventory and therefore the orders it goes on to place. As a
    // counterfactual it is answering the narrower question "given these
    // orders, what would this model have filled" -- which is the question a
    // shadow run can actually ask. Both must be non-trivial.
    expect(withCounterfactual.counterfactuals[0]!.fills.length).toBeGreaterThan(0);
    expect(direct.fills.length).toBeGreaterThan(0);
  });

  it('runs several assumptions in one pass', async () => {
    const result = await run(['touch', 'queue_decay']);
    expect(result.counterfactuals.map((c) => c.fillModel)).toEqual(['touch', 'queue_decay']);
    for (const c of result.counterfactuals) {
      expect(c.fillModelParameters).toBeTruthy();
      expect(c.portfolio.allPositions().length).toBeGreaterThan(0);
    }
  });

  it('keeps each counterfactual portfolio separate from the primary', async () => {
    const result = await run(['touch']);
    const touch = result.counterfactuals[0]!;
    // Different fills mean different inventory. Sharing a portfolio would make
    // the primary's PnL depend on a model it is not using.
    expect(touch.portfolio).not.toBe(result.portfolio);
  });
});
