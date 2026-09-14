import type { Sql } from '@/src/persistence/db';

/**
 * Reading the calibration dataset.
 *
 * Three questions, in the order they should be asked:
 *
 *   1. How long do our own messages actually take? That replaces the arbitrary
 *      0/50/100/250 ms latency sweep in the backtester with measurements.
 *   2. Where does each fill model disagree with reality? Not "does it make
 *      money" -- false positives, false negatives and fill-time error, against
 *      the same orders at the same instants.
 *   3. How does the true queue move, compared with what the visible book says?
 *      That is the alpha in dQ = executed + alpha * removed.
 *
 * Everything here reads; nothing fits a model. A parameter fitted on a handful
 * of probes would be a number with a confidence interval wider than its own
 * value, and the point of reporting the sample size beside every figure is to
 * make that impossible to forget.
 */

export interface LatencySummary {
  operation: string;
  n: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export async function latencyDistribution(sql: Sql, runId?: string): Promise<LatencySummary[]> {
  // Only probes that actually reached the exchange. A rejected create has no
  // round trip, and early runs wrote a zero for it, which dragged the median
  // to nothing.
  const scope = runId
    ? sql`AND p.run_id = ${runId} AND p.order_id IS NOT NULL`
    : sql`AND p.order_id IS NOT NULL`;
  const rows = (await sql`
    SELECT g.operation, g.n, g.p50, g.p90, g.p95, g.p99, g.mx FROM (
      SELECT 'submit' AS operation,
             count(*) AS n,
             percentile_disc(0.50) WITHIN GROUP (ORDER BY p.submit_latency_ms) AS p50,
             percentile_disc(0.90) WITHIN GROUP (ORDER BY p.submit_latency_ms) AS p90,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY p.submit_latency_ms) AS p95,
             percentile_disc(0.99) WITHIN GROUP (ORDER BY p.submit_latency_ms) AS p99,
             max(p.submit_latency_ms) AS mx
        FROM calibration_probes p
       WHERE p.submit_latency_ms IS NOT NULL ${scope}
      UNION ALL
      SELECT 'cancel',
             count(*),
             percentile_disc(0.50) WITHIN GROUP (ORDER BY p.cancel_latency_ms),
             percentile_disc(0.90) WITHIN GROUP (ORDER BY p.cancel_latency_ms),
             percentile_disc(0.95) WITHIN GROUP (ORDER BY p.cancel_latency_ms),
             percentile_disc(0.99) WITHIN GROUP (ORDER BY p.cancel_latency_ms),
             max(p.cancel_latency_ms)
        FROM calibration_probes p
       WHERE p.cancel_latency_ms IS NOT NULL ${scope}
      UNION ALL
      -- How long after the HTTP ack the private feed first mentions the order.
      SELECT 'private_ack_after_http',
             count(*),
             percentile_disc(0.50) WITHIN GROUP (ORDER BY p.private_ack_ts_ms - p.http_ack_ts_ms),
             percentile_disc(0.90) WITHIN GROUP (ORDER BY p.private_ack_ts_ms - p.http_ack_ts_ms),
             percentile_disc(0.95) WITHIN GROUP (ORDER BY p.private_ack_ts_ms - p.http_ack_ts_ms),
             percentile_disc(0.99) WITHIN GROUP (ORDER BY p.private_ack_ts_ms - p.http_ack_ts_ms),
             max(p.private_ack_ts_ms - p.http_ack_ts_ms)
        FROM calibration_probes p
       WHERE p.private_ack_ts_ms IS NOT NULL AND p.http_ack_ts_ms IS NOT NULL ${scope}
      UNION ALL
      -- How long before the exchange will report a new order's queue position.
      SELECT 'queue_visible_after_ack',
             count(*),
             percentile_disc(0.50) WITHIN GROUP (ORDER BY p.initial_queue_recv_ts_ms - p.http_ack_ts_ms),
             percentile_disc(0.90) WITHIN GROUP (ORDER BY p.initial_queue_recv_ts_ms - p.http_ack_ts_ms),
             percentile_disc(0.95) WITHIN GROUP (ORDER BY p.initial_queue_recv_ts_ms - p.http_ack_ts_ms),
             percentile_disc(0.99) WITHIN GROUP (ORDER BY p.initial_queue_recv_ts_ms - p.http_ack_ts_ms),
             max(p.initial_queue_recv_ts_ms - p.http_ack_ts_ms)
        FROM calibration_probes p
       WHERE p.initial_queue_recv_ts_ms IS NOT NULL AND p.http_ack_ts_ms IS NOT NULL ${scope}
    ) AS g WHERE g.n > 0 ORDER BY g.operation
  `) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    operation: String(r.operation),
    n: Number(r.n),
    p50: r.p50 === null ? null : Number(r.p50),
    p90: r.p90 === null ? null : Number(r.p90),
    p95: r.p95 === null ? null : Number(r.p95),
    p99: r.p99 === null ? null : Number(r.p99),
    max: r.mx === null ? null : Number(r.mx),
  }));
}

export interface ModelAgreement {
  fillModel: string;
  probes: number;
  /** Model said fill, reality filled. */
  truePositive: number;
  /** Model said fill, reality did not. The expensive error for a backtest. */
  falsePositive: number;
  /** Model said no fill, reality filled. */
  falseNegative: number;
  trueNegative: number;
  /** Mean absolute difference in fill time, over probes both agreed filled. */
  meanFillTimeErrorMs: number | null;
  fillTimeComparisons: number;
  /** Mean modelled queue-at-entry minus the exchange's own reading. */
  meanQueueBiasAtEntry: number | null;
  queueComparisons: number;
}

/**
 * Where each fill model disagrees with what actually happened.
 *
 * A false POSITIVE is the expensive one. It is a backtest reporting a fill
 * that would not have occurred, which inflates volume, spread capture and PnL
 * all at once and does so silently.
 */
export async function modelAgreement(sql: Sql, runId?: string): Promise<ModelAgreement[]> {
  const scope = runId ? sql`AND p.run_id = ${runId}` : sql``;
  const rows = (await sql`
    SELECT c.fill_model,
           count(*) AS probes,
           count(*) FILTER (WHERE c.would_fill AND p.terminal_state = 'filled') AS tp,
           count(*) FILTER (WHERE c.would_fill AND p.terminal_state <> 'filled') AS fp,
           count(*) FILTER (WHERE NOT c.would_fill AND p.terminal_state = 'filled') AS fn,
           count(*) FILTER (WHERE NOT c.would_fill AND p.terminal_state <> 'filled') AS tn,
           avg(abs(c.fill_time_ms - (p.fill_receive_ts_ms - p.http_ack_ts_ms)))
             FILTER (WHERE c.would_fill AND p.terminal_state = 'filled'
                       AND c.fill_time_ms IS NOT NULL AND p.fill_receive_ts_ms IS NOT NULL)
             AS fill_time_err,
           count(*) FILTER (WHERE c.would_fill AND p.terminal_state = 'filled'
                              AND c.fill_time_ms IS NOT NULL AND p.fill_receive_ts_ms IS NOT NULL)
             AS fill_time_n,
           avg(c.modelled_queue_at_entry - p.initial_queue_position)
             FILTER (WHERE c.modelled_queue_at_entry IS NOT NULL
                       AND p.initial_queue_position IS NOT NULL) AS queue_bias,
           count(*) FILTER (WHERE c.modelled_queue_at_entry IS NOT NULL
                              AND p.initial_queue_position IS NOT NULL) AS queue_n
      FROM calibration_counterfactuals c
      JOIN calibration_probes p ON p.probe_id = c.probe_id
     WHERE p.order_id IS NOT NULL ${scope}
     GROUP BY c.fill_model
     ORDER BY c.fill_model
  `) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    fillModel: String(r.fill_model),
    probes: Number(r.probes),
    truePositive: Number(r.tp),
    falsePositive: Number(r.fp),
    falseNegative: Number(r.fn),
    trueNegative: Number(r.tn),
    meanFillTimeErrorMs: r.fill_time_err === null ? null : Number(r.fill_time_err),
    fillTimeComparisons: Number(r.fill_time_n),
    meanQueueBiasAtEntry: r.queue_bias === null ? null : Number(r.queue_bias),
    queueComparisons: Number(r.queue_n),
  }));
}

export interface QueueStep {
  steps: number;
  /** Steps where the queue moved at all. */
  movingSteps: number;
  meanDeltaQ: number | null;
  meanExecuted: number | null;
  meanRemoved: number | null;
  /**
   * A naive least-squares alpha for dQ = executed + alpha * removed.
   *
   * Reported for orientation only. With a handful of probes the interval
   * around it is wider than the value, and the honest use of this number today
   * is to check that the pipeline produces one at all.
   */
  naiveAlpha: number | null;
  /** Steps where the queue moved with no executions and no removals seen. */
  unexplainedSteps: number;
}

/**
 * How the true queue moved against what the visible book showed.
 *
 * The residual after subtracting executed volume is what alpha is supposed to
 * explain. An UNEXPLAINED step -- the queue moved while our book saw neither a
 * trade nor a withdrawal at that price -- is the interesting failure, because
 * it means market-by-price data is missing something the model will never
 * capture no matter how alpha is fitted.
 */
export async function queueSteps(sql: Sql, runId?: string): Promise<QueueStep> {
  const scope = runId ? sql`AND p.run_id = ${runId}` : sql``;
  const rows = (await sql`
    SELECT count(*) AS steps,
           count(*) FILTER (WHERE s.dq <> 0) AS moving,
           avg(s.dq) AS mean_dq,
           avg(s.dexec) AS mean_exec,
           avg(s.drem) AS mean_rem,
           count(*) FILTER (WHERE s.dq <> 0 AND s.dexec = 0 AND s.drem = 0) AS unexplained,
           sum((s.dq - s.dexec) * s.drem) AS num,
           sum(s.drem * s.drem) AS den
      FROM (
        SELECT lag(o.queue_position) OVER w - o.queue_position AS dq,
               o.cum_executed_at_price - lag(o.cum_executed_at_price) OVER w AS dexec,
               o.cum_removed_at_price - lag(o.cum_removed_at_price) OVER w AS drem
          FROM calibration_queue_observations o
          JOIN calibration_probes p ON p.probe_id = o.probe_id
         WHERE o.queue_position IS NOT NULL ${scope}
        WINDOW w AS (PARTITION BY o.probe_id ORDER BY o.seq_no)
      ) AS s
     WHERE s.dq IS NOT NULL
  `) as unknown as Record<string, unknown>[];

  const r = rows[0]!;
  const num = r.num === null ? null : Number(r.num);
  const den = r.den === null ? null : Number(r.den);
  return {
    steps: Number(r.steps),
    movingSteps: Number(r.moving),
    meanDeltaQ: r.mean_dq === null ? null : Number(r.mean_dq),
    meanExecuted: r.mean_exec === null ? null : Number(r.mean_exec),
    meanRemoved: r.mean_rem === null ? null : Number(r.mean_rem),
    naiveAlpha: num !== null && den !== null && den > 0 ? num / den : null,
    unexplainedSteps: Number(r.unexplained),
  };
}

export interface CensoringSummary {
  placed: number;
  filled: number;
  censored: number;
  /** Total resting time across censored probes, in seconds. */
  censoredRestingSeconds: number | null;
  byDwell: { dwellMs: number; placed: number; filled: number }[];
}

export async function censoring(sql: Sql, runId?: string): Promise<CensoringSummary> {
  const scope = runId ? sql`AND p.run_id = ${runId}` : sql``;
  const totals = (await sql`
    SELECT count(*) AS placed,
           count(*) FILTER (WHERE p.terminal_state = 'filled') AS filled,
           count(*) FILTER (WHERE p.censored) AS censored,
           sum(
             CASE WHEN p.censored AND p.cancel_ack_ts_ms IS NOT NULL AND p.http_ack_ts_ms IS NOT NULL
                  THEN (p.cancel_ack_ts_ms - p.http_ack_ts_ms) / 1000.0 END
           ) AS resting_seconds
      FROM calibration_probes p WHERE p.order_id IS NOT NULL ${scope}
  `) as unknown as Record<string, unknown>[];

  const byDwell = (await sql`
    SELECT p.planned_dwell_ms,
           count(*) AS placed,
           count(*) FILTER (WHERE p.terminal_state = 'filled') AS filled
      FROM calibration_probes p WHERE p.order_id IS NOT NULL ${scope}
     GROUP BY p.planned_dwell_ms ORDER BY p.planned_dwell_ms
  `) as unknown as Record<string, unknown>[];

  const t = totals[0]!;
  return {
    placed: Number(t.placed),
    filled: Number(t.filled),
    censored: Number(t.censored),
    censoredRestingSeconds: t.resting_seconds === null ? null : Number(t.resting_seconds),
    byDwell: byDwell.map((r) => ({
      dwellMs: Number(r.planned_dwell_ms),
      placed: Number(r.placed),
      filled: Number(r.filled),
    })),
  };
}
