import { EventEmitter } from 'node:events';
import { BookManager } from '@/src/book/bookManager';
import { checkConsistency } from '@/src/book/features';
import { Decimal } from '@/src/book/decimal';
import type { CollectorConfig } from '@/src/config/collectorConfig';
import type { KalshiRestClient } from '@/src/kalshi/restClient';
import {
  EventLifecycleMsg,
  MarketLifecycleMsg,
  METADATA_REFRESH_TRIGGERS,
  OrderbookDeltaMsg,
  OrderbookSnapshotMsg,
  TickerMsg,
  TradeMsg,
  isSequencedChannel,
} from '@/src/kalshi/schemas';
import type { KalshiWebSocketClient, RawFrame } from '@/src/kalshi/websocketClient';
import { SequenceTracker } from '@/src/integrity/sequenceTracker';
import { BatchWriter } from '@/src/persistence/batchWriter';
import type { Sql } from '@/src/persistence/db';
import {
  integrityRow,
  recordIntegrityEvent,
  markGapFailed,
  markGapRecovered,
  markGapRecovering,
  recordSequenceGap,
} from '@/src/persistence/repositories/integrity';
import {
  closeStream,
  createStream,
  setStreamSid,
  setStreamStatus,
  updateStreamSeq,
} from '@/src/persistence/repositories/sessions';
import type { IngestUnit, NormalizedRow } from '@/src/persistence/types';
import { channelForType, toRawIngestEvent } from '@/src/collector/messageRouter';
import { MarketStateCache } from '@/src/collector/marketState';
import { SubscriptionManager } from '@/src/collector/subscriptionManager';
import type { UniverseManager } from '@/src/collector/universeManager';
import { logger } from '@/src/logging/logger';

/**
 * The recorder core.
 *
 * Ordering discipline for every frame:
 *
 *   1. capture the raw event (already timestamped by the socket layer)
 *   2. classify its sequence
 *   3. reconstruct book state, if and only if continuity is intact
 *   4. emit normalised rows
 *   5. hand the whole unit to the batch writer
 *
 * If step 3 or 4 throws, step 1 has already happened and the raw event is
 * still written. The raw log is never contingent on our ability to interpret
 * what it contains.
 *
 * This class has no Vercel and no Next.js dependency; the daemon and the
 * rolling-session wrapper both drive exactly this object.
 */

export interface CollectorOptions {
  sql: Sql;
  ws: KalshiWebSocketClient;
  rest: KalshiRestClient;
  universe: UniverseManager;
  writer: BatchWriter;
  books?: BookManager;
  config: CollectorConfig;
  sessionId: string;
  /** Only the lease owner writes canonical normalised events. */
  canWriteCanonical?: () => boolean;
}

export interface CollectorCounters {
  messagesReceived: number;
  messagesPersisted: number;
  orderbookDeltas: number;
  snapshots: number;
  trades: number;
  tickers: number;
  lifecycle: number;
  sequenceGaps: number;
  negativeLevels: number;
  unparseable: number;
  reconnects: number;
  tickerBboMismatches: number;
}

const CHANNELS_FOR_CAPTURE = {
  orderbookDeltas: 'orderbook_delta',
  trades: 'trade',
  tickerUpdates: 'ticker',
  lifecycleEvents: 'market_lifecycle_v2',
} as const;

/** Suppresses repeated ticker-vs-book complaints for the same market. */
const TICKER_MISMATCH_COOLDOWN_MS = 60_000;

/**
 * Minimum interval between recovery-snapshot requests for one market.
 *
 * Every requested snapshot advances the subscription's sequence, so an
 * unthrottled request-on-every-violation loop is self-sustaining.
 */
const SNAPSHOT_REQUEST_COOLDOWN_MS = 5_000;

/** An episode that produces no snapshots within this window has failed. */
const RECOVERY_TIMEOUT_MS = 30_000;

export class Collector extends EventEmitter {
  readonly books: BookManager;
  /** Last-trade / volume / open-interest context for sampling. */
  readonly marketState = new MarketStateCache();
  readonly sequences = new SequenceTracker();
  readonly subscriptions: SubscriptionManager;

  readonly counters: CollectorCounters = {
    messagesReceived: 0,
    messagesPersisted: 0,
    orderbookDeltas: 0,
    snapshots: 0,
    trades: 0,
    tickers: 0,
    lifecycle: 0,
    sequenceGaps: 0,
    negativeLevels: 0,
    unparseable: 0,
    reconnects: 0,
    tickerBboMismatches: 0,
  };

  private readonly sql: Sql;
  private readonly ws: KalshiWebSocketClient;
  private readonly rest: KalshiRestClient;
  private readonly universe: UniverseManager;
  private readonly writer: BatchWriter;
  private config: CollectorConfig;
  private readonly sessionId: string;
  private readonly canWriteCanonical: () => boolean;

  /** stream_id -> open recovery episode awaiting snapshots. */
  private readonly pendingRecovery = new Map<
    string,
    { gapId: string | null; markets: Set<string>; requestedAtMs: number }
  >();
  private readonly lastTickerMismatchAt = new Map<string, number>();
  private readonly lastSnapshotRequestAt = new Map<string, number>();

  /**
   * Database side effects deferred off the frame path.
   *
   * The frame handler MUST stay synchronous: awaiting inside it lets later
   * frames enqueue ahead of earlier ones, which silently reorders the raw log.
   * Since replay walks raw/normalised rows in id order, that reordering would
   * corrupt reconstruction. So anything needing I/O is queued here and drained
   * by a single serial worker.
   */
  private readonly deferred: (() => Promise<void>)[] = [];
  private draining = false;

  private started = false;

  constructor(opts: CollectorOptions) {
    super();
    this.sql = opts.sql;
    this.ws = opts.ws;
    this.rest = opts.rest;
    this.universe = opts.universe;
    this.writer = opts.writer;
    this.books = opts.books ?? new BookManager();
    this.config = opts.config;
    this.sessionId = opts.sessionId;
    this.canWriteCanonical = opts.canWriteCanonical ?? (() => true);
    this.subscriptions = new SubscriptionManager(this.ws);
  }

  setConfig(config: CollectorConfig): void {
    this.config = config;
  }

  /** Rate-limits per-market snapshot requests so recovery cannot self-amplify. */
  private mayRequestSnapshot(marketTicker: string, nowMs = Date.now()): boolean {
    const last = this.lastSnapshotRequestAt.get(marketTicker) ?? 0;
    if (nowMs - last < SNAPSHOT_REQUEST_COOLDOWN_MS) return false;
    this.lastSnapshotRequestAt.set(marketTicker, nowMs);
    return true;
  }

  /**
   * Fails recovery episodes that never produced their snapshots. Called from
   * the heartbeat, so a stuck episode cannot leave a stream degraded forever
   * with no record of why.
   */
  reapStalledRecoveries(nowMs = Date.now()): void {
    for (const [streamId, episode] of this.pendingRecovery) {
      if (nowMs - episode.requestedAtMs < RECOVERY_TIMEOUT_MS) continue;

      this.pendingRecovery.delete(streamId);
      const outstanding = [...episode.markets];

      logger.error(
        { event: 'recovery_timeout', stream_id: streamId, outstanding: outstanding.length },
        'recovery snapshots never arrived; stream remains degraded',
      );

      const sql = this.sql;
      const sessionId = this.sessionId;
      const gapId = episode.gapId;
      this.defer(async () => {
        if (gapId) {
          await markGapFailed(sql, gapId, `recovery timed out; ${outstanding.length} markets outstanding`).catch(() => {});
        }
        await recordIntegrityEvent(sql, {
          sessionId,
          type: 'recovery_failure',
          severity: 'critical',
          details: { stream_id: streamId, outstanding_markets: outstanding },
        }).catch(() => {});
      });
    }
  }

  /** Queues an I/O side effect to run after the current frame is enqueued. */
  private defer(task: () => Promise<void>): void {
    this.deferred.push(task);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.deferred.length > 0) {
        const task = this.deferred.shift()!;
        try {
          await task();
        } catch (err) {
          logger.error({ event: 'deferred_task_failed', err: String(err) }, 'deferred task failed');
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Waits for queued side effects to finish; used on shutdown and in tests. */
  async flushDeferred(): Promise<void> {
    while (this.deferred.length > 0 || this.draining) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  get enabledChannels(): string[] {
    const out: string[] = [];
    for (const [key, channel] of Object.entries(CHANNELS_FOR_CAPTURE)) {
      if (this.config.capture[key as keyof typeof CHANNELS_FOR_CAPTURE]) out.push(channel);
    }
    if (this.config.capture.privateOrders) out.push('user_orders');
    if (this.config.capture.privateFills) out.push('fill');
    return out;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;

    this.ws.on('frame', (frame) => {
      // Synchronous by design: see `deferred`. Never let a handler error kill
      // the socket listener.
      try {
        this.handleFrame(frame);
      } catch (err) {
        logger.error({ event: 'frame_handler_error', err: String(err) }, 'frame handler threw');
      }
    });

    this.ws.on('close', () => {
      void this.handleDisconnect();
    });
  }

  /**
   * Subscribes every enabled channel to the current universe.
   *
   * Called on connect and on reconnect. A reconnect always produces NEW
   * streams; book state is not carried across, and every book is rebuilt from
   * the fresh snapshots the exchange sends on subscribe.
   */
  async subscribeAll(markets: string[]): Promise<void> {
    // Guard against double-subscribing the same connection. Two subscriptions
    // on one channel produce two sids, two snapshot bursts and two independent
    // sequence streams, which looks exactly like a gap on the first one.
    if (this.subscriptions.size > 0) {
      logger.warn(
        { event: 'subscribe_all_skipped', existing: this.subscriptions.size },
        'subscribeAll called while subscriptions already exist; ignoring',
      );
      return;
    }

    for (const channel of this.enabledChannels) {
      // The lifecycle channel is market-scoped on Kalshi but is worth keeping
      // subscribed to the tracked set so new strikes announce themselves.
      const subs = this.subscriptions.subscribe(channel, markets);
      for (const sub of subs) {
        await createStream(this.sql, {
          streamId: sub.streamId,
          sessionId: this.sessionId,
          channel: sub.channel,
          sid: null,
          marketTickers: [...sub.markets],
        });
        this.sequences.register(sub.streamId, sub.channel);
        for (const m of sub.markets) this.books.associate(sub.streamId, m);
      }
    }
  }

  /** Applies a universe diff to live subscriptions without reconnecting. */
  async applyUniverseDiff(added: string[], removed: string[]): Promise<void> {
    if (added.length === 0 && removed.length === 0) return;

    // Before the first subscribe, the whole universe is "added"; subscribing it
    // here would duplicate what subscribeAll is about to do. Nothing to
    // reconcile until a connection exists.
    if (this.subscriptions.size === 0) return;

    for (const channel of this.enabledChannels) {
      if (added.length > 0) {
        const { created } = this.subscriptions.addMarkets(channel, added);
        for (const sub of created) {
          await createStream(this.sql, {
            streamId: sub.streamId,
            sessionId: this.sessionId,
            channel: sub.channel,
            sid: null,
            marketTickers: [...sub.markets],
          });
          this.sequences.register(sub.streamId, sub.channel);
        }
      }
      if (removed.length > 0) this.subscriptions.removeMarkets(channel, removed);
    }

    // Books for dropped markets are released, but their recorded history is
    // untouched -- a closed tracking window never deletes data.
    for (const ticker of removed) {
      this.books.remove(ticker);
      this.marketState.remove(ticker);
    }
  }

  private async handleDisconnect(): Promise<void> {
    this.counters.reconnects += 1;

    // Old state is NEVER reapplied after a reconnect. Every book is invalid
    // until the exchange sends a fresh snapshot on the new connection.
    const affected = this.books.invalidateAll('websocket disconnected; awaiting fresh snapshots');

    const streams = this.subscriptions.reset();
    for (const sub of streams) {
      await closeStream(this.sql, sub.streamId).catch(() => {});
      this.sequences.remove(sub.streamId);
    }
    this.pendingRecovery.clear();

    this.writer.enqueueDerived([
      integrityRow({
        sessionId: this.sessionId,
        type: 'ws_disconnect',
        severity: 'warning',
        details: { invalidatedBooks: affected.length, streamsClosed: streams.length },
      }),
    ]);

    this.emit('disconnected', { invalidatedBooks: affected.length });
  }

  // -------------------------------------------------------------------------
  // Frame handling
  // -------------------------------------------------------------------------

  private handleFrame(frame: RawFrame): void {
    this.counters.messagesReceived += 1;

    const env = frame.envelope;
    const messageType = env?.type ?? 'unparseable';

    // Control-plane frames carry no market data.
    if (messageType === 'subscribed') {
      this.handleSubscribed(env);
      return;
    }
    if (messageType === 'error') {
      this.handleError(env);
      return;
    }
    if (messageType === 'ok' || messageType === 'unsubscribed' || messageType === 'ping' || messageType === 'pong') {
      return;
    }

    const sub = env?.sid !== undefined && env.sid !== null ? this.subscriptions.bySidOrNull(env.sid) : null;
    const streamId = sub?.streamId ?? null;
    const channel = sub?.channel ?? channelForType(messageType);

    // ---- 1. Capture raw FIRST -------------------------------------------
    const raw = toRawIngestEvent(frame, this.sessionId, streamId);
    const unit: IngestUnit = { raw, normalized: [] };

    // Exchange-to-receive latency, for messages that carried a usable
    // exchange timestamp. Not true network latency -- see healthMetrics.
    if (raw.exchangeTsMs !== null) this.emit('latency', raw.exchangeTsMs, raw.receivedAtMs);

    if (!env) {
      this.counters.unparseable += 1;
      unit.normalized.push(
        integrityRow({
          sessionId: this.sessionId,
          type: 'unexpected_schema',
          severity: 'error',
          details: { parseError: frame.parseError, preview: frame.text.slice(0, 500) },
        }),
      );
      this.writer.enqueue(unit);
      return;
    }

    // ---- 2. Sequence classification --------------------------------------
    let applyAllowed = true;
    let skipReason: string | undefined;

    if (streamId && channel && isSequencedChannel(channel)) {
      const verdict = this.sequences.observe(streamId, channel, env.seq ?? null);

      if (verdict.verdict === 'gap') {
        this.counters.sequenceGaps += 1;
        this.handleSequenceGap(unit, sub!, verdict.expectedSeq, verdict.receivedSeq);
        applyAllowed = false;
        skipReason = `sequence gap: expected ${verdict.expectedSeq}, received ${verdict.receivedSeq}`;
      } else if (verdict.verdict === 'duplicate' || verdict.verdict === 'out_of_order') {
        applyAllowed = false;
        skipReason = `sequence ${verdict.verdict}: expected ${verdict.expectedSeq}, received ${verdict.receivedSeq}`;
      } else if (verdict.verdict === 'degraded') {
        // A gap is already open on this stream. Only a recovery snapshot may
        // re-establish state; deltas are recorded but not applied.
        applyAllowed = messageType === 'orderbook_snapshot';
        skipReason = 'stream degraded; awaiting recovery snapshot';
      }
    }

    // ---- 3 & 4. Reconstruct + normalise ----------------------------------
    try {
      switch (messageType) {
        case 'orderbook_snapshot':
          this.handleSnapshot(unit, env, sub?.streamId ?? null, sub?.sid ?? null);
          break;
        case 'orderbook_delta':
          this.handleDelta(unit, env, sub?.streamId ?? null, sub?.sid ?? null, applyAllowed, skipReason);
          break;
        case 'trade':
          this.handleTrade(unit, env, sub?.streamId ?? null);
          break;
        case 'ticker':
        case 'ticker_v2':
          this.handleTicker(unit, env);
          break;
        case 'market_lifecycle_v2':
        case 'event_lifecycle':
        case 'event_fee_update':
          this.handleLifecycle(unit, env, messageType);
          break;
        default:
          // Unknown but well-formed: the raw row is the record.
          logger.debug({ event: 'unhandled_message_type', messageType }, 'unhandled message type');
      }
    } catch (err) {
      // Normalisation failed; the raw event still gets written.
      logger.error(
        { event: 'normalize_failed', messageType, err: String(err) },
        'failed to normalise message; raw event preserved',
      );
      unit.normalized.push(
        integrityRow({
          sessionId: this.sessionId,
          marketTicker: raw.marketTicker,
          type: 'unexpected_schema',
          severity: 'error',
          details: { messageType, error: String(err) },
        }),
      );
    }

    // ---- 5. Hand off ------------------------------------------------------
    // A standby session records raw events but must not write canonical
    // normalised market data; only the lease owner does that.
    if (!this.canWriteCanonical()) unit.normalized = unit.normalized.filter((r) => r.table === 'integrity_events');

    this.writer.enqueue(unit);
    this.counters.messagesPersisted += 1;
  }

  /**
   * Binds the sid SYNCHRONOUSLY so that data frames arriving immediately after
   * the `subscribed` response are attributed to the right stream. Awaiting the
   * database here would leave a window in which frames land unattributed and
   * drop out of sequence accounting entirely.
   */
  private handleSubscribed(env: { id?: number | null; msg?: unknown } | null): void {
    if (!env?.msg || typeof env.msg !== 'object') return;
    const msg = env.msg as { channel?: string; sid?: number };
    if (msg.sid === undefined || !msg.channel) return;

    const sub = this.subscriptions.bindSid(env.id ?? undefined, msg.sid, msg.channel);
    if (!sub) return;

    const streamId = sub.streamId;
    const sid = msg.sid;
    this.defer(async () => {
      await setStreamSid(this.sql, streamId, sid);
      await setStreamStatus(this.sql, streamId, 'healthy');
    });
  }

  private handleError(env: { msg?: unknown } | null): void {
    const msg = (env?.msg ?? {}) as { code?: number; msg?: string };
    logger.error(
      { event: 'ws_command_error', code: msg.code, message: msg.msg },
      'kalshi rejected a command',
    );
    this.writer.enqueueDerived([
      integrityRow({
        sessionId: this.sessionId,
        type: 'subscription_failure',
        severity: msg.code === 26 || msg.code === 27 ? 'error' : 'warning',
        details: { code: msg.code, message: msg.msg },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Sequence gaps and recovery
  // -------------------------------------------------------------------------

  /**
   * Gap handling, per spec:
   *   persist raw -> record gap -> degrade stream -> invalidate its books ->
   *   stop applying deltas -> request fresh snapshots -> rebuild -> healthy.
   *
   * Nothing is interpolated and the missing updates are never guessed at.
   *
   * Exactly ONE episode is opened per discontinuity. Snapshots are requested
   * once; while the episode is open the tracker returns 'degraded' rather than
   * re-reporting, because re-requesting recovery on every subsequent frame
   * feeds back into an exponential snapshot storm (each snapshot advances the
   * server's seq, which looks like more gaps, which requests more snapshots).
   */
  private handleSequenceGap(
    unit: IngestUnit,
    sub: { streamId: string; channel: string; sid: number | null },
    expectedSeq: bigint | null,
    receivedSeq: bigint | null,
  ): void {
    const reason = `sequence gap on ${sub.channel}: expected ${expectedSeq}, received ${receivedSeq}`;
    const affected = this.books.invalidateStream(sub.streamId, reason);

    unit.normalized.push(
      integrityRow({
        sessionId: this.sessionId,
        type: 'sequence_gap',
        severity: 'error',
        details: {
          stream_id: sub.streamId,
          channel: sub.channel,
          sid: sub.sid,
          expected_seq: expectedSeq?.toString() ?? null,
          received_seq: receivedSeq?.toString() ?? null,
          affected_markets: affected.length,
        },
      }),
    );

    logger.error(
      {
        event: 'sequence_gap',
        session_id: this.sessionId,
        stream_id: sub.streamId,
        channel: sub.channel,
        seq: receivedSeq ?? undefined,
        expected_seq: expectedSeq?.toString(),
        affected_markets: affected.length,
      },
      'sequence gap detected; books invalidated and recovery requested',
    );

    // Open the episode synchronously so concurrent frames see it immediately.
    const episode = {
      gapId: null as string | null,
      markets: new Set(affected),
      requestedAtMs: Date.now(),
    };
    this.pendingRecovery.set(sub.streamId, episode);

    // Request snapshots once, now, without altering the subscription.
    let requested = 0;
    try {
      if (affected.length > 0) {
        requested = this.subscriptions.requestSnapshots(affected, 'orderbook_delta');
      }
    } catch (err) {
      logger.error(
        { event: 'recovery_request_failed', stream_id: sub.streamId, err: String(err) },
        'failed to request recovery snapshots',
      );
      unit.normalized.push(
        integrityRow({
          sessionId: this.sessionId,
          type: 'recovery_failure',
          severity: 'critical',
          details: { stream_id: sub.streamId, error: String(err) },
        }),
      );
    }

    const sessionId = this.sessionId;
    const sql = this.sql;
    this.defer(async () => {
      await setStreamStatus(sql, sub.streamId, 'degraded').catch(() => {});
      const gapId = await recordSequenceGap(sql, {
        sessionId,
        streamId: sub.streamId,
        channel: sub.channel,
        sid: sub.sid,
        expectedSeq,
        receivedSeq,
        affectedMarkets: affected,
      });
      episode.gapId = gapId;

      if (requested > 0) {
        await markGapRecovering(sql, gapId);
        await setStreamStatus(sql, sub.streamId, 'recovering').catch(() => {});
      } else {
        await markGapFailed(sql, gapId, 'no subscription available to request snapshots').catch(
          () => {},
        );
      }
    });

    this.emit('sequenceGap', { streamId: sub.streamId, expectedSeq, receivedSeq, affected });
  }

  /**
   * Closes a recovery episode once every affected market has produced a fresh
   * snapshot, re-baselining the stream's sequence.
   */
  private completeRecovery(streamId: string, episode: { gapId: string | null; markets: Set<string> }, seq: number | null): void {
    const skipped = this.sequences.resetAfterRecovery(streamId, seq);
    this.pendingRecovery.delete(streamId);

    const sql = this.sql;
    const snapshotCount = this.counters.snapshots;
    this.defer(async () => {
      if (episode.gapId) {
        await markGapRecovered(sql, episode.gapId, snapshotCount).catch(() => {});
      }
      await setStreamStatus(sql, streamId, 'healthy').catch(() => {});
    });

    logger.info(
      { event: 'gap_recovered', stream_id: streamId, skippedWhileDegraded: skipped },
      'stream recovered from snapshot',
    );
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  private handleSnapshot(
    unit: IngestUnit,
    env: { seq?: number | null; msg?: unknown },
    streamId: string | null,
    sid: number | null,
  ): void {
    const msg = OrderbookSnapshotMsg.parse(env.msg);
    this.counters.snapshots += 1;

    const recovery = streamId ? this.pendingRecovery.get(streamId) : undefined;
    const isRecovery = !!recovery?.markets.has(msg.market_ticker);

    const row = this.books.applySnapshot({
      marketTicker: msg.market_ticker,
      marketId: msg.market_id ?? null,
      yesBids: msg.yes_dollars_fp ?? [],
      noBids: msg.no_dollars_fp ?? [],
      seq: env.seq === undefined || env.seq === null ? null : BigInt(env.seq),
      sid,
      sessionId: this.sessionId,
      streamId: streamId ?? '',
      source: isRecovery ? 'ws_recovery' : 'ws_initial',
      receivedAt: unit.raw.receivedAt,
      receivedAtMs: unit.raw.receivedAtMs,
    });
    unit.normalized.push(row);

    if (isRecovery && streamId && recovery) {
      recovery.markets.delete(msg.market_ticker);

      // Only re-baseline once the WHOLE affected set has been rebuilt: leaving
      // the episode open until then keeps deltas for not-yet-recovered markets
      // from being applied to a stale book.
      if (recovery.markets.size === 0) {
        this.completeRecovery(streamId, recovery, env.seq ?? null);
      }
    }
  }

  private handleDelta(
    unit: IngestUnit,
    env: { seq?: number | null; msg?: unknown },
    streamId: string | null,
    sid: number | null,
    applyAllowed: boolean,
    skipReason: string | undefined,
  ): void {
    const msg = OrderbookDeltaMsg.parse(env.msg);
    this.counters.orderbookDeltas += 1;

    const outcome = this.books.applyDelta(
      {
        marketTicker: msg.market_ticker,
        marketId: msg.market_id ?? null,
        side: msg.side,
        price: msg.price_dollars,
        delta: msg.delta_fp,
        seq: env.seq === undefined || env.seq === null ? 0n : BigInt(env.seq),
        sid,
        sessionId: this.sessionId,
        streamId: streamId ?? '',
        exchangeTsMs: unit.raw.exchangeTsMs,
        receivedAt: unit.raw.receivedAt,
        receivedAtMs: unit.raw.receivedAtMs,
      },
      { canApply: applyAllowed, skipReason },
    );

    unit.normalized.push(outcome.row);

    // A negative post-count means our state has diverged from the exchange's.
    if (outcome.result.postCount?.isNegative()) {
      this.counters.negativeLevels += 1;
      unit.normalized.push(
        integrityRow({
          sessionId: this.sessionId,
          marketTicker: msg.market_ticker,
          type: 'negative_level_quantity',
          severity: 'error',
          details: {
            side: msg.side,
            price: msg.price_dollars,
            delta: msg.delta_fp,
            pre_count: outcome.result.preCount.toString(),
            post_count: outcome.result.postCount.toString(),
            seq: env.seq ?? null,
          },
        }),
      );

      if (streamId && this.mayRequestSnapshot(msg.market_ticker)) {
        this.subscriptions.requestSnapshots([msg.market_ticker], 'orderbook_delta');
        logger.error(
          {
            event: 'negative_level_quantity',
            market_ticker: msg.market_ticker,
            stream_id: streamId,
            seq: env.seq ?? undefined,
          },
          'invariant violation; requested fresh snapshot',
        );
      }
    }
  }

  private handleTrade(unit: IngestUnit, env: { sid?: number | null; seq?: number | null; msg?: unknown }, streamId: string | null): void {
    const msg = TradeMsg.parse(env.msg);
    this.counters.trades += 1;

    this.marketState.recordTrade(
      msg.market_ticker,
      msg.yes_price_dollars,
      msg.count_fp,
      Number(unit.raw.receivedAtMs),
    );

    unit.normalized.push({
      table: 'public_trades',
      linkRawEvent: true,
      values: {
        trade_id: msg.trade_id,
        session_id: this.sessionId,
        stream_id: streamId,
        market_ticker: msg.market_ticker,
        sid: env.sid ?? null,
        seq: env.seq === undefined || env.seq === null ? null : String(env.seq),
        yes_price: msg.yes_price_dollars,
        no_price: msg.no_price_dollars,
        count: msg.count_fp,
        // All three aggressor fields are preserved verbatim; none is inferred.
        taker_side: msg.taker_side ?? null,
        taker_outcome_side: msg.taker_outcome_side ?? null,
        taker_book_side: msg.taker_book_side ?? null,
        is_block_trade: msg.is_block_trade ?? null,
        exchange_ts_ms: unit.raw.exchangeTsMs?.toString() ?? null,
        exchange_ts: unit.raw.exchangeTsMs ? new Date(Number(unit.raw.exchangeTsMs)) : null,
        received_at: unit.raw.receivedAt,
        received_at_ms: unit.raw.receivedAtMs.toString(),
      },
    });
  }

  private handleTicker(unit: IngestUnit, env: { sid?: number | null; msg?: unknown }): void {
    const msg = TickerMsg.parse(env.msg);
    this.counters.tickers += 1;

    this.marketState.recordTicker(
      msg.market_ticker,
      {
        volume: msg.volume_fp,
        openInterest: msg.open_interest_fp,
        yesBid: msg.yes_bid_dollars,
        yesAsk: msg.yes_ask_dollars,
        lastPrice: msg.price_dollars,
      },
      Number(unit.raw.receivedAtMs),
    );

    unit.normalized.push({
      table: 'ticker_updates',
      linkRawEvent: true,
      values: {
        session_id: this.sessionId,
        market_ticker: msg.market_ticker,
        market_id: msg.market_id ?? null,
        price: msg.price_dollars ?? null,
        yes_bid: msg.yes_bid_dollars ?? null,
        yes_ask: msg.yes_ask_dollars ?? null,
        yes_bid_size: msg.yes_bid_size_fp ?? null,
        yes_ask_size: msg.yes_ask_size_fp ?? null,
        last_trade_size: msg.last_trade_size_fp ?? null,
        volume: msg.volume_fp ?? null,
        open_interest: msg.open_interest_fp ?? null,
        dollar_volume: msg.dollar_volume === null || msg.dollar_volume === undefined ? null : String(msg.dollar_volume),
        dollar_open_interest:
          msg.dollar_open_interest === null || msg.dollar_open_interest === undefined
            ? null
            : String(msg.dollar_open_interest),
        exchange_ts_ms: unit.raw.exchangeTsMs?.toString() ?? null,
        exchange_ts: unit.raw.exchangeTsMs ? new Date(Number(unit.raw.exchangeTsMs)) : null,
        received_at: unit.raw.receivedAt,
        received_at_ms: unit.raw.receivedAtMs.toString(),
      },
    });

    this.crossCheckTickerBbo(unit, msg);
  }

  /**
   * Independent sanity check: the exchange's own BBO versus the one we
   * reconstructed from the delta stream. A disagreement is recorded, never
   * used to overwrite the book.
   */
  private crossCheckTickerBbo(
    unit: IngestUnit,
    msg: { market_ticker: string; yes_bid_dollars?: string | null; yes_ask_dollars?: string | null },
  ): void {
    const book = this.books.get(msg.market_ticker);
    if (!book?.valid) return;

    const bbo = book.getYesBBO();
    const tickerBid = msg.yes_bid_dollars ? new Decimal(msg.yes_bid_dollars) : null;
    const tickerAsk = msg.yes_ask_dollars ? new Decimal(msg.yes_ask_dollars) : null;

    const bidDiffers = tickerBid !== null && (bbo.bid === null || !bbo.bid.eq(tickerBid));
    const askDiffers = tickerAsk !== null && (bbo.ask === null || !bbo.ask.eq(tickerAsk));
    if (!bidDiffers && !askDiffers) return;

    // Ticker and orderbook_delta are separate streams and can legitimately be
    // a beat apart, so this is throttled and only ever informational.
    const last = this.lastTickerMismatchAt.get(msg.market_ticker) ?? 0;
    const nowMs = Number(unit.raw.receivedAtMs);
    if (nowMs - last < TICKER_MISMATCH_COOLDOWN_MS) return;
    this.lastTickerMismatchAt.set(msg.market_ticker, nowMs);

    this.counters.tickerBboMismatches += 1;
    unit.normalized.push(
      integrityRow({
        sessionId: this.sessionId,
        marketTicker: msg.market_ticker,
        type: 'ticker_bbo_mismatch',
        severity: 'info',
        details: {
          ticker_yes_bid: msg.yes_bid_dollars ?? null,
          ticker_yes_ask: msg.yes_ask_dollars ?? null,
          book_yes_bid: bbo.bid?.toString() ?? null,
          book_yes_ask: bbo.ask?.toString() ?? null,
          book_seq: book.lastSeq?.toString() ?? null,
        },
      }),
    );
  }

  private handleLifecycle(unit: IngestUnit, env: { msg?: unknown }, messageType: string): void {
    this.counters.lifecycle += 1;

    if (messageType === 'market_lifecycle_v2') {
      const msg = MarketLifecycleMsg.parse(env.msg);

      // market_lifecycle_v2 is a GLOBAL channel: despite subscribing with
      // market_tickers, Kalshi delivers lifecycle events for the entire
      // exchange (NFL, MLB, ...). The raw frame is always kept, but the
      // normalised table stays scoped to the universe we actually track --
      // otherwise it fills with markets this recorder has no data for.
      //
      // A `created` event for a brand-new strike names a market we do not
      // track yet, and the message carries no event_ticker, so it cannot be
      // attributed without parsing the ticker string. That is deliberately not
      // done: the next discovery pass picks up new strikes from the official
      // event/market relationship within MARKET_DISCOVERY_INTERVAL_MS.
      if (!this.universe.isTracked(msg.market_ticker)) return;

      unit.normalized.push({
        table: 'market_lifecycle_events',
        linkRawEvent: true,
        values: {
          session_id: this.sessionId,
          event_type: msg.event_type,
          market_ticker: msg.market_ticker,
          event_ticker: null,
          exchange_ts_ms: unit.raw.exchangeTsMs?.toString() ?? null,
          received_at: unit.raw.receivedAt,
          payload: msg,
        },
      });

      // created / close_date_updated / metadata_updated / determined / settled
      // must trigger an immediate metadata refresh.
      if (METADATA_REFRESH_TRIGGERS.has(msg.event_type)) {
        this.universe.queueMetadataRefresh(msg.market_ticker);
        logger.info(
          { event: 'lifecycle_metadata_refresh_queued', market_ticker: msg.market_ticker, lifecycle: msg.event_type },
          'queued metadata refresh from lifecycle event',
        );
      }
      return;
    }

    // event_lifecycle / event_fee_update
    const parsed =
      messageType === 'event_lifecycle'
        ? EventLifecycleMsg.safeParse(env.msg)
        : { success: false as const, data: undefined };

    const eventTicker = parsed.success ? parsed.data.event_ticker : null;

    unit.normalized.push({
      table: 'market_lifecycle_events',
      linkRawEvent: true,
      values: {
        session_id: this.sessionId,
        event_type: messageType,
        market_ticker: null,
        event_ticker: eventTicker,
        exchange_ts_ms: unit.raw.exchangeTsMs?.toString() ?? null,
        received_at: unit.raw.receivedAt,
        payload: env.msg ?? {},
      },
    });

    if (eventTicker) this.universe.queueEventRefresh(eventTicker);
  }

  // -------------------------------------------------------------------------
  // Periodic bookkeeping
  // -------------------------------------------------------------------------

  /** Persists per-stream sequence progress; called on the heartbeat tick. */
  async persistStreamProgress(): Promise<void> {
    for (const state of this.sequences.all()) {
      await updateStreamSeq(
        this.sql,
        state.streamId,
        state.firstSeq,
        state.lastSeq,
        state.gapCount,
      ).catch(() => {});
    }
  }

  /**
   * Runs the book consistency assertions across valid books and records any
   * violations. Anomalies are preserved, not corrected.
   */
  runConsistencyChecks(): NormalizedRow[] {
    const rows: NormalizedRow[] = [];

    for (const book of this.books.validBooks()) {
      for (const issue of checkConsistency(book)) {
        rows.push(
          integrityRow({
            sessionId: this.sessionId,
            marketTicker: book.marketTicker,
            type: issue.kind === 'crossed_book' ? 'crossed_book' : 'price_out_of_range',
            // A transiently crossed book can be genuine exchange state.
            severity: issue.kind === 'crossed_book' ? 'info' : 'warning',
            details: { ...issue, seq: book.lastSeq?.toString() ?? null },
          }),
        );
      }
    }

    return rows;
  }

  /** Snapshots every tracked book at an ownership boundary. */
  handoffSnapshots(receivedAt = new Date()): NormalizedRow[] {
    const rows: NormalizedRow[] = [];
    for (const book of this.books.validBooks()) {
      rows.push(
        this.books.applySnapshot({
          marketTicker: book.marketTicker,
          yesBids: book.yesBidLevels(),
          noBids: book.noBidLevels(),
          seq: book.lastSeq,
          sessionId: this.sessionId,
          streamId: book.streamId ?? '',
          source: 'session_handoff',
          receivedAt,
          receivedAtMs: BigInt(receivedAt.getTime()),
        }),
      );
    }
    return rows;
  }
}
