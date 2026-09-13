-- ===========================================================================
-- 0007  Immutable raw archive
--
-- Archive boundaries follow PARTITION boundaries, not arbitrary id ranges, so
-- that "the SQL partition I dropped" and "the objects I archived" are provably
-- the same rows. A daily partition is archived as a set of parts keyed by
-- (channel, hour), matching the blob layout:
--
--   kalshi/raw/channel=orderbook_delta/date=2026-09-13/hour=17/
--       part-<session>-<first_id>-<last_id>.jsonl.gz
--
-- A partition is NEVER detached or dropped before every part is uploaded,
-- checksum-verified, and the archived row count equals the sealed row count.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS raw_archives (
    archive_id         UUID PRIMARY KEY,

    partition_name     TEXT        NOT NULL,
    partition_start    TIMESTAMPTZ NOT NULL,
    partition_end      TIMESTAMPTZ NOT NULL,

    channel            TEXT,
    hour_start         TIMESTAMPTZ,

    start_raw_id       BIGINT,
    end_raw_id         BIGINT,

    start_time         TIMESTAMPTZ,
    end_time           TIMESTAMPTZ,

    row_count          BIGINT      NOT NULL,

    blob_path          TEXT        NOT NULL,

    uncompressed_bytes BIGINT,
    compressed_bytes   BIGINT,

    -- SHA-256 of the GZIPPED bytes exactly as uploaded.
    sha256             BYTEA       NOT NULL,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_at        TIMESTAMPTZ,
    verified_at        TIMESTAMPTZ,

    verification_error TEXT,

    CONSTRAINT raw_archives_blob_path_uniq UNIQUE (blob_path)
);

CREATE INDEX IF NOT EXISTS raw_archives_partition_idx
    ON raw_archives (partition_name);

CREATE INDEX IF NOT EXISTS raw_archives_unverified_idx
    ON raw_archives (created_at)
    WHERE verified_at IS NULL;


-- Per-partition archival ledger. `sealed_row_count` is counted once, after the
-- partition's time range has fully elapsed and no further inserts can land in
-- it, and is the number the archive must reproduce exactly.
CREATE TABLE IF NOT EXISTS raw_partition_archive_state (
    partition_name       TEXT PRIMARY KEY,

    partition_start      TIMESTAMPTZ NOT NULL,
    partition_end        TIMESTAMPTZ NOT NULL,

    sealed_at            TIMESTAMPTZ,
    sealed_row_count     BIGINT,

    archived_row_count   BIGINT      NOT NULL DEFAULT 0,
    part_count           INTEGER     NOT NULL DEFAULT 0,

    archive_completed_at TIMESTAMPTZ,
    verified_at          TIMESTAMPTZ,

    detached_at          TIMESTAMPTZ,
    dropped_at           TIMESTAMPTZ,

    -- pending | sealing | archiving | archived | verified | detached | dropped | failed
    status               TEXT        NOT NULL DEFAULT 'pending',
    last_error           TEXT,

    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT raw_partition_archive_state_status_chk CHECK (
        status IN ('pending', 'sealing', 'archiving', 'archived',
                   'verified', 'detached', 'dropped', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS raw_partition_archive_state_status_idx
    ON raw_partition_archive_state (status, partition_end);
