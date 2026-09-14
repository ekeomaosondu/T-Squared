import { gitCommitSha } from '@/src/config/env';
import type { HistoricalDataSource, HistoricalRequest } from '@/src/research/data/historicalDataSource';
import { BacktestEngine, type BacktestOptions, type BacktestRunResult } from '@/src/research/engine/backtestEngine';
import type { Strategy } from '@/src/research/strategy/strategy';
import type { FillModel } from '@/src/research/execution/fills/fillModel';
import type { FeeModel } from '@/src/research/portfolio/fees';
import type { LatencyModel } from '@/src/research/execution/latencyModel';
import { summarizeRun, type RunSummary, type SummaryOptions } from '@/src/research/metrics/performance';
import type { FillMarkout } from '@/src/research/metrics/markouts';
import {
  computeRunKey,
  makeRunId,
  ENGINE_VERSION,
  type RunManifest,
} from '@/src/research/results/runManifest';

/**
 * One backtest, end to end: resolve the slice, run it, summarize it, and build
 * the manifest that makes it reproducible.
 *
 * The manifest is assembled from the SAME objects the run used -- the fill
 * model describes itself, the latency model describes itself -- rather than
 * from the caller's intent. A manifest built from what was requested rather
 * than from what ran is the classic way a reproducibility record ends up
 * describing a different experiment.
 */
export interface RunBacktestOptions {
  source: HistoricalDataSource;
  request: HistoricalRequest;
  strategy: Strategy;
  fillModel: FillModel;
  feeModel: FeeModel;
  latency: LatencyModel;
  gapPolicy?: BacktestOptions['gapPolicy'];
  gapOrderPolicy?: BacktestOptions['gapOrderPolicy'];
  markIntervalMs?: number;
  maxEvents?: number;
  randomSeed?: number;
  verifyCheckpoints?: boolean;
  summary?: SummaryOptions;
  /** Test seam: pinned so a manifest can be compared byte for byte. */
  now?: () => Date;
}

export interface CompletedRun {
  manifest: RunManifest;
  summary: RunSummary;
  markouts: FillMarkout[];
  result: BacktestRunResult;
}

export async function runBacktest(opts: RunBacktestOptions): Promise<CompletedRun> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now();

  const engine = new BacktestEngine({
    source: opts.source,
    request: opts.request,
    strategy: opts.strategy,
    fillModel: opts.fillModel,
    feeModel: opts.feeModel,
    latency: opts.latency,
    gapPolicy: opts.gapPolicy,
    gapOrderPolicy: opts.gapOrderPolicy,
    markIntervalMs: opts.markIntervalMs,
    maxEvents: opts.maxEvents,
    randomSeed: opts.randomSeed,
    verifyCheckpoints: opts.verifyCheckpoints,
  });

  const result = await engine.run();
  const { summary, markouts } = summarizeRun(result, opts.summary);

  const gapPolicy = opts.gapPolicy ?? 'skip_until_fresh_snapshot';
  const gapOrderPolicy = opts.gapOrderPolicy ?? 'cancel_all';
  const markIntervalMs = opts.markIntervalMs ?? 1000;
  const randomSeed = opts.randomSeed ?? 0;

  const keyInputs = {
    datasetId: opts.request.datasetId,
    datasetFingerprint: result.slice.fingerprint,
    strategyName: opts.strategy.name,
    strategyVersion: opts.strategy.version,
    strategyParameters: opts.strategy.parameters(),
    gitCommitSha: gitCommitSha(),
    startTime: opts.request.startTime.toISOString(),
    endTime: opts.request.endTime.toISOString(),
    seriesTickers: opts.request.seriesTickers ?? [],
    eventTickers: opts.request.eventTickers,
    marketTickers: opts.request.marketTickers,
    fillModel: opts.fillModel.name,
    fillModelParameters: opts.fillModel.describe(),
    latencyModel: opts.latency.describe(),
    feeModel: opts.feeModel.describe(),
    captureGapPolicy: gapPolicy,
    gapOrderPolicy,
    markIntervalMs,
    randomSeed,
    engineVersion: ENGINE_VERSION,
  };

  const runKey = computeRunKey(keyInputs);

  const manifest: RunManifest = {
    runId: makeRunId(runKey, startedAt),
    runKey,
    ...keyInputs,
    datasetObjects: result.slice.objects,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
  };

  return { manifest, summary, markouts, result };
}
