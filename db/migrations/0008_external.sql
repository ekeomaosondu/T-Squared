-- ===========================================================================
-- 0008  External reference data
--
-- Deliberately NOT a dependency of the core recorder. No external provider is
-- ever treated as settlement truth -- Kalshi may change settlement sources, so
-- the settlement-source metadata Kalshi supplies (series.settlement_sources)
-- remains authoritative and is preserved verbatim.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS external_observations (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    provider      TEXT        NOT NULL,

    series_ticker TEXT,
    event_ticker  TEXT,
    market_ticker TEXT,

    station_id    TEXT,
    metric        TEXT        NOT NULL,

    observed_at   TIMESTAMPTZ,
    received_at   TIMESTAMPTZ NOT NULL,

    value         NUMERIC(24, 8),
    unit          TEXT,

    -- e.g. METAR / SPECI / CLI / daily summary
    report_type   TEXT,
    -- Preliminary observations are frequently revised; both versions are kept.
    is_final      BOOLEAN,

    raw           JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS external_observations_station_metric_idx
    ON external_observations (provider, station_id, metric, observed_at DESC);

CREATE INDEX IF NOT EXISTS external_observations_series_idx
    ON external_observations (series_ticker, observed_at DESC);

CREATE INDEX IF NOT EXISTS external_observations_received_idx
    ON external_observations (received_at DESC);


-- Mapping is time-bounded because a series' settlement station can change.
CREATE TABLE IF NOT EXISTS weather_station_mapping (
    series_ticker TEXT        NOT NULL,
    provider      TEXT        NOT NULL,
    station_id    TEXT        NOT NULL,

    station_name  TEXT,
    timezone      TEXT,

    active_from   TIMESTAMPTZ NOT NULL,
    active_until  TIMESTAMPTZ,

    metadata      JSONB,

    PRIMARY KEY (series_ticker, provider, active_from)
);
