-- ===========================================================================
-- 0002  Collector sessions, subscription streams, and the rolling-worker lease
--
-- A Kalshi WebSocket `seq` is scoped to a connection/subscription, NOT global.
-- Separate connections are therefore never stitched into one continuous
-- sequence. Each session is an independently auditable capture epoch and
-- replay code must treat a session boundary as a hard reset.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS collector_sessions (
    session_id           UUID PRIMARY KEY,

    -- 'daemon' | 'vercel_rolling'
    mode                 TEXT        NOT NULL,

    vercel_deployment_id TEXT,
    instance_id          TEXT,

    started_at           TIMESTAMPTZ NOT NULL,
    ended_at             TIMESTAMPTZ,

    -- 'soft_runtime_limit' | 'hard_runtime_limit' | 'handoff_complete'
    -- 'lease_lost' | 'shutdown_signal' | 'fatal_error' | ...
    end_reason           TEXT,

    config_hash          TEXT        NOT NULL,
    git_commit_sha       TEXT,

    ws_url               TEXT,

    messages_received    BIGINT      NOT NULL DEFAULT 0,
    messages_persisted   BIGINT      NOT NULL DEFAULT 0,

    sequence_gaps        INTEGER     NOT NULL DEFAULT 0,
    reconnect_count      INTEGER     NOT NULL DEFAULT 0,
    db_error_count       INTEGER     NOT NULL DEFAULT 0,

    last_heartbeat_at    TIMESTAMPTZ,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collector_sessions_started_at_idx
    ON collector_sessions (started_at DESC);

-- Supervisor lookup: "is there a live session?"
CREATE INDEX IF NOT EXISTS collector_sessions_live_idx
    ON collector_sessions (last_heartbeat_at DESC)
    WHERE ended_at IS NULL;


-- One row per (connection, channel subscription). `sid` is assigned by Kalshi
-- per subscription and is only meaningful within its session.
CREATE TABLE IF NOT EXISTS subscription_streams (
    stream_id       UUID PRIMARY KEY,

    session_id      UUID        NOT NULL REFERENCES collector_sessions (session_id),

    channel         TEXT        NOT NULL,
    sid             INTEGER,

    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,

    market_tickers  JSONB,

    first_seq       BIGINT,
    last_seq        BIGINT,

    gap_count       INTEGER     NOT NULL DEFAULT 0,

    -- starting | healthy | degraded | recovering | closed
    status          TEXT        NOT NULL DEFAULT 'starting',

    CONSTRAINT subscription_streams_status_chk CHECK (
        status IN ('starting', 'healthy', 'degraded', 'recovering', 'closed')
    )
);

CREATE INDEX IF NOT EXISTS subscription_streams_session_idx
    ON subscription_streams (session_id, channel);

-- `sid` is unique per session, not globally.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_streams_session_sid_uniq
    ON subscription_streams (session_id, sid)
    WHERE sid IS NOT NULL;


-- Single-row-per-name lease coordinating rolling Vercel workers. Ownership
-- changes are guarded by optimistic concurrency on `version` plus an advisory
-- lock; only the active session writes canonical normalised events.
CREATE TABLE IF NOT EXISTS collector_leases (
    lease_name           TEXT PRIMARY KEY,

    active_session_id    UUID,
    standby_session_id   UUID,

    active_heartbeat_at  TIMESTAMPTZ,
    standby_heartbeat_at TIMESTAMPTZ,

    handoff_requested    BOOLEAN     NOT NULL DEFAULT FALSE,

    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    version              BIGINT      NOT NULL DEFAULT 0
);
