import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { KalshiSigner } from '@/src/kalshi/auth';
import {
  GetEventWithMarketsResponse,
  GetEventsResponse,
  GetMarketResponse,
  GetMarketsResponse,
  GetOrderbookResponse,
  GetOrderbooksResponse,
  GetSeriesListResponse,
  GetSeriesResponse,
  GetTradesResponse,
  MAX_ORDERBOOK_BATCH,
  type KalshiEvent,
  type KalshiMarket,
  type KalshiOrderbookFp,
  type KalshiSeries,
  type MarketQueryStatus,
} from '@/src/kalshi/schemas';
import { logger } from '@/src/logging/logger';

/**
 * Kalshi REST client.
 *
 * Used for market discovery, metadata refresh, and periodic order-book
 * validation. It is deliberately NOT the source of order-book history -- the
 * WebSocket delta stream is authoritative, and REST exists here as an
 * independent second opinion.
 */

const API_PREFIX = '/trade-api/v2';

export class KalshiApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Kalshi ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'KalshiApiError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface RestClientOptions {
  baseUrl: string;
  signer?: KalshiSigner | null;
  /** Per-request timeout. Discovery must not wedge the collector. */
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface PageOptions {
  limit?: number;
  cursor?: string;
  /** Safety valve so a runaway cursor cannot loop forever. */
  maxPages?: number;
}

export class KalshiRestClient {
  private readonly baseUrl: string;
  private readonly signer: KalshiSigner | null;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.signer = opts.signer ?? null;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async request<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    query?: URLSearchParams,
  ): Promise<z.infer<T>> {
    const fullPath = `${API_PREFIX}${path}`;
    const url = `${this.baseUrl}${fullPath}${query && [...query].length ? `?${query}` : ''}`;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      try {
        // The signature covers the path only; the query string is excluded.
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent': 'kalshi-market-recorder/0.1',
          ...(this.signer ? this.signer.headers('GET', fullPath) : {}),
        };

        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new KalshiApiError(res.status, fullPath, body);
          if (!err.retryable || attempt === this.maxRetries) throw err;
          lastErr = err;
          await this.backoff(attempt, res.headers.get('retry-after'));
          continue;
        }

        const json = await res.json();
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          // A schema drift must be loud but must not be retried -- retrying
          // will produce the same shape.
          logger.error(
            {
              event: 'rest_schema_mismatch',
              path: fullPath,
              issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
            },
            'Kalshi REST response did not match the expected schema',
          );
          throw new Error(`Kalshi response schema mismatch on ${fullPath}`);
        }

        logger.debug(
          { event: 'rest_request', path: fullPath, latencyMs: Date.now() - startedAt },
          'kalshi rest request',
        );
        return parsed.data;
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        const isNetwork = err instanceof TypeError;
        if ((isTimeout || isNetwork) && attempt < this.maxRetries) {
          lastErr = err;
          await this.backoff(attempt, null);
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error(`Kalshi request failed: ${fullPath}`);
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        await delay(Math.min(seconds * 1000, 30_000));
        return;
      }
    }
    const base = Math.min(8_000, 250 * 2 ** (attempt - 1));
    await delay(base / 2 + Math.random() * (base / 2));
  }

  /** Walks a cursor-paginated endpoint to completion. */
  private async *paginate<T>(
    path: string,
    schema: z.ZodType<{ cursor?: string | null | undefined }>,
    extract: (page: never) => T[],
    query: URLSearchParams,
    opts: PageOptions = {},
  ): AsyncGenerator<T[]> {
    const limit = opts.limit ?? 200;
    const maxPages = opts.maxPages ?? 200;
    // Stopping at a caller-specified page budget is intentional, not a fault.
    const budgetIsExplicit = opts.maxPages !== undefined;
    let cursor = opts.cursor;

    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams(query);
      q.set('limit', String(limit));
      if (cursor) q.set('cursor', cursor);

      const res = (await this.request(path, schema, q)) as { cursor?: string | null };
      const items = extract(res as never);
      if (items.length > 0) yield items;

      // Kalshi returns a cursor even on the final page; an empty page is the
      // reliable terminator.
      if (!res.cursor || items.length === 0) return;
      cursor = res.cursor;
    }

    if (!budgetIsExplicit) {
      logger.warn({ event: 'pagination_truncated', path, maxPages }, 'stopped paginating at maxPages');
    }
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  async getSeriesList(params: { category?: string; tags?: string } = {}): Promise<KalshiSeries[]> {
    const q = new URLSearchParams();
    if (params.category) q.set('category', params.category);
    if (params.tags) q.set('tags', params.tags);
    const res = await this.request('/series', GetSeriesListResponse, q);
    return res.series;
  }

  async getSeries(seriesTicker: string): Promise<KalshiSeries> {
    const res = await this.request(`/series/${encodeURIComponent(seriesTicker)}`, GetSeriesResponse);
    return res.series;
  }

  async getEvents(
    params: { seriesTicker?: string; status?: string; withNestedMarkets?: boolean } = {},
    page: PageOptions = {},
  ): Promise<KalshiEvent[]> {
    const q = new URLSearchParams();
    if (params.seriesTicker) q.set('series_ticker', params.seriesTicker);
    if (params.status) q.set('status', params.status);
    q.set('with_nested_markets', String(params.withNestedMarkets ?? false));

    const out: KalshiEvent[] = [];
    for await (const batch of this.paginate<KalshiEvent>(
      '/events',
      GetEventsResponse,
      (p: never) => (p as unknown as { events: KalshiEvent[] }).events,
      q,
      page,
    )) {
      out.push(...batch);
    }
    return out;
  }

  /**
   * `status` here uses the API's QUERY vocabulary -- open | unopened | closed |
   * settled -- which is NOT the same as the `status` field on a market object
   * (initialized | active | inactive | closed | determined | finalized). Only
   * one value may be supplied. See statusFiltersForSelector().
   *
   * `minCloseTs` is the important one for a long-running recorder: it prunes
   * settled history server-side and is what keeps a discovery cycle cheap.
   */
  async getMarkets(
    params: {
      eventTicker?: string;
      seriesTicker?: string;
      status?: MarketQueryStatus;
      tickers?: string[];
      minCloseTs?: number;
      maxCloseTs?: number;
    } = {},
    page: PageOptions = {},
  ): Promise<KalshiMarket[]> {
    const q = new URLSearchParams();
    if (params.eventTicker) q.set('event_ticker', params.eventTicker);
    if (params.seriesTicker) q.set('series_ticker', params.seriesTicker);
    if (params.status) q.set('status', params.status);
    if (params.tickers?.length) q.set('tickers', params.tickers.join(','));
    if (params.minCloseTs !== undefined) q.set('min_close_ts', String(params.minCloseTs));
    if (params.maxCloseTs !== undefined) q.set('max_close_ts', String(params.maxCloseTs));

    const out: KalshiMarket[] = [];
    for await (const batch of this.paginate<KalshiMarket>(
      '/markets',
      GetMarketsResponse,
      (p: never) => (p as unknown as { markets: KalshiMarket[] }).markets,
      q,
      page,
    )) {
      out.push(...batch);
    }
    return out;
  }

  /**
   * Single event, including its nested markets. Used instead of listing every
   * event for a series: /events returns the full history (thousands of rows
   * for a daily series) which is far too expensive to poll every minute.
   */
  async getEvent(eventTicker: string): Promise<{ event: KalshiEvent; markets: KalshiMarket[] }> {
    const res = await this.request(
      `/events/${encodeURIComponent(eventTicker)}`,
      GetEventWithMarketsResponse,
    );
    return { event: res.event, markets: res.markets ?? [] };
  }

  async getMarket(ticker: string): Promise<KalshiMarket> {
    const res = await this.request(`/markets/${encodeURIComponent(ticker)}`, GetMarketResponse);
    return res.market;
  }

  async getOrderbook(ticker: string): Promise<KalshiOrderbookFp> {
    const res = await this.request(
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
      GetOrderbookResponse,
    );
    return res.orderbook_fp;
  }

  /**
   * Batched order books for validation.
   *
   * `tickers` must be REPEATED query parameters -- a comma-joined value is
   * interpreted by the API as a single ticker and silently returns one empty
   * book. The verified server-side maximum is 100 per call.
   */
  async getOrderbooks(tickers: string[]): Promise<Map<string, KalshiOrderbookFp>> {
    const out = new Map<string, KalshiOrderbookFp>();

    for (let i = 0; i < tickers.length; i += MAX_ORDERBOOK_BATCH) {
      const batch = tickers.slice(i, i + MAX_ORDERBOOK_BATCH);
      const q = new URLSearchParams();
      for (const t of batch) q.append('tickers', t);

      const res = await this.request('/markets/orderbooks', GetOrderbooksResponse, q);
      for (const entry of res.orderbooks) out.set(entry.ticker, entry.orderbook_fp);
    }

    return out;
  }

  async getTrades(
    params: { ticker?: string; minTs?: number; maxTs?: number } = {},
    page: PageOptions = {},
  ): Promise<z.infer<typeof GetTradesResponse>['trades']> {
    const q = new URLSearchParams();
    if (params.ticker) q.set('ticker', params.ticker);
    if (params.minTs !== undefined) q.set('min_ts', String(params.minTs));
    if (params.maxTs !== undefined) q.set('max_ts', String(params.maxTs));

    const out: z.infer<typeof GetTradesResponse>['trades'] = [];
    for await (const batch of this.paginate(
      '/markets/trades',
      GetTradesResponse,
      (p: never) => (p as unknown as z.infer<typeof GetTradesResponse>).trades,
      q,
      page,
    )) {
      out.push(...batch);
    }
    return out;
  }
}
