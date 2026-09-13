import { z } from 'zod';

/**
 * Kalshi wire schemas.
 *
 * Verified against the live production REST API and the published AsyncAPI 2.0
 * document on 2026-09-13.
 *
 * Two conventions matter throughout:
 *
 *   `*_dollars`  decimal STRING in dollars, e.g. "0.0200" for two cents. The
 *                current API no longer uses integer cents, so no cent->dollar
 *                conversion happens anywhere in this codebase.
 *   `*_fp`       fixed-point decimal STRING for quantities, e.g. "26.91".
 *                Quantities are FRACTIONAL -- treating them as integers would
 *                silently truncate real resting size.
 *
 * Both are kept as strings all the way to decimal.js. They are never parsed
 * with Number().
 *
 * Every schema is `.passthrough()`: an unrecognised field must survive into the
 * raw payload rather than cause a message to be rejected.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A decimal string as returned by Kalshi. Rejects NaN/Infinity/exponent forms. */
export const DecimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'expected a plain decimal string');

export const MarketSide = z.enum(['yes', 'no']);
export type MarketSide = z.infer<typeof MarketSide>;

export const BookSide = z.enum(['bid', 'ask']);
export type BookSide = z.infer<typeof BookSide>;

/** [price_dollars, size_fp] */
export const PriceLevel = z.tuple([DecimalString, DecimalString]);
export type PriceLevel = z.infer<typeof PriceLevel>;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export const SeriesSchema = z
  .object({
    ticker: z.string(),
    title: z.string().nullish(),
    category: z.string().nullish(),
    frequency: z.string().nullish(),
    tags: z.array(z.string()).nullish(),
    settlement_sources: z.array(z.record(z.string(), z.unknown())).nullish(),
    contract_url: z.string().nullish(),
    contract_terms_url: z.string().nullish(),
    fee_type: z.string().nullish(),
    fee_multiplier: z.union([z.number(), DecimalString]).nullish(),
    product_metadata: z.record(z.string(), z.unknown()).nullish(),
    additional_prohibitions: z.array(z.string()).nullish(),
    last_updated_ts: z.string().nullish(),
  })
  .passthrough();
export type KalshiSeries = z.infer<typeof SeriesSchema>;

export const EventSchema = z
  .object({
    event_ticker: z.string(),
    series_ticker: z.string().nullish(),
    title: z.string().nullish(),
    sub_title: z.string().nullish(),
    category: z.string().nullish(),
    mutually_exclusive: z.boolean().nullish(),
    available_on_brokers: z.boolean().nullish(),
    collateral_return_type: z.string().nullish(),
    settlement_sources: z.array(z.record(z.string(), z.unknown())).nullish(),
    strike_date: z.string().nullish(),
    strike_period: z.string().nullish(),
    product_metadata: z.record(z.string(), z.unknown()).nullish(),
    last_updated_ts: z.string().nullish(),
  })
  .passthrough();
export type KalshiEvent = z.infer<typeof EventSchema>;

export const MarketSchema = z
  .object({
    ticker: z.string(),
    event_ticker: z.string().nullish(),
    market_type: z.string().nullish(),

    title: z.string().nullish(),
    subtitle: z.string().nullish(),
    yes_sub_title: z.string().nullish(),
    no_sub_title: z.string().nullish(),

    status: z.string().nullish(),

    strike_type: z.string().nullish(),
    floor_strike: z.union([z.number(), DecimalString]).nullish(),
    cap_strike: z.union([z.number(), DecimalString]).nullish(),
    functional_strike: z.string().nullish(),
    custom_strike: z.record(z.string(), z.unknown()).nullish(),

    price_level_structure: z.string().nullish(),
    price_ranges: z.array(z.record(z.string(), z.unknown())).nullish(),

    created_time: z.string().nullish(),
    updated_time: z.string().nullish(),
    open_time: z.string().nullish(),
    close_time: z.string().nullish(),
    expected_expiration_time: z.string().nullish(),
    latest_expiration_time: z.string().nullish(),
    expiration_time: z.string().nullish(),
    occurrence_datetime: z.string().nullish(),

    settlement_timer_seconds: z.number().nullish(),
    can_close_early: z.boolean().nullish(),
    early_close_condition: z.string().nullish(),

    rules_primary: z.string().nullish(),
    rules_secondary: z.string().nullish(),

    result: z.string().nullish(),
    expiration_value: z.string().nullish(),
    settlement_value_dollars: DecimalString.nullish(),

    notional_value_dollars: DecimalString.nullish(),

    // Quote snapshot embedded in the market object. Useful for cross-checking
    // but NOT a substitute for the order book.
    yes_bid_dollars: DecimalString.nullish(),
    yes_ask_dollars: DecimalString.nullish(),
    no_bid_dollars: DecimalString.nullish(),
    no_ask_dollars: DecimalString.nullish(),
    last_price_dollars: DecimalString.nullish(),
    previous_price_dollars: DecimalString.nullish(),
    yes_bid_size_fp: DecimalString.nullish(),
    yes_ask_size_fp: DecimalString.nullish(),
    volume_fp: DecimalString.nullish(),
    volume_24h_fp: DecimalString.nullish(),
    open_interest_fp: DecimalString.nullish(),
    liquidity_dollars: DecimalString.nullish(),
  })
  .passthrough();
export type KalshiMarket = z.infer<typeof MarketSchema>;

/** GET /markets/{ticker}/orderbook and the entries of /markets/orderbooks. */
export const OrderbookFpSchema = z
  .object({
    yes_dollars: z.array(PriceLevel).nullish(),
    no_dollars: z.array(PriceLevel).nullish(),
  })
  .passthrough();
export type KalshiOrderbookFp = z.infer<typeof OrderbookFpSchema>;

export const GetOrderbookResponse = z.object({ orderbook_fp: OrderbookFpSchema }).passthrough();

export const GetOrderbooksResponse = z
  .object({
    orderbooks: z.array(
      z.object({ ticker: z.string(), orderbook_fp: OrderbookFpSchema }).passthrough(),
    ),
  })
  .passthrough();

export const GetSeriesListResponse = z.object({ series: z.array(SeriesSchema) }).passthrough();
export const GetSeriesResponse = z.object({ series: SeriesSchema }).passthrough();
export const GetEventsResponse = z
  .object({ events: z.array(EventSchema), cursor: z.string().nullish() })
  .passthrough();
export const GetMarketsResponse = z
  .object({ markets: z.array(MarketSchema), cursor: z.string().nullish() })
  .passthrough();
export const GetMarketResponse = z.object({ market: MarketSchema }).passthrough();

/** GET /events/{event_ticker} returns the event plus its nested markets. */
export const GetEventWithMarketsResponse = z
  .object({ event: EventSchema, markets: z.array(MarketSchema).nullish() })
  .passthrough();

/**
 * The `status` QUERY parameter vocabulary, which differs from the `status`
 * FIELD on a market object. Verified against the live API: supplying 'active',
 * 'determined', 'finalized' or 'initialized' returns "invalid status filter",
 * and only one value may be supplied per request.
 */
export const MarketQueryStatus = z.enum(['open', 'unopened', 'closed', 'settled']);
export type MarketQueryStatus = z.infer<typeof MarketQueryStatus>;

/**
 * Maps the selector's market-object statuses onto the API's query vocabulary.
 * Returns a deduplicated set, since several object statuses collapse onto one
 * query value.
 */
export function statusFiltersForSelector(
  statuses: readonly string[] | undefined,
): MarketQueryStatus[] {
  if (!statuses?.length) return [];
  const out = new Set<MarketQueryStatus>();
  for (const s of statuses) {
    switch (s) {
      case 'initialized':
        out.add('unopened');
        break;
      case 'active':
        out.add('open');
        break;
      case 'inactive':
      case 'closed':
        out.add('closed');
        break;
      case 'determined':
      case 'finalized':
        out.add('settled');
        break;
    }
  }
  return [...out];
}

export const RestTradeSchema = z
  .object({
    trade_id: z.string(),
    ticker: z.string(),
    count_fp: DecimalString,
    yes_price_dollars: DecimalString,
    no_price_dollars: DecimalString,
    taker_side: MarketSide.nullish(),
    taker_outcome_side: MarketSide.nullish(),
    taker_book_side: BookSide.nullish(),
    is_block_trade: z.boolean().nullish(),
    created_time: z.string(),
  })
  .passthrough();

export const GetTradesResponse = z
  .object({ trades: z.array(RestTradeSchema), cursor: z.string().nullish() })
  .passthrough();

// ---------------------------------------------------------------------------
// WebSocket envelopes
// ---------------------------------------------------------------------------

export const WsChannel = z.enum([
  'orderbook_delta',
  'ticker',
  'trade',
  'fill',
  'market_lifecycle_v2',
  'user_orders',
  'market_positions',
]);
export type WsChannel = z.infer<typeof WsChannel>;

/** Channels whose messages carry a per-subscription `seq` we must validate. */
export const SEQUENCED_CHANNELS: ReadonlySet<string> = new Set([
  'orderbook_delta',
  'trade',
  'fill',
  'market_lifecycle_v2',
]);

/**
 * The ticker channel is NOT sequenced -- `seq` is absent from its payload -- so
 * gap detection must never be applied to it.
 */
export function isSequencedChannel(channel: string | undefined): boolean {
  return channel !== undefined && SEQUENCED_CHANNELS.has(channel);
}

export const OrderbookSnapshotMsg = z
  .object({
    market_ticker: z.string(),
    market_id: z.string().nullish(),
    // Absent (not empty) when a side has no resting interest.
    yes_dollars_fp: z.array(PriceLevel).nullish(),
    no_dollars_fp: z.array(PriceLevel).nullish(),
  })
  .passthrough();

export const OrderbookDeltaMsg = z
  .object({
    market_ticker: z.string(),
    market_id: z.string().nullish(),
    price_dollars: DecimalString,
    delta_fp: DecimalString,
    side: MarketSide,
    client_order_id: z.string().nullish(),
    subaccount: z.number().nullish(),
    ts: z.string().nullish(),
    ts_ms: z.number().nullish(),
  })
  .passthrough();

export const TradeMsg = z
  .object({
    trade_id: z.string(),
    market_ticker: z.string(),
    market_id: z.string().nullish(),
    yes_price_dollars: DecimalString,
    no_price_dollars: DecimalString,
    count_fp: DecimalString,
    // taker_side is deprecated in favour of taker_outcome_side but is still
    // sent; all three are preserved rather than collapsed.
    taker_side: MarketSide.nullish(),
    taker_outcome_side: MarketSide.nullish(),
    taker_book_side: BookSide.nullish(),
    is_block_trade: z.boolean().nullish(),
    ts: z.number().nullish(),
    ts_ms: z.number().nullish(),
  })
  .passthrough();

export const TickerMsg = z
  .object({
    market_ticker: z.string(),
    market_id: z.string().nullish(),
    price_dollars: DecimalString.nullish(),
    yes_bid_dollars: DecimalString.nullish(),
    yes_ask_dollars: DecimalString.nullish(),
    yes_bid_size_fp: DecimalString.nullish(),
    yes_ask_size_fp: DecimalString.nullish(),
    last_trade_size_fp: DecimalString.nullish(),
    volume_fp: DecimalString.nullish(),
    open_interest_fp: DecimalString.nullish(),
    dollar_volume: z.union([z.number(), DecimalString]).nullish(),
    dollar_open_interest: z.union([z.number(), DecimalString]).nullish(),
    ts: z.number().nullish(),
    ts_ms: z.number().nullish(),
    time: z.string().nullish(),
  })
  .passthrough();

export const MarketLifecycleMsg = z
  .object({
    event_type: z.string(),
    market_ticker: z.string(),
    exchange_index: z.number().nullish(),
    open_ts: z.number().nullish(),
    close_ts: z.number().nullish(),
    result: z.string().nullish(),
    determination_ts: z.number().nullish(),
    settlement_value: z.union([z.number(), DecimalString]).nullish(),
    settled_ts: z.number().nullish(),
    is_deactivated: z.boolean().nullish(),
    price_level_structure: z.string().nullish(),
    price_ranges: z.array(z.record(z.string(), z.unknown())).nullish(),
    strike_type: z.string().nullish(),
    floor_strike: z.union([z.number(), DecimalString]).nullish(),
    cap_strike: z.union([z.number(), DecimalString]).nullish(),
    custom_strike: z.record(z.string(), z.unknown()).nullish(),
    yes_sub_title: z.string().nullish(),
    additional_metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const EventLifecycleMsg = z
  .object({
    event_ticker: z.string(),
    series_ticker: z.string().nullish(),
    exchange_index: z.number().nullish(),
    title: z.string().nullish(),
    subtitle: z.string().nullish(),
    collateral_return_type: z.string().nullish(),
    strike_date: z.number().nullish(),
    strike_period: z.string().nullish(),
  })
  .passthrough();

/** Lifecycle event types that must trigger an immediate metadata refresh. */
export const METADATA_REFRESH_TRIGGERS: ReadonlySet<string> = new Set([
  'created',
  'close_date_updated',
  'metadata_updated',
  'price_level_structure_updated',
  'determined',
  'settled',
]);

export const SubscribedMsg = z
  .object({ channel: z.string(), sid: z.number() })
  .passthrough();

export const ErrorMsg = z.object({ code: z.number(), msg: z.string() }).passthrough();

/**
 * Generic envelope. Deliberately permissive: an unknown `type` is recorded to
 * raw_ingest_events like anything else rather than dropped.
 */
export const WsEnvelope = z
  .object({
    type: z.string(),
    id: z.number().nullish(),
    sid: z.number().nullish(),
    seq: z.number().nullish(),
    msg: z.unknown().nullish(),
  })
  .passthrough();
export type WsEnvelope = z.infer<typeof WsEnvelope>;

// ---------------------------------------------------------------------------
// Outbound commands
// ---------------------------------------------------------------------------

export interface SubscribeCommand {
  id: number;
  cmd: 'subscribe';
  params: {
    channels: string[];
    market_tickers?: string[];
  };
}

export interface UpdateSubscriptionCommand {
  id: number;
  cmd: 'update_subscription';
  params: {
    sids: number[];
    market_tickers?: string[];
    action: 'add_markets' | 'delete_markets' | 'get_snapshot';
  };
}

export interface UnsubscribeCommand {
  id: number;
  cmd: 'unsubscribe';
  params: { sids: number[] };
}

export type OutboundCommand = SubscribeCommand | UpdateSubscriptionCommand | UnsubscribeCommand;

/** Max markets accepted by GET /markets/orderbooks in one call (verified). */
export const MAX_ORDERBOOK_BATCH = 100;
