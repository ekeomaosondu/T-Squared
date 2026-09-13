-- ===========================================================================
-- 0015  capture_gaps -- intervals where the recorder was not listening
--
-- A deployment, restart or crash leaves a hole in the record. Without this
-- table that hole is indistinguishable from a quiet market: a backtest reading
-- the delta stream sees no events and concludes nothing happened, which is
-- exactly wrong when the truth is "we were not watching".
--
-- Every interval between the last frame of one session and the first valid
-- snapshot of the next is therefore recorded explicitly, with a reason, and
-- surfaced by replay alongside sequence gaps.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS capture_gaps (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    dataset_id        TEXT        NOT NULL,

    -- Last frame observed before the recorder stopped.
    started_at        TIMESTAMPTZ NOT NULL,
    -- First valid snapshot after it resumed. NULL while still open.
    ended_at          TIMESTAMPTZ,
    duration_ms       BIGINT,

    start_session_id  UUID,
    end_session_id    UUID,

    -- deploy | restart | crash | shutdown | unknown
    reason            TEXT        NOT NULL,
    -- end_reason of the session that closed, which is how reason is derived.
    prior_end_reason  TEXT,

    -- Markets known to be tracked when the gap opened, so a study can tell
    -- which instruments were actually affected.
    affected_markets  JSONB,

    notes             TEXT,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT capture_gaps_reason_chk CHECK (
        reason IN ('deploy', 'restart', 'crash', 'shutdown', 'unknown')
    )
);

CREATE INDEX IF NOT EXISTS capture_gaps_window_idx ON capture_gaps (started_at, ended_at);
CREATE INDEX IF NOT EXISTS capture_gaps_open_idx ON capture_gaps (started_at) WHERE ended_at IS NULL;

COMMENT ON TABLE capture_gaps IS
    'Intervals when no collector was listening. Replay surfaces these so an '
    'absence of events is never mistaken for an absence of market activity.';
