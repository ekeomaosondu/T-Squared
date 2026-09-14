import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { KalshiWebSocketClient, type WebSocketClientOptions } from '@/src/kalshi/websocketClient';
import type { KalshiSigner } from '@/src/kalshi/auth';
import { logger } from '@/src/logging/logger';

/**
 * The private order and fill feed.
 *
 * Calibration cannot run without it. Polling would tell us a fill happened
 * some time in the last poll interval; the feed tells us when the exchange
 * says it happened, and the difference between the exchange's timestamp and
 * our receive time is part of the latency dataset.
 *
 * More importantly it is a SAFETY input. If this feed is down we do not know
 * our own order state, and an experiment that keeps placing orders while blind
 * to their outcome is not an experiment. The runner treats a disconnect as a
 * stop condition, not a warning.
 */

const PrivateOrderMsg = z
  .object({
    order_id: z.string().nullish(),
    client_order_id: z.string().nullish(),
    market_ticker: z.string().nullish(),
    ticker: z.string().nullish(),
    status: z.string().nullish(),
    action: z.string().nullish(),
    side: z.string().nullish(),
    remaining_count: z.union([z.number(), z.string()]).nullish(),
    filled_count: z.union([z.number(), z.string()]).nullish(),
    queue_position: z.union([z.number(), z.string()]).nullish(),
    ts: z.number().nullish(),
    ts_ms: z.number().nullish(),
  })
  .passthrough();

const PrivateFillMsg = z
  .object({
    trade_id: z.string().nullish(),
    fill_id: z.string().nullish(),
    order_id: z.string().nullish(),
    client_order_id: z.string().nullish(),
    market_ticker: z.string().nullish(),
    ticker: z.string().nullish(),
    side: z.string().nullish(),
    action: z.string().nullish(),
    is_taker: z.boolean().nullish(),
    count_fp: z.string().nullish(),
    count: z.union([z.number(), z.string()]).nullish(),
    yes_price_dollars: z.string().nullish(),
    no_price_dollars: z.string().nullish(),
    fee_dollars: z.string().nullish(),
    ts: z.number().nullish(),
    ts_ms: z.number().nullish(),
  })
  .passthrough();

export interface PrivateOrderUpdate {
  orderId: string | null;
  clientOrderId: string | null;
  marketTicker: string | null;
  status: string | null;
  remainingCount: number | null;
  filledCount: number | null;
  queuePosition: number | null;
  exchangeTsMs: number | null;
  receivedAtMs: number;
  raw: unknown;
}

export interface PrivateFill {
  fillId: string | null;
  orderId: string | null;
  clientOrderId: string | null;
  marketTicker: string | null;
  side: string | null;
  action: string | null;
  isTaker: boolean | null;
  count: string | null;
  yesPrice: string | null;
  noPrice: string | null;
  /** What the exchange ACTUALLY charged, not what a model computed. */
  feeDollars: string | null;
  exchangeTsMs: number | null;
  receivedAtMs: number;
  raw: unknown;
}

export interface PrivateFeedEvents {
  order: [PrivateOrderUpdate];
  fill: [PrivateFill];
  /** The feed is no longer trustworthy. The runner must stop placing orders. */
  down: [{ reason: string }];
  up: [];
}

export class KalshiPrivateFeed extends EventEmitter<PrivateFeedEvents> {
  private client: KalshiWebSocketClient | null = null;
  private connected = false;
  private lastMessageAtMs = 0;

  constructor(
    private readonly opts: {
      wsUrl: string;
      signer: KalshiSigner;
      webSocketImpl?: WebSocketClientOptions['webSocketImpl'];
    },
  ) {
    super();
  }

  get isUp(): boolean {
    return this.connected;
  }

  get lastMessageMs(): number {
    return this.lastMessageAtMs;
  }

  async start(): Promise<void> {
    const client = new KalshiWebSocketClient({
      url: this.opts.wsUrl,
      signer: this.opts.signer,
      webSocketImpl: this.opts.webSocketImpl,
    });
    this.client = client;

    client.on('open', () => {
      this.connected = true;
      client.subscribe(['user_orders', 'fill']);
      logger.info({ event: 'private_feed_up' }, 'private order and fill feed subscribed');
      this.emit('up');
    });

    client.on('close', ({ reason }) => {
      this.connected = false;
      // A disconnect is a STOP condition. While it is down we do not know our
      // own order state, and placing more orders would be trading blind.
      logger.error({ event: 'private_feed_down', reason }, 'private feed disconnected');
      this.emit('down', { reason: reason || 'websocket closed' });
    });

    client.on('error', (err) => {
      logger.error({ event: 'private_feed_error', err: String(err) }, 'private feed error');
    });

    client.on('frame', (frame) => {
      if (!frame.envelope) return;
      this.lastMessageAtMs = frame.receivedAtMs;
      try {
        this.handle(frame.receivedAtMs, frame.envelope.type, frame.envelope.msg);
      } catch (err) {
        logger.warn(
          { event: 'private_feed_parse_failed', err: String(err) },
          'unparseable private frame',
        );
      }
    });

    await client.connect();
  }

  private handle(receivedAtMs: number, type: string, msg: unknown): void {
    if (type === 'fill') {
      const m = PrivateFillMsg.parse(msg);
      this.emit('fill', {
        fillId: m.fill_id ?? m.trade_id ?? null,
        orderId: m.order_id ?? null,
        clientOrderId: m.client_order_id ?? null,
        marketTicker: m.market_ticker ?? m.ticker ?? null,
        side: m.side ?? null,
        action: m.action ?? null,
        isTaker: m.is_taker ?? null,
        count: m.count_fp ?? (m.count === null || m.count === undefined ? null : String(m.count)),
        yesPrice: m.yes_price_dollars ?? null,
        noPrice: m.no_price_dollars ?? null,
        feeDollars: m.fee_dollars ?? null,
        exchangeTsMs: m.ts_ms ?? (m.ts ? m.ts * 1000 : null),
        receivedAtMs,
        raw: msg,
      });
      return;
    }

    if (type === 'user_order' || type === 'user_orders' || type === 'order_update') {
      const m = PrivateOrderMsg.parse(msg);
      this.emit('order', {
        orderId: m.order_id ?? null,
        clientOrderId: m.client_order_id ?? null,
        marketTicker: m.market_ticker ?? m.ticker ?? null,
        status: m.status ?? null,
        remainingCount:
          m.remaining_count === null || m.remaining_count === undefined
            ? null
            : Number(m.remaining_count),
        filledCount:
          m.filled_count === null || m.filled_count === undefined ? null : Number(m.filled_count),
        queuePosition:
          m.queue_position === null || m.queue_position === undefined
            ? null
            : Number(m.queue_position),
        exchangeTsMs: m.ts_ms ?? (m.ts ? m.ts * 1000 : null),
        receivedAtMs,
        raw: msg,
      });
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.client?.close();
    this.client = null;
  }
}
