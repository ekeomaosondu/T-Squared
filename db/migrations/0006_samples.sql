-- ===========================================================================
-- 0006  Derived samples
--
-- Everything here is DERIVED and reproducible from raw deltas + snapshots.
-- Sampling horizons are configuration, never a reason to drop raw events.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- BBO / feature samples, one row per (market, interval, bucket).
--
-- Missing BBOs are stored as NULL and never imputed. book_valid records
-- whether the reconstructed book was trustworthy at that instant, so research
-- code can filter rather than guess.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS book_samples (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    market_ticker    TEXT        NOT NULL,

    interval_ms      INTEGER     NOT NULL,

    bucket_ts        TIMESTAMPTZ NOT NULL,
    bucket_ts_ms     BIGINT      NOT NULL,

    source_seq       BIGINT,

    yes_bid          NUMERIC(12, 6),
    yes_ask          NUMERIC(12, 6),

    bid_size         NUMERIC(24, 6),
    ask_size         NUMERIC(24, 6),

    spread           NUMERIC(12, 6),
    mid              NUMERIC(12, 6),
    microprice       NUMERIC(12, 6),

    bid_depth_1      NUMERIC(24, 6),
    ask_depth_1      NUMERIC(24, 6),

    bid_depth_3      NUMERIC(24, 6),
    ask_depth_3      NUMERIC(24, 6),

    bid_depth_5      NUMERIC(24, 6),
    ask_depth_5      NUMERIC(24, 6),

    bid_depth_10     NUMERIC(24, 6),
    ask_depth_10     NUMERIC(24, 6),

    -- NULL when the denominator is zero. Never 0-as-a-stand-in.
    imbalance_1      NUMERIC(14, 8),
    imbalance_3      NUMERIC(14, 8),
    imbalance_5      NUMERIC(14, 8),
    imbalance_10     NUMERIC(14, 8),

    last_trade_price NUMERIC(12, 6),
    last_trade_count NUMERIC(24, 6),

    volume           NUMERIC(24, 6),
    open_interest    NUMERIC(24, 6),

    book_state_hash  TEXT,

    book_valid       BOOLEAN     NOT NULL,

    CONSTRAINT book_samples_key_uniq UNIQUE (market_ticker, interval_ms, bucket_ts)
);

CREATE INDEX IF NOT EXISTS book_samples_market_interval_bucket_idx
    ON book_samples (market_ticker, interval_ms, bucket_ts DESC);

CREATE INDEX IF NOT EXISTS book_samples_bucket_idx
    ON book_samples (bucket_ts DESC);


-- ---------------------------------------------------------------------------
-- Synchronised event-ladder samples.
--
-- All rows in a group are read from ONE logical sampling instant, so the
-- cross-strike distribution is internally consistent. Contracts are never
-- timestamped independently and later presented as synchronised.
--
-- `complete` records whether every market we expected under the event was
-- captured. Probabilities are NOT forced to sum to one -- what the market
-- actually showed is what is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_ladder_sample_groups (
    sample_group_id       UUID PRIMARY KEY,

    event_ticker          TEXT        NOT NULL,
    series_ticker         TEXT        NOT NULL,

    interval_ms           INTEGER     NOT NULL,

    sampled_at            TIMESTAMPTZ NOT NULL,
    sampled_at_ms         BIGINT      NOT NULL,

    expected_market_count INTEGER,
    captured_market_count INTEGER,

    complete              BOOLEAN     NOT NULL,

    ladder_state_hash     TEXT,

    CONSTRAINT event_ladder_sample_groups_key_uniq
        UNIQUE (event_ticker, interval_ms, sampled_at)
);

CREATE INDEX IF NOT EXISTS event_ladder_sample_groups_event_idx
    ON event_ladder_sample_groups (event_ticker, interval_ms, sampled_at DESC);

CREATE INDEX IF NOT EXISTS event_ladder_sample_groups_series_idx
    ON event_ladder_sample_groups (series_ticker, sampled_at DESC);


CREATE TABLE IF NOT EXISTS event_ladder_samples (
    sample_group_id   UUID NOT NULL
        REFERENCES event_ladder_sample_groups (sample_group_id) ON DELETE CASCADE,
    market_ticker     TEXT NOT NULL,

    -- Strike definition is denormalised onto the sample so a historical ladder
    -- stays interpretable even if the grid changes tomorrow.
    floor_strike      NUMERIC(20, 8),
    cap_strike        NUMERIC(20, 8),
    strike_type       TEXT,
    functional_strike TEXT,

    yes_bid           NUMERIC(12, 6),
    yes_ask           NUMERIC(12, 6),

    bid_size          NUMERIC(24, 6),
    ask_size          NUMERIC(24, 6),

    mid               NUMERIC(12, 6),
    microprice        NUMERIC(12, 6),

    last_trade_price  NUMERIC(12, 6),

    volume            NUMERIC(24, 6),
    open_interest     NUMERIC(24, 6),

    source_seq        BIGINT,

    book_state_hash   TEXT,
    book_valid        BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (sample_group_id, market_ticker)
);

CREATE INDEX IF NOT EXISTS event_ladder_samples_market_idx
    ON event_ladder_samples (market_ticker);


-- ---------------------------------------------------------------------------
-- Rolling order-flow statistics. Derived, and explicitly allowed to lag: this
-- is never computed at the expense of raw ingestion reliability.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orderflow_windows (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    market_ticker     TEXT        NOT NULL,

    window_ms         INTEGER     NOT NULL,

    bucket_ts         TIMESTAMPTZ NOT NULL,
    bucket_ts_ms      BIGINT      NOT NULL,

    trade_count       INTEGER     NOT NULL DEFAULT 0,
    trade_volume      NUMERIC(24, 6) NOT NULL DEFAULT 0,
    yes_taker_volume  NUMERIC(24, 6) NOT NULL DEFAULT 0,
    no_taker_volume   NUMERIC(24, 6) NOT NULL DEFAULT 0,

    bid_added         NUMERIC(24, 6) NOT NULL DEFAULT 0,
    bid_removed       NUMERIC(24, 6) NOT NULL DEFAULT 0,
    ask_added         NUMERIC(24, 6) NOT NULL DEFAULT 0,
    ask_removed       NUMERIC(24, 6) NOT NULL DEFAULT 0,

    top_bid_added     NUMERIC(24, 6) NOT NULL DEFAULT 0,
    top_bid_removed   NUMERIC(24, 6) NOT NULL DEFAULT 0,
    top_ask_added     NUMERIC(24, 6) NOT NULL DEFAULT 0,
    top_ask_removed   NUMERIC(24, 6) NOT NULL DEFAULT 0,

    price_changes     INTEGER     NOT NULL DEFAULT 0,
    spread_changes    INTEGER     NOT NULL DEFAULT 0,

    CONSTRAINT orderflow_windows_key_uniq
        UNIQUE (market_ticker, window_ms, bucket_ts)
);

CREATE INDEX IF NOT EXISTS orderflow_windows_market_window_idx
    ON orderflow_windows (market_ticker, window_ms, bucket_ts DESC);
