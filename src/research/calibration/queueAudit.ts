import { Decimal, D, ZERO } from '@/src/book/decimal';
import { MarketBook } from '@/src/book/book';
import { depthAhead, ticksFromTouch, type LadderSide } from '@/src/book/ladder';
import type { Sql } from '@/src/persistence/db';
import { logger } from '@/src/logging/logger';

/**
 * What does `queue_position_fp` actually measure?
 *
 * The first calibration run compared it against same-price displayed size and
 * left 20 of 24 queue moves unexplained. Two hypotheses are worth testing
 * before another probe is placed, because both change what the number means:
 *
 *   1. Queue position counts everything that must match before us, which under
 *      price-time priority includes depth at BETTER prices, not just our own
 *      level. A probe that never reprices sits still while the market moves,
 *      so better-priced liquidity appearing and vanishing in front of it moves
 *      its queue without anything happening at its own price.
 *
 *   2. The queue endpoint is a LAGGED view. A new order takes ~800 ms to
 *      appear in it at all, so a response received at t is unlikely to
 *      describe the book at t.
 *
 * This module tests both against data already collected, by rebuilding the
 * full ladder from the collector's own recorded deltas over each probe's life.
 * That reconstruction is the point of having a raw archive: the better-price
 * depth was never captured at poll time, and it does not need to have been.
 *
 * Nothing here fits a model. The output is a classification of where each
 * queue move came from, so that the residual worth modelling can be seen.
 */

export type MoveClass =
  | 'TRADE_EXPLAINED'
  | 'BETTER_LEVEL_EXPLAINED'
  | 'SAME_LEVEL_EXPLAINED'
  | 'POSSIBLE_TIMING_ALIAS'
  | 'STILL_UNEXPLAINED';

/** Contracts of disagreement below which a move counts as explained. */
export const EXPLAINED_TOLERANCE = 1;

export interface AuditOptions {
  runId?: string;
  /**
   * Lag applied before comparing the reported queue with the public book.
   *
   * The v0 audit measured this rather than assuming it: the endpoint is a
   * lagged view, concentrated at 400-800 ms. Applying it is what makes the
   * H0-versus-H1 comparison a test of the DEFINITION rather than a test of
   * whether we aligned the clocks.
   */
  appliedLagMs?: number;
  /** How far back a queue reading may be describing. See the file comment. */
  lagSearchStartMs?: number;
  lagSearchEndMs?: number;
  lagStepMs?: number;
}

export const AUDIT_DEFAULTS = {
  lagSearchStartMs: -500,
  lagSearchEndMs: 2500,
  lagStepMs: 100,
  /** Measured, not assumed: the v0 audit put the endpoint lag at 400-800 ms. */
  appliedLagMs: 500,
};

interface ProbeRow {
  probe_id: string;
  market_ticker: string;
  series_ticker: string | null;
  probe_side: LadderSide;
  yes_price: string;
  terminal_state: string;
  http_ack_ts_ms: string | null;
  cancel_ack_ts_ms: string | null;
  fill_receive_ts_ms: string | null;
}

interface ObsRow {
  probe_id: string;
  seq_no: number;
  poll_send_ts_ms: string;
  poll_receive_ts_ms: string;
  queue_position: string | null;
}

/** A point on the reconstructed ladder, from the recorder's own deltas. */
interface DepthPoint {
  atMs: number;
  better: Decimal;
  same: Decimal;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
}

export interface Transition {
  probeId: string;
  marketTicker: string;
  seriesTicker: string | null;
  side: LadderSide;
  terminalState: string;
  t0Ms: number;
  t1Ms: number;
  q0: number;
  q1: number;
  /** Positive means the queue advanced, i.e. contracts ahead went away. */
  deltaQ: number;
  sameT0: number;
  sameT1: number;
  betterT0: number;
  betterT1: number;
  deltaSame: number;
  deltaBetter: number;
  executedAhead: number;
  ticksT0: number | null;
  ticksT1: number | null;
  /** Reported queue against each hypothesis, on the lag-adjusted book. */
  h0PredictedLevel: number;
  h1PredictedLevel: number;
  h0PredictedDelta: number;
  h1PredictedDelta: number;
  atBboT0: boolean;
  atBboT1: boolean;
  betterAppeared: boolean;
  betterDisappeared: boolean;
  classification: MoveClass;
  /** Lag at which the public book best explains this move, when one exists. */
  bestLagMs: number | null;
  residualAtBestLag: number;
}

export interface AuditResult {
  transitions: number;
  movingTransitions: number;
  byClass: Record<MoveClass, number>;
  /** Inferred lag over the moves an aligned book explains. */
  lagSamples: number;
  medianLagMs: number | null;
  p90LagMs: number | null;
  /**
   * How many moves the UNSHIFTED book already explains.
   *
   * The guard against reading too much into the lag search. Scanning 31
   * candidate alignments will find something that fits in a busy book, so the
   * lag story is only credible if zero-lag explains few, the best lags
   * concentrate, and the histogram below is not flat.
   */
  explainedAtZeroLag: number;
  lagHistogram: { lagMs: number; n: number }[];
  /** Correlation of reported queue with better + same-level depth. */
  correlationTotalAhead: number | null;
  correlationSameOnly: number | null;
  observationsCompared: number;
  /** Mean of reported queue minus better depth: the same-level residual. */
  meanResidualSameLevel: number | null;
  splits: {
    dimension: string;
    buckets: { bucket: string; moves: number; unexplained: number }[];
  }[];
  probesAudited: number;
  probesSkipped: { probeId: string; reason: string }[];
  rows: Transition[];
  /** H0 against H1, on the lag-adjusted book. See HypothesisComparison. */
  hypotheses: HypothesisComparison[];
  /** The nested model gate. See QueueModelFit. */
  models: QueueModelFit[];
  /** How a fill model should TRACK the queue. See LevelTrackingFit. */
  levelModels: LevelTrackingFit[];
  /** The definitional test. See EntryIdentity. */
  entryIdentity: EntryIdentity;
  /** Transitions by how far behind the touch the probe was sitting. */
  byRegime: RegimeBreakdown[];
  appliedLagMs: number;
}

/**
 * Two explicit readings of what the exchange reports, compared on the same
 * observations.
 *
 *   H0   queue position is the same-price FIFO queue
 *   H1   queue position is everything ahead under price priority, so
 *        better-priced depth counts too
 *
 * Deliberately NOT a fitted model. Two named hypotheses, compared on error and
 * correlation, so the answer is "which reading of the endpoint is right"
 * rather than "which parameters minimise a residual". A flexible model would
 * fit either way and tell us nothing about the definition.
 */
export interface HypothesisComparison {
  hypothesis: 'H0_same_price' | 'H1_price_priority';
  observations: number;
  /** Mean absolute error in contracts, against the reported queue. */
  levelMae: number | null;
  /**
   * Signed mean error: reported minus predicted.
   *
   * MAE says how wrong, this says which way. A hypothesis that overshoots is
   * counting something the exchange does not, which is the specific claim H1
   * makes about better-priced depth.
   */
  levelBias: number | null;
  correlation: number | null;
  /** Share of nonzero moves the hypothesis predicts within tolerance. */
  explainedMoveRate: number | null;
  moves: number;
  /** MAE of the predicted CHANGE, which is what a fill model consumes. */
  deltaMae: number | null;
}

/**
 * A candidate model for how the queue advances, and how well it did.
 *
 *     A   dQ = V_executed
 *     B   dQ = V_executed + alpha * C_same
 *     C   dQ = V_executed + alpha * C_same + beta * dD_better
 *
 * Nested on purpose, and read from the bottom up: take the simplest model
 * whose error is MATERIALLY better than the one below it. `beta` is kept
 * separate from `alpha` because they answer different questions -- alpha is how
 * much of a same-level cancellation was ahead of us, beta is whether
 * better-priced depth counts at all -- and letting better-priced depth leak
 * into alpha would corrupt the one parameter we have evidence for.
 *
 * Fitted by ordinary least squares on the residual after executed volume,
 * which is exact and has no tuning of its own. A flexible fit would do better
 * on these samples and mean less.
 */
export interface QueueModelFit {
  model: 'A_executions' | 'B_alpha_cancellations' | 'C_plus_better_depth';
  observations: number;
  alpha: number | null;
  beta: number | null;
  mae: number | null;
  rmse: number | null;
  /** Share of moves predicted within tolerance. */
  hitRate: number | null;
}

/**
 * How a fill model should carry queue-ahead through a resting order's life.
 *
 * The delta gate above asks what moves the queue. This asks something more
 * useful and more answerable: given the public book, what is the best estimate
 * of the queue RIGHT NOW?
 *
 *   INTEGRATED    the current implementation. Anchor to displayed size at
 *                 entry, then decrement by observed executions. Errors
 *                 accumulate and are never corrected.
 *   REANCHORED    read same-price displayed depth from the book at every step.
 *                 Cannot drift, because it never carries state forward.
 *
 * The distinction matters because a simulated order rests for minutes. An
 * estimator that is unbiased per step but never re-reads the book will still
 * be far wrong by the end.
 */
export interface LevelTrackingFit {
  model: 'INTEGRATED' | 'REANCHORED';
  observations: number;
  mae: number | null;
  bias: number | null;
  /** Error on the LAST reading of each probe, where drift has accumulated. */
  terminalMae: number | null;
}

/**
 * The definitional test, at the one instant where nothing has had time to
 * drift: does the exchange's reported queue EQUAL the same-price displayed
 * depth we computed from the public feed?
 *
 * Everything else in this module compares hypotheses on error and correlation,
 * which can only ever say one reading fits better. This can say the reading is
 * exact -- and if it is, no amount of better-priced depth belongs in the
 * definition and beta is zero by construction rather than by regression.
 */
export interface EntryIdentity {
  probes: number;
  /** Probes where the two agree to within a hundredth of a contract. */
  exactMatches: number;
  meanGap: number | null;
  medianGap: number | null;
  maxAbsGap: number | null;
  /** The same test restricted to probes that rested behind the touch. */
  behindTouchProbes: number;
  behindTouchExact: number;
}

export interface RegimeBreakdown {
  regime: 'AT_TOUCH' | '1_TICK_BEHIND' | '2_TICKS_BEHIND' | 'DEEPER';
  transitions: number;
  moves: number;
  unexplained: number;
  betterDepthUnchanged: number;
  betterDepthIncreased: number;
  betterDepthDecreased: number;
  sameLevelTrade: number;
  sameLevelRemoval: number;
  sameLevelAddition: number;
  sameLevelUnchanged: number;
  h0Mae: number | null;
  h1Mae: number | null;
  h0Bias: number | null;
  h1Bias: number | null;
}

/**
 * Rebuilds the ladder for one market over one window from recorded deltas.
 *
 * Seeded from the nearest exchange snapshot at or before the window, then
 * advanced delta by delta -- the same reconstruction the replay verification
 * proves exact. Only the depth ahead of ONE price is retained, because that is
 * all the audit needs and keeping whole books would not fit.
 */
async function depthTimeline(
  sql: Sql,
  marketTicker: string,
  side: LadderSide,
  yesPrice: Decimal,
  fromMs: number,
  toMs: number,
): Promise<DepthPoint[]> {
  const seed = (await sql`
    SELECT s.yes_bids, s.no_bids, s.received_at_ms
      FROM orderbook_snapshots s
     WHERE s.market_ticker = ${marketTicker}
       AND s.received_at_ms <= ${String(fromMs)}
       AND s.source IN ('ws_initial', 'ws_recovery', 'session_handoff', 'local_materialized')
     ORDER BY s.received_at_ms DESC
     LIMIT 1
  `) as unknown as { yes_bids: [string, string][]; no_bids: [string, string][]; received_at_ms: string }[];

  if (seed.length === 0) return [];

  const book = new MarketBook(marketTicker);
  book.replaceWithSnapshot({ yesBids: seed[0]!.yes_bids ?? [], noBids: seed[0]!.no_bids ?? [] });

  const deltas = (await sql`
    SELECT d.received_at_ms, d.side, d.price, d.delta_count
      FROM orderbook_deltas d
     WHERE d.market_ticker = ${marketTicker}
       AND d.received_at_ms > ${seed[0]!.received_at_ms}
       AND d.received_at_ms <= ${String(toMs)}
       AND d.applied
     ORDER BY d.received_at_ms, d.id
  `) as unknown as { received_at_ms: string; side: 'yes' | 'no'; price: string; delta_count: string }[];

  const points: DepthPoint[] = [];
  const capture = (atMs: number) => {
    const ahead = depthAhead(side, yesPrice, { yesBids: book.yesBids, noBids: book.noBids });
    const bbo = book.getYesBBO();
    points.push({
      atMs,
      better: ahead.better,
      same: ahead.sameLevel,
      bestBid: bbo.bid,
      bestAsk: bbo.ask,
    });
  };

  capture(Number(seed[0]!.received_at_ms));
  for (const d of deltas) {
    book.applyDelta({ side: d.side, price: d.price, delta: d.delta_count });
    capture(Number(d.received_at_ms));
  }
  return points;
}

/** State in force at `atMs`, i.e. the last point at or before it. */
function depthAt(points: readonly DepthPoint[], atMs: number): DepthPoint | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.atMs <= atMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? null : points[found]!;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const percentile = (sorted: readonly number[], q: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export interface MoveEvidence {
  /** Positive means the queue advanced: contracts ahead went away. */
  deltaQ: number;
  /** Fall in displayed size at our own price, over the same interval. */
  deltaSame: number;
  /** Fall in depth at better prices, over the same interval. */
  deltaBetter: number;
  /** Public volume executed at or better than our price. */
  executedAhead: number;
  /** Smallest residual any candidate lag alignment achieved. */
  bestLagResidual: number;
}

/**
 * Attributes one queue move to a public cause.
 *
 * Order matters and encodes what we are willing to claim. A trade is the least
 * ambiguous explanation, so it is checked first. Better-priced depth is only
 * credited when it actually moved -- otherwise every move at the touch, where
 * better depth is constantly zero, would be attributed to it for free. A lag
 * alignment is the LAST resort, because a search over dozens of candidate
 * offsets will eventually fit something in a busy book, and calling that an
 * explanation without saying so would be the easiest way to talk ourselves
 * into a false result.
 */
export function classifyMove(e: MoveEvidence): MoveClass {
  const unshifted = e.deltaSame + e.deltaBetter;

  if (Math.abs(e.deltaQ) < EXPLAINED_TOLERANCE) {
    // Not a real move. Still labelled, so the counts stay comparable.
    return Math.abs(unshifted) < EXPLAINED_TOLERANCE
      ? 'SAME_LEVEL_EXPLAINED'
      : 'STILL_UNEXPLAINED';
  }
  if (Math.abs(e.deltaQ - e.executedAhead) < EXPLAINED_TOLERANCE) return 'TRADE_EXPLAINED';
  if (
    Math.abs(e.deltaBetter) >= EXPLAINED_TOLERANCE &&
    Math.abs(e.deltaQ - unshifted) < EXPLAINED_TOLERANCE
  ) {
    return 'BETTER_LEVEL_EXPLAINED';
  }
  if (Math.abs(e.deltaQ - e.deltaSame) < EXPLAINED_TOLERANCE) return 'SAME_LEVEL_EXPLAINED';
  if (e.bestLagResidual < EXPLAINED_TOLERANCE) return 'POSSIBLE_TIMING_ALIAS';
  return 'STILL_UNEXPLAINED';
}

export async function auditQueueSemantics(
  sql: Sql,
  opts: AuditOptions = {},
): Promise<AuditResult> {
  const lagStart = opts.lagSearchStartMs ?? AUDIT_DEFAULTS.lagSearchStartMs;
  const lagEnd = opts.lagSearchEndMs ?? AUDIT_DEFAULTS.lagSearchEndMs;
  const lagStep = opts.lagStepMs ?? AUDIT_DEFAULTS.lagStepMs;
  const appliedLag = opts.appliedLagMs ?? AUDIT_DEFAULTS.appliedLagMs;

  const scope = opts.runId ? sql`AND p.run_id = ${opts.runId}` : sql``;
  const probes = (await sql`
    SELECT p.probe_id, p.market_ticker, p.series_ticker, p.probe_side, p.yes_price,
           p.terminal_state, p.http_ack_ts_ms, p.cancel_ack_ts_ms, p.fill_receive_ts_ms
      FROM calibration_probes p
     WHERE p.order_id IS NOT NULL ${scope}
     ORDER BY p.decision_ts
  `) as unknown as ProbeRow[];

  const rows: Transition[] = [];
  const skipped: { probeId: string; reason: string }[] = [];
  const lagSamples: number[] = [];
  const reportedQ: number[] = [];
  const totalAhead: number[] = [];
  const sameOnly: number[] = [];
  const residuals: number[] = [];
  let audited = 0;
  let zeroLagExplained = 0;

  for (const probe of probes) {
    const observations = (await sql`
      SELECT o.probe_id, o.seq_no, o.poll_send_ts_ms, o.poll_receive_ts_ms, o.queue_position
        FROM calibration_queue_observations o
       WHERE o.probe_id = ${probe.probe_id} AND o.queue_position IS NOT NULL
       ORDER BY o.seq_no
    `) as unknown as ObsRow[];

    if (observations.length < 2) {
      skipped.push({ probeId: probe.probe_id, reason: 'fewer than two queue readings' });
      continue;
    }

    const first = Number(observations[0]!.poll_send_ts_ms);
    const last = Number(observations[observations.length - 1]!.poll_receive_ts_ms);
    const side = probe.probe_side;
    const yesPrice = D(probe.yes_price);

    const points = await depthTimeline(
      sql,
      probe.market_ticker,
      side,
      yesPrice,
      first + lagStart - 5_000,
      last + 5_000,
    );
    if (points.length === 0) {
      // The recorded book does not reach this window. Without a reconstruction
      // there is nothing to compare against, and guessing would be worse.
      skipped.push({ probeId: probe.probe_id, reason: 'no recorded book for the window' });
      continue;
    }
    audited += 1;

    // Trades at or better than our price over the probe's life, for the
    // executed-ahead term.
    const trades = (await sql`
      SELECT t.received_at_ms, t.yes_price, t.count, t.taker_outcome_side
        FROM public_trades t
       WHERE t.market_ticker = ${probe.market_ticker}
         AND t.received_at_ms >= ${String(first - 5_000)}
         AND t.received_at_ms <= ${String(last + 5_000)}
       ORDER BY t.received_at_ms
    `) as unknown as {
      received_at_ms: string;
      yes_price: string;
      count: string;
      taker_outcome_side: string | null;
    }[];

    const executedBetween = (t0: number, t1: number): number => {
      let total = ZERO;
      for (const t of trades) {
        const at = Number(t.received_at_ms);
        if (at <= t0 || at > t1) continue;
        // A print reaches us only if the aggressor consumed OUR side.
        const eligible = side === 'bid' ? t.taker_outcome_side === 'no' : t.taker_outcome_side === 'yes';
        if (!eligible) continue;
        const price = D(t.yes_price);
        const atOrBetter = side === 'bid' ? price.gte(yesPrice) : price.lte(yesPrice);
        if (!atOrBetter) continue;
        total = total.plus(D(t.count));
      }
      return total.toNumber();
    };

    for (let i = 1; i < observations.length; i++) {
      const prev = observations[i - 1]!;
      const cur = observations[i]!;
      const q0 = Number(prev.queue_position);
      const q1 = Number(cur.queue_position);
      const t0 = Number(prev.poll_send_ts_ms);
      const t1 = Number(cur.poll_send_ts_ms);

      const d0 = depthAt(points, t0);
      const d1 = depthAt(points, t1);
      if (!d0 || !d1) continue;

      // The hypothesis comparison uses the LAG-ADJUSTED book, because the v0
      // audit established that the endpoint reports a past state. Comparing
      // against the book at poll time would test our clock alignment rather
      // than the definition of the number.
      const a0 = depthAt(points, t0 - appliedLag) ?? d0;
      const a1 = depthAt(points, t1 - appliedLag) ?? d1;
      const h0Level = a1.same.toNumber();
      const h1Level = a1.better.plus(a1.same).toNumber();
      const h0Delta = a0.same.minus(a1.same).toNumber();
      const h1Delta = a0.better.plus(a0.same).minus(a1.better.plus(a1.same)).toNumber();

      // Correlation is over every reading, not just the moving ones.
      reportedQ.push(q1);
      totalAhead.push(d1.better.plus(d1.same).toNumber());
      sameOnly.push(d1.same.toNumber());
      residuals.push(q1 - d1.better.toNumber());

      const deltaQ = q0 - q1;
      const deltaSame = d0.same.minus(d1.same).toNumber();
      const deltaBetter = d0.better.minus(d1.better).toNumber();
      const executedAhead = executedBetween(t0, t1);

      // Best explanatory lag: shift BOTH endpoints and see which alignment of
      // the public book most nearly reproduces the reported move.
      let bestLag: number | null = null;
      let bestResidual = Number.POSITIVE_INFINITY;
      for (let lag = lagStart; lag <= lagEnd; lag += lagStep) {
        const a = depthAt(points, t0 - lag);
        const b = depthAt(points, t1 - lag);
        if (!a || !b) continue;
        const predicted =
          a.better.plus(a.same).minus(b.better.plus(b.same)).toNumber();
        const residual = Math.abs(deltaQ - predicted);
        if (residual < bestResidual) {
          bestResidual = residual;
          bestLag = lag;
        }
      }

      const unshiftedPredicted = deltaSame + deltaBetter;
      if (
        Math.abs(deltaQ) >= EXPLAINED_TOLERANCE &&
        Math.abs(deltaQ - unshiftedPredicted) < EXPLAINED_TOLERANCE
      ) {
        zeroLagExplained += 1;
      }
      const classification = classifyMove({
        deltaQ,
        deltaSame,
        deltaBetter,
        executedAhead,
        bestLagResidual: bestResidual,
      });

      if (
        Math.abs(deltaQ) >= EXPLAINED_TOLERANCE &&
        bestLag !== null &&
        bestResidual < EXPLAINED_TOLERANCE
      ) {
        lagSamples.push(bestLag);
      }

      rows.push({
        probeId: probe.probe_id,
        marketTicker: probe.market_ticker,
        seriesTicker: probe.series_ticker,
        side,
        terminalState: probe.terminal_state,
        t0Ms: t0,
        t1Ms: t1,
        q0,
        q1,
        deltaQ,
        sameT0: d0.same.toNumber(),
        sameT1: d1.same.toNumber(),
        betterT0: d0.better.toNumber(),
        betterT1: d1.better.toNumber(),
        deltaSame,
        deltaBetter,
        executedAhead,
        ticksT0: ticksFromTouch(side, yesPrice, d0.bestBid, d0.bestAsk),
        ticksT1: ticksFromTouch(side, yesPrice, d1.bestBid, d1.bestAsk),
        h0PredictedLevel: h0Level,
        h1PredictedLevel: h1Level,
        h0PredictedDelta: h0Delta,
        h1PredictedDelta: h1Delta,
        atBboT0: ticksFromTouch(side, yesPrice, d0.bestBid, d0.bestAsk) === 0,
        atBboT1: ticksFromTouch(side, yesPrice, d1.bestBid, d1.bestAsk) === 0,
        betterAppeared: d1.better.gt(d0.better),
        betterDisappeared: d1.better.lt(d0.better),
        classification,
        bestLagMs: bestLag,
        residualAtBestLag: Number.isFinite(bestResidual) ? bestResidual : Number.NaN,
      });
    }
  }

  const byClass: Record<MoveClass, number> = {
    TRADE_EXPLAINED: 0,
    BETTER_LEVEL_EXPLAINED: 0,
    SAME_LEVEL_EXPLAINED: 0,
    POSSIBLE_TIMING_ALIAS: 0,
    STILL_UNEXPLAINED: 0,
  };
  const moving = rows.filter((r) => Math.abs(r.deltaQ) >= EXPLAINED_TOLERANCE);
  for (const r of moving) byClass[r.classification] += 1;

  const split = (dimension: string, of: (r: Transition) => string) => {
    const buckets = new Map<string, { moves: number; unexplained: number }>();
    for (const r of moving) {
      const key = of(r);
      const b = buckets.get(key) ?? { moves: 0, unexplained: 0 };
      b.moves += 1;
      if (r.classification === 'STILL_UNEXPLAINED') b.unexplained += 1;
      buckets.set(key, b);
    }
    return {
      dimension,
      buckets: [...buckets.entries()]
        .map(([bucket, v]) => ({ bucket, ...v }))
        .sort((a, b) => (a.bucket < b.bucket ? -1 : 1)),
    };
  };

  const mae = (xs: readonly number[]) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;

  const compare = (
    hypothesis: HypothesisComparison['hypothesis'],
    level: (r: Transition) => number,
    delta: (r: Transition) => number,
    subset: readonly Transition[] = rows,
  ): HypothesisComparison => {
    const movingSubset = subset.filter((r) => Math.abs(r.deltaQ) >= EXPLAINED_TOLERANCE);
    return {
      hypothesis,
      observations: subset.length,
      levelMae: mae(subset.map((r) => r.q1 - level(r))),
      levelBias:
        subset.length === 0
          ? null
          : subset.reduce((a, r) => a + (r.q1 - level(r)), 0) / subset.length,
      correlation: pearson(subset.map((r) => r.q1), subset.map(level)),
      moves: movingSubset.length,
      explainedMoveRate:
        movingSubset.length === 0
          ? null
          : movingSubset.filter((r) => Math.abs(r.deltaQ - delta(r)) < EXPLAINED_TOLERANCE).length /
            movingSubset.length,
      deltaMae: mae(movingSubset.map((r) => r.deltaQ - delta(r))),
    };
  };

  const hypotheses = [
    compare('H0_same_price', (r) => r.h0PredictedLevel, (r) => r.h0PredictedDelta),
    compare('H1_price_priority', (r) => r.h1PredictedLevel, (r) => r.h1PredictedDelta),
  ];

  const regimeOf = (r: Transition): RegimeBreakdown['regime'] => {
    const t = r.ticksT0 ?? 0;
    if (t <= 0) return 'AT_TOUCH';
    if (t === 1) return '1_TICK_BEHIND';
    if (t === 2) return '2_TICKS_BEHIND';
    return 'DEEPER';
  };

  const byRegime: RegimeBreakdown[] = (
    ['AT_TOUCH', '1_TICK_BEHIND', '2_TICKS_BEHIND', 'DEEPER'] as const
  )
    .map((regime) => {
      const inRegime = rows.filter((r) => regimeOf(r) === regime);
      const movingHere = inRegime.filter((r) => Math.abs(r.deltaQ) >= EXPLAINED_TOLERANCE);
      return {
        regime,
        transitions: inRegime.length,
        moves: movingHere.length,
        unexplained: movingHere.filter((r) => r.classification === 'STILL_UNEXPLAINED').length,
        betterDepthUnchanged: movingHere.filter((r) => Math.abs(r.deltaBetter) < EXPLAINED_TOLERANCE)
          .length,
        betterDepthIncreased: movingHere.filter((r) => r.deltaBetter <= -EXPLAINED_TOLERANCE).length,
        betterDepthDecreased: movingHere.filter((r) => r.deltaBetter >= EXPLAINED_TOLERANCE).length,
        sameLevelTrade: movingHere.filter((r) => r.executedAhead >= EXPLAINED_TOLERANCE).length,
        sameLevelRemoval: movingHere.filter(
          (r) => r.executedAhead < EXPLAINED_TOLERANCE && r.deltaSame >= EXPLAINED_TOLERANCE,
        ).length,
        sameLevelAddition: movingHere.filter((r) => r.deltaSame <= -EXPLAINED_TOLERANCE).length,
        sameLevelUnchanged: movingHere.filter((r) => Math.abs(r.deltaSame) < EXPLAINED_TOLERANCE)
          .length,
        h0Mae: mae(inRegime.map((r) => r.q1 - r.h0PredictedLevel)),
        h1Mae: mae(inRegime.map((r) => r.q1 - r.h1PredictedLevel)),
        h0Bias:
          inRegime.length === 0
            ? null
            : inRegime.reduce((a, r) => a + (r.q1 - r.h0PredictedLevel), 0) / inRegime.length,
        h1Bias:
          inRegime.length === 0
            ? null
            : inRegime.reduce((a, r) => a + (r.q1 - r.h1PredictedLevel), 0) / inRegime.length,
      };
    })
    .filter((r) => r.transitions > 0);

  // ---- the nested model gate --------------------------------------------
  //
  // Fitted only on moves, and only where the book was reconstructable. A model
  // of how the queue ADVANCES has nothing to learn from intervals in which it
  // did not move, and including them would let a model that predicts zero
  // everywhere look excellent.
  const fitRows = rows.filter((r) => Math.abs(r.deltaQ) >= EXPLAINED_TOLERANCE);
  const y = fitRows.map((r) => r.deltaQ - r.executedAhead);
  const cSame = fitRows.map((r) => r.deltaSame);
  const dBetter = fitRows.map((r) => r.deltaBetter);

  /** Least squares through the origin, one or two regressors. */
  const ols = (regressors: number[][]): number[] | null => {
    const k = regressors.length;
    if (k === 0 || y.length < k + 2) return null;
    if (k === 1) {
      const x = regressors[0]!;
      const den = x.reduce((a, v) => a + v * v, 0);
      if (den === 0) return null;
      return [x.reduce((a, v, i) => a + v * y[i]!, 0) / den];
    }
    // Two regressors: solve the 2x2 normal equations directly.
    const [x1, x2] = regressors as [number[], number[]];
    const s11 = x1.reduce((a, v) => a + v * v, 0);
    const s22 = x2.reduce((a, v) => a + v * v, 0);
    const s12 = x1.reduce((a, v, i) => a + v * x2[i]!, 0);
    const s1y = x1.reduce((a, v, i) => a + v * y[i]!, 0);
    const s2y = x2.reduce((a, v, i) => a + v * y[i]!, 0);
    const det = s11 * s22 - s12 * s12;
    if (Math.abs(det) < 1e-9) return null;
    return [(s1y * s22 - s2y * s12) / det, (s2y * s11 - s1y * s12) / det];
  };

  const scoreModel = (
    model: QueueModelFit['model'],
    alpha: number | null,
    beta: number | null,
  ): QueueModelFit => {
    const errors = fitRows.map((r, i) => {
      const predicted =
        r.executedAhead + (alpha ?? 0) * cSame[i]! + (beta ?? 0) * dBetter[i]!;
      return r.deltaQ - predicted;
    });
    const n = errors.length;
    return {
      model,
      observations: n,
      alpha,
      beta,
      mae: n === 0 ? null : errors.reduce((a, e) => a + Math.abs(e), 0) / n,
      rmse: n === 0 ? null : Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / n),
      hitRate:
        n === 0 ? null : errors.filter((e) => Math.abs(e) < EXPLAINED_TOLERANCE).length / n,
    };
  };

  const alphaOnly = ols([cSame]);
  const both = ols([cSame, dBetter]);
  const models: QueueModelFit[] = [
    scoreModel('A_executions', null, null),
    scoreModel('B_alpha_cancellations', alphaOnly?.[0] ?? null, null),
    scoreModel('C_plus_better_depth', both?.[0] ?? null, both?.[1] ?? null),
  ];

  // ---- how should a fill model TRACK the queue? -------------------------
  //
  // Both estimators are run forward over each probe's own sequence of
  // readings and scored against what the exchange reported. This is the
  // question the fill model actually needs answered.
  const byProbe = new Map<string, Transition[]>();
  for (const r of rows) {
    const list = byProbe.get(r.probeId) ?? [];
    list.push(r);
    byProbe.set(r.probeId, list);
  }

  const integratedErrors: number[] = [];
  const reanchoredErrors: number[] = [];
  const integratedTerminal: number[] = [];
  const reanchoredTerminal: number[] = [];

  for (const seq of byProbe.values()) {
    seq.sort((a, b) => a.t0Ms - b.t0Ms);
    // Anchored once, at the first reading, exactly as the live model does.
    let integrated = seq[0]!.sameT0;
    for (const [i, r] of seq.entries()) {
      integrated = Math.max(0, integrated - r.executedAhead);
      const reanchored = r.sameT1;
      const eInt = r.q1 - integrated;
      const eRe = r.q1 - reanchored;
      integratedErrors.push(eInt);
      reanchoredErrors.push(eRe);
      if (i === seq.length - 1) {
        integratedTerminal.push(eInt);
        reanchoredTerminal.push(eRe);
      }
    }
  }

  const meanAbs = (xs: readonly number[]) =>
    xs.length === 0 ? null : xs.reduce((a, v) => a + Math.abs(v), 0) / xs.length;
  const meanSigned = (xs: readonly number[]) =>
    xs.length === 0 ? null : xs.reduce((a, v) => a + v, 0) / xs.length;

  const levelModels: LevelTrackingFit[] = [
    {
      model: 'INTEGRATED',
      observations: integratedErrors.length,
      mae: meanAbs(integratedErrors),
      bias: meanSigned(integratedErrors),
      terminalMae: meanAbs(integratedTerminal),
    },
    {
      model: 'REANCHORED',
      observations: reanchoredErrors.length,
      mae: meanAbs(reanchoredErrors),
      bias: meanSigned(reanchoredErrors),
      terminalMae: meanAbs(reanchoredTerminal),
    },
  ];

  // ---- the definitional test --------------------------------------------
  const entryRows = (await sql`
    SELECT p.displayed_size_at_entry AS displayed,
           p.initial_queue_position AS q0,
           p.better_depth_at_entry AS better
      FROM calibration_probes p
     WHERE p.initial_queue_position IS NOT NULL
       AND p.displayed_size_at_entry IS NOT NULL ${scope}
  `) as unknown as { displayed: string; q0: string; better: string | null }[];

  const gaps = entryRows.map((r) => Number(r.displayed) - Number(r.q0));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const behind = entryRows.filter((r) => r.better !== null && Number(r.better) > 0);
  const entryIdentity: EntryIdentity = {
    probes: gaps.length,
    exactMatches: gaps.filter((g) => Math.abs(g) < 0.01).length,
    meanGap: gaps.length === 0 ? null : gaps.reduce((a, g) => a + g, 0) / gaps.length,
    medianGap: percentile(sortedGaps, 0.5),
    maxAbsGap: gaps.length === 0 ? null : Math.max(...gaps.map(Math.abs)),
    behindTouchProbes: behind.length,
    behindTouchExact: behind.filter(
      (r) => Math.abs(Number(r.displayed) - Number(r.q0)) < 0.01,
    ).length,
  };

  const sortedLags = [...lagSamples].sort((a, b) => a - b);
  const histogram = new Map<number, number>();
  for (const l of sortedLags) histogram.set(l, (histogram.get(l) ?? 0) + 1);

  logger.info(
    { event: 'queue_audit', probes: audited, moves: moving.length, skipped: skipped.length },
    `queue audit over ${audited} probe(s)`,
  );

  return {
    transitions: rows.length,
    movingTransitions: moving.length,
    byClass,
    lagSamples: sortedLags.length,
    medianLagMs: percentile(sortedLags, 0.5),
    p90LagMs: percentile(sortedLags, 0.9),
    explainedAtZeroLag: zeroLagExplained,
    lagHistogram: [...histogram.entries()]
      .map(([lagMs, n]) => ({ lagMs, n }))
      .sort((a, b) => a.lagMs - b.lagMs),
    correlationTotalAhead: pearson(reportedQ, totalAhead),
    correlationSameOnly: pearson(reportedQ, sameOnly),
    observationsCompared: reportedQ.length,
    meanResidualSameLevel:
      residuals.length === 0 ? null : residuals.reduce((a, b) => a + b, 0) / residuals.length,
    splits: [
      split('side', (r) => r.side),
      split('series', (r) => r.seriesTicker ?? 'unknown'),
      split('at BBO', (r) => (r.atBboT0 ? 'at_bbo' : 'behind_bbo')),
      split('outcome', (r) => r.terminalState),
    ],
    probesAudited: audited,
    probesSkipped: skipped,
    rows,
    hypotheses,
    models,
    levelModels,
    entryIdentity,
    byRegime,
    appliedLagMs: appliedLag,
  };
}
