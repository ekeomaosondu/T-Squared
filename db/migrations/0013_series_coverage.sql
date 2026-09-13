-- ===========================================================================
-- 0013  Series coverage
--
-- A configured series that has never listed an active market looks identical
-- to a series the recorder is silently failing on. KXLOWNY and KXLOWLAX are in
-- the capture universe but currently have no open markets, so the distinction
-- matters from day one.
--
-- When such a series finally lists, its first appearance is worth treating as a
-- small production test: discovery, subscription, initial snapshot,
-- synchronized ladder sampling, REST validation and replay all exercised for
-- the first time on that series.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS series_coverage (
    series_ticker         TEXT PRIMARY KEY,

    -- configured | awaiting_first_market | exercised
    status                TEXT        NOT NULL DEFAULT 'configured',

    first_seen_at         TIMESTAMPTZ,
    -- When a market for this series was first actually subscribed.
    first_subscribed_at   TIMESTAMPTZ,
    -- When the first order-book snapshot for this series was captured.
    first_snapshot_at     TIMESTAMPTZ,
    -- When the first delta was applied to one of its books.
    first_delta_at        TIMESTAMPTZ,
    -- When a synchronized ladder sample first covered it.
    first_ladder_at       TIMESTAMPTZ,

    markets_seen          INTEGER     NOT NULL DEFAULT 0,
    last_market_ticker    TEXT,

    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT series_coverage_status_chk CHECK (
        status IN ('configured', 'awaiting_first_market', 'exercised')
    )
);

CREATE INDEX IF NOT EXISTS series_coverage_status_idx ON series_coverage (status);
