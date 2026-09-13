import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Collector } from '@/src/collector/collector';
import { UniverseManager } from '@/src/collector/universeManager';
import type { CollectorConfig } from '@/src/config/collectorConfig';
import { configHash } from '@/src/config/collectorConfig';
import { gitCommitSha, type Env } from '@/src/config/env';
import { KalshiSigner } from '@/src/kalshi/auth';
import { KalshiRestClient } from '@/src/kalshi/restClient';
import { KalshiWebSocketClient } from '@/src/kalshi/websocketClient';
import { BookValidator } from '@/src/integrity/validator';
import {
  minuteOf,
  newMinuteAccumulator,
  recordLatency,
  writeHealthMinute,
  type MinuteAccumulator,
} from '@/src/integrity/healthMetrics';
import { BatchWriter } from '@/src/persistence/batchWriter';
import type { Sql } from '@/src/persistence/db';
import { ArchiveWorker } from '@/src/persistence/archive';
import { selectArchiveStore } from '@/src/persistence/archiveStore';
import { ensureRawPartitions } from '@/src/persistence/partitions';
import { integrityRow, recordIntegrityEvent } from '@/src/persistence/repositories/integrity';
import { closeCaptureGap, openCaptureGap } from '@/src/persistence/repositories/captureGaps';
import { loadEventLadders } from '@/src/persistence/repositories/metadata';
import {
  bumpSessionCounters,
  closeAllStreamsForSession,
  endSession,
  heartbeatSession,
  startSession,
} from '@/src/persistence/repositories/sessions';
import { BookSampler } from '@/src/sampling/bookSampler';
import { LadderSampler } from '@/src/sampling/ladderSampler';
import { logger } from '@/src/logging/logger';

/** Delay before confirming a transient REST mismatch with a second check. */
const VALIDATION_RECHECK_DELAY_MS = 1_500;

/** Coalesces a burst of lifecycle events into a single discovery pass. */
const DISCOVERY_DEBOUNCE_MS = 2_000;

/**
 * One capture epoch, start to finish.
 *
 * Owns every periodic loop and the shutdown ordering. The wrapper above it --
 * daemon or Vercel rolling worker -- differs only in how it decides when to
 * start and stop; nothing in this file knows about either.
 */

export interface SessionRunnerOptions {
  sql: Sql;
  env: Env;
  config: CollectorConfig;
  mode: 'daemon' | 'vercel_rolling';
  sessionId?: string;
  instanceId?: string | null;
  /** Gate for canonical writes; a standby session records raw only. */
  canWriteCanonical?: () => boolean;
}

export interface SessionRunnerEvents {
  ready: [{ sessionId: string; trackedMarkets: number }];
  handoffRequested: [{ sessionId: string; elapsedSeconds: number }];
  stopped: [{ sessionId: string; reason: string }];
}

export class SessionRunner extends EventEmitter {
  readonly sessionId: string;
  readonly collector: Collector;
  readonly universe: UniverseManager;
  readonly writer: BatchWriter;
  readonly rest: KalshiRestClient;
  readonly ws: KalshiWebSocketClient;
  readonly validator: BookValidator;
  readonly bookSampler: BookSampler;
  readonly ladderSampler: LadderSampler;
  readonly archiver: ArchiveWorker | null;

  private readonly sql: Sql;
  private readonly env: Env;
  private readonly config: CollectorConfig;
  private readonly mode: 'daemon' | 'vercel_rolling';

  private timers: NodeJS.Timeout[] = [];
  private startedAtMs = 0;
  private stopping = false;
  private minute: MinuteAccumulator;
  private handoffAnnounced = false;
  private sessionPersisted = false;
  private discovered = false;
  private pendingDiscoveryTimer: NodeJS.Timeout | null = null;
  /** Open capture gap awaiting the first valid snapshot of this session. */
  private openGapId: string | null = null;

  constructor(opts: SessionRunnerOptions) {
    super();
    this.sql = opts.sql;
    this.env = opts.env;
    this.config = opts.config;
    this.mode = opts.mode;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.minute = newMinuteAccumulator(minuteOf(Date.now()));

    const endpoints =
      opts.env.KALSHI_ENV === 'demo'
        ? { rest: 'https://demo-api.kalshi.co', ws: 'wss://demo-api.kalshi.co/trade-api/ws/v2' }
        : {
            rest: 'https://api.elections.kalshi.com',
            ws: 'wss://api.elections.kalshi.com/trade-api/ws/v2',
          };

    const signer = new KalshiSigner(opts.env.KALSHI_API_KEY_ID, opts.env.KALSHI_PRIVATE_KEY_PEM);

    this.rest = new KalshiRestClient({ baseUrl: endpoints.rest, signer });
    this.ws = new KalshiWebSocketClient({ url: endpoints.ws, signer });

    this.writer = new BatchWriter({
      sql: opts.sql,
      maxRows: opts.env.DB_BATCH_MAX_ROWS,
      maxWaitMs: opts.env.DB_BATCH_MAX_WAIT_MS,
      maxBufferedRows: opts.env.DB_BUFFER_MAX_ROWS,
      mode: opts.mode,
    });

    this.universe = new UniverseManager({
      sql: opts.sql,
      rest: this.rest,
      config: opts.config,
      seriesCacheTtlMs: opts.env.METADATA_REFRESH_INTERVAL_MS,
    });

    this.collector = new Collector({
      sql: opts.sql,
      ws: this.ws,
      rest: this.rest,
      universe: this.universe,
      writer: this.writer,
      config: opts.config,
      sessionId: this.sessionId,
      canWriteCanonical: opts.canWriteCanonical,
    });

    this.validator = new BookValidator({
      rest: this.rest,
      books: this.collector.books,
      maxMarketsPerBatch: opts.config.validation.maxMarketsPerValidationBatch,
      toleranceMs: opts.config.validation.matchToleranceMs,
    });

    this.bookSampler = new BookSampler({
      books: this.collector.books,
      marketState: this.collector.marketState,
      bboIntervalsMs: opts.config.sampling.bboIntervalsMs,
      fullBookIntervalsMs: opts.config.sampling.fullBookIntervalsMs,
    });

    this.ladderSampler = new LadderSampler({
      books: this.collector.books,
      marketState: this.collector.marketState,
      intervalsMs: opts.config.sampling.eventLadderIntervalsMs,
    });

    // Archival is best-effort at construction: a misconfigured store must not
    // stop the recorder from capturing. It will refuse to DROP anything either
    // way, since retention is gated separately.
    let archiver: ArchiveWorker | null = null;
    try {
      const { store } = selectArchiveStore({
        blobToken: opts.env.BLOB_READ_WRITE_TOKEN,
        mode: opts.mode,
        storage: opts.env.ARCHIVE_STORAGE,
        s3: {
          bucket: opts.env.ARCHIVE_BUCKET,
          endpoint: opts.env.ARCHIVE_ENDPOINT,
          region: opts.env.ARCHIVE_REGION,
          accessKeyId: opts.env.ARCHIVE_ACCESS_KEY_ID,
          secretAccessKey: opts.env.ARCHIVE_SECRET_ACCESS_KEY,
        },
      });
      archiver = new ArchiveWorker({
        sql: opts.sql,
        store,
        retentionHours: opts.env.RAW_DB_RETENTION_HOURS,
        retentionEnabled: opts.env.RAW_DB_RETENTION_ENABLED,
      });
    } catch (err) {
      logger.error(
        { event: 'archiver_unavailable', err: String(err) },
        'archiving is disabled; raw partitions will accumulate until this is fixed',
      );
    }
    this.archiver = archiver;

    this.collector.on('latency', (exchangeTsMs: bigint, receivedAtMs: bigint) => {
      this.observeLatency(exchangeTsMs, receivedAtMs);
    });

    // Coverage resumes when we hold book state we can vouch for, not merely
    // when bytes start arriving -- so the gap closes at the first snapshot.
    this.collector.on('firstSnapshot', (at: Date) => {
      const gapId = this.openGapId;
      if (!gapId) return;
      this.openGapId = null;
      void closeCaptureGap(this.sql, gapId, at).catch(() => {});
    });

    // A lifecycle message can announce a new daily ladder. Pull discovery
    // forward rather than waiting up to MARKET_DISCOVERY_INTERVAL_MS, while
    // debouncing so a burst of lifecycle events causes one refresh.
    this.collector.on('discoveryRefreshRequested', ({ reason }: { reason: string }) => {
      this.requestDiscoverySoon(reason);
    });

    this.wireWriterEvents();
  }

  private wireWriterEvents(): void {
    this.writer.on('flushed', (stats) => {
      this.minute.dbBatches += stats.batches;
      this.minute.dbRowsWritten += stats.rawRows + stats.normalizedRows;
    });

    this.writer.on('error', () => {
      this.minute.dbErrors += 1;
    });

    this.writer.on('overflow', ({ bufferedRows, spooled, spoolPath }) => {
      void recordIntegrityEvent(this.sql, {
        sessionId: this.sessionId,
        type: 'buffer_overflow',
        // On Vercel local disk is not durable, so an overflow there is critical.
        severity: spooled ? 'error' : 'critical',
        details: { bufferedRows, spooled, spoolPath: spoolPath ?? null, mode: this.mode },
      }).catch(() => {});
    });

    this.writer.on('partitionMissing', ({ err }) => {
      void recordIntegrityEvent(this.sql, {
        sessionId: this.sessionId,
        type: 'partition_missing',
        severity: 'critical',
        details: { error: String(err) },
      }).catch(() => {});
      // Try to repair immediately rather than waiting for the hourly job.
      void ensureRawPartitions(this.sql, this.env.RAW_PARTITION_AHEAD_DAYS).catch(() => {});
    });
  }

  // -------------------------------------------------------------------------
  // Start / stop
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.startedAtMs = Date.now();

    // Partitions must exist before a single raw event is written.
    await ensureRawPartitions(this.sql, this.env.RAW_PARTITION_AHEAD_DAYS);

    await startSession(this.sql, {
      sessionId: this.sessionId,
      mode: this.mode,
      configHash: configHash(this.config),
      wsUrl: this.ws.url,
      vercelDeploymentId: this.env.VERCEL_DEPLOYMENT_ID || null,
      gitCommitSha: gitCommitSha(this.env),
      instanceId: this.env.VERCEL_REGION || null,
    });
    this.sessionPersisted = true;

    // Record the interval since the previous session stopped observing.
    // Without this, a deployment hole looks like a quiet market to any future
    // backtest reading the delta stream.
    this.openGapId = await openCaptureGap(this.sql, {
      datasetId: this.env.DATASET_ID,
      newSessionId: this.sessionId,
      deployHint: process.env.DEPLOY_BOUNDARY === 'true',
    }).catch(() => null);

    logger.info(
      { event: 'session_started', session_id: this.sessionId, mode: this.mode, capture_gap_id: this.openGapId },
      'collector session started',
    );

    this.collector.start();

    // Discovery FIRST, so the universe is known before the socket opens and
    // there is exactly one subscribe path.
    await this.runDiscovery();

    // Every new connection is a fresh epoch: (re)subscribe and rebuild every
    // book from the snapshots the exchange sends on subscribe. This is the
    // only place subscriptions are created.
    this.ws.on('open', () => {
      void this.onConnected();
    });

    await this.ws.connect();

    this.startLoops();

    this.emit('ready', {
      sessionId: this.sessionId,
      trackedMarkets: this.universe.trackedTickers.length,
    });
  }

  private async onConnected(): Promise<void> {
    if (this.stopping) return;

    const markets = this.universe.trackedTickers;
    if (markets.length === 0) {
      // Expected on the very first connect, which happens before the initial
      // discovery pass; start() calls this again once the universe is known.
      if (this.discovered) {
        logger.warn({ event: 'no_tracked_markets' }, 'no markets match the configured selectors');
      }
      return;
    }
    await this.collector.subscribeAll(markets);
  }

  private startLoops(): void {
    const every = (ms: number, fn: () => void | Promise<void>, label: string) => {
      const t = setInterval(() => {
        void Promise.resolve(fn()).catch((err) =>
          logger.error({ event: 'loop_error', loop: label, err: String(err) }, `${label} loop failed`),
        );
      }, ms);
      t.unref?.();
      this.timers.push(t);
    };

    every(this.env.COLLECTOR_HEARTBEAT_INTERVAL_MS, () => this.heartbeat(), 'heartbeat');
    every(this.env.MARKET_DISCOVERY_INTERVAL_MS, () => this.runDiscovery(), 'discovery');
    every(this.config.validation.restOrderbookIntervalMs, () => this.runValidation(), 'validation');
    every(this.env.RAW_PARTITION_MAINTENANCE_INTERVAL_MS, () => this.runPartitionMaintenance(), 'partitions');
    if (this.archiver && this.env.RAW_ARCHIVE_ENABLED) {
      every(this.env.ARCHIVE_INTERVAL_MS, () => this.runArchive(), 'archive');
    }
    every(60_000, () => this.rollMinute(), 'health');

    // Sampling ticks at the finest configured interval and each sampler
    // decides which buckets are actually due.
    const finest = Math.min(
      ...[
        ...this.bookSampler.intervals,
        ...this.ladderSampler.sampleIntervals,
        60_000,
      ].filter((n) => Number.isFinite(n) && n > 0),
    );
    every(Math.max(250, finest), () => this.runSampling(), 'sampling');
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    logger.info({ event: 'session_stopping', session_id: this.sessionId, reason }, 'stopping session');

    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.pendingDiscoveryTimer) {
      clearTimeout(this.pendingDiscoveryTimer);
      this.pendingDiscoveryTimer = null;
    }

    // Close the socket first so no new frames arrive mid-drain.
    await this.ws.close(1000, reason).catch(() => {});

    // Let queued side effects finish so nothing is still trying to enqueue.
    await this.collector.flushDeferred().catch(() => {});

    // Then flush everything still buffered. This must not be skipped: the
    // buffer is the only place those events exist.
    await this.writer.close().catch((err) =>
      logger.error({ event: 'final_flush_failed', err: String(err) }, 'final flush failed'),
    );

    if (this.sessionPersisted) {
      await this.rollMinute().catch(() => {});
      await closeAllStreamsForSession(this.sql, this.sessionId).catch(() => {});
      await endSession(this.sql, this.sessionId, reason).catch(() => {});
    }

    logger.info({ event: 'session_stopped', session_id: this.sessionId, reason }, 'session stopped');
    this.emit('stopped', { sessionId: this.sessionId, reason });
  }

  // -------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------

  get elapsedSeconds(): number {
    return (Date.now() - this.startedAtMs) / 1000;
  }

  /** True once the soft runtime budget is exhausted and a handoff is due. */
  get handoffDue(): boolean {
    return this.elapsedSeconds >= this.env.COLLECTOR_SOFT_RUNTIME_SECONDS;
  }

  get hardLimitReached(): boolean {
    return this.elapsedSeconds >= this.env.COLLECTOR_HARD_RUNTIME_SECONDS;
  }

  private async heartbeat(): Promise<void> {
    await heartbeatSession(this.sql, this.sessionId);
    await this.collector.persistStreamProgress();
    this.collector.reapStalledRecoveries();

    const c = this.collector.counters;
    await bumpSessionCounters(this.sql, this.sessionId, {
      messagesReceived: c.messagesReceived,
      messagesPersisted: c.messagesPersisted,
      sequenceGaps: c.sequenceGaps,
      reconnects: c.reconnects,
      dbErrors: this.minute.dbErrors,
    });

    // Counters are deltas between heartbeats; the session row accumulates.
    this.minute.rawMessages += c.messagesReceived;
    this.minute.orderbookDeltas += c.orderbookDeltas;
    this.minute.trades += c.trades;
    this.minute.tickers += c.tickers;
    this.minute.snapshots += c.snapshots;
    this.minute.sequenceGaps += c.sequenceGaps;
    this.minute.reconnects += c.reconnects;
    this.minute.wsConnected = this.ws.isOpen;
    this.minute.trackedMarkets = this.universe.trackedTickers.length;

    c.messagesReceived = 0;
    c.messagesPersisted = 0;
    c.orderbookDeltas = 0;
    c.trades = 0;
    c.tickers = 0;
    c.snapshots = 0;
    c.sequenceGaps = 0;
    c.reconnects = 0;

    if (this.handoffDue && !this.handoffAnnounced) {
      this.handoffAnnounced = true;
      this.emit('handoffRequested', { sessionId: this.sessionId, elapsedSeconds: this.elapsedSeconds });
    }
  }

  /**
   * Debounced out-of-band discovery pass.
   *
   * Lifecycle parsing never establishes market relationships itself; it only
   * prompts REST to re-read them sooner. Periodic polling remains the fallback
   * if a lifecycle message is missed entirely.
   */
  private requestDiscoverySoon(reason: string): void {
    if (this.pendingDiscoveryTimer) return;

    this.pendingDiscoveryTimer = setTimeout(() => {
      this.pendingDiscoveryTimer = null;
      logger.info({ event: 'discovery_triggered', reason }, 'running out-of-band discovery');
      void this.runDiscovery().catch((err) =>
        logger.error({ event: 'discovery_failed', reason, err: String(err) }, 'out-of-band discovery failed'),
      );
    }, DISCOVERY_DEBOUNCE_MS);
    this.pendingDiscoveryTimer.unref?.();
  }

  private async runDiscovery(): Promise<void> {
    const diff = await this.universe.discover();
    this.discovered = true;
    if (diff.added.length > 0 || diff.removed.length > 0) {
      await this.collector.applyUniverseDiff(
        diff.added.map((m) => m.marketTicker),
        diff.removed,
      );
      for (const ticker of diff.removed) this.bookSampler.forget(ticker);
    }
  }

  private async runSampling(): Promise<void> {
    const nowMs = Date.now();

    const rows = this.bookSampler.sample(nowMs, this.sessionId);

    const eventTickers = this.universe.trackedEventTickers;
    if (eventTickers.length > 0 && this.ladderSampler.sampleIntervals.length > 0) {
      const ladders = await loadEventLadders(this.sql, eventTickers);
      const { rows: ladderRows } = this.ladderSampler.sample(nowMs, ladders, (e) =>
        this.universe.seriesForEvent(e),
      );
      rows.push(...ladderRows);
    }

    rows.push(...this.collector.runConsistencyChecks());

    if (rows.length > 0) this.writer.enqueueDerived(rows);
  }

  private async runValidation(): Promise<void> {
    const outcome = await this.validator.validate(this.universe.trackedTickers, this.sessionId);
    if (outcome.rows.length > 0) this.writer.enqueueDerived(outcome.rows);

    // Only confirmed mismatches count as data-quality incidents. A book that
    // matched a state it genuinely held during the request window is correct.
    this.minute.validationMismatches += outcome.confirmed;

    // A confirmed mismatch asks the WEBSOCKET for a fresh snapshot; the live
    // book is never replaced directly from REST.
    if (outcome.recoveryNeeded.length > 0) {
      this.collector.requestRecoverySnapshots(outcome.recoveryNeeded, 'rest_validation_mismatch');
    }

    // Re-check transient mismatches promptly rather than waiting a full
    // interval, so a real divergence is confirmed quickly.
    const pending = this.validator.awaitingRecheck;
    if (pending.length > 0) {
      setTimeout(() => {
        void this.validator
          .validate(pending, this.sessionId)
          .then((second) => {
            if (second.rows.length > 0) this.writer.enqueueDerived(second.rows);
            this.minute.validationMismatches += second.confirmed;
            if (second.recoveryNeeded.length > 0) {
              this.collector.requestRecoverySnapshots(second.recoveryNeeded, 'rest_validation_mismatch');
            }
          })
          .catch((err) =>
            logger.warn({ event: 'validation_recheck_failed', err: String(err) }, 'validation re-check failed'),
          );
      }, VALIDATION_RECHECK_DELAY_MS).unref?.();
    }

    // Only if confirmed mismatches persist do we reconnect the session.
    if (outcome.escalate) {
      logger.error(
        { event: 'validation_escalation', confirmed: outcome.confirmed },
        'persistent confirmed REST mismatches; reconnecting websocket',
      );
      this.writer.enqueueDerived([
        integrityRow({
          sessionId: this.sessionId,
          type: 'rest_snapshot_mismatch',
          severity: 'critical',
          details: { action: 'reconnect', markets: outcome.recoveryNeeded },
        }),
      ]);
      await this.ws.close(4000, 'validation escalation').catch(() => {});
      await this.ws.connect().catch(() => {});
    }
  }

  /**
   * Seals, uploads and verifies completed partitions. Dropping is gated
   * separately by RAW_DB_RETENTION_ENABLED and only ever touches a partition
   * whose archive verified.
   */
  private async runArchive(): Promise<void> {
    if (!this.archiver) return;

    const result = await this.archiver.run();
    if (result.failed.length > 0) {
      for (const f of result.failed) {
        await recordIntegrityEvent(this.sql, {
          sessionId: this.sessionId,
          type: 'db_write_failure',
          severity: 'error',
          details: { stage: 'archive', partition: f.partition, error: f.error },
        }).catch(() => {});
      }
    }
    if (result.archived.length || result.verified.length || result.dropped.length) {
      logger.info(
        {
          event: 'archive_run',
          archived: result.archived.length,
          verified: result.verified.length,
          dropped: result.dropped.length,
          failed: result.failed.length,
        },
        'archive run complete',
      );
    }
  }

  private async runPartitionMaintenance(): Promise<void> {
    await ensureRawPartitions(this.sql, this.env.RAW_PARTITION_AHEAD_DAYS);
  }

  private async rollMinute(): Promise<void> {
    const current = this.minute;
    const nowMinute = minuteOf(Date.now());
    if (nowMinute === current.minute && !this.stopping) {
      // Same minute; nothing to roll yet.
      return;
    }

    this.minute = newMinuteAccumulator(nowMinute);
    await writeHealthMinute(this.sql, this.sessionId, current, this.writer.drainFlushLatencies());
  }

  /** Exposed for the health endpoint and the dashboard. */
  snapshotStatus() {
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      elapsedSeconds: Math.round(this.elapsedSeconds),
      wsConnected: this.ws.isOpen,
      wsState: this.ws.getState(),
      trackedMarkets: this.universe.trackedTickers.length,
      trackedEvents: this.universe.trackedEventTickers.length,
      books: {
        total: this.collector.books.size,
        valid: this.collector.books.validBooks().length,
        invalid: this.collector.books.invalidBooks().length,
      },
      streams: this.collector.sequences.all().map((s) => ({
        streamId: s.streamId,
        channel: s.channel,
        lastSeq: s.lastSeq?.toString() ?? null,
        gapCount: s.gapCount,
        degraded: s.degraded,
      })),
      bufferedRows: this.writer.bufferedRows,
      handoffDue: this.handoffDue,
    };
  }

  /** Records a latency observation from the ingest path. */
  observeLatency(exchangeTsMs: bigint | null, receivedAtMs: bigint): void {
    recordLatency(this.minute, exchangeTsMs, receivedAtMs);
  }
}
