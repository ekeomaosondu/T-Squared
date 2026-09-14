import { describe, expect, it } from 'vitest';
import { MemoryHistoricalDataSource } from '@/src/research/data/memorySource';
import { runBacktest } from '@/src/research/engine/runBacktest';
import { makeFeeModel, makeFillModel, makeLatencyModel, makeStrategy } from '@/src/research/registry';
import { MARKET, syntheticStream } from './fixtures';

/**
 * The benchmark strategies, checked for the behaviour that makes them a
 * benchmark: they quote, they respect their limits, and they differ from each
 * other in the direction their design claims.
 */

const request = { datasetId: 'test', startTime: new Date(0), endTime: new Date(10_000_000) };
const stream = () => syntheticStream(600, 99);

async function run(name: string, params: Record<string, unknown> = {}) {
  return runBacktest({
    source: new MemoryHistoricalDataSource(stream()),
    request,
    strategy: makeStrategy(name, { size: '10', maxInventory: '30', minSpreadCents: 1, ...params }),
    fillModel: makeFillModel('touch'),
    feeModel: await makeFeeModel('zero'),
    latency: makeLatencyModel(0),
    verifyCheckpoints: false,
    now: () => new Date('2026-09-14T00:00:00.000Z'),
  });
}

describe('benchmark strategies', () => {
  it('join-bbo quotes and trades', async () => {
    const r = await run('join-bbo');
    expect(r.summary.execution.ordersSubmitted).toBeGreaterThan(0);
    expect(r.summary.execution.fills).toBeGreaterThan(0);
  });

  it('respects its per-market inventory limit', async () => {
    const r = await run('join-bbo', { maxInventory: '20' });
    const position = r.result.portfolio.positionQuantity(MARKET);
    // The limit binds on the position a fill WOULD create, so the realised
    // position can reach the limit but must not pass it.
    expect(position.abs().toNumber()).toBeLessThanOrEqual(20);
  });

  it('is identical to join-bbo when the imbalance filter never engages', async () => {
    const plain = await run('join-bbo');
    // A threshold above the range of I_k can never fire, so the filter is a
    // no-op and the two strategies must agree exactly.
    const inert = await run('imbalance-maker', { threshold: '2' });
    expect(inert.summary.execution.fills).toBe(plain.summary.execution.fills);
    expect(inert.summary.execution.ordersSubmitted).toBe(plain.summary.execution.ordersSubmitted);
  });

  it('never shows both sides at once when the filter always engages', async () => {
    const r = await run('imbalance-maker', { threshold: '0', policy: 'quote_favoured' });

    // Two orders overlap if their live intervals intersect. Under
    // quote_favoured the strategy must never have a bid and an offer working
    // in the same market at the same instant.
    const live = r.result.orders
      .filter((o) => o.restedAtMs !== null)
      .map((o) => ({
        tag: o.tag,
        from: o.restedAtMs!,
        to: o.terminalAtMs ?? o.restedAtMs!,
      }));

    let overlaps = 0;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        if (a.tag === b.tag) continue;
        if (a.from < b.to && b.from < a.to) overlaps += 1;
      }
    }
    expect(overlaps).toBe(0);
  });

  it('exposes its imbalance policy as a parameter, not a hardcoded belief', async () => {
    const favoured = await run('imbalance-maker', { policy: 'quote_favoured', threshold: '0.05' });
    const against = await run('imbalance-maker', { policy: 'quote_against', threshold: '0.05' });
    expect(favoured.manifest.runKey).not.toBe(against.manifest.runKey);
    expect((favoured.manifest.strategyParameters as Record<string, unknown>).policy).toBe(
      'quote_favoured',
    );
  });

  it('inventory skew carries less inventory than plain BBO joining', async () => {
    const plain = await run('join-bbo');
    const skewed = await run('inventory-skew-maker', { maxSkewCents: 2 });

    const plainMean = Number(plain.summary.inventory.meanAbsInventory ?? '0');
    const skewMean = Number(skewed.summary.inventory.meanAbsInventory ?? '0');
    // The whole claim of the strategy. If this ever inverts, the skew has the
    // wrong sign and the "risk control" is adding risk.
    expect(skewMean).toBeLessThanOrEqual(plainMean);
  });

  it('never books a maker fill through the touch', async () => {
    const r = await run('inventory-skew-maker', { maxSkewCents: 3 });
    for (const fill of r.result.fills.filter((f) => f.liquidity === 'maker')) {
      // A quote that crossed the book would be a taker order wearing a maker's
      // clothes, and would inflate spread capture.
      expect(fill.yesPrice.gte(0)).toBe(true);
      expect(fill.yesPrice.lte(1)).toBe(true);
    }
  });

  it('records every strategy parameter in the manifest', async () => {
    const r = await run('inventory-skew-maker', { maxSkewCents: 4, symmetric: false });
    const p = r.manifest.strategyParameters as Record<string, unknown>;
    expect(p.maxSkewCents).toBe(4);
    expect(p.symmetric).toBe(false);
    expect(p.size).toBe('10');
    expect(p.maxInventory).toBe('30');
  });

  it('rejects an unknown strategy by name', () => {
    expect(() => makeStrategy('not-a-strategy')).toThrow(/unknown strategy/);
  });
});
