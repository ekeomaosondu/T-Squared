#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { loadCollectorConfig } from '@/src/config/collectorConfig';
import { env, redactedEnv } from '@/src/config/env';
import { SessionRunner } from '@/src/collector/session';
import { startHealthServer } from '@/src/collector/healthServer';
import { closeDb, db } from '@/src/persistence/db';
import { migrate } from '@/src/persistence/migrate';
import { logger } from '@/src/logging/logger';

/**
 * Daemon mode: one long-lived collector process.
 *
 * This is the SAME core the Vercel rolling worker drives -- MarketDataClient,
 * BookManager, DatabaseWriter, UniverseManager and the samplers are all shared.
 * Only the supervision wrapper differs, which is what makes moving ingestion to
 * Fly.io, Railway, Render, AWS or a bare VM a deployment decision rather than a
 * rewrite.
 *
 * Unlike the Vercel wrapper, there is no runtime budget here: the session runs
 * until the process is signalled.
 */

/**
 * Retries database work with backoff instead of exiting.
 *
 * A container that dies on a transient database outage takes its health
 * endpoint with it, so the operator sees a crash-loop rather than a clear
 * "database unreachable". Failures are logged at ERROR every attempt, so a
 * genuinely misconfigured URL is still obvious.
 */
async function withDatabaseRetry<T>(fn: () => Promise<T>, maxAttempts = 60): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
      logger.error(
        { event: 'database_unavailable', attempt, delayMs, err: String(err) },
        'database unavailable at startup; retrying (health endpoint is serving)',
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const e = env();
  logger.info({ event: 'collector_boot', ...redactedEnv(e) }, 'starting collector daemon');

  if (!e.COLLECTOR_ENABLED) {
    logger.warn({ event: 'collector_disabled' }, 'COLLECTOR_ENABLED is false; exiting');
    return;
  }
  if (!e.KALSHI_API_KEY_ID || !e.KALSHI_PRIVATE_KEY_PEM) {
    throw new Error(
      'KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PEM are required: the market-data ' +
        'WebSocket requires an authenticated connection.',
    );
  }

  const sql = db();

  // The health endpoint comes up BEFORE any database work.
  //
  // On a remote host, a database that is unreachable at startup must not turn
  // into a crash-loop with no diagnostics. /live answers immediately, /health
  // reports CRITICAL, and the orchestrator can tell "alive but the database is
  // down" apart from "the image is broken".
  let runnerRef: SessionRunner | null = null;
  if (e.HEALTH_PORT > 0) {
    startHealthServer({ port: e.HEALTH_PORT, sql, env: e, runner: () => runnerRef });
  }

  // Migrating on boot keeps a fresh VM or container self-sufficient. A
  // transient database outage is retried rather than exiting, because exiting
  // loses the health endpoint too.
  await withDatabaseRetry(() => migrate(sql));

  const config = await loadCollectorConfig(e.COLLECTOR_CONFIG_PATH);
  logger.info(
    {
      event: 'config_loaded',
      selectors: config.selectors.map((s) => s.id),
      bboIntervalsMs: config.sampling.bboIntervalsMs,
      fullBookIntervalsMs: config.sampling.fullBookIntervalsMs,
      eventLadderIntervalsMs: config.sampling.eventLadderIntervalsMs,
    },
    'collector config loaded',
  );

  const runner = new SessionRunner({ sql, env: e, config, mode: 'daemon' });
  runnerRef = runner;

  runner.on('ready', ({ sessionId, trackedMarkets }) => {
    logger.info(
      { event: 'collector_ready', session_id: sessionId, trackedMarkets },
      `collector ready, tracking ${trackedMarkets} markets`,
    );
  });

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ event: 'shutdown_requested', reason }, 'shutting down');
    try {
      // stop() flushes the write buffer; skipping it would lose buffered events.
      await runner.stop(reason);
    } finally {
      await closeDb().catch(() => {});
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('SIGTERM', () => void shutdown('sigterm'));

  // An unexpected throw must still drain the buffer before the process dies.
  process.on('uncaughtException', (err) => {
    logger.fatal({ event: 'uncaught_exception', err: String(err), stack: (err as Error).stack }, 'uncaught exception');
    void shutdown('uncaught_exception');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ event: 'unhandled_rejection', reason: String(reason) }, 'unhandled rejection');
  });

  await runner.start();

  // Periodic status line so a tailed log shows liveness without DEBUG noise.
  const statusTimer = setInterval(() => {
    const s = runner.snapshotStatus();
    logger.info(
      {
        event: 'collector_status',
        session_id: s.sessionId,
        wsConnected: s.wsConnected,
        trackedMarkets: s.trackedMarkets,
        booksValid: s.books.valid,
        booksInvalid: s.books.invalid,
        bufferedRows: s.bufferedRows,
        elapsedSeconds: s.elapsedSeconds,
      },
      'collector status',
    );
  }, 60_000);
  statusTimer.unref?.();
}

main().catch(async (err) => {
  logger.fatal({ event: 'collector_failed', err: String(err), stack: (err as Error)?.stack }, 'collector failed to start');
  await closeDb().catch(() => {});
  process.exit(1);
});
