-- ===========================================================================
-- 0014  Silver layer: Parquet exports and normalized retention
--
-- The raw archive is the ultimate source of truth; normalized deltas are the
-- canonical RESEARCH representation but remain reproducible from raw. That
-- means normalized rows can also expire from Postgres once they are safely in
-- object storage, which is what keeps Neon a small hot store rather than a
-- 75 GB warehouse.
--
-- Nothing is expired until its silver Parquet is written AND its row count is
-- verified against the database, mirroring the raw archive gate exactly.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- ingest_ordinal on normalized tables.
--
-- Silver delta files are sorted by (session_id, ingest_ordinal) because that
-- reproduces the exact order the collector observed events -- the ordering a
-- backtest must replay in. Carrying the ordinal directly avoids joining back
-- to raw_ingest_events, which is deliberately deleted after its retention
-- window and so cannot be relied on at export time.
-- ---------------------------------------------------------------------------
ALTER TABLE orderbook_deltas        ADD COLUMN IF NOT EXISTS ingest_ordinal BIGINT;
ALTER TABLE public_trades           ADD COLUMN IF NOT EXISTS ingest_ordinal BIGINT;
ALTER TABLE ticker_updates          ADD COLUMN IF NOT EXISTS ingest_ordinal BIGINT;
ALTER TABLE market_lifecycle_events ADD COLUMN IF NOT EXISTS ingest_ordinal BIGINT;
ALTER TABLE orderbook_snapshots     ADD COLUMN IF NOT EXISTS ingest_ordinal BIGINT;

CREATE INDEX IF NOT EXISTS orderbook_deltas_session_ordinal_idx
    ON orderbook_deltas (session_id, ingest_ordinal);


-- ---------------------------------------------------------------------------
-- One row per (table, UTC day) exported to the research lake.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS silver_exports (
    export_id          UUID PRIMARY KEY,

    dataset_id         TEXT        NOT NULL,
    source_table       TEXT        NOT NULL,
    trading_date       DATE        NOT NULL,
    series_ticker      TEXT,

    -- Row count in Postgres at export time; the Parquet must reproduce it.
    source_row_count   BIGINT      NOT NULL,
    exported_row_count BIGINT      NOT NULL,

    object_path        TEXT        NOT NULL,
    compressed_bytes   BIGINT,
    sha256             BYTEA,

    exported_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at        TIMESTAMPTZ,
    verification_error TEXT,

    -- pending | exported | verified | failed
    status             TEXT        NOT NULL DEFAULT 'pending',

    CONSTRAINT silver_exports_key_uniq
        UNIQUE (source_table, trading_date, series_ticker),
    CONSTRAINT silver_exports_status_chk CHECK (
        status IN ('pending', 'exported', 'verified', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS silver_exports_date_idx ON silver_exports (trading_date DESC);
CREATE INDEX IF NOT EXISTS silver_exports_status_idx ON silver_exports (status, trading_date);


-- ---------------------------------------------------------------------------
-- Normalized retention ledger: which days have been expired from Postgres.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS normalized_retention (
    trading_date   DATE PRIMARY KEY,

    expired_at     TIMESTAMPTZ,
    rows_deleted   BIGINT      NOT NULL DEFAULT 0,
    tables_expired JSONB,

    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE normalized_retention IS
    'A trading day is only expired from Postgres after every silver export for '
    'that day is verified. The raw archive remains the ultimate source of truth.';
