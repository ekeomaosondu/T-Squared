import { randomUUID } from 'node:crypto';
import { one, type Sql } from '@/src/persistence/db';

/**
 * Collector sessions and subscription streams.
 *
 * A session is a capture EPOCH. Sequence continuity is never claimed across
 * sessions, and replay code is expected to reset from a snapshot at every
 * session boundary.
 */

export type SessionMode = 'daemon' | 'vercel_rolling';

export interface StartSessionInput {
  sessionId?: string;
  mode: SessionMode;
  configHash: string;
  wsUrl: string;
  vercelDeploymentId?: string | null;
  instanceId?: string | null;
  gitCommitSha?: string | null;
}

export async function startSession(sql: Sql, input: StartSessionInput): Promise<string> {
  const sessionId = input.sessionId ?? randomUUID();
  await sql`
    INSERT INTO collector_sessions (
      session_id, mode, vercel_deployment_id, instance_id, started_at,
      config_hash, git_commit_sha, ws_url, last_heartbeat_at
    ) VALUES (
      ${sessionId}, ${input.mode}, ${input.vercelDeploymentId ?? null},
      ${input.instanceId ?? null}, now(), ${input.configHash},
      ${input.gitCommitSha ?? null}, ${input.wsUrl}, now()
    )
  `;
  return sessionId;
}

export async function heartbeatSession(sql: Sql, sessionId: string): Promise<void> {
  await sql`
    UPDATE collector_sessions SET last_heartbeat_at = now() WHERE session_id = ${sessionId}
  `;
}

export interface SessionCounters {
  messagesReceived?: number;
  messagesPersisted?: number;
  sequenceGaps?: number;
  reconnects?: number;
  dbErrors?: number;
}

/** Counters accumulate; they are never reset within a session. */
export async function bumpSessionCounters(
  sql: Sql,
  sessionId: string,
  c: SessionCounters,
): Promise<void> {
  await sql`
    UPDATE collector_sessions SET
      messages_received  = messages_received  + ${c.messagesReceived ?? 0},
      messages_persisted = messages_persisted + ${c.messagesPersisted ?? 0},
      sequence_gaps      = sequence_gaps      + ${c.sequenceGaps ?? 0},
      reconnect_count    = reconnect_count    + ${c.reconnects ?? 0},
      db_error_count     = db_error_count     + ${c.dbErrors ?? 0},
      last_heartbeat_at  = now()
    WHERE session_id = ${sessionId}
  `;
}

export async function endSession(sql: Sql, sessionId: string, endReason: string): Promise<void> {
  await sql`
    UPDATE collector_sessions
       SET ended_at = now(), end_reason = ${endReason}
     WHERE session_id = ${sessionId} AND ended_at IS NULL
  `;
}

export interface SessionRow {
  session_id: string;
  mode: string;
  started_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  last_heartbeat_at: Date | null;
  messages_received: string;
  messages_persisted: string;
  sequence_gaps: number;
  reconnect_count: number;
  db_error_count: number;
  config_hash: string;
  ws_url: string | null;
}

export async function getSession(sql: Sql, sessionId: string): Promise<SessionRow | null> {
  const rows = await sql<SessionRow[]>`
    SELECT * FROM collector_sessions WHERE session_id = ${sessionId}
  `;
  return rows[0] ?? null;
}

export async function listRecentSessions(sql: Sql, limit = 20): Promise<SessionRow[]> {
  return sql<SessionRow[]>`
    SELECT * FROM collector_sessions ORDER BY started_at DESC LIMIT ${limit}
  `;
}

/**
 * Sessions that are still open and heartbeating. Process existence is never
 * used as the health signal -- only the heartbeat is.
 */
export async function findLiveSessions(sql: Sql, staleMs: number): Promise<SessionRow[]> {
  return sql<SessionRow[]>`
    SELECT * FROM collector_sessions
     WHERE ended_at IS NULL
       AND last_heartbeat_at > now() - make_interval(secs => ${staleMs / 1000})
     ORDER BY started_at DESC
  `;
}

// ---------------------------------------------------------------------------
// Subscription streams
// ---------------------------------------------------------------------------

export type StreamStatus = 'starting' | 'healthy' | 'degraded' | 'recovering' | 'closed';

export async function createStream(
  sql: Sql,
  input: {
    streamId?: string;
    sessionId: string;
    channel: string;
    sid?: number | null;
    marketTickers: string[];
  },
): Promise<string> {
  const streamId = input.streamId ?? randomUUID();
  await sql`
    INSERT INTO subscription_streams (
      stream_id, session_id, channel, sid, started_at, market_tickers, status
    ) VALUES (
      ${streamId}, ${input.sessionId}, ${input.channel}, ${input.sid ?? null},
      now(), ${sql.json(input.marketTickers as never)}, 'starting'
    )
  `;
  return streamId;
}

export async function setStreamSid(sql: Sql, streamId: string, sid: number): Promise<void> {
  await sql`UPDATE subscription_streams SET sid = ${sid} WHERE stream_id = ${streamId}`;
}

export async function setStreamStatus(
  sql: Sql,
  streamId: string,
  status: StreamStatus,
): Promise<void> {
  await sql`UPDATE subscription_streams SET status = ${status} WHERE stream_id = ${streamId}`;
}

export async function updateStreamSeq(
  sql: Sql,
  streamId: string,
  firstSeq: bigint | null,
  lastSeq: bigint | null,
  gapCount: number,
): Promise<void> {
  await sql`
    UPDATE subscription_streams SET
      first_seq = COALESCE(first_seq, ${firstSeq?.toString() ?? null}),
      last_seq  = ${lastSeq?.toString() ?? null},
      gap_count = ${gapCount}
    WHERE stream_id = ${streamId}
  `;
}

export async function setStreamMarkets(
  sql: Sql,
  streamId: string,
  marketTickers: string[],
): Promise<void> {
  await sql`
    UPDATE subscription_streams
       SET market_tickers = ${sql.json(marketTickers as never)}
     WHERE stream_id = ${streamId}
  `;
}

export async function closeStream(sql: Sql, streamId: string): Promise<void> {
  await sql`
    UPDATE subscription_streams
       SET ended_at = now(), status = 'closed'
     WHERE stream_id = ${streamId} AND ended_at IS NULL
  `;
}

export async function closeAllStreamsForSession(sql: Sql, sessionId: string): Promise<void> {
  await sql`
    UPDATE subscription_streams
       SET ended_at = now(), status = 'closed'
     WHERE session_id = ${sessionId} AND ended_at IS NULL
  `;
}

export async function countLiveStreams(sql: Sql, sessionId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM subscription_streams
     WHERE session_id = ${sessionId} AND ended_at IS NULL
  `;
  return Number(one(rows).n);
}
