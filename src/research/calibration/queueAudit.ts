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
  /** How far back a queue reading may be describing. See the file comment. */
  lagSearchStartMs?: number;
  lagSearchEndMs?: number;
  lagStepMs?: number;
}

export const AUDIT_DEFAULTS = {
  lagSearchStartMs: -500,
  lagSearchEndMs: 2500,
  lagStepMs: 100,
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
  };
}
