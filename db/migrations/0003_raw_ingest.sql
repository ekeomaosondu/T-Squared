-- ===========================================================================
-- 0003  raw_ingest_events  --  the authoritative raw event log
--
-- Every message received on the socket is written here before it is considered
-- captured. Nothing in this table is ever downsampled, deduplicated, smoothed
-- or repaired. If Kalshi sends the same bytes twice, BOTH rows are recorded:
-- "what did our socket process actually receive?" is the question this table
-- answers. Deduplication belongs downstream (public_trades.trade_id, and
-- session/stream/seq analysis).
--
-- Partitioning
-- ------------
-- Daily UTC range partitions. Retention is a DROP of a whole partition after
-- its archive is verified -- never a bulk DELETE, which at this write rate
-- would leave autovacuum scanning every index while ingestion competes for
-- the same I/O.
--
-- Postgres requires the partition key in any unique constraint, so the key is
-- (id, received_at). All partitions share the parent identity sequence, so
-- `id` remains operationally globally increasing; the database simply does not
-- enforce UNIQUE(id) on its own. That is accepted and documented.
--
-- There is deliberately NO DEFAULT partition. If partition maintenance fails,
-- inserts must fail loudly rather than silently pooling into a catch-all that
-- later blocks ATTACH of the correct range.
--
-- Indexes
-- -------
-- Three, not six. Each index turns one heap append into additional random
-- index maintenance on the hot path, and this table is not meant to serve
-- ordinary strategy queries. Daily partition pruning already removes almost
-- all irrelevant data, which is also why there is no BRIN index: each live
-- partition only spans one day. There is no index on payload_hash -- it exists
-- for integrity, archive verification and diagnostics, not for lookup.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS raw_ingest_events (
    id                BIGINT GENERATED ALWAYS AS IDENTITY,

    session_id        UUID        NOT NULL,
    stream_id         UUID,

    received_at       TIMESTAMPTZ NOT NULL,
    received_at_ms    BIGINT      NOT NULL,

    -- process.hrtime.bigint(). Signed BIGINT covers ~292 years of nanoseconds,
    -- far beyond any collector process lifetime, so NUMERIC is unnecessary.
    -- Only comparable WITHIN a single collector session.
    recv_monotonic_ns BIGINT,

    channel           TEXT,
    message_type      TEXT        NOT NULL,

    sid               INTEGER,
    seq               BIGINT,

    market_ticker     TEXT,
    market_id         TEXT,

    exchange_ts_ms    BIGINT,

    -- SHA-256 as 32 raw bytes. Hex text would be 64 bytes per row for no gain.
    payload_hash      BYTEA       NOT NULL,

    -- The verbatim Kalshi message.
    payload           JSONB       NOT NULL,

    parse_version     SMALLINT    NOT NULL DEFAULT 1,

    archived_at       TIMESTAMPTZ,

    PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

CREATE INDEX IF NOT EXISTS raw_ingest_events_market_time_idx
    ON raw_ingest_events (market_ticker, received_at);

CREATE INDEX IF NOT EXISTS raw_ingest_events_stream_seq_idx
    ON raw_ingest_events (session_id, stream_id, seq);

CREATE INDEX IF NOT EXISTS raw_ingest_events_channel_time_idx
    ON raw_ingest_events (channel, received_at);


-- ---------------------------------------------------------------------------
-- Partition maintenance
--
-- Serialised by advisory lock 81726391 so overlapping Vercel workers cannot
-- race to create the same partition. The lock is transaction-scoped, so it is
-- released even if the call fails.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION raw_ingest_partition_name(day date)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT 'raw_ingest_events_' || to_char(day, 'YYYY_MM_DD');
$$;


CREATE OR REPLACE FUNCTION ensure_raw_ingest_partitions(
    days_ahead  integer DEFAULT 7,
    days_behind integer DEFAULT 1
)
RETURNS TABLE (partition_name text, day date, created boolean)
LANGUAGE plpgsql
AS $$
DECLARE
    d            date;
    today_utc    date := (now() AT TIME ZONE 'UTC')::date;
    pname        text;
    did_create   boolean;
BEGIN
    PERFORM pg_advisory_xact_lock(81726391);

    FOR d IN
        SELECT generate_series(
            today_utc - make_interval(days => days_behind),
            today_utc + make_interval(days => days_ahead),
            interval '1 day'
        )::date
    LOOP
        pname := raw_ingest_partition_name(d);

        IF to_regclass(format('public.%I', pname)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF raw_ingest_events '
                || 'FOR VALUES FROM (%L) TO (%L)',
                pname,
                d::timestamptz,
                (d + 1)::timestamptz
            );
            did_create := true;
        ELSE
            did_create := false;
        END IF;

        partition_name := pname;
        day            := d;
        created        := did_create;
        RETURN NEXT;
    END LOOP;
END;
$$;


-- Number of FULL future days covered by contiguous partitions, counting from
-- today (UTC). Today covered but not tomorrow => 0. Surfaced as the
-- partitions_ahead health metric:
--   >= 3 healthy | 2 warning | 1 critical | 0 collector at risk
CREATE OR REPLACE FUNCTION raw_ingest_partitions_ahead()
RETURNS integer
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    today_utc date := (now() AT TIME ZONE 'UTC')::date;
    n         integer := 0;
BEGIN
    -- If today itself is missing, we are already broken.
    IF to_regclass(format('public.%I', raw_ingest_partition_name(today_utc))) IS NULL THEN
        RETURN -1;
    END IF;

    WHILE to_regclass(
        format('public.%I', raw_ingest_partition_name(today_utc + (n + 1)))
    ) IS NOT NULL LOOP
        n := n + 1;
        IF n > 400 THEN
            EXIT;
        END IF;
    END LOOP;

    RETURN n;
END;
$$;


-- Inventory of attached daily partitions with their bounds and row counts.
-- Drives the archive worker (archive whole partitions, never arbitrary id
-- ranges) and the retention job.
CREATE OR REPLACE FUNCTION raw_ingest_partition_inventory()
RETURNS TABLE (
    partition_name  text,
    partition_start timestamptz,
    partition_end   timestamptz,
    is_complete     boolean
)
LANGUAGE sql STABLE
AS $$
    SELECT
        c.relname::text,
        lower_bound.v,
        upper_bound.v,
        upper_bound.v <= now()
    FROM pg_class c
    JOIN pg_inherits i         ON i.inhrelid = c.oid
    JOIN pg_class parent       ON parent.oid = i.inhparent
    CROSS JOIN LATERAL (
        SELECT (regexp_match(
            pg_get_expr(c.relpartbound, c.oid),
            'FROM \(''([^'']+)''\)'
        ))[1]::timestamptz AS v
    ) AS lower_bound
    CROSS JOIN LATERAL (
        SELECT (regexp_match(
            pg_get_expr(c.relpartbound, c.oid),
            'TO \(''([^'']+)''\)'
        ))[1]::timestamptz AS v
    ) AS upper_bound
    WHERE parent.relname = 'raw_ingest_events'
    ORDER BY lower_bound.v;
$$;
