import { createServer, type Server } from 'node:http';
import { datasetHealth, DEFAULT_THRESHOLDS } from '@/src/integrity/datasetHealth';
import type { Env } from '@/src/config/env';
import type { Sql } from '@/src/persistence/db';
import type { SessionRunner } from '@/src/collector/session';
import { logger } from '@/src/logging/logger';

/**
 * Minimal health endpoint for the daemon.
 *
 * A remote host needs something to probe: without it, "the process is running"
 * is the only available signal, and a collector can be running while recording
 * nothing. This exposes the same dataset health used by the Vercel API so an
 * orchestrator can restart on CRITICAL rather than on process death alone.
 *
 *   GET /health   dataset health; 503 on CRITICAL
 *   GET /live     process liveness only; never touches the database
 */
export function startHealthServer(opts: {
  port: number;
  sql: Sql;
  env: Env;
  runner: () => SessionRunner | null;
}): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    // Liveness must not depend on the database: a database outage should not
    // make the orchestrator kill a collector that is correctly buffering.
    if (url.startsWith('/live')) {
      const runner = opts.runner();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          alive: true,
          sessionId: runner?.sessionId ?? null,
          wsConnected: runner?.snapshotStatus().wsConnected ?? false,
          bufferedRows: runner?.snapshotStatus().bufferedRows ?? 0,
        }),
      );
      return;
    }

    if (!url.startsWith('/health')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    void datasetHealth(opts.sql, {
      ...DEFAULT_THRESHOLDS,
      heartbeatStaleMs: opts.env.COLLECTOR_HEARTBEAT_STALE_MS,
      retentionEnabled: opts.env.RAW_DB_RETENTION_ENABLED,
    })
      .then((health) => {
        const runner = opts.runner();
        res.writeHead(health.level === 'CRITICAL' ? 503 : 200, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ ...health, collector: runner?.snapshotStatus() ?? null }));
      })
      .catch((err) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ level: 'CRITICAL', error: String(err) }));
      });
  });

  // A bind failure on this host usually means another collector is already
  // running here. Say so explicitly rather than dying with a bare EADDRINUSE.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        { event: 'health_port_in_use', port: opts.port },
        `port ${opts.port} is already in use -- another collector is probably running on this host. ` +
          'Stop it first, or set HEALTH_PORT to a different port.',
      );
    } else {
      logger.fatal({ event: 'health_server_failed', err: String(err) }, 'health server failed to start');
    }
    process.exit(1);
  });

  server.listen(opts.port, '0.0.0.0', () => {
    logger.info({ event: 'health_server_started', port: opts.port }, `health endpoint on :${opts.port}`);
  });

  server.unref();
  return server;
}
