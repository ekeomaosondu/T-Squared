-- ===========================================================================
-- 0012  Two defects found by fault-injected soak testing
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. A sid identifies one LIVE subscription, not one per session forever.
--
-- Kalshi assigns sids per connection starting from 1, so a reconnect within the
-- same session reissues sid 1..4. The previous index made that a unique
-- violation against the already-closed streams, which meant a reconnecting
-- collector could not record its new subscriptions at all.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS subscription_streams_session_sid_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_streams_live_sid_uniq
    ON subscription_streams (session_id, sid)
    WHERE sid IS NOT NULL AND ended_at IS NULL;

-- Historical lookup by sid stays cheap without asserting uniqueness.
CREATE INDEX IF NOT EXISTS subscription_streams_session_sid_idx
    ON subscription_streams (session_id, sid);


-- ---------------------------------------------------------------------------
-- 2. Ladder sample groups are now keyed deterministically.
--
-- sample_group_id used to be a random UUID. When a collector restarted, the
-- in-memory bucket dedupe reset while the row already existed in the database,
-- so the group INSERT hit its ON CONFLICT and did nothing -- and the child
-- samples, which referenced the NEW random id, violated the foreign key.
--
-- The id is now derived from (event_ticker, interval_ms, sampled_at), so
-- re-sampling the same bucket produces the same id: the group insert is a
-- genuine no-op and the children resolve against the existing parent.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN event_ladder_sample_groups.sample_group_id IS
    'Deterministic UUID derived from (event_ticker, interval_ms, sampled_at). '
    'Re-sampling a bucket is idempotent rather than an FK violation.';
