import { describe, expect, it } from 'vitest';
import { UniverseManager } from '@/src/collector/universeManager';
import { parseCollectorConfig, type MarketSelector } from '@/src/config/collectorConfig';
import { statusFiltersForSelector } from '@/src/kalshi/schemas';
import type { KalshiMarket } from '@/src/kalshi/schemas';

const NOW = new Date('2026-09-13T18:00:00Z');

function market(overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker: 'KXHIGHNY-26SEP14-B74.5',
    event_ticker: 'KXHIGHNY-26SEP14',
    status: 'active',
    open_time: '2026-09-13T14:00:00Z',
    close_time: '2026-09-15T05:00:00Z',
    ...overrides,
  } as KalshiMarket;
}

function manager(): UniverseManager {
  return new UniverseManager({
    sql: (() => Promise.resolve([])) as never,
    rest: {} as never,
    config: parseCollectorConfig({ selectors: [{ id: 't', seriesAllowlist: ['KXHIGHNY'] }] }),
  });
}

const base: MarketSelector = {
  id: 'daily-temperature',
  seriesPrefixes: ['KXHIGH', 'KXLOW'],
  statuses: ['initialized', 'active', 'inactive', 'closed', 'determined'],
  subscribeBeforeOpenSeconds: 21_600,
  retainAfterCloseSeconds: 7_200,
};

describe('market eligibility', () => {
  const um = manager();

  it('accepts an open market matching the selector', () => {
    expect(um.isEligible(market(), base, NOW)).toBe(true);
  });

  it('excludes a status the selector does not list', () => {
    expect(um.isEligible(market({ status: 'finalized' }), base, NOW)).toBe(false);
  });

  it('picks up a market before it opens, within the lead window', () => {
    // Opens in 3 hours, lead window is 6.
    const m = market({ status: 'initialized', open_time: '2026-09-13T21:00:00Z' });
    expect(um.isEligible(m, base, NOW)).toBe(true);
  });

  it('ignores a market still outside the lead window', () => {
    // Opens in 10 hours.
    const m = market({ status: 'initialized', open_time: '2026-09-14T04:00:00Z' });
    expect(um.isEligible(m, base, NOW)).toBe(false);
  });

  it('retains a recently closed market so settlement flow is captured', () => {
    const m = market({ status: 'closed', close_time: '2026-09-13T17:00:00Z' });
    expect(um.isEligible(m, base, NOW)).toBe(true);
  });

  it('drops a market past its retention window', () => {
    const m = market({ status: 'determined', close_time: '2026-09-13T10:00:00Z' });
    expect(um.isEligible(m, base, NOW)).toBe(false);
  });

  it('honours explicit market allow and deny lists', () => {
    const denied = { ...base, marketDenylist: ['KXHIGHNY-26SEP14-B74.5'] };
    expect(um.isEligible(market(), denied, NOW)).toBe(false);

    const allowed = { ...base, marketAllowlist: ['SOMETHING-ELSE'] };
    expect(um.isEligible(market(), allowed, NOW)).toBe(false);
  });

  it('applies no time bounds when the selector sets none', () => {
    const loose: MarketSelector = { id: 'x', seriesPrefixes: ['KX'] };
    const ancient = market({ close_time: '2020-01-01T00:00:00Z', status: 'finalized' });
    expect(um.isEligible(ancient, loose, NOW)).toBe(true);
  });
});

describe('status filter mapping', () => {
  it('maps market-object statuses onto the API query vocabulary', () => {
    // The API rejects 'active'/'determined'/'finalized'/'initialized' as query
    // values and accepts only one filter per request.
    expect(statusFiltersForSelector(['active']).sort()).toEqual(['open']);
    expect(statusFiltersForSelector(['initialized']).sort()).toEqual(['unopened']);
    expect(statusFiltersForSelector(['determined', 'finalized']).sort()).toEqual(['settled']);
    expect(statusFiltersForSelector(['inactive', 'closed']).sort()).toEqual(['closed']);
  });

  it('deduplicates statuses that collapse onto one query value', () => {
    expect(statusFiltersForSelector(base.statuses).sort()).toEqual(
      ['closed', 'open', 'settled', 'unopened'],
    );
  });

  it('returns nothing when the selector names no statuses', () => {
    expect(statusFiltersForSelector(undefined)).toEqual([]);
  });
});

describe('collector config', () => {
  it('rejects a selector that constrains nothing', () => {
    expect(() => parseCollectorConfig({ selectors: [{ id: 'x' }] })).toThrow(/at least one of/);
  });

  it('accepts an explicit series allowlist with no code change', () => {
    const cfg = parseCollectorConfig({
      selectors: [{ id: 'four-city', seriesAllowlist: ['KXHIGHNY', 'KXLOWNY', 'KXHIGHLAX', 'KXLOWLAX'] }],
    });
    expect(cfg.selectors[0]!.seriesAllowlist).toHaveLength(4);
    // Private channels stay off unless explicitly enabled.
    expect(cfg.capture.privateOrders).toBe(false);
    expect(cfg.capture.privateFills).toBe(false);
  });
});
