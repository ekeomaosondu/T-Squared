import { EventEmitter } from 'node:events';
import type { RawFrame } from '@/src/kalshi/websocketClient';

/**
 * Deterministic synthetic Kalshi feed.
 *
 * Emits frames in exactly the shape the live API produces (verified against
 * production on 2026-09-13), so collector tests exercise the real parsing and
 * sequencing paths. Also drives the load test.
 */

export interface FakeCommand {
  id: number;
  cmd: string;
  params: Record<string, unknown>;
}

/** Stand-in for KalshiWebSocketClient with the surface the Collector uses. */
export class FakeWebSocketClient extends EventEmitter {
  readonly sent: FakeCommand[] = [];
  private nextId = 1;
  private nextSid = 1;
  open = true;

  get isOpen(): boolean {
    return this.open;
  }

  getState(): string {
    return this.open ? 'open' : 'closed';
  }

  get url(): string {
    return 'wss://fake/trade-api/ws/v2';
  }

  allocateCommandId(): number {
    return this.nextId++;
  }

  subscribe(channels: string[], marketTickers?: string[]): number {
    const id = this.allocateCommandId();
    this.sent.push({ id, cmd: 'subscribe', params: { channels, market_tickers: marketTickers } });
    return id;
  }

  addMarkets(sids: number[], market_tickers: string[]): number {
    const id = this.allocateCommandId();
    this.sent.push({ id, cmd: 'update_subscription', params: { sids, market_tickers, action: 'add_markets' } });
    return id;
  }

  deleteMarkets(sids: number[], market_tickers: string[]): number {
    const id = this.allocateCommandId();
    this.sent.push({ id, cmd: 'update_subscription', params: { sids, market_tickers, action: 'delete_markets' } });
    return id;
  }

  requestSnapshot(sids: number[], market_tickers: string[]): number {
    const id = this.allocateCommandId();
    this.sent.push({ id, cmd: 'update_subscription', params: { sids, market_tickers, action: 'get_snapshot' } });
    return id;
  }

  unsubscribe(sids: number[]): number {
    const id = this.allocateCommandId();
    this.sent.push({ id, cmd: 'unsubscribe', params: { sids } });
    return id;
  }

  /**
   * Delivers the server's `subscribed` ack for the most recent subscribe.
   *
   * `forceSid` reproduces a sid recorded in an archive, so restored frames
   * resolve to the same subscription they were captured on.
   */
  ackSubscribe(channel: string, commandId?: number, forceSid?: number): number {
    const sid = forceSid ?? this.nextSid++;
    const id = commandId ?? this.sent.filter((c) => c.cmd === 'subscribe').at(-1)?.id;
    this.deliver({ type: 'subscribed', id, msg: { channel, sid } });
    return sid;
  }

  /** Emits a frame exactly as the socket layer would. */
  deliver(envelope: Record<string, unknown>): void {
    const text = JSON.stringify(envelope);
    const receivedAtMs = Date.now();
    const frame: RawFrame = {
      receivedAt: new Date(receivedAtMs),
      receivedAtMs,
      recvMonotonicNs: process.hrtime.bigint(),
      text,
      envelope: envelope as never,
    };
    this.emit('frame', frame);
  }

  /** Delivers a malformed frame, as an unparseable socket message. */
  deliverRaw(text: string): void {
    const receivedAtMs = Date.now();
    this.emit('frame', {
      receivedAt: new Date(receivedAtMs),
      receivedAtMs,
      recvMonotonicNs: process.hrtime.bigint(),
      text,
      envelope: null,
      parseError: 'invalid json',
    } satisfies RawFrame);
  }

  close(code = 1000, reason = 'test'): Promise<void> {
    this.open = false;
    this.emit('close', { code, reason, wasClean: true });
    return Promise.resolve();
  }

  commandsOfType(action: string): FakeCommand[] {
    return this.sent.filter((c) => c.params.action === action);
  }
}

// ---------------------------------------------------------------------------
// Message builders, matching the live wire format
// ---------------------------------------------------------------------------

export function snapshotFrame(opts: {
  sid: number;
  seq: number;
  ticker: string;
  marketId?: string;
  yes?: [string, string][];
  no?: [string, string][];
}) {
  const msg: Record<string, unknown> = {
    market_ticker: opts.ticker,
    market_id: opts.marketId ?? '00000000-0000-0000-0000-000000000000',
  };
  // Kalshi OMITS a side entirely when it is empty.
  if (opts.yes?.length) msg.yes_dollars_fp = opts.yes;
  if (opts.no?.length) msg.no_dollars_fp = opts.no;
  return { type: 'orderbook_snapshot', sid: opts.sid, seq: opts.seq, msg };
}

export function deltaFrame(opts: {
  sid: number;
  seq: number;
  ticker: string;
  side: 'yes' | 'no';
  price: string;
  delta: string;
  tsMs?: number;
}) {
  return {
    type: 'orderbook_delta',
    sid: opts.sid,
    seq: opts.seq,
    msg: {
      market_ticker: opts.ticker,
      market_id: '00000000-0000-0000-0000-000000000000',
      price_dollars: opts.price,
      delta_fp: opts.delta,
      side: opts.side,
      ts: new Date(opts.tsMs ?? Date.now()).toISOString(),
      ts_ms: opts.tsMs ?? Date.now(),
    },
  };
}

export function tradeFrame(opts: {
  sid: number;
  seq: number;
  ticker: string;
  tradeId: string;
  yesPrice: string;
  count: string;
  takerOutcomeSide?: 'yes' | 'no';
  takerBookSide?: 'bid' | 'ask';
  tsMs?: number;
}) {
  const yes = Number(opts.yesPrice);
  return {
    type: 'trade',
    sid: opts.sid,
    seq: opts.seq,
    msg: {
      trade_id: opts.tradeId,
      market_ticker: opts.ticker,
      yes_price_dollars: opts.yesPrice,
      no_price_dollars: (1 - yes).toFixed(4),
      count_fp: opts.count,
      taker_side: opts.takerOutcomeSide ?? 'yes',
      taker_outcome_side: opts.takerOutcomeSide ?? 'yes',
      taker_book_side: opts.takerBookSide ?? 'bid',
      is_block_trade: false,
      ts: Math.floor((opts.tsMs ?? Date.now()) / 1000),
      ts_ms: opts.tsMs ?? Date.now(),
    },
  };
}

export function tickerFrame(opts: {
  sid: number;
  ticker: string;
  yesBid?: string;
  yesAsk?: string;
  volume?: string;
  openInterest?: string;
  tsMs?: number;
}) {
  // The ticker channel carries NO seq.
  return {
    type: 'ticker',
    sid: opts.sid,
    msg: {
      market_ticker: opts.ticker,
      market_id: '00000000-0000-0000-0000-000000000000',
      price_dollars: opts.yesBid ?? '0.5000',
      yes_bid_dollars: opts.yesBid ?? '0.5000',
      yes_ask_dollars: opts.yesAsk ?? '0.5200',
      yes_bid_size_fp: '10.00',
      yes_ask_size_fp: '12.00',
      last_trade_size_fp: '1.00',
      volume_fp: opts.volume ?? '100.00',
      open_interest_fp: opts.openInterest ?? '50.00',
      dollar_volume: 50,
      dollar_open_interest: 25,
      ts: Math.floor((opts.tsMs ?? Date.now()) / 1000),
      ts_ms: opts.tsMs ?? Date.now(),
      time: new Date(opts.tsMs ?? Date.now()).toISOString(),
    },
  };
}

export function lifecycleFrame(opts: {
  sid: number;
  seq: number;
  ticker: string;
  eventType: string;
}) {
  return {
    type: 'market_lifecycle_v2',
    sid: opts.sid,
    seq: opts.seq,
    msg: { event_type: opts.eventType, market_ticker: opts.ticker },
  };
}
