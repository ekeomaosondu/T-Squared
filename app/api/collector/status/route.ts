import { NextResponse } from 'next/server';
import { env } from '@/src/config/env';
import { datasetHealth, DEFAULT_THRESHOLDS } from '@/src/integrity/datasetHealth';
import { db } from '@/src/persistence/db';
import { listCoverage } from '@/src/persistence/repositories/coverage';
import { listRecentSessions } from '@/src/persistence/repositories/sessions';
import { partitionsAhead } from '@/src/persistence/partitions';

/**
 * Operational detail behind /api/health.
 *
 * Read-only. Requires INTERNAL_API_TOKEN when one is configured.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const e = env();

  if (e.INTERNAL_API_TOKEN) {
    const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (provided !== e.INTERNAL_API_TOKEN) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const sql = db();

  const [health, sessions, coverage, ahead] = await Promise.all([
    datasetHealth(sql, {
      ...DEFAULT_THRESHOLDS,
      heartbeatStaleMs: e.COLLECTOR_HEARTBEAT_STALE_MS,
      retentionEnabled: e.RAW_DB_RETENTION_ENABLED,
    }),
    listRecentSessions(sql, 5),
    listCoverage(sql),
    partitionsAhead(sql).catch(() => null),
  ]);

  const archives = await sql`
    SELECT s.status, count(*) AS partitions, coalesce(sum(s.archived_row_count), 0) AS rows
      FROM raw_partition_archive_state s
     GROUP BY s.status
     ORDER BY s.status
  `;

  const today = await sql`
    SELECT (SELECT count(*) FROM raw_ingest_events r WHERE r.received_at > now() - interval '24 hours') AS raw_24h,
           (SELECT count(*) FROM orderbook_deltas d WHERE d.received_at > now() - interval '24 hours') AS deltas_24h,
           (SELECT count(*) FROM public_trades t WHERE t.received_at > now() - interval '24 hours') AS trades_24h,
           (SELECT count(*) FROM sequence_gaps g WHERE g.detected_at > now() - interval '24 hours') AS gaps_24h
  `;

  return NextResponse.json({
    health,
    retentionEnabled: e.RAW_DB_RETENTION_ENABLED,
    partitionsAhead: ahead,
    last24h: today[0] ?? null,
    archives,
    // Which configured series have actually been exercised.
    seriesCoverage: coverage.map((c) => ({
      seriesTicker: c.series_ticker,
      status: c.status,
      marketsSeen: c.markets_seen,
      firstSubscribedAt: c.first_subscribed_at,
      firstSnapshotAt: c.first_snapshot_at,
      firstLadderAt: c.first_ladder_at,
    })),
    sessions: sessions.map((s) => ({
      sessionId: s.session_id,
      mode: s.mode,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      endReason: s.end_reason,
      lastHeartbeatAt: s.last_heartbeat_at,
      messagesReceived: s.messages_received,
      sequenceGaps: s.sequence_gaps,
      reconnects: s.reconnect_count,
      configHash: s.config_hash,
    })),
  });
}
