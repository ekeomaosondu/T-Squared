-- ===========================================================================
-- 0001  Reference data: series -> events -> markets
--
-- These tables hold the OFFICIAL relationships returned by Kalshi. Market
-- grouping is never inferred by parsing ticker strings; ticker prefixes are
-- only ever used as a discovery selector, after which event_ticker /
-- series_ticker as supplied by the API are authoritative.
--
-- Every table keeps the verbatim API object in `raw` so a future parser can
-- recover fields this version did not normalise.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS series (
    series_ticker        TEXT PRIMARY KEY,

    title                TEXT,
    category             TEXT,
    frequency            TEXT,

    tags                 JSONB,
    settlement_sources   JSONB,

    contract_url         TEXT,
    contract_terms_url   TEXT,

    fee_type             TEXT,
    fee_multiplier       NUMERIC(18, 8),

    product_metadata     JSONB,

    last_updated_ts      TIMESTAMPTZ,
    last_refreshed_at    TIMESTAMPTZ NOT NULL,

    raw                  JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS series_category_idx        ON series (category);
CREATE INDEX IF NOT EXISTS series_last_updated_ts_idx ON series (last_updated_ts);


CREATE TABLE IF NOT EXISTS events (
    event_ticker         TEXT PRIMARY KEY,
    series_ticker        TEXT REFERENCES series (series_ticker),

    title                TEXT,
    sub_title            TEXT,
    category             TEXT,

    -- Critical for KXHIGH/KXLOW: the temperature buckets under one event form
    -- a mutually exclusive ladder. Preserved exactly as the exchange reports.
    mutually_exclusive   BOOLEAN,
    available_on_brokers BOOLEAN,

    -- Kalshi returns settlement_sources on the EVENT as well as the series,
    -- and the event-level value is the one that governs this day's contracts.
    settlement_sources   JSONB,
    collateral_return_type TEXT,

    strike_date          TIMESTAMPTZ,
    strike_period        TEXT,

    product_metadata     JSONB,

    last_updated_ts      TIMESTAMPTZ,

    last_refreshed_at    TIMESTAMPTZ NOT NULL,

    raw                  JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS events_series_ticker_idx ON events (series_ticker);
CREATE INDEX IF NOT EXISTS events_strike_date_idx   ON events (strike_date);


-- Latest known state/metadata for each market. History of changes lives in
-- market_metadata_versions; this row is deliberately mutable.
CREATE TABLE IF NOT EXISTS markets (
    market_ticker            TEXT PRIMARY KEY,
    market_id                TEXT,

    event_ticker             TEXT REFERENCES events (event_ticker),
    series_ticker            TEXT REFERENCES series (series_ticker),

    market_type              TEXT,

    title                    TEXT,
    subtitle                 TEXT,
    yes_sub_title            TEXT,
    no_sub_title             TEXT,

    status                   TEXT,

    -- Strike definition. Never assume today's grid equals tomorrow's.
    strike_type              TEXT,
    floor_strike             NUMERIC(20, 8),
    cap_strike               NUMERIC(20, 8),
    functional_strike        TEXT,
    custom_strike            JSONB,

    price_level_structure    TEXT,
    price_ranges             JSONB,

    created_time             TIMESTAMPTZ,
    updated_time             TIMESTAMPTZ,
    open_time                TIMESTAMPTZ,
    close_time               TIMESTAMPTZ,

    expected_expiration_time TIMESTAMPTZ,
    latest_expiration_time   TIMESTAMPTZ,
    expiration_time          TIMESTAMPTZ,
    -- When the underlying real-world occurrence is measured (temperature read).
    occurrence_datetime      TIMESTAMPTZ,

    -- Payout of one contract, in dollars. Currently always 1.00, but it is
    -- exchange-supplied and must not be assumed.
    notional_value           NUMERIC(12, 6),

    settlement_timer_seconds INTEGER,

    can_close_early          BOOLEAN,
    early_close_condition    TEXT,

    rules_primary            TEXT,
    rules_secondary          TEXT,

    result                   TEXT,
    expiration_value         TEXT,
    settlement_value         NUMERIC(12, 6),
    settlement_ts            TIMESTAMPTZ,

    is_provisional           BOOLEAN,

    last_refreshed_at        TIMESTAMPTZ NOT NULL,

    raw                      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS markets_event_ticker_idx   ON markets (event_ticker);
CREATE INDEX IF NOT EXISTS markets_series_ticker_idx  ON markets (series_ticker);
CREATE INDEX IF NOT EXISTS markets_status_idx         ON markets (status);
CREATE INDEX IF NOT EXISTS markets_open_time_idx      ON markets (open_time);
CREATE INDEX IF NOT EXISTS markets_close_time_idx     ON markets (close_time);
CREATE INDEX IF NOT EXISTS markets_series_status_idx  ON markets (series_ticker, status);


-- Append-only audit of metadata changes. version_hash is a SHA-256 over the
-- canonicalised API object, so an unchanged poll is a no-op insert.
CREATE TABLE IF NOT EXISTS market_metadata_versions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    market_ticker TEXT        NOT NULL,
    observed_at   TIMESTAMPTZ NOT NULL,

    version_hash  TEXT        NOT NULL,

    status        TEXT,
    close_time    TIMESTAMPTZ,
    result        TEXT,

    raw           JSONB       NOT NULL,

    CONSTRAINT market_metadata_versions_uniq UNIQUE (market_ticker, version_hash)
);

CREATE INDEX IF NOT EXISTS market_metadata_versions_market_observed_idx
    ON market_metadata_versions (market_ticker, observed_at DESC);


-- Exactly when the recorder INTENDED to be capturing each market. Prior
-- windows are never overwritten: a market that is tracked, dropped and tracked
-- again produces three rows, not one mutated row.
CREATE TABLE IF NOT EXISTS tracked_markets (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    market_ticker       TEXT        NOT NULL,
    selector_id         TEXT        NOT NULL,

    tracking_started_at TIMESTAMPTZ NOT NULL,
    tracking_ended_at   TIMESTAMPTZ,

    reason_started      TEXT,
    reason_ended        TEXT
);

CREATE INDEX IF NOT EXISTS tracked_markets_market_idx
    ON tracked_markets (market_ticker, tracking_started_at DESC);

-- At most one OPEN tracking window per (market, selector).
CREATE UNIQUE INDEX IF NOT EXISTS tracked_markets_open_window_uniq
    ON tracked_markets (market_ticker, selector_id)
    WHERE tracking_ended_at IS NULL;
