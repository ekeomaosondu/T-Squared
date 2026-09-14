import { z } from 'zod';
import type { KalshiSigner } from '@/src/kalshi/auth';
import type { Decimal } from '@/src/book/decimal';
import { KalshiApiError } from '@/src/kalshi/restClient';
import { logger } from '@/src/logging/logger';

/**
 * Kalshi's private trading API.
 *
 * Deliberately separate from the read-only REST client, because the rules are
 * different in one way that matters more than all the others:
 *
 *   ORDER CREATION IS NEVER RETRIED.
 *
 * A create that times out has an unknown outcome. The order may be resting on
 * the exchange right now. Retrying is how one intended order becomes two, and
 * "the request failed so nothing happened" is the single most expensive
 * assumption available in this file. On any ambiguous outcome this client
 * throws {@link AmbiguousOrderError} and the caller must RECONCILE -- query,
 * find out, and only then act.
 *
 * Every call records the exact instant the request left and the instant the
 * response arrived. Those two numbers are the empirical latency dataset that
 * is supposed to replace the arbitrary 50/100/250 ms settings in the
 * backtester, so they are measured around the narrowest possible span rather
 * than inferred later from a log line.
 */

const API_PREFIX = '/trade-api/v2';

/**
 * The V2 order API.
 *
 * Materially different from the endpoint that used to live at
 * `/portfolio/orders`, which now answers 410 `deprecated_v1_order_endpoint`:
 *
 *   path      /portfolio/events/orders
 *   side      'bid' or 'ask' -- the YES ladder directly, not yes/no + buy/sell
 *   price     a fixed-point DOLLAR string, not integer cents
 *   count     a fixed-point string
 *
 * The bid/ask form is a simplification worth noticing: it is exactly the
 * representation the research layer already uses internally, so a probe's side
 * maps straight through instead of being encoded as a NO buy at the
 * complement.
 */
const V2OrderResponse = z
  .object({
    order_id: z.string(),
    client_order_id: z.string().nullish(),
    fill_count: z.union([z.number(), z.string()]).nullish(),
    remaining_count: z.union([z.number(), z.string()]).nullish(),
    average_fill_price: z.string().nullish(),
    average_fee_paid: z.string().nullish(),
    ts_ms: z.number().nullish(),
  })
  .passthrough();

export type V2Order = z.infer<typeof V2OrderResponse>;

const V2CancelResponse = z
  .object({
    order_id: z.string().nullish(),
    client_order_id: z.string().nullish(),
    reduced_by: z.string().nullish(),
    ts_ms: z.number().nullish(),
  })
  .passthrough();

/** The legacy read endpoints, which are not deprecated. */
const OrderSchema = z
  .object({
    order_id: z.string(),
    client_order_id: z.string().nullish(),
    ticker: z.string().nullish(),
    status: z.string().nullish(),
    action: z.string().nullish(),
    side: z.string().nullish(),
    type: z.string().nullish(),
    yes_price_dollars: z.string().nullish(),
    no_price_dollars: z.string().nullish(),
    initial_count: z.union([z.number(), z.string()]).nullish(),
    remaining_count: z.union([z.number(), z.string()]).nullish(),
    remaining_count_fp: z.string().nullish(),
    fill_count_fp: z.string().nullish(),
    book_side: z.string().nullish(),
    outcome_side: z.string().nullish(),
    maker_fees_dollars: z.string().nullish(),
    taker_fees_dollars: z.string().nullish(),
    created_time: z.string().nullish(),
  })
  .passthrough();

export type KalshiOrder = z.infer<typeof OrderSchema>;

const GetOrderResponse = z.object({ order: OrderSchema }).passthrough();

const ListOrdersResponse = z
  .object({ orders: z.array(OrderSchema).nullish(), cursor: z.string().nullish() })
  .passthrough();

/**
 * Bulk queue positions.
 *
 * Kalshi exposes how many contracts sit ahead of each resting order under
 * price-time priority. The BULK form is the one to use: polling N orders
 * individually multiplies request count and, worse, spreads the observations
 * across N different instants so they cannot be compared to one book state.
 */
const QueuePositionSchema = z
  .object({
    order_id: z.string(),
    market_ticker: z.string().nullish(),
    ticker: z.string().nullish(),
    /**
     * Contracts ahead of this order, as a FIXED-POINT STRING.
     *
     * `queue_position_fp`, not `queue_position`. The difference cost a live
     * run: the response parsed cleanly, every row came back, and the field
     * this code was reading was simply absent -- so 685 observations recorded
     * a null queue position and looked like a working experiment.
     */
    queue_position_fp: z.string().nullish(),
    queue_position: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const QueuePositionsResponse = z
  .object({
    queue_positions: z.array(QueuePositionSchema).nullish(),
    order_queue_positions: z.array(QueuePositionSchema).nullish(),
  })
  .passthrough();

const PositionSchema = z
  .object({
    ticker: z.string().nullish(),
    market_ticker: z.string().nullish(),
    position: z.union([z.number(), z.string()]).nullish(),
    market_exposure_dollars: z.string().nullish(),
    resting_orders_count: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const PositionsResponse = z
  .object({ market_positions: z.array(PositionSchema).nullish() })
  .passthrough();

const BalanceResponse = z
  .object({ balance_dollars: z.string().nullish(), balance: z.number().nullish() })
  .passthrough();

const OrderGroupSchema = z
  .object({ order_group_id: z.string().nullish(), id: z.string().nullish() })
  .passthrough();
const CreateOrderGroupResponse = z
  .object({ order_group: OrderGroupSchema.nullish(), order_group_id: z.string().nullish() })
  .passthrough();

/**
 * The outcome of a create is unknown.
 *
 * NOT an error meaning "it did not happen". It means we do not know, the order
 * may be live, and the only safe next step is to look. Carries the
 * clientOrderId so the caller can find it.
 */
export class AmbiguousOrderError extends Error {
  readonly ambiguous = true;
  constructor(
    readonly clientOrderId: string,
    readonly operation: 'create' | 'cancel',
    readonly cause: unknown,
  ) {
    super(
      `${operation} for ${clientOrderId} had an unknown outcome: ${
        cause instanceof Error ? cause.message : String(cause)
      }. The order may be live; reconcile before acting.`,
    );
    this.name = 'AmbiguousOrderError';
  }
}

/** Precise client-side timing around one API call. */
export interface CallTiming {
  sendTs: number;
  ackTs: number;
  latencyMs: number;
  httpStatus: number | null;
}

export interface Timed<T> {
  value: T;
  timing: CallTiming;
}

export interface CreateOrderRequest {
  clientOrderId: string;
  marketTicker: string;
  /**
   * Which side of the YES ladder to rest on.
   *
   * The V2 API takes this directly, so there is no yes/no + buy/sell encoding
   * to get backwards. `bid` at 0.42 bids 42c for YES; `ask` at 0.42 offers YES
   * at 42c.
   */
  side: 'bid' | 'ask';
  /** YES-ladder price in dollars. Sent as a fixed-point string. */
  price: Decimal;
  count: number;
  /**
   * Rejected rather than crossed if it would take liquidity.
   *
   * Non-negotiable for calibration: a probe that crosses is not measuring
   * queue position, it is measuring nothing, and it pays the spread to do so.
   */
  postOnly: boolean;
  /**
   * Cancelled by the exchange if the market pauses.
   *
   * A pause is exactly when our own state is least trustworthy, so the safest
   * resting order during one is no resting order.
   */
  cancelOrderOnPause: boolean;
  /** Exchange-side backstop, longer than the planned dwell. Unix seconds. */
  expirationTime?: number;
  orderGroupId?: string;
}

export interface TradingClientOptions {
  baseUrl: string;
  signer: KalshiSigner;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class KalshiTradingClient {
  private readonly baseUrl: string;
  private readonly signer: KalshiSigner;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TradingClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.signer = opts.signer;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * One request, one attempt, timed.
   *
   * No retry loop anywhere in this client. Read paths could safely retry, but
   * a retry inside the timing measurement would silently report the latency of
   * the last attempt as though it were the latency of the operation, and these
   * measurements exist precisely to be believed.
   */
  private async call<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: T,
    opts: { body?: unknown; query?: URLSearchParams } = {},
  ): Promise<Timed<z.infer<T>>> {
    const fullPath = `${API_PREFIX}${path}`;
    const qs = opts.query && [...opts.query].length ? `?${opts.query}` : '';
    const url = `${this.baseUrl}${fullPath}${qs}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'kalshi-market-recorder/0.1 (calibration)',
      // The signature covers the path only; the query string is excluded.
      ...this.signer.headers(method, fullPath),
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const sendTs = Date.now();
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const ackTs = Date.now();
    const timing: CallTiming = {
      sendTs,
      ackTs,
      latencyMs: ackTs - sendTs,
      httpStatus: res.status,
    };

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new KalshiApiError(res.status, fullPath, body);
    }

    const json = await res.json().catch(() => ({}));
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      logger.error(
        {
          event: 'trading_schema_mismatch',
          path: fullPath,
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
          body: JSON.stringify(json).slice(0, 600),
        },
        'Kalshi trading response did not match the expected schema',
      );
      throw new Error(`Kalshi trading response schema mismatch on ${fullPath}`);
    }
    return { value: parsed.data, timing };
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /**
   * Places one order. Never retried.
   *
   * A timeout or network failure throws {@link AmbiguousOrderError}: the order
   * may be resting right now, and the caller must query before doing anything
   * else. An HTTP error with a response is unambiguous -- the exchange
   * answered -- and is thrown as-is.
   */
  async createOrder(req: CreateOrderRequest): Promise<Timed<V2Order>> {
    const body: Record<string, unknown> = {
      ticker: req.marketTicker,
      side: req.side,
      // Fixed-point strings, not numbers: the exchange prices in dollars and a
      // float would reintroduce exactly the rounding this codebase avoids
      // everywhere else.
      count: req.count.toFixed(2),
      price: req.price.toFixed(4),
      time_in_force: 'good_till_canceled',
      // Irrelevant at one resting order per market, but the field is required
      // and 'maker' is the conservative reading: our resting order yields.
      self_trade_prevention_type: 'maker',
      post_only: req.postOnly,
      cancel_order_on_pause: req.cancelOrderOnPause,
      client_order_id: req.clientOrderId,
      ...(req.expirationTime !== undefined ? { expiration_time: req.expirationTime } : {}),
      ...(req.orderGroupId !== undefined ? { order_group_id: req.orderGroupId } : {}),
    };

    try {
      return await this.call('POST', '/portfolio/events/orders', V2OrderResponse, { body });
    } catch (err) {
      if (err instanceof KalshiApiError) throw err; // the exchange answered
      throw new AmbiguousOrderError(req.clientOrderId, 'create', err);
    }
  }

  /**
   * Cancels an order.
   *
   * Also never retried, for the same reason in reverse: a cancel whose outcome
   * is unknown must not be assumed to have worked. Reconcile.
   *
   * `market_ticker` is passed so the exchange can auto-route without us having
   * to track which shard the order landed on.
   */
  async cancelOrder(
    orderId: string,
    clientOrderId: string,
    marketTicker: string,
  ): Promise<Timed<{ reducedBy: string | null }>> {
    try {
      const out = await this.call(
        'DELETE',
        `/portfolio/events/orders/${encodeURIComponent(orderId)}`,
        V2CancelResponse,
        { query: new URLSearchParams({ market_ticker: marketTicker }) },
      );
      return { value: { reducedBy: out.value.reduced_by ?? null }, timing: out.timing };
    } catch (err) {
      if (err instanceof KalshiApiError) throw err;
      throw new AmbiguousOrderError(clientOrderId, 'cancel', err);
    }
  }

  async getOrder(orderId: string): Promise<Timed<KalshiOrder>> {
    const out = await this.call(
      'GET',
      `/portfolio/orders/${encodeURIComponent(orderId)}`,
      GetOrderResponse,
    );
    return { value: out.value.order, timing: out.timing };
  }

  /** Resting orders. The authority for reconciliation after an ambiguity. */
  async listOrders(params: { status?: string; ticker?: string } = {}): Promise<
    Timed<KalshiOrder[]>
  > {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.ticker) query.set('ticker', params.ticker);
    const out = await this.call('GET', '/portfolio/orders', ListOrdersResponse, { query });
    return { value: out.value.orders ?? [], timing: out.timing };
  }

  /**
   * Queue position for every resting order, in ONE request.
   *
   * One request means one instant. Polling orders individually would spread
   * the observations across N round trips, and a queue position is only
   * comparable to the book state it was measured against.
   *
   * The endpoint requires a scope: an unscoped request is rejected with
   * "Need to specify market_tickers or event_ticker". Passing the markets we
   * actually have probes in keeps it to one call regardless.
   */
  async getQueuePositions(
    marketTickers: readonly string[],
  ): Promise<Timed<{ orderId: string; queuePosition: number | null }[]>> {
    if (marketTickers.length === 0) {
      throw new Error(
        'getQueuePositions needs at least one market ticker: the endpoint rejects an ' +
          'unscoped request with "Need to specify market_tickers or event_ticker"',
      );
    }
    const query = new URLSearchParams({ market_tickers: [...marketTickers].join(',') });
    const out = await this.call(
      'GET',
      '/portfolio/orders/queue_positions',
      QueuePositionsResponse,
      { query },
    );
    const rows = out.value.queue_positions ?? out.value.order_queue_positions ?? [];
    return {
      value: rows.map((r) => {
        const raw = r.queue_position_fp ?? r.queue_position;
        return {
          orderId: r.order_id,
          queuePosition: raw === null || raw === undefined ? null : Number(raw),
        };
      }),
      timing: out.timing,
    };
  }

  async getPositions(): Promise<
    Timed<{ marketTicker: string; position: number; restingOrders: number }[]>
  > {
    const out = await this.call('GET', '/portfolio/positions', PositionsResponse);
    return {
      value: (out.value.market_positions ?? []).map((p) => ({
        marketTicker: p.ticker ?? p.market_ticker ?? '',
        position: Number(p.position ?? 0),
        restingOrders: Number(p.resting_orders_count ?? 0),
      })),
      timing: out.timing,
    };
  }

  async getBalance(): Promise<Timed<{ dollars: string | null }>> {
    const out = await this.call('GET', '/portfolio/balance', BalanceResponse);
    return {
      value: {
        dollars:
          out.value.balance_dollars ??
          (out.value.balance !== null && out.value.balance !== undefined
            ? (out.value.balance / 100).toFixed(2)
            : null),
      },
      timing: out.timing,
    };
  }

  /**
   * Creates an order group with a rolling contract limit.
   *
   * An EXCHANGE-SIDE runaway guard. Every limit in our own process depends on
   * our process being correct; this one holds even if it is not, which is the
   * only kind of limit worth having when real orders are involved.
   */
  async createOrderGroup(contractsLimit: number): Promise<Timed<string | null>> {
    const out = await this.call('POST', '/portfolio/order_groups', CreateOrderGroupResponse, {
      body: { contracts_limit: contractsLimit, is_auto_cancel: true },
    });
    const id = out.value.order_group_id ?? out.value.order_group?.order_group_id ?? out.value.order_group?.id ?? null;
    return { value: id, timing: out.timing };
  }
}
