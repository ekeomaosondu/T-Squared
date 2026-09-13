-- ===========================================================================
-- 0004  Normalised market events
--
-- Price convention
-- ----------------
-- Kalshi quotes integer cents (1..99). These tables store DOLLARS as NUMERIC,
-- i.e. 0.420000 for 42c, matching the canonical book JSON and the 0..1
-- consistency assertions. The original integer cents are always recoverable
-- from raw_ingest_events.payload -- normalisation never loses the wire form.
--
-- Provenance
-- ----------
-- raw_event_id is a POINTER, not a foreign key. Raw rows are intentionally
-- dropped after the retention window while normalised rows may live for
-- months, so `raw_event_id = 91827364` means "this came from raw capture event
-- 91827364" -- which after archival lives in object storage -- and not
-- "Postgres guarantees that row still exists".
--
-- raw_event_received_at is carried alongside so a provenance lookup can prune
-- straight to the owning daily partition instead of probing every live one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Order-book snapshots
--
-- source:
--   ws_initial        first orderbook_snapshot after subscribing
--   ws_recovery       snapshot requested after a gap / integrity violation
--   local_materialized periodic sample of our reconstructed book
--   rest_validation   book fetched over REST for cross-checking
--   session_handoff   ownership boundary between two collector epochs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    snapshot_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    market_ticker         TEXT        NOT NULL,
    market_id             TEXT,

    session_id            UUID,
    stream_id             UUID,

    source                TEXT        NOT NULL,

    sid                   INTEGER,
    seq                   BIGINT,

    received_at           TIMESTAMPTZ NOT NULL,
    received_at_ms        BIGINT      NOT NULL,

    -- Raw exchange representation, preserved exactly: arrays of
    -- [price, size] pairs as canonical decimal strings, deterministically
    -- sorted price-descending. The YES-side bid/ask view is derived, never
    -- stored in place of this.
    yes_bids              JSONB       NOT NULL,
    no_bids               JSONB       NOT NULL,

    yes_level_count       INTEGER     NOT NULL,
    no_level_count        INTEGER     NOT NULL,

    best_yes_bid          NUMERIC(12, 6),
    best_yes_bid_size     NUMERIC(24, 6),

    best_no_bid           NUMERIC(12, 6),
    best_no_bid_size      NUMERIC(24, 6),

    -- Derived: 1 - best_no_bid.
    best_yes_ask          NUMERIC(12, 6),
    best_yes_ask_size     NUMERIC(24, 6),

    spread                NUMERIC(12, 6),
    mid                   NUMERIC(12, 6),

    state_hash            TEXT        NOT NULL,

    raw_event_id          BIGINT,
    raw_event_received_at TIMESTAMPTZ,

    CONSTRAINT orderbook_snapshots_source_chk CHECK (
        source IN ('ws_initial', 'ws_recovery', 'local_materialized',
                   'rest_validation', 'session_handoff')
    )
);

CREATE INDEX IF NOT EXISTS orderbook_snapshots_market_time_idx
    ON orderbook_snapshots (market_ticker, received_at DESC);

CREATE INDEX IF NOT EXISTS orderbook_snapshots_source_time_idx
    ON orderbook_snapshots (source, received_at DESC);

-- Replay entry point: "nearest usable snapshot at or before T for this market".
CREATE INDEX IF NOT EXISTS orderbook_snapshots_replay_idx
    ON orderbook_snapshots (market_ticker, received_at_ms DESC)
    WHERE source IN ('ws_initial', 'ws_recovery', 'session_handoff', 'local_materialized');

CREATE INDEX IF NOT EXISTS orderbook_snapshots_session_idx
    ON orderbook_snapshots (session_id, stream_id, seq);


-- ---------------------------------------------------------------------------
-- Order-book deltas: one row per WebSocket delta, applied or not.
--
-- A delta that could not be applied (negative post-count, invalid book) is
-- still recorded with applied = false and an apply_error. Quantities are never
-- clamped and the event is never dropped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orderbook_deltas (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    session_id            UUID        NOT NULL,
    stream_id             UUID        NOT NULL,

    market_ticker         TEXT        NOT NULL,
    market_id             TEXT,

    sid                   INTEGER,
    seq                   BIGINT      NOT NULL,

    exchange_ts_ms        BIGINT,
    exchange_ts           TIMESTAMPTZ,

    received_at           TIMESTAMPTZ NOT NULL,
    received_at_ms        BIGINT      NOT NULL,

    -- 'yes' | 'no' -- the raw exchange side, not a derived bid/ask label.
    side                  TEXT        NOT NULL,

    price                 NUMERIC(12, 6) NOT NULL,
    delta_count           NUMERIC(24, 6) NOT NULL,

    pre_count             NUMERIC(24, 6),
    post_count            NUMERIC(24, 6),

    -- insert | increase | decrease | delete | unknown
    level_action          TEXT,

    applied               BOOLEAN     NOT NULL,
    apply_error           TEXT,

    raw_event_id          BIGINT,
    raw_event_received_at TIMESTAMPTZ,

    CONSTRAINT orderbook_deltas_side_chk CHECK (side IN ('yes', 'no')),
    CONSTRAINT orderbook_deltas_action_chk CHECK (
        level_action IS NULL
        OR level_action IN ('insert', 'increase', 'decrease', 'delete', 'unknown')
    )
);

CREATE INDEX IF NOT EXISTS orderbook_deltas_market_exchange_ts_idx
    ON orderbook_deltas (market_ticker, exchange_ts_ms);

CREATE INDEX IF NOT EXISTS orderbook_deltas_market_received_idx
    ON orderbook_deltas (market_ticker, received_at);

-- Replay applies deltas in (session, stream, seq) order. Unique because within
-- one subscription stream a sequence number identifies exactly one delta;
-- a repeat is a transport duplicate and is rejected here while still being
-- preserved in raw_ingest_events.
CREATE UNIQUE INDEX IF NOT EXISTS orderbook_deltas_stream_seq_uniq
    ON orderbook_deltas (session_id, stream_id, seq);


-- ---------------------------------------------------------------------------
-- Public trades. Exchange-supplied aggressor information is preserved verbatim
-- and never replaced with an inferred direction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public_trades (
    trade_id              TEXT PRIMARY KEY,

    session_id            UUID,
    stream_id             UUID,

    market_ticker         TEXT        NOT NULL,

    sid                   INTEGER,
    seq                   BIGINT,

    yes_price             NUMERIC(12, 6),
    no_price              NUMERIC(12, 6),

    count                 NUMERIC(24, 6) NOT NULL,

    taker_side            TEXT,
    taker_outcome_side    TEXT,
    taker_book_side       TEXT,

    is_block_trade        BOOLEAN,

    exchange_ts_ms        BIGINT,
    exchange_ts           TIMESTAMPTZ,

    received_at           TIMESTAMPTZ NOT NULL,
    received_at_ms        BIGINT      NOT NULL,

    raw_event_id          BIGINT,
    raw_event_received_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS public_trades_market_exchange_ts_idx
    ON public_trades (market_ticker, exchange_ts_ms);

CREATE INDEX IF NOT EXISTS public_trades_market_received_idx
    ON public_trades (market_ticker, received_at);


-- ---------------------------------------------------------------------------
-- Ticker updates. Also used as an INDEPENDENT sanity check against the BBO we
-- reconstruct from the delta stream.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticker_updates (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    session_id            UUID,

    market_ticker         TEXT        NOT NULL,
    market_id             TEXT,

    price                 NUMERIC(12, 6),

    yes_bid               NUMERIC(12, 6),
    yes_ask               NUMERIC(12, 6),

    yes_bid_size          NUMERIC(24, 6),
    yes_ask_size          NUMERIC(24, 6),

    last_trade_size       NUMERIC(24, 6),

    volume                NUMERIC(24, 6),
    open_interest         NUMERIC(24, 6),

    dollar_volume         NUMERIC(24, 6),
    dollar_open_interest  NUMERIC(24, 6),

    exchange_ts_ms        BIGINT,
    exchange_ts           TIMESTAMPTZ,

    received_at           TIMESTAMPTZ NOT NULL,
    received_at_ms        BIGINT      NOT NULL,

    raw_event_id          BIGINT,
    raw_event_received_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ticker_updates_market_received_idx
    ON ticker_updates (market_ticker, received_at DESC);

CREATE INDEX IF NOT EXISTS ticker_updates_market_exchange_ts_idx
    ON ticker_updates (market_ticker, exchange_ts_ms);


-- ---------------------------------------------------------------------------
-- Market lifecycle events. created / close_date_updated / metadata_updated /
-- determined / settled each queue an immediate metadata refresh.
-- ---------------------------------------------------------------------------
-- event_type values observed on the market_lifecycle_v2 channel:
--   created | activated | deactivated | close_date_updated | determined
--   settled | metadata_updated | price_level_structure_updated
-- plus event_lifecycle / event_fee_update messages on the same channel.
-- Deliberately NOT constrained by a CHECK: an unrecognised lifecycle type must
-- be recorded, not rejected.
CREATE TABLE IF NOT EXISTS market_lifecycle_events (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    session_id            UUID,

    event_type            TEXT        NOT NULL,

    market_ticker         TEXT,
    event_ticker          TEXT,

    exchange_ts_ms        BIGINT,
    received_at           TIMESTAMPTZ NOT NULL,

    payload               JSONB       NOT NULL,

    raw_event_id          BIGINT,
    raw_event_received_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS market_lifecycle_events_market_idx
    ON market_lifecycle_events (market_ticker, received_at DESC);

CREATE INDEX IF NOT EXISTS market_lifecycle_events_type_idx
    ON market_lifecycle_events (event_type, received_at DESC);
