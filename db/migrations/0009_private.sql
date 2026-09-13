-- ===========================================================================
-- 0009  Optional private trading data
--
-- Disabled by default (capture.privateOrders / capture.privateFills = false).
-- The market-data recorder never requires these to operate. They exist so that
-- when a live maker runs, our quote, queue state, the book, trade flow, the
-- fill and post-fill adverse selection can all be aligned on one timeline.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS user_order_updates (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    session_id            UUID,
    stream_id             UUID,

    order_id              TEXT,
    client_order_id       TEXT,

    market_ticker         TEXT        NOT NULL,

    action                TEXT,
    side                  TEXT,
    order_type            TEXT,
    status                TEXT,

    price                 NUMERIC(12, 6),

    original_count        NUMERIC(24, 6),
    remaining_count       NUMERIC(24, 6),
    filled_count          NUMERIC(24, 6),

    -- Queue position when the exchange reports it; central to fill modelling.
    queue_position        NUMERIC(24, 6),

    exchange_ts_ms        BIGINT,
    exchange_ts           TIMESTAMPTZ,

    received_at           TIMESTAMPTZ NOT NULL,
    received_at_ms        BIGINT      NOT NULL,

    payload               JSONB       NOT NULL,

    raw_event_id          BIGINT,
    raw_event_received_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS user_order_updates_market_received_idx
    ON user_order_updates (market_ticker, received_at DESC);

CREATE INDEX IF NOT EXISTS user_order_updates_order_idx
    ON user_order_updates (order_id, received_at DESC);


CREATE TABLE IF NOT EXISTS user_fills (
    fill_id               TEXT PRIMARY KEY,

    session_id            UUID,
    stream_id             UUID,

    order_id              TEXT,
    trade_id              TEXT,

    market_ticker         TEXT        NOT NULL,

    side                  TEXT,
    action                TEXT,

    is_taker              BOOLEAN,

    yes_price             NUMERIC(12, 6),
    no_price              NUMERIC(12, 6),

    count                 NUMERIC(24, 6) NOT NULL,

    exchange_ts_ms        BIGINT,
    exchange_ts           TIMESTAMPTZ,

    received_at           TIMESTAMPTZ NOT NULL,
    received_at_ms        BIGINT      NOT NULL,

    payload               JSONB       NOT NULL,

    raw_event_id          BIGINT,
    raw_event_received_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS user_fills_market_received_idx
    ON user_fills (market_ticker, received_at DESC);
