-- ===========================================================================
-- 0017  Execution calibration
--
-- The dataset that turns market-by-PRICE data into a believable FIFO
-- approximation.
--
-- Every other fill model in this repository is a guess about where a resting
-- order sits in a queue we cannot see. Kalshi will tell us -- but only about
-- orders that are actually resting on the exchange. So these tables record
-- real one-contract probes and, beside them, what each simulated fill model
-- said would have happened to the same order at the same instant.
--
-- Three properties of this schema are load-bearing:
--
--   1. A queue observation is an INTERVAL, not an instant. It is a REST
--      round trip, so the true measurement time lies somewhere in
--      [poll_send_ts, poll_receive_ts]. Both are stored and no midpoint is
--      manufactured, because at a 500 ms poll interval a 40 ms round trip is
--      a real fraction of the sampling period.
--
--   2. Non-fills are kept. A probe that entered behind 400 contracts, watched
--      the queue fall to 220 over two minutes and never filled is one of the
--      most informative rows in the table. Retaining only fills would train
--      the model on the conditions under which we chose easy fills.
--
--   3. Timing is measured around the narrowest possible span. These numbers
--      are meant to replace the arbitrary 50/100/250 ms latency settings in
--      the backtester, so they have to be believable.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS calibration_runs (
    run_id              UUID PRIMARY KEY,
    dataset_id          TEXT        NOT NULL,

    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ,
    /* completed | killed | crashed | interrupted */
    end_reason          TEXT,
    end_detail          TEXT,

    git_commit_sha      TEXT,
    kalshi_env          TEXT        NOT NULL,

    -- The risk envelope actually in force. A dataset cannot be interpreted
    -- without knowing what the experiment was allowed to do.
    envelope            JSONB       NOT NULL,
    -- Exchange-side runaway guard, when one was established.
    order_group_id      TEXT,

    probes_attempted    INTEGER     NOT NULL DEFAULT 0,
    probes_placed       INTEGER     NOT NULL DEFAULT 0,
    probes_filled       INTEGER     NOT NULL DEFAULT 0,
    contracts_filled    NUMERIC(24, 6) NOT NULL DEFAULT 0,

    CONSTRAINT calibration_runs_env_chk CHECK (kalshi_env IN ('production', 'demo'))
);


CREATE TABLE IF NOT EXISTS calibration_probes (
    probe_id                 UUID PRIMARY KEY,
    run_id                   UUID        NOT NULL REFERENCES calibration_runs (run_id),

    market_ticker            TEXT        NOT NULL,
    series_ticker            TEXT,
    event_ticker             TEXT,

    -- Which stratum this probe was drawn from. Rotation across these is what
    -- stops the dataset describing only the most liquid contract.
    depth_stratum            TEXT,
    flow_stratum             TEXT,
    -- 'bid' or 'ask'. Chosen by coin flip, not by where we expected a fill.
    probe_side               TEXT        NOT NULL,
    planned_dwell_ms         INTEGER     NOT NULL,

    -- ---- decision -------------------------------------------------------
    decision_ts              TIMESTAMPTZ NOT NULL,
    decision_ts_ms           BIGINT      NOT NULL,
    book_seq_at_decision     BIGINT,
    book_hash_at_decision    TEXT,
    decision_bid             NUMERIC(12, 6),
    decision_ask             NUMERIC(12, 6),
    decision_bid_size        NUMERIC(24, 6),
    decision_ask_size        NUMERIC(24, 6),
    decision_mid             NUMERIC(12, 6),
    decision_imbalance_1     NUMERIC(18, 8),
    decision_imbalance_3     NUMERIC(18, 8),
    -- Displayed size at the level we joined: the queue we expect to be behind.
    displayed_size_at_entry  NUMERIC(24, 6),

    -- ---- the order ------------------------------------------------------
    client_order_id          TEXT        NOT NULL UNIQUE,
    order_id                 TEXT,
    order_side               TEXT        NOT NULL,
    order_action             TEXT        NOT NULL,
    price_cents              INTEGER     NOT NULL,
    yes_price                NUMERIC(12, 6) NOT NULL,
    quantity                 NUMERIC(24, 6) NOT NULL,
    expiration_ts            BIGINT,

    -- ---- submission timing ----------------------------------------------
    http_send_ts_ms          BIGINT,
    http_ack_ts_ms           BIGINT,
    submit_latency_ms        INTEGER,
    http_status              INTEGER,
    -- First private-feed message referring to this order.
    private_ack_ts_ms        BIGINT,

    -- ---- queue at entry --------------------------------------------------
    initial_queue_position   NUMERIC(24, 6),
    initial_queue_send_ts_ms BIGINT,
    initial_queue_recv_ts_ms BIGINT,

    -- ---- cancellation ----------------------------------------------------
    cancel_decision_ts_ms    BIGINT,
    cancel_send_ts_ms        BIGINT,
    cancel_ack_ts_ms         BIGINT,
    cancel_latency_ms        INTEGER,

    -- ---- fill ------------------------------------------------------------
    fill_exchange_ts_ms      BIGINT,
    fill_receive_ts_ms       BIGINT,
    fill_price               NUMERIC(12, 6),
    fill_quantity            NUMERIC(24, 6),
    -- What the exchange ACTUALLY charged, not what a model computed.
    fill_fee                 NUMERIC(12, 6),
    fill_queue_before        NUMERIC(24, 6),

    -- ---- outcome ---------------------------------------------------------
    /* placed | filled | cancelled | expired | rejected | ambiguous | aborted */
    terminal_state           TEXT,
    terminal_at              TIMESTAMPTZ,
    reject_reason            TEXT,
    /*
     * A probe that rested and never filled. Censored, not failed: it bounds
     * the fill time from below and is exactly the observation a fill-only
     * dataset would be missing.
     */
    censored                 BOOLEAN     NOT NULL DEFAULT false,
    notes                    TEXT,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calibration_probes_run_idx
    ON calibration_probes (run_id, decision_ts);
CREATE INDEX IF NOT EXISTS calibration_probes_market_idx
    ON calibration_probes (market_ticker, decision_ts DESC);
CREATE INDEX IF NOT EXISTS calibration_probes_order_idx
    ON calibration_probes (order_id) WHERE order_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS calibration_queue_observations (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    probe_id                 UUID        NOT NULL REFERENCES calibration_probes (probe_id),
    seq_no                   INTEGER     NOT NULL,

    -- The measurement INTERVAL. There is no single instant at which a REST
    -- queue position is true, and inventing one would let a 40 ms round trip
    -- be treated as exact against a 500 ms sampling grid.
    poll_send_ts_ms          BIGINT      NOT NULL,
    poll_receive_ts_ms       BIGINT      NOT NULL,
    time_since_entry_ms      BIGINT      NOT NULL,

    -- What the exchange said.
    queue_position           NUMERIC(24, 6),

    -- What our own book reconstruction said at the same moment.
    displayed_level_size     NUMERIC(24, 6),
    best_bid                 NUMERIC(12, 6),
    best_ask                 NUMERIC(12, 6),
    best_bid_size            NUMERIC(24, 6),
    best_ask_size            NUMERIC(24, 6),
    imbalance_1              NUMERIC(18, 8),
    imbalance_3              NUMERIC(18, 8),

    -- Cumulative since the order rested, at OUR price level. These three are
    -- the right-hand side of the model being tested:
    --     dQ_hat = executed + alpha * removed
    cum_executed_at_price    NUMERIC(24, 6) NOT NULL DEFAULT 0,
    cum_removed_at_price     NUMERIC(24, 6) NOT NULL DEFAULT 0,
    cum_added_at_price       NUMERIC(24, 6) NOT NULL DEFAULT 0,
    cum_trades_at_price      INTEGER        NOT NULL DEFAULT 0,

    CONSTRAINT calibration_queue_obs_uniq UNIQUE (probe_id, seq_no)
);

CREATE INDEX IF NOT EXISTS calibration_queue_obs_probe_idx
    ON calibration_queue_observations (probe_id, seq_no);


CREATE TABLE IF NOT EXISTS calibration_counterfactuals (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    probe_id                 UUID        NOT NULL REFERENCES calibration_probes (probe_id),

    fill_model               TEXT        NOT NULL,
    fill_model_parameters    JSONB,

    -- What the model said would happen to the SAME order at the SAME instants.
    would_fill               BOOLEAN     NOT NULL,
    fill_time_ms             BIGINT,
    fill_reason              TEXT,
    modelled_queue_at_entry  NUMERIC(24, 6),
    modelled_queue_before_fill NUMERIC(24, 6),

    CONSTRAINT calibration_counterfactual_uniq UNIQUE (probe_id, fill_model)
);


-- Everything the calibration runner decided NOT to do, and why. A run that
-- placed three probes in an hour is only interpretable alongside the reasons
-- it declined the rest.
CREATE TABLE IF NOT EXISTS calibration_events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id        UUID        NOT NULL REFERENCES calibration_runs (run_id),
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* blocked | killed | ambiguous | reconciled | warning | info */
    kind          TEXT        NOT NULL,
    reason        TEXT        NOT NULL,
    market_ticker TEXT,
    detail        JSONB
);

CREATE INDEX IF NOT EXISTS calibration_events_run_idx ON calibration_events (run_id, at DESC);

COMMENT ON TABLE calibration_probes IS
    'One real one-contract post-only probe. Retained whether or not it filled: '
    'a censored non-fill bounds the fill time from below and is exactly what a '
    'fill-only dataset would be missing.';

COMMENT ON TABLE calibration_queue_observations IS
    'Exchange-reported queue position over the life of a probe, paired with our '
    'own book reconstruction. The measurement is an interval, not an instant.';
