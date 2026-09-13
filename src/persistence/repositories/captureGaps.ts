import type { Sql } from '@/src/persistence/db';
import { logger } from '@/src/logging/logger';

/**
 * Capture gaps: intervals when no collector was listening.
 *
 * Without these recorded, a deployment hole is indistinguishable from a quiet
 * market. A backtest reading the delta stream over that interval sees no events
 * and concludes nothing happened, when the truth is that we were not watching.
 */

export type GapReason = 'deploy' | 'restart' | 'crash' | 'shutdown' | 'unknown';

/**
 * Infers why collection stopped from how the previous session ended.
 *
 * A NULL end_reason means the session never ran its shutdown path, so the
 * process was killed or crashed -- which is exactly the case most worth
 * distinguishing, because that session may also have lost buffered events.
 */
export function reasonForEnd(priorEndReason: string | null, deployHint = false): GapReason {
  if (deployHint) return 'deploy';
  if (priorEndReason === null) return 'crash';
  if (priorEndReason === 'sigterm' || priorEndReason === 'sigint') return 'restart';
  if (priorEndReason.startsWith('deploy')) return 'deploy';
  if (priorEndReason.includes('shutdown')) return 'shutdown';
  return 'unknown';
}

export interface OpenGapInput {
  datasetId: string;
  newSessionId: string;
  deployHint?: boolean;
}

/**
 * Opens a gap on collector start, spanning from the last frame the previous
 * session observed. Returns null when this is the first session ever, since
 * there is no preceding coverage to have interrupted.
 */
export async function openCaptureGap(sql: Sql, input: OpenGapInput): Promise<string | null> {
  const prior = await sql<{
    session_id: string;
    end_reason: string | null;
    last_frame_at: Date | null;
  }[]>`
    SELECT c.session_id,
           c.end_reason,
           (SELECT max(r.received_at) FROM raw_ingest_events r WHERE r.session_id = c.session_id)
             AS last_frame_at
      FROM collector_sessions c
     WHERE c.session_id <> ${input.newSessionId}
     ORDER BY c.started_at DESC
     LIMIT 1
  `;

  const previous = prior[0];
  if (!previous?.last_frame_at) return null;

  const markets = await sql<{ market_ticker: string }[]>`
    SELECT DISTINCT t.market_ticker
      FROM tracked_markets t
     WHERE t.tracking_ended_at IS NULL
     ORDER BY t.market_ticker
  `;

  const reason = reasonForEnd(previous.end_reason, input.deployHint);

  const rows = await sql<{ id: string }[]>`
    INSERT INTO capture_gaps (
      dataset_id, started_at, start_session_id, end_session_id,
      reason, prior_end_reason, affected_markets
    ) VALUES (
      ${input.datasetId}, ${previous.last_frame_at}, ${previous.session_id},
      ${input.newSessionId}, ${reason}, ${previous.end_reason},
      ${sql.json(markets.map((m) => m.market_ticker) as never)}
    )
    RETURNING id
  `;

  logger.warn(
    {
      event: 'capture_gap_opened',
      gap_id: rows[0]!.id,
      reason,
      prior_end_reason: previous.end_reason,
      since: previous.last_frame_at.toISOString(),
    },
    `capture gap opened (${reason}); no coverage since ${previous.last_frame_at.toISOString()}`,
  );

  return rows[0]!.id;
}

/**
 * Closes the gap at the first valid snapshot of the new session.
 *
 * The first snapshot, not the first frame: coverage resumes when we have book
 * state we can vouch for, not merely when bytes start arriving.
 */
export async function closeCaptureGap(
  sql: Sql,
  gapId: string,
  firstSnapshotAt: Date,
): Promise<void> {
  const rows = await sql<{ duration_ms_text: string }[]>`
    UPDATE capture_gaps g
       SET ended_at = ${firstSnapshotAt},
           duration_ms = (extract(epoch FROM (${firstSnapshotAt}::timestamptz - g.started_at)) * 1000)::bigint
     WHERE g.id = ${gapId}::bigint AND g.ended_at IS NULL
    RETURNING g.duration_ms::text AS duration_ms_text
  `;

  if (rows[0]) {
    logger.warn(
      { event: 'capture_gap_closed', gap_id: gapId, durationMs: Number(rows[0].duration_ms_text) },
      `capture gap closed after ${Math.round(Number(rows[0].duration_ms_text) / 1000)}s without coverage`,
    );
  }
}

export interface CaptureGapRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  duration_ms_text: string | null;
  reason: GapReason;
  prior_end_reason: string | null;
  start_session_id: string | null;
  end_session_id: string | null;
}

/** Gaps overlapping a window, for replay and research to surface. */
export async function captureGapsInWindow(
  sql: Sql,
  fromMs: bigint,
  toMs: bigint,
): Promise<CaptureGapRow[]> {
  return sql<CaptureGapRow[]>`
    SELECT g.id, g.started_at, g.ended_at, g.duration_ms::text AS duration_ms_text,
           g.reason, g.prior_end_reason, g.start_session_id, g.end_session_id
      FROM capture_gaps g
     WHERE g.started_at <= to_timestamp(${Number(toMs) / 1000})
       AND (g.ended_at IS NULL OR g.ended_at >= to_timestamp(${Number(fromMs) / 1000}))
     ORDER BY g.started_at
  `;
}
