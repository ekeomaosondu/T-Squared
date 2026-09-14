-- ===========================================================================
-- 0016  sequence_gaps: a terminal status for gaps closed by a reconnect
--
-- A gap detected while a stream was live could only ever reach 'recovered' by
-- that same stream receiving replacement snapshots. When the stream instead
-- DIES -- a reconnect, a deploy, a restart -- the in-memory recovery episode
-- was discarded and the row was left at 'detected' or 'recovering' forever.
--
-- The consequence was not a data problem but an alarm problem, which is worse
-- in its own way: the health check counted those rows as unrecovered for all
-- time, went CRITICAL, and stayed there. An alarm that is always on is not an
-- alarm, and the next real gap would have arrived to a red light nobody was
-- reading any more.
--
-- 'superseded' says exactly what happened, and deliberately does not say
-- "recovered":
--
--   the missed MESSAGES are gone and are never coming back
--   the BOOK was rebuilt from a fresh snapshot on the next stream
--   no further action is possible or useful
--
-- Replay already treats a new stream as a new epoch and surfaces the interval
-- as a capture gap, so a study still sees the hole. This status only stops the
-- operational signal from lying.
-- ===========================================================================

ALTER TABLE sequence_gaps DROP CONSTRAINT IF EXISTS sequence_gaps_status_chk;

ALTER TABLE sequence_gaps
    ADD CONSTRAINT sequence_gaps_status_chk CHECK (
        status IN ('detected', 'recovering', 'recovered', 'failed', 'superseded')
    );

COMMENT ON COLUMN sequence_gaps.status IS
    'detected -> recovering -> recovered is the normal path. failed means the '
    'replacement snapshots never arrived while the stream was still live. '
    'superseded means the stream ended first: the missed messages are lost, '
    'the book was rebuilt on a new stream, and nothing further can be done.';

-- Reconcile the rows that were already stranded. A gap on a stream that has
-- ended cannot reach any other terminal state, so leaving it open is not
-- caution, it is noise.
UPDATE sequence_gaps g
   SET status = 'superseded',
       notes  = coalesce(g.notes || ' | ', '') ||
                'closed by migration 0016: the stream ended before recovery completed'
  FROM subscription_streams s
 WHERE s.stream_id = g.stream_id
   AND s.ended_at IS NOT NULL
   AND g.status IN ('detected', 'recovering', 'failed');
