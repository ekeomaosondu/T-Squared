import { Decimal, ZERO } from '@/src/book/decimal';
import type { BacktestRunResult } from '@/src/research/engine/backtestEngine';
import {
  computeExecutionQuality,
  type ExecutionQuality,
} from '@/src/research/metrics/executionQuality';
import {
  computeMarkouts,
  summarizeMarkouts,
  MARKOUT_HORIZONS_MS,
  type FillMarkout,
  type MarkoutReference,
  type MarkoutSummary,
} from '@/src/research/metrics/markouts';
import { computeBreakdowns, type Breakdown } from '@/src/research/metrics/pnl';

/**
 * The standard report every run produces.
 *
 * Assembled AFTER the run from recorded artifacts. Nothing here can influence
 * the run that produced it, which is what makes it safe to compute markouts
 * over future prices.
 */

export interface RunSummary {
  /** Dataset and coverage, so a number is never read without its context. */
  coverage: {
    firstEventMs: string | null;
    lastEventMs: string | null;
    spanMs: string | null;
    spanDays: string | null;
    markets: number;
    events: number;
    deltas: number;
    trades: number;
    snapshots: number;
    captureGaps: number;
    /** Market-intervals the run refused to trust. */
    invalidIntervals: number;
  };

  /**
   * Book reconstruction check against the collector's own recorded hashes.
   *
   * If `compared` and `matched` differ, every other number below was computed
   * on a book that is not the one that existed, and the run should be
   * discarded rather than interpreted.
   */
  replayEquality: {
    compared: number;
    matched: number;
    exact: boolean;
    skippedInvalidBook: number;
  };

  /**
   * PnL, decomposed.
   *
   * The components answer different questions and must not be read as one
   * number. Settlement money says whether the inventory we were left holding
   * happened to be right; trading money says whether the market making was any
   * good. A maker that loses on spread and is rescued by a lucky determination
   * has not found an edge.
   */
  pnl: {
    /** Round-trip trading during the run. */
    realizedTradingPnl: string;
    /** Crystallised by exchange determinations after the run. */
    settlementPnl: string;
    /** Open positions marked at the last mid. A mark, not a result. */
    unrealizedMarkPnl: string;
    grossPnl: string;
    fees: string;
    /** True only if every fill's fee came from a verified schedule. */
    feeVerified: boolean;
    /** Gross minus fees, or null when the fee could not be verified. */
    netPnl: string | null;
    /** Everything above, i.e. gross minus fees. Null under the same condition. */
    totalEconomicPnl: string | null;
    pnlPerDay: string | null;
    pnlPerMarket: string | null;
    pnlPerEvent: string | null;
    maxDrawdown: string;
    finalAbsInventory: string;
    finalPositionsOpen: number;
    /** Open positions with no mark. Excluded from the figures above. */
    unmarkedPositions: number;
    unmarkedQuantity: string;
    /** How each held position finished. See SettlementReport. */
    resolution: {
      settled: number;
      voided: number;
      openAtRunEnd: number;
      awaitingDetermination: number;
      unpriceable: number;
      provisional: number;
      noMarketState: number;
      basisCounts: Record<string, number>;
    };
  };

  inventory: {
    meanAbsInventory: string | null;
    maxAbsInventory: string;
    maxCollateral: string;
    turnoverContracts: string;
    turnoverNotional: string;
  };

  execution: ExecutionQuality;
  markouts: MarkoutSummary[];
  /** Adverse selection at the reporting horizon, over maker fills. */
  adverseSelectionRate: string | null;

  breakdowns: Breakdown[];

  performance: {
    wallClockMs: number;
    eventsPerSecond: number;
    peakRssBytes: number;
    midSeriesPoints: number;
  };
}

export interface SummaryOptions {
  reference?: MarkoutReference;
  horizons?: readonly number[];
  /** Horizon used for the headline adverse-selection rate. */
  adverseHorizonMs?: number;
}

export function summarizeRun(
  result: BacktestRunResult,
  opts: SummaryOptions = {},
): { summary: RunSummary; markouts: FillMarkout[] } {
  const reference = opts.reference ?? 'mid';
  const horizons = opts.horizons ?? MARKOUT_HORIZONS_MS;
  const adverseHorizon = opts.adverseHorizonMs ?? 1_000;

  const markouts = computeMarkouts(result.fills, result.midSeries, reference, horizons);
  const markoutSummary = summarizeMarkouts(markouts, horizons);
  const execution = computeExecutionQuality(result.orders, result.fills);
  const breakdowns = computeBreakdowns(result.fills, markouts, adverseHorizon);

  const last = result.equityCurve[result.equityCurve.length - 1];
  const net = last?.netPnl == null ? null : new Decimal(last.netPnl);
  const gross = last?.grossPnl == null ? null : new Decimal(last.grossPnl);

  const spanMs =
    result.firstEventMs === null || result.lastEventMs === null
      ? null
      : result.lastEventMs - result.firstEventMs;
  const spanDays = spanMs === null ? null : new Decimal(spanMs.toString()).div(86_400_000);

  const markets = result.slice.marketTickers.length;
  const finalAbs = last === undefined ? ZERO : new Decimal(last.absInventory);
  const openPositions = result.portfolio.allPositions().filter((p) => !p.quantity.isZero()).length;

  const adverse = markoutSummary.find((m) => m.horizonMs === adverseHorizon)?.adverseRate ?? null;

  return {
    markouts,
    summary: {
      coverage: {
        firstEventMs: result.firstEventMs?.toString() ?? null,
        lastEventMs: result.lastEventMs?.toString() ?? null,
        spanMs: spanMs?.toString() ?? null,
        spanDays: spanDays === null ? null : spanDays.toFixed(6),
        markets,
        events: result.counts.events,
        deltas: result.counts.deltas,
        trades: result.counts.trades,
        snapshots: result.counts.snapshots,
        captureGaps: result.counts.captureGaps,
        invalidIntervals: result.invalidIntervals.length,
      },

      replayEquality: {
        compared: result.checkpointChecks.compared,
        matched: result.checkpointChecks.matched,
        exact:
          result.checkpointChecks.compared > 0 &&
          result.checkpointChecks.compared === result.checkpointChecks.matched,
        skippedInvalidBook: result.checkpointChecks.skippedInvalidBook,
      },

      pnl: {
        realizedTradingPnl: result.portfolio.realizedPnl.toFixed(6),
        settlementPnl: result.portfolio.settlementPnl.toFixed(6),
        unrealizedMarkPnl: last?.unrealizedMarkPnl ?? '0.000000',
        grossPnl: gross?.toFixed(6) ?? '0.000000',
        fees: result.portfolio.feesPaid.toFixed(6),
        feeVerified: last?.feeVerified ?? true,
        netPnl: net?.toFixed(6) ?? null,
        totalEconomicPnl: net?.toFixed(6) ?? null,
        pnlPerDay:
          net === null || spanDays === null || spanDays.lte(0) ? null : net.div(spanDays).toFixed(6),
        pnlPerMarket: net === null || markets === 0 ? null : net.div(markets).toFixed(6),
        pnlPerEvent:
          net === null || result.counts.events === 0
            ? null
            : net.div(result.counts.events).toFixed(10),
        maxDrawdown: result.portfolio.maxDrawdown.toFixed(6),
        finalAbsInventory: finalAbs.toFixed(6),
        finalPositionsOpen: openPositions,
        unmarkedPositions: last?.unmarkedPositions ?? 0,
        unmarkedQuantity: last?.unmarkedQuantity ?? '0',
        resolution: {
          settled: result.settlement.settled,
          voided: result.settlement.voided,
          openAtRunEnd: result.settlement.openAtRunEnd,
          awaitingDetermination: result.settlement.awaitingDetermination,
          unpriceable: result.settlement.unpriceable,
          provisional: result.settlement.provisional.length,
          noMarketState: result.settlement.noMarketState.length,
          basisCounts: result.settlement.basisCounts,
        },
      },

      inventory: {
        meanAbsInventory:
          result.portfolio.meanAbsInventory(result.firstEventMs, result.lastEventMs)?.toFixed(6) ??
          null,
        maxAbsInventory: result.portfolio.maxAbsoluteInventory.toFixed(6),
        maxCollateral: result.portfolio.maxCollateralUsed.toFixed(6),
        turnoverContracts: execution.contractVolume,
        turnoverNotional: execution.notional,
      },

      execution,
      markouts: markoutSummary,
      adverseSelectionRate: adverse,
      breakdowns,

      performance: {
        wallClockMs: result.wallClockMs,
        eventsPerSecond:
          result.wallClockMs === 0
            ? 0
            : Math.round((result.counts.events / result.wallClockMs) * 1000),
        peakRssBytes: result.peakRssBytes,
        midSeriesPoints: result.midSeries.totalPoints,
      },
    },
  };
}
