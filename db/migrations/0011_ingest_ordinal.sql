-- ===========================================================================
-- 0011  ingest_ordinal -- explicit observation order
--
-- `id` is DATABASE/PROVENANCE identity, not exchange event ordering, and it is
-- assigned at flush time. It answers "which captured frame produced this
-- normalized row?" and nothing more. Relying on it to order events is exactly
-- the assumption that let an earlier bug reorder the raw log undetected.
--
-- ingest_ordinal is an in-process counter assigned SYNCHRONOUSLY at socket
-- receipt, before any asynchronous work, so it records the order in which this
-- collector process actually observed frames. It is monotonic within a session
-- and meaningless across sessions.
--
-- Ordering authority, most to least semantically useful:
--
--   exchange seq   >   ingest_ordinal   >   id
--
-- For order-book replay, ordering is (session_id, stream_id, seq) -- the
-- exchange's own sequence. For UNSEQUENCED channels (ticker), where no seq
-- exists, ingest_ordinal is the only principled ordering available.
-- ===========================================================================

ALTER TABLE raw_ingest_events
    ADD COLUMN IF NOT EXISTS ingest_ordinal BIGINT;

-- Observation order within a session. Also makes "did we drop a frame between
-- receipt and durability?" a checkable question: ordinals must be contiguous.
CREATE INDEX IF NOT EXISTS raw_ingest_events_session_ordinal_idx
    ON raw_ingest_events (session_id, ingest_ordinal);

COMMENT ON COLUMN raw_ingest_events.ingest_ordinal IS
    'In-process counter assigned synchronously at socket receipt. Monotonic '
    'within session_id; meaningless across sessions. Use exchange seq for '
    'sequenced channels and this for unsequenced ones. Never use id for ordering.';

COMMENT ON COLUMN raw_ingest_events.id IS
    'Provenance identity only, assigned at flush time. NOT event ordering.';
