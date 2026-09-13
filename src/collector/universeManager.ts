import type { CollectorConfig, MarketSelector } from '@/src/config/collectorConfig';
import {
  statusFiltersForSelector,
  type KalshiEvent,
  type KalshiMarket,
  type KalshiSeries,
} from '@/src/kalshi/schemas';
import type { KalshiRestClient } from '@/src/kalshi/restClient';
import type { Sql } from '@/src/persistence/db';
import {
  closeTrackingWindow,
  openTrackingWindow,
  upsertEvent,
  upsertMarket,
  upsertSeries,
} from '@/src/persistence/repositories/metadata';
import { logger } from '@/src/logging/logger';

/**
 * Decides which markets should be tracked right now.
 *
 * Ticker prefixes are used ONLY as a discovery selector. Once markets are
 * discovered, the official series_ticker / event_ticker relationships returned
 * by the API are what get persisted and used for grouping -- ticker strings are
 * never parsed to infer structure. This matters for KXHIGH/KXLOW because the
 * temperature buckets under one event form a mutually exclusive ladder, and
 * today's strike grid is not tomorrow's.
 */

export interface TrackedMarket {
  marketTicker: string;
  eventTicker: string | null;
  seriesTicker: string | null;
  selectorId: string;
  status: string | null;
  openTime: Date | null;
  closeTime: Date | null;
}

export interface UniverseDiff {
  added: TrackedMarket[];
  removed: string[];
  unchanged: number;
  /** Events with at least one tracked market, for ladder sampling. */
  eventTickers: string[];
}

export interface UniverseManagerOptions {
  sql: Sql;
  rest: KalshiRestClient;
  config: CollectorConfig;
  /** Series listings are large; cache them between discovery cycles. */
  seriesCacheTtlMs?: number;
  clock?: () => number;
}

export class UniverseManager {
  private readonly sql: Sql;
  private readonly rest: KalshiRestClient;
  private config: CollectorConfig;
  private readonly seriesCacheTtlMs: number;
  private readonly clock: () => number;

  private current = new Map<string, TrackedMarket>();

  private seriesCache: { at: number; byCategory: Map<string, KalshiSeries[]> } = {
    at: 0,
    byCategory: new Map(),
  };

  /** event_ticker -> series_ticker, from the API relationship. */
  private readonly seriesByEvent = new Map<string, string>();
  /** Series visible in discoveryScope, whether or not they are captured. */
  private inScopeSeries = new Set<string>();
  private discoveryScopeRefreshedAtMs = 0;
  private readonly pendingMetadataRefresh = new Set<string>();
  private readonly pendingEventRefresh = new Set<string>();

  constructor(opts: UniverseManagerOptions) {
    this.sql = opts.sql;
    this.rest = opts.rest;
    this.config = opts.config;
    this.seriesCacheTtlMs = opts.seriesCacheTtlMs ?? 300_000;
    this.clock = opts.clock ?? Date.now;
  }

  setConfig(config: CollectorConfig): void {
    this.config = config;
  }

  get trackedMarkets(): TrackedMarket[] {
    return [...this.current.values()];
  }

  get trackedTickers(): string[] {
    return [...this.current.keys()];
  }

  get trackedEventTickers(): string[] {
    return [...new Set(this.trackedMarkets.map((m) => m.eventTicker).filter((e): e is string => !!e))];
  }

  seriesForEvent(eventTicker: string): string | null {
    return this.seriesByEvent.get(eventTicker) ?? null;
  }

  isTracked(marketTicker: string): boolean {
    return this.current.has(marketTicker);
  }

  /** Queued by lifecycle events; drained on the next discovery pass. */
  queueMetadataRefresh(marketTicker: string): void {
    this.pendingMetadataRefresh.add(marketTicker);
  }

  /** Forces the next pass to re-read an event's metadata from the API. */
  queueEventRefresh(eventTicker: string): void {
    this.pendingEventRefresh.add(eventTicker);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Full discovery pass:
   *   series -> filter by config -> markets in the relevant close-time window
   *   -> official event links -> eligible markets -> diff.
   *
   * Markets are fetched with a server-side `min_close_ts` derived from the
   * selector's retention window. This matters enormously for a recorder that
   * runs for weeks: a daily series accumulates thousands of settled markets,
   * and listing them every minute would dwarf the actual work. For KXHIGHNY
   * this is the difference between 840 rows per cycle and 12.
   *
   * Events are then fetched individually for just the events those markets
   * belong to, rather than listing a series' full (multi-thousand) event
   * history.
   */
  async discover(now = new Date()): Promise<UniverseDiff> {
    const desired = new Map<string, TrackedMarket>();

    // Observe-only scope first, so the operator can see what is available to
    // capture without any of it being subscribed.
    await this.refreshDiscoveryScope(now);

    for (const selector of this.config.selectors) {
      const seriesList = await this.resolveSeries(selector);
      this.assertCaptureScope(selector.id, seriesList.map((x) => x.ticker));

      // Only look back as far as the selector actually retains closed markets.
      const minCloseTs =
        selector.retainAfterCloseSeconds === undefined
          ? undefined
          : Math.floor(now.getTime() / 1000) - selector.retainAfterCloseSeconds;

      for (const series of seriesList) {
        await upsertSeries(this.sql, series, now);

        const markets = await this.fetchCandidateMarkets(series.ticker, selector, minCloseTs);

        // Resolve the OFFICIAL event -> series relationship for every event
        // these markets belong to. Never inferred from the ticker string.
        const eventTickers = [
          ...new Set(markets.map((m) => m.event_ticker).filter((e): e is string => !!e)),
        ];
        await this.ensureEvents(eventTickers, series.ticker, now);

        for (const market of markets) {
          const seriesTicker = market.event_ticker
            ? (this.seriesByEvent.get(market.event_ticker) ?? series.ticker)
            : series.ticker;

          await upsertMarket(this.sql, market, seriesTicker, now);

          if (this.isEligible(market, selector, now)) {
            desired.set(market.ticker, {
              marketTicker: market.ticker,
              eventTicker: market.event_ticker ?? null,
              seriesTicker,
              selectorId: selector.id,
              status: market.status ?? null,
              openTime: market.open_time ? new Date(market.open_time) : null,
              closeTime: market.close_time ? new Date(market.close_time) : null,
            });
          }
        }
      }
    }

    await this.refreshQueuedMetadata(now);

    return this.applyDiff(desired, now);
  }

  /**
   * Candidate markets for a series.
   *
   * The API permits only ONE status filter per request and uses a different
   * vocabulary from the market object's own status field, so a selector naming
   * several statuses becomes several requests whose results are merged. When
   * the selector names no statuses, a single unfiltered (but still
   * close-time-bounded) request suffices.
   */
  private async fetchCandidateMarkets(
    seriesTicker: string,
    selector: MarketSelector,
    minCloseTs: number | undefined,
  ): Promise<KalshiMarket[]> {
    const filters = statusFiltersForSelector(selector.statuses);

    if (filters.length === 0) {
      return this.rest.getMarkets({ seriesTicker, minCloseTs });
    }

    const merged = new Map<string, KalshiMarket>();
    for (const status of filters) {
      const batch = await this.rest.getMarkets({ seriesTicker, status, minCloseTs });
      for (const m of batch) merged.set(m.ticker, m);
    }
    return [...merged.values()];
  }

  /**
   * Fetches and persists events we have not already seen. Event metadata is
   * near-static, so a seen event is not re-fetched unless a lifecycle message
   * queues it.
   */
  private async ensureEvents(
    eventTickers: string[],
    fallbackSeries: string,
    now: Date,
  ): Promise<void> {
    for (const eventTicker of eventTickers) {
      if (this.seriesByEvent.has(eventTicker) && !this.pendingEventRefresh.has(eventTicker)) {
        continue;
      }
      this.pendingEventRefresh.delete(eventTicker);

      try {
        const { event } = await this.rest.getEvent(eventTicker);
        const ev: KalshiEvent = {
          ...event,
          series_ticker: event.series_ticker ?? fallbackSeries,
        };
        await upsertEvent(this.sql, ev, now);
        this.seriesByEvent.set(ev.event_ticker, ev.series_ticker ?? fallbackSeries);
      } catch (err) {
        logger.warn(
          { event: 'event_fetch_failed', event_ticker: eventTicker, err: String(err) },
          'failed to fetch event metadata',
        );
      }
    }
  }

  /**
   * Persists metadata for the broad discovery scope WITHOUT subscribing to any
   * of it. Only series rows are written: fetching events and markets for every
   * candidate would cost far more than the visibility is worth, and none of it
   * is being recorded anyway.
   */
  private async refreshDiscoveryScope(now: Date): Promise<void> {
    const scope = this.config.discoveryScope;
    if (!scope?.persistMetadata) return;

    // Series metadata is near-static; refresh on the metadata cadence.
    if (this.clock() - this.discoveryScopeRefreshedAtMs < this.seriesCacheTtlMs) return;
    this.discoveryScopeRefreshedAtMs = this.clock();

    const deny = new Set(scope.seriesDenylist ?? []);
    const categories = scope.categories?.length ? scope.categories : [undefined];
    const seen = new Map<string, KalshiSeries>();

    for (const category of categories) {
      for (const series of await this.listSeries(category)) {
        if (deny.has(series.ticker)) continue;
        if (scope.seriesPrefixes?.length && !scope.seriesPrefixes.some((p) => series.ticker.startsWith(p))) {
          continue;
        }
        seen.set(series.ticker, series);
      }
    }

    for (const series of seen.values()) await upsertSeries(this.sql, series, now);

    this.inScopeSeries = new Set(seen.keys());

    logger.info(
      { event: 'discovery_scope_refreshed', inScope: seen.size },
      `discovery scope: ${seen.size} series visible`,
    );
  }

  /**
   * Series visible in discovery scope that are NOT being captured.
   *
   * Computed on read rather than cached, because the capture set is only known
   * after the diff has been applied.
   */
  get observedOnlySeries(): string[] {
    const captured = new Set(this.capturedSeriesTickers());
    return [...this.inScopeSeries].filter((t) => !captured.has(t)).sort();
  }

  /** Series visible in discovery scope, captured or not. */
  get inScopeSeriesCount(): number {
    return this.inScopeSeries.size;
  }

  private capturedSeriesTickers(): string[] {
    return [...new Set(this.trackedMarkets.map((m) => m.seriesTicker).filter((s): s is string => !!s))];
  }

  /**
   * Refuses to capture an unexpectedly wide universe.
   *
   * A prefix selector can silently widen when the exchange lists new series, so
   * this turns "the recorder quietly started capturing 104 series" into a
   * startup failure that has to be acknowledged in config.
   */
  private assertCaptureScope(selectorId: string, seriesTickers: string[]): void {
    const limit = this.config.maxCaptureSeries;
    if (seriesTickers.length <= limit) return;

    throw new Error(
      `Selector "${selectorId}" resolves to ${seriesTickers.length} series, which exceeds ` +
        `maxCaptureSeries (${limit}). Capturing this many series is a deliberate decision: ` +
        `either narrow the selector (seriesAllowlist is the usual answer) or raise ` +
        `maxCaptureSeries in the collector config. First few: ${seriesTickers.slice(0, 8).join(', ')}`,
    );
  }

  /**
   * Resolves the series a selector refers to.
   *
   * An explicit allowlist is fetched directly. Prefix discovery goes through
   * the category-filtered listing when categories are configured, which both
   * excludes non-weather prefix collisions and avoids pulling the full ~17 MB
   * series catalogue.
   */
  private async resolveSeries(selector: MarketSelector): Promise<KalshiSeries[]> {
    const deny = new Set(selector.seriesDenylist ?? []);
    let result: KalshiSeries[] = [];

    if (selector.seriesAllowlist?.length) {
      result = await Promise.all(selector.seriesAllowlist.map((t) => this.rest.getSeries(t)));
    } else if (selector.seriesPrefixes?.length) {
      const categories = selector.categories?.length ? selector.categories : [undefined];
      const seen = new Set<string>();

      for (const category of categories) {
        const list = await this.listSeries(category);
        for (const series of list) {
          if (seen.has(series.ticker)) continue;
          if (!selector.seriesPrefixes.some((p) => series.ticker.startsWith(p))) continue;
          seen.add(series.ticker);
          result.push(series);
        }
      }
    }

    return result.filter((s) => !deny.has(s.ticker));
  }

  private async listSeries(category: string | undefined): Promise<KalshiSeries[]> {
    const key = category ?? '__all__';
    const fresh = this.clock() - this.seriesCache.at < this.seriesCacheTtlMs;
    const cached = this.seriesCache.byCategory.get(key);
    if (fresh && cached) return cached;

    const list = await this.rest.getSeriesList(category ? { category } : {});
    if (!fresh) this.seriesCache = { at: this.clock(), byCategory: new Map() };
    this.seriesCache.byCategory.set(key, list);
    return list;
  }

  /**
   * Eligibility, entirely driven by config. Note that markets are picked up
   * BEFORE they open when `subscribeBeforeOpenSeconds` allows it, so the very
   * first quotes of a new daily event are captured.
   */
  isEligible(market: KalshiMarket, selector: MarketSelector, now: Date): boolean {
    if (selector.marketDenylist?.includes(market.ticker)) return false;
    if (selector.marketAllowlist?.length && !selector.marketAllowlist.includes(market.ticker)) {
      return false;
    }

    if (selector.statuses?.length) {
      const status = market.status as (typeof selector.statuses)[number] | undefined;
      if (!status || !selector.statuses.includes(status)) return false;
    }

    const nowMs = now.getTime();

    if (selector.subscribeBeforeOpenSeconds !== undefined && market.open_time) {
      const openMs = new Date(market.open_time).getTime();
      if (Number.isFinite(openMs) && nowMs < openMs - selector.subscribeBeforeOpenSeconds * 1000) {
        return false;
      }
    }

    if (selector.retainAfterCloseSeconds !== undefined && market.close_time) {
      const closeMs = new Date(market.close_time).getTime();
      if (Number.isFinite(closeMs) && nowMs > closeMs + selector.retainAfterCloseSeconds * 1000) {
        return false;
      }
    }

    return true;
  }

  private async applyDiff(desired: Map<string, TrackedMarket>, now: Date): Promise<UniverseDiff> {
    const added: TrackedMarket[] = [];
    const removed: string[] = [];

    for (const [ticker, market] of desired) {
      if (!this.current.has(ticker)) {
        added.push(market);
        await openTrackingWindow(this.sql, ticker, market.selectorId, 'selector_match', now);
      }
    }

    for (const [ticker, market] of this.current) {
      if (!desired.has(ticker)) {
        removed.push(ticker);
        await closeTrackingWindow(this.sql, ticker, market.selectorId, 'no_longer_eligible', now);
      }
    }

    this.current = desired;

    if (added.length > 0 || removed.length > 0) {
      logger.info(
        {
          event: 'universe_changed',
          added: added.length,
          removed: removed.length,
          total: desired.size,
          events: this.trackedEventTickers.length,
        },
        'tracked market universe changed',
      );
    }

    return {
      added,
      removed,
      unchanged: desired.size - added.length,
      eventTickers: this.trackedEventTickers,
    };
  }

  /** Refreshes markets flagged by lifecycle events since the last pass. */
  private async refreshQueuedMetadata(now: Date): Promise<void> {
    if (this.pendingMetadataRefresh.size === 0) return;

    const tickers = [...this.pendingMetadataRefresh];
    this.pendingMetadataRefresh.clear();

    for (const ticker of tickers) {
      try {
        const market = await this.rest.getMarket(ticker);

        // markets.event_ticker references events, so the event row must exist
        // first. A market can legitimately be seen before its event (a new
        // strike announced by a lifecycle message, for example).
        if (market.event_ticker && !this.seriesByEvent.has(market.event_ticker)) {
          await this.ensureEvents([market.event_ticker], '', now);
        }

        const seriesTicker = market.event_ticker
          ? (this.seriesByEvent.get(market.event_ticker) ?? null)
          : null;
        await upsertMarket(this.sql, market, seriesTicker, now);
      } catch (err) {
        logger.warn(
          { event: 'metadata_refresh_failed', market_ticker: ticker, err: String(err) },
          'failed to refresh market metadata',
        );
      }
    }

    logger.info(
      { event: 'metadata_refreshed', count: tickers.length },
      'refreshed market metadata from lifecycle events',
    );
  }

  /** Closes every open tracking window, e.g. on shutdown. */
  async closeAllTrackingWindows(reason: string, now = new Date()): Promise<void> {
    for (const [ticker, market] of this.current) {
      await closeTrackingWindow(this.sql, ticker, market.selectorId, reason, now);
    }
    this.current.clear();
  }
}
