-- ===========================================================================
-- 0010  Richer REST validation outcomes
--
-- A REST snapshot is built at an unobservable instant between our request and
-- our receipt of the response, so comparing it only against the book "now"
-- reports a mismatch on any actively traded market. `matched` alone therefore
-- understated correctness and would have driven unnecessary recoveries.
--
-- match_kind records which of four things actually happened:
--   match_current       REST agrees with the book as it stands
--   match_recent        REST agrees with a state the book genuinely held
--                       during the request window
--   mismatch_transient  no match, first observation; re-checked before acting
--   mismatch_confirmed  no match on an independent re-check -- actionable
--
-- Only mismatch_confirmed triggers recovery in the absence of a sequence gap
-- or an invariant violation.
-- ===========================================================================

ALTER TABLE book_validations
    ADD COLUMN IF NOT EXISTS match_kind        TEXT,
    ADD COLUMN IF NOT EXISTS matched_at_ms     BIGINT,
    ADD COLUMN IF NOT EXISTS matched_local_seq BIGINT,
    -- How many distinct historical book states were considered.
    ADD COLUMN IF NOT EXISTS states_considered INTEGER;

CREATE INDEX IF NOT EXISTS book_validations_match_kind_idx
    ON book_validations (match_kind, checked_at DESC);

-- Confirmed mismatches are the only ones worth alerting on.
CREATE INDEX IF NOT EXISTS book_validations_confirmed_idx
    ON book_validations (checked_at DESC)
    WHERE match_kind = 'mismatch_confirmed';
