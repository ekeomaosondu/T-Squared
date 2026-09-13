-- ===========================================================================
-- 0005  Integrity, validation and health
--
-- The dataset is only useful if we can later tell whether a given window was
-- reconstructed from an uninterrupted stream or stitched after a recovery.
-- These tables make that question answerable offline.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS sequence_gaps (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    session_id              UUID        NOT NULL,
    stream_id               UUID        NOT NULL,

    channel                 TEXT        NOT NULL,
    sid                     INTEGER,

    expected_seq            BIGINT,
    received_seq            BIGINT,

    detected_at             TIMESTAMPTZ NOT NULL,

    affected_markets        JSONB,

    recovery_requested_at   TIMESTAMPTZ,
    recovery_completed_at   TIMESTAMPTZ,

    recovery_snapshot_count INTEGER,

    -- detected | recovering | recovered | failed
    status                  TEXT        NOT NULL DEFAULT 'detected',
    notes                   TEXT,

    CONSTRAINT sequence_gaps_status_chk CHECK (
        status IN ('detected', 'recovering', 'recovered', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS sequence_gaps_detected_at_idx
    ON sequence_gaps (detected_at DESC);

CREATE INDEX IF NOT EXISTS sequence_gaps_stream_idx
    ON sequence_gaps (session_id, stream_id, detected_at DESC);


-- Anything the recorder observed that it could not treat as normal. Suspicious
-- exchange states are RECORDED, never deleted -- research data should preserve
-- reality, including anomalies.
CREATE TABLE IF NOT EXISTS integrity_events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    session_id    UUID,
    market_ticker TEXT,

    detected_at   TIMESTAMPTZ NOT NULL,

    type          TEXT        NOT NULL,
    severity      TEXT        NOT NULL,

    details       JSONB       NOT NULL,

    resolved_at   TIMESTAMPTZ,
    resolution    TEXT,

    CONSTRAINT integrity_events_severity_chk CHECK (
        severity IN ('info', 'warning', 'error', 'critical')
    )
);

CREATE INDEX IF NOT EXISTS integrity_events_detected_at_idx
    ON integrity_events (detected_at DESC);

CREATE INDEX IF NOT EXISTS integrity_events_type_idx
    ON integrity_events (type, detected_at DESC);

CREATE INDEX IF NOT EXISTS integrity_events_market_idx
    ON integrity_events (market_ticker, detected_at DESC)
    WHERE market_ticker IS NOT NULL;

CREATE INDEX IF NOT EXISTS integrity_events_unresolved_idx
    ON integrity_events (detected_at DESC)
    WHERE resolved_at IS NULL;


-- REST cross-check results. EVERY result is persisted, matched or not, so the
-- match rate over any window is computable.
CREATE TABLE IF NOT EXISTS book_validations (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    market_ticker        TEXT        NOT NULL,

    checked_at           TIMESTAMPTZ NOT NULL,

    session_id           UUID,

    local_seq            BIGINT,

    local_state_hash     TEXT,
    rest_state_hash      TEXT,

    matched              BOOLEAN     NOT NULL,

    local_level_count    INTEGER,
    rest_level_count     INTEGER,

    -- Level-by-level diff when the hashes disagree.
    difference           JSONB,

    request_started_at   TIMESTAMPTZ,
    request_completed_at TIMESTAMPTZ,
    request_latency_ms   INTEGER
);

CREATE INDEX IF NOT EXISTS book_validations_market_checked_idx
    ON book_validations (market_ticker, checked_at DESC);

CREATE INDEX IF NOT EXISTS book_validations_mismatch_idx
    ON book_validations (checked_at DESC)
    WHERE matched = false;


-- One row per session per minute. Cheap enough to always write, and it is what
-- makes "was this portion of the dataset trustworthy?" answerable later.
CREATE TABLE IF NOT EXISTS ingest_health_minutes (
    session_id                 UUID        NOT NULL,
    minute                     TIMESTAMPTZ NOT NULL,

    ws_connected               BOOLEAN,

    tracked_market_count       INTEGER,

    raw_message_count          BIGINT      NOT NULL DEFAULT 0,

    orderbook_delta_count      BIGINT      NOT NULL DEFAULT 0,
    trade_count                BIGINT      NOT NULL DEFAULT 0,
    ticker_count               BIGINT      NOT NULL DEFAULT 0,
    snapshot_count             BIGINT      NOT NULL DEFAULT 0,

    sequence_gap_count         INTEGER     NOT NULL DEFAULT 0,
    validation_mismatch_count  INTEGER     NOT NULL DEFAULT 0,

    db_batch_count             INTEGER     NOT NULL DEFAULT 0,
    db_rows_written            BIGINT      NOT NULL DEFAULT 0,
    db_error_count             INTEGER     NOT NULL DEFAULT 0,

    avg_db_flush_ms            NUMERIC(12, 3),
    max_db_flush_ms            NUMERIC(12, 3),

    -- Only computed from messages carrying a usable exchange timestamp. Kalshi
    -- timestamps can be coarse, so this is NOT true network latency.
    avg_exchange_to_receive_ms NUMERIC(12, 3),
    p50_exchange_to_receive_ms NUMERIC(12, 3),
    p95_exchange_to_receive_ms NUMERIC(12, 3),
    p99_exchange_to_receive_ms NUMERIC(12, 3),

    reconnect_count            INTEGER     NOT NULL DEFAULT 0,

    -- Operational dependency introduced by partitioning, made visible:
    -- >= 3 healthy | 2 warning | 1 critical | 0 at risk | -1 today missing
    partitions_ahead           INTEGER,

    PRIMARY KEY (session_id, minute)
);

CREATE INDEX IF NOT EXISTS ingest_health_minutes_minute_idx
    ON ingest_health_minutes (minute DESC);
