import { EventEmitter } from 'node:events';
import {
  KalshiWebSocketClient,
  type WebSocketClientOptions,
} from '@/src/kalshi/websocketClient';
import { KalshiRestClient } from '@/src/kalshi/restClient';
import { KalshiSigner } from '@/src/kalshi/auth';
import {
  OrderbookDeltaMsg,
  OrderbookSnapshotMsg,
  TradeMsg,
  WsEnvelope,
} from '@/src/kalshi/schemas';
import { canonicalPrice, canonicalSize } from '@/src/book/decimal';
import { fingerprintObjects } from '@/src/research/data/datasetManifest';
import type {
  BookCheckpoint,
  DatasetSlice,
  HistoricalDataSource,
  HistoricalRequest,
} from '@/src/research/data/historicalDataSource';
import {
  resolveLifecycleState,
  yesPayout,
  type HistoricalMarketState,
} from '@/src/research/data/marketDefinitions';
import type {
  BookDeltaEvent,
  BookSnapshotEvent,
  Level,
  ResearchEvent,
  TradeEvent,
} from '@/src/research/events/researchEvent';
import { D } from '@/src/book/decimal';
import { logger } from '@/src/logging/logger';

/**
 * A live Kalshi feed, presented as the same source a backtest reads.
 *
 * Implementing `HistoricalDataSource` is the point: the engine, the
 * strategies, the fill models and the metrics cannot tell the difference, so a
 * strategy that ran against recorded Parquet yesterday runs against the socket
 * today with no change to any of them.
 *
 * ---------------------------------------------------------------------------
 * This is NOT a second collector
 * ---------------------------------------------------------------------------
 * It opens its own read-only subscription and writes nothing: no session row,
 * no raw frames, no normalized rows, no archive. The recorded dataset has
 * exactly one writer and this is not it. What it does do is consume the same
 * frames through the same parsers, so a divergence between live and recorded
 * behaviour is a bug in one narrow adapter rather than in two independent
 * implementations of the protocol.
 *
 * Sequence gaps are surfaced, not repaired. A live consumer that quietly
 * re-seeds looks healthy while trading a book it cannot vouch for; here a gap
 * invalidates the affected stream and the engine's own rules take over.
 */

export interface LiveKalshiSourceOptions {
  wsUrl: string;
  restClient: KalshiRestClient;
  signer: KalshiSigner;
  /** Markets to subscribe to. Resolved from the request when absent. */
  marketTickers?: string[];
  /** Stop the stream after this long. Zero means run until closed. */
  runForMs?: number;
  /** Test seam, matching the collector's own client option. */
  webSocketImpl?: WebSocketClientOptions['webSocketImpl'];
}

interface StreamCursor {
  push(event: ResearchEvent): void;
  end(): void;
  fail(err: Error): void;
}

/**
 * A bounded async queue bridging the socket's callbacks to an async iterable.
 *
 * Bounded on purpose. If a strategy is slower than the market the queue grows,
 * and an unbounded one turns that into an out-of-memory hours later with no
 * indication of the cause. Overflow is reported as what it is: the consumer
 * fell behind, and every event dropped is one the strategy did not see.
 */
class EventQueue implements StreamCursor {
  private readonly buffer: ResearchEvent[] = [];
  private waiting: ((v: IteratorResult<ResearchEvent>) => void) | null = null;
  private failure: Error | null = null;
  private done = false;
  private dropped = 0;

  constructor(private readonly maxDepth: number) {}

  get droppedCount(): number {
    return this.dropped;
  }

  push(event: ResearchEvent): void {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: event, done: false });
      return;
    }
    if (this.buffer.length >= this.maxDepth) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1000 === 0) {
        logger.error(
          { event: 'live_source_overflow', dropped: this.dropped, depth: this.maxDepth },
          'the strategy is slower than the market; events are being dropped',
        );
      }
      return;
    }
    this.buffer.push(event);
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  fail(err: Error): void {
    this.failure = err;
    this.end();
  }

  async *drain(): AsyncGenerator<ResearchEvent> {
    for (;;) {
      if (this.failure) throw this.failure;
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) return;
      const value = await new Promise<IteratorResult<ResearchEvent>>((resolve) => {
        this.waiting = resolve;
      });
      if (value.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield value.value;
    }
  }
}

export class LiveKalshiDataSource extends EventEmitter implements HistoricalDataSource {
  readonly kind = 'kalshi-live';

  private client: KalshiWebSocketClient | null = null;
  private queue: EventQueue | null = null;
  private ordinal = 0n;
  /** One synthetic session per process run; ordinals are scoped to it. */
  private readonly sessionId = `live-${Date.now().toString(36)}`;
  private readonly streamBySid = new Map<number, string>();
  private universe: string[] = [];

  constructor(private readonly opts: LiveKalshiSourceOptions) {
    super();
  }

  private async resolveUniverse(req: HistoricalRequest): Promise<string[]> {
    if (this.opts.marketTickers?.length) return [...this.opts.marketTickers];
    if (req.marketTickers?.length) return [...req.marketTickers];

    const tickers: string[] = [];
    for (const series of req.seriesTickers ?? []) {
      const markets = await this.opts.restClient.getMarkets({
        seriesTicker: series,
        status: 'open',
      });
      for (const m of markets) tickers.push(m.ticker);
    }
    if (tickers.length === 0) {
      throw new Error(
        'the live source needs a market universe: pass --markets, or --series with open markets',
      );
    }
    return tickers.sort();
  }

  async describe(req: HistoricalRequest): Promise<DatasetSlice> {
    this.universe = await this.resolveUniverse(req);
    const objects = [{ path: `live://${this.opts.wsUrl}`, rows: 0, rowGroups: 0 }];
    return {
      datasetId: req.datasetId,
      // A live slice has no fixed content, so the fingerprint identifies the
      // SUBSCRIPTION rather than pretending to identify bytes. A shadow run is
      // reproducible only in the sense that its recording is; that limit is
      // stated here rather than papered over with a hash of nothing.
      fingerprint: fingerprintObjects([
        { path: `live://${this.universe.join(',')}`, rows: 0, rowGroups: 0 },
      ]),
      objects,
      rowCounts: {},
      firstReceiveMs: null,
      lastReceiveMs: null,
      marketTickers: this.universe,
      seriesTickers: req.seriesTickers ?? [],
      captureGaps: [],
    };
  }

  /** Live data has no independently recorded hashes to check against. */
  async checkpoints(): Promise<BookCheckpoint[]> {
    return [];
  }

  async marketStates(req: HistoricalRequest): Promise<Map<string, HistoricalMarketState>> {
    const out = new Map<string, HistoricalMarketState>();
    const tickers = this.universe.length > 0 ? this.universe : await this.resolveUniverse(req);

    for (const ticker of tickers) {
      try {
        const m = await this.opts.restClient.getMarket(ticker);
        const raw = m as unknown as Record<string, unknown>;
        const state = resolveLifecycleState(m.status ?? null, (raw.result as string) ?? null);
        const settlementValue =
          raw.settlement_value_dollars !== undefined && raw.settlement_value_dollars !== null
            ? D(String(raw.settlement_value_dollars))
            : null;
        const notional =
          raw.notional_value_dollars !== undefined && raw.notional_value_dollars !== null
            ? D(String(raw.notional_value_dollars))
            : null;
        const payout = yesPayout(state, settlementValue, notional);

        out.set(ticker, {
          marketTicker: ticker,
          eventTicker: m.event_ticker ?? null,
          seriesTicker: (raw.series_ticker as string) ?? null,
          state,
          rawStatus: m.status ?? null,
          rawResult: (raw.result as string) ?? null,
          yesSettlementValue: payout.value,
          settlementBasis: payout.basis,
          notionalValue: notional,
          isProvisional: raw.is_provisional === true,
          closeTimeMs: null,
          settlementTimeMs: null,
          observedAtMs: BigInt(Date.now()),
          strikeType: (raw.strike_type as string) ?? null,
          floorStrike: null,
          capStrike: null,
          // Fee treatment lives on the SERIES, and the live source does not
          // fetch it: a shadow run reads its fee provenance from the lake
          // snapshot like every other run, so the two cannot disagree.
          feeType: null,
          feeMultiplier: null,
          feeUpdatedAtMs: null,
          settlementSources: [],
        });
      } catch (err) {
        logger.warn(
          { event: 'live_market_state_failed', market_ticker: ticker, err: String(err) },
          `could not read live state for ${ticker}`,
        );
      }
    }
    return out;
  }

  async *stream(req: HistoricalRequest): AsyncIterable<ResearchEvent> {
    if (this.universe.length === 0) this.universe = await this.resolveUniverse(req);

    const queue = new EventQueue(200_000);
    this.queue = queue;

    const client = new KalshiWebSocketClient({
      url: this.opts.wsUrl,
      signer: this.opts.signer,
      webSocketImpl: this.opts.webSocketImpl,
    });
    this.client = client;

    client.on('frame', (frame) => {
      if (!frame.envelope) return;
      try {
        this.handleFrame(frame.receivedAtMs, frame.envelope, queue);
      } catch (err) {
        logger.warn({ event: 'live_frame_failed', err: String(err) }, 'unparseable live frame');
      }
    });
    client.on('error', (err) => logger.error({ event: 'live_ws_error', err: String(err) }, 'socket error'));
    client.on('open', () => {
      // Every reconnect is a new sequence space. Subscribing again produces a
      // fresh snapshot per market, which the engine treats as a new epoch.
      client.subscribe(['orderbook_delta', 'trade'], this.universe);
      logger.info(
        { event: 'live_subscribed', markets: this.universe.length },
        `subscribed to ${this.universe.length} market(s)`,
      );
    });

    await client.connect();

    const stopAt = this.opts.runForMs ? Date.now() + this.opts.runForMs : null;
    const timer = stopAt
      ? setTimeout(() => queue.end(), this.opts.runForMs)
      : null;

    try {
      for await (const event of queue.drain()) yield event;
    } finally {
      if (timer) clearTimeout(timer);
      await this.close();
    }
  }

  private nextOrdinal(): bigint {
    this.ordinal += 1n;
    return this.ordinal;
  }

  private streamIdFor(sid: number | null | undefined): string | null {
    if (sid === null || sid === undefined) return null;
    let id = this.streamBySid.get(sid);
    if (!id) {
      id = `${this.sessionId}-sid${sid}-${this.streamBySid.size}`;
      this.streamBySid.set(sid, id);
    }
    return id;
  }

  private handleFrame(receivedAtMs: number, envelope: WsEnvelope, queue: StreamCursor): void {
    const type = envelope.type;
    const at = BigInt(receivedAtMs);
    const streamId = this.streamIdFor(envelope.sid);
    const seq = envelope.seq === null || envelope.seq === undefined ? null : BigInt(envelope.seq);

    if (type === 'orderbook_snapshot') {
      const msg = OrderbookSnapshotMsg.parse(envelope.msg);
      const levels = (raw: [string, string][] | null | undefined): Level[] =>
        (raw ?? []).map(([p, s]) => [canonicalPrice(p), canonicalSize(s)] as Level);

      const event: BookSnapshotEvent = {
        kind: 'book_snapshot',
        exchangeTimeMs: null,
        receiveTimeMs: at,
        sessionId: this.sessionId,
        ingestOrdinal: null,
        streamId,
        seq,
        marketTicker: msg.market_ticker,
        source: 'ws_initial',
        yesBids: levels(msg.yes_dollars_fp as [string, string][] | null | undefined),
        noBids: levels(msg.no_dollars_fp as [string, string][] | null | undefined),
        // A live frame carries no state hash; there is nothing recorded to
        // check it against yet, and inventing one would imply otherwise.
        stateHash: null,
      };
      queue.push(event);
      return;
    }

    if (type === 'orderbook_delta') {
      const msg = OrderbookDeltaMsg.parse(envelope.msg);
      const event: BookDeltaEvent = {
        kind: 'book_delta',
        exchangeTimeMs: msg.ts_ms === null || msg.ts_ms === undefined ? null : BigInt(msg.ts_ms),
        receiveTimeMs: at,
        sessionId: this.sessionId,
        ingestOrdinal: this.nextOrdinal(),
        streamId,
        seq,
        marketTicker: msg.market_ticker,
        side: msg.side,
        price: canonicalPrice(msg.price_dollars),
        deltaCount: canonicalSize(msg.delta_fp),
        // The exchange does not send pre/post counts. Null rather than a
        // reconstruction: the queue model reconciles trades against DISPLAYED
        // size changes, and feeding it a value we derived from our own book
        // would make it reconcile against itself.
        preCount: null,
        postCount: null,
        applied: true,
        applyError: null,
      };
      queue.push(event);
      return;
    }

    if (type === 'trade') {
      const msg = TradeMsg.parse(envelope.msg);
      const event: TradeEvent = {
        kind: 'trade',
        exchangeTimeMs: msg.ts_ms === null || msg.ts_ms === undefined ? null : BigInt(msg.ts_ms),
        receiveTimeMs: at,
        sessionId: this.sessionId,
        ingestOrdinal: this.nextOrdinal(),
        streamId,
        seq,
        marketTicker: msg.market_ticker,
        tradeId: msg.trade_id,
        yesPrice: canonicalPrice(msg.yes_price_dollars),
        noPrice: canonicalPrice(msg.no_price_dollars),
        count: canonicalSize(msg.count_fp),
        takerOutcomeSide: msg.taker_outcome_side ?? msg.taker_side ?? null,
        takerBookSide: msg.taker_book_side ?? null,
        isBlockTrade: msg.is_block_trade === true,
      };
      queue.push(event);
    }
  }

  get droppedEvents(): number {
    return this.queue?.droppedCount ?? 0;
  }

  async close(): Promise<void> {
    this.queue?.end();
    this.queue = null;
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}
