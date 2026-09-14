-- ===========================================================================
-- 0018  Better-priced depth on queue observations
--
-- Kalshi defines queue position as the contracts that must be matched before
-- an order can fill under price-time priority. That is NOT the same as the
-- contracts at the order's own price: anything resting at a BETTER price is
-- also ahead of it.
--
-- The first calibration run measured only same-price displayed size and found
-- 20 of 24 queue moves unexplained. A probe that does not reprice starts at
-- the touch and stays there while the market moves, so better-priced liquidity
-- appearing and vanishing ahead of it will move its queue position without
-- anything happening at its own level at all.
--
-- These columns record the full ahead-of-us quantity at poll time, so the
-- hypothesis can be tested prospectively instead of only reconstructed.
-- ===========================================================================

ALTER TABLE calibration_queue_observations
    ADD COLUMN IF NOT EXISTS better_depth       NUMERIC(24, 6),
    ADD COLUMN IF NOT EXISTS better_levels      INTEGER,
    ADD COLUMN IF NOT EXISTS total_public_ahead NUMERIC(24, 6),
    ADD COLUMN IF NOT EXISTS ticks_from_touch   INTEGER;

ALTER TABLE calibration_probes
    ADD COLUMN IF NOT EXISTS better_depth_at_entry NUMERIC(24, 6);

COMMENT ON COLUMN calibration_queue_observations.better_depth IS
    'Contracts resting at prices BETTER than ours on our own ladder. Ahead of '
    'us under price-time priority even though none of it is at our level.';

COMMENT ON COLUMN calibration_queue_observations.total_public_ahead IS
    'better_depth + displayed_level_size: the public quantity that should '
    'approximate the exchange-reported queue position, if queue position is '
    'measured over the whole ladder rather than one level.';

COMMENT ON COLUMN calibration_queue_observations.ticks_from_touch IS
    'Cents between our resting price and the current touch on our side. Zero '
    'at entry by construction; grows as the market moves away from a probe '
    'that deliberately does not reprice.';
