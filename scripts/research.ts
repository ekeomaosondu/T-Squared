#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { readFile } from 'node:fs/promises';
import { env } from '@/src/config/env';
import { openLake } from '@/src/research/data/lakeSource';
import type {
  HistoricalDataSource,
  HistoricalRequest,
} from '@/src/research/data/historicalDataSource';
import { runBacktest, type CompletedRun } from '@/src/research/engine/runBacktest';
import { ResultWriter } from '@/src/research/results/resultWriter';
import {
  FILL_MODEL_NAMES,
  STRATEGY_NAMES,
  makeFeeModel,
  makeFillModel,
  makeLatencyModel,
  makeStrategy,
} from '@/src/research/registry';
import { renderComparison, renderRun } from '@/src/research/results/report';
import { logger } from '@/src/logging/logger';

/**
 * Research CLI.
 *
 *   npm run research -- describe --series KXHIGHNY --from 2026-09-13 --to 2026-09-14
 *   npm run research -- verify   --series KXHIGHNY --from 2026-09-13 --to 2026-09-14
 *   npm run research -- backtest --strategy join-bbo --series KXHIGHNY \
 *                                --from 2026-09-13 --to 2026-09-14 \
 *                                --fill-model conservative_queue --latency-ms 100
 *   npm run research -- compare  --config experiments/baseline.yaml
 *
 * `describe` resolves a slice without reading it. `verify` replays the book
 * and checks it against the collector's own recorded hashes -- run it on a new
 * day before trusting any result from that day.
 */

interface Args {
  command: string;
  flags: Map<string, string>;
  bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? 'help';
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) bools.add(name);
    else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { command, flags, bools };
}

/** A --from/--to date. Accepts a bare UTC day or a full ISO instant. */
function parseInstant(value: string, endOfDay: boolean): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date: ${value}`);
  void endOfDay;
  return d;
}

function buildRequest(args: Args): HistoricalRequest {
  const from = args.flags.get('from');
  const to = args.flags.get('to');
  if (!from || !to) throw new Error('--from and --to are required (YYYY-MM-DD or an ISO instant)');

  const list = (name: string) =>
    args.flags.get(name)?.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    datasetId: args.flags.get('dataset') ?? env().DATASET_ID,
    startTime: parseInstant(from, false),
    endTime: parseInstant(to, true),
    seriesTickers: list('series'),
    eventTickers: list('events'),
    marketTickers: list('markets'),
    includeTrades: !args.bools.has('no-trades'),
  };
}

async function describe(args: Args): Promise<void> {
  const source = openLake();
  try {
    const slice = await source.describe(buildRequest(args));
    console.log(JSON.stringify(slice, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } finally {
    await source.close();
  }
}

/**
 * Replay equality for a slice.
 *
 * Reconstructs every book from the event stream and compares it against the
 * hashes the collector recorded while it was live. Exit code 1 on any
 * mismatch: a day that fails this has no business being backtested.
 */
async function verify(args: Args): Promise<void> {
  const source: HistoricalDataSource = openLake();
  try {
    const run = await runBacktest({
      source,
      request: buildRequest(args),
      strategy: makeStrategy('join-bbo', { marketTickers: ['__none__'] }),
      fillModel: makeFillModel('touch'),
      feeModel: await makeFeeModel('zero'),
      latency: makeLatencyModel(0),
      verifyCheckpoints: true,
    });

    const eq = run.summary.replayEquality;
    console.log(`\nreplay equality: ${eq.matched}/${eq.compared} exact` +
      (eq.skippedInvalidBook > 0 ? `  (${eq.skippedInvalidBook} skipped: book not valid)` : ''));
    console.log(`capture gaps:    ${run.summary.coverage.captureGaps}`);
    console.log(`deltas applied:  ${run.result.bookStats.deltasApplied}`);
    console.log(`  not applied by the recorder: ${run.result.bookStats.deltasSkippedNotApplied}`);
    console.log(`  book not seeded:             ${run.result.bookStats.deltasSkippedInvalidBook}`);
    console.log(`  stale stream:                ${run.result.bookStats.deltasSkippedStaleStream}`);
    console.log(`  diverged:                    ${run.result.bookStats.deltasDiverged}`);

    if (!eq.exact) {
      console.error('\nFAIL: the reconstructed book does not match what the collector recorded.');
      for (const m of run.result.checkpointChecks.mismatches.slice(0, 10)) {
        console.error(`  ${m.marketTicker} at ${new Date(Number(m.atMs)).toISOString()}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log('\nPASS');
  } finally {
    await source.close();
  }
}

interface BacktestSpec {
  strategy: string;
  strategyParams: Record<string, unknown>;
  fillModel: string;
  fillModelParams: Record<string, unknown>;
  latencyMs: number;
  feeModel: string;
  feeModelParams: { schedulePath?: string };
}

/**
 * One run against an ALREADY OPEN lake.
 *
 * The source is passed in rather than opened here so a 24-cell matrix shares
 * one connection and one set of credentials instead of re-establishing them
 * two dozen times.
 */
async function runOne(
  source: HistoricalDataSource,
  request: HistoricalRequest,
  spec: BacktestSpec,
  opts: { write: boolean; verifyCheckpoints: boolean; maxEvents?: number },
): Promise<CompletedRun> {
  const run = await runBacktest({
    source,
    request,
    strategy: makeStrategy(spec.strategy, spec.strategyParams),
    fillModel: makeFillModel(spec.fillModel, spec.fillModelParams),
    feeModel: await makeFeeModel(spec.feeModel, spec.feeModelParams),
    latency: makeLatencyModel(spec.latencyMs),
    verifyCheckpoints: opts.verifyCheckpoints,
    maxEvents: opts.maxEvents,
  });
  if (opts.write) {
    const writer = new ResultWriter();
    const written = await writer.write(run.manifest, run.summary, run.result, run.markouts);
    console.log(`\nartifacts: ${written.directory}`);
  }
  return run;
}

function specFromArgs(args: Args): BacktestSpec {
  return {
    strategy: args.flags.get('strategy') ?? 'join-bbo',
    strategyParams: JSON.parse(args.flags.get('strategy-params') ?? '{}') as Record<string, unknown>,
    fillModel: args.flags.get('fill-model') ?? 'conservative_queue',
    fillModelParams: JSON.parse(args.flags.get('fill-params') ?? '{}') as Record<string, unknown>,
    latencyMs: Number(args.flags.get('latency-ms') ?? 0),
    feeModel: args.flags.get('fee-model') ?? 'kalshi_historical',
    feeModelParams: { schedulePath: args.flags.get('fee-schedule') },
  };
}

async function backtest(args: Args): Promise<void> {
  const request = buildRequest(args);
  const source = openLake();
  try {
    const run = await runOne(source, request, specFromArgs(args), {
      write: !args.bools.has('no-write'),
      verifyCheckpoints: !args.bools.has('no-verify'),
      maxEvents: args.flags.has('max-events') ? Number(args.flags.get('max-events')) : undefined,
    });
    console.log(renderRun(run.manifest, run.summary));
  } finally {
    await source.close();
  }
}

interface ExperimentConfig {
  dataset?: string;
  period: { from: string; to: string };
  series?: string[];
  events?: string[];
  markets?: string[];
  strategies: string[];
  strategyParams?: Record<string, Record<string, unknown>>;
  fillModels: string[];
  latencyMs: number[];
  feeModel?: string;
}

/**
 * The experiment matrix.
 *
 * Runs the full cross product and prints one table. Comparing strategies
 * across separate invocations invites mismatched windows and mismatched
 * assumptions; running them together makes that impossible, and every row
 * shares one dataset fingerprint.
 */
async function compare(args: Args): Promise<void> {
  const configPath = args.flags.get('config');
  if (!configPath) throw new Error('--config is required');

  const raw = await readFile(configPath, 'utf8');
  const yaml = await import('js-yaml');
  const config = yaml.load(raw) as ExperimentConfig;

  const request: HistoricalRequest = {
    datasetId: config.dataset ?? env().DATASET_ID,
    startTime: parseInstant(config.period.from, false),
    endTime: parseInstant(config.period.to, true),
    seriesTickers: config.series,
    eventTickers: config.events,
    marketTickers: config.markets,
    includeTrades: true,
  };

  const specs: BacktestSpec[] = [];
  for (const strategy of config.strategies) {
    for (const fillModel of config.fillModels) {
      for (const latencyMs of config.latencyMs) {
        specs.push({
          strategy,
          strategyParams: config.strategyParams?.[strategy] ?? {},
          fillModel,
          fillModelParams: {},
          latencyMs,
          feeModel: config.feeModel ?? 'kalshi_historical',
          feeModelParams: {},
        });
      }
    }
  }

  console.log(`running ${specs.length} backtest(s)\n`);
  const source = openLake();
  const runs: CompletedRun[] = [];
  try {
    for (const [i, spec] of specs.entries()) {
      process.stdout.write(
        `  [${i + 1}/${specs.length}] ${spec.strategy} / ${spec.fillModel} / ${spec.latencyMs}ms ... `,
      );
      // Checkpoint verification is identical for every row -- same data, same
      // reconstruction -- so it runs once and the rest inherit the verdict.
      const run = await runOne(source, request, spec, { write: true, verifyCheckpoints: i === 0 });
      runs.push(run);
      process.stdout.write(`${run.result.wallClockMs}ms\n`);
    }
  } finally {
    await source.close();
  }

  console.log(renderComparison(runs));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case 'describe':
        return await describe(args);
      case 'verify':
        return await verify(args);
      case 'backtest':
        return await backtest(args);
      case 'compare':
        return await compare(args);
      default:
        console.log(
          [
            'usage: npm run research -- <command> [flags]',
            '',
            'commands:',
            '  describe   resolve a dataset slice without reading it',
            '  verify     replay the book and check it against the recorded hashes',
            '  backtest   run one strategy',
            '  compare    run an experiment matrix from a YAML config',
            '',
            `strategies:  ${STRATEGY_NAMES.join(', ')}`,
            `fill models: ${FILL_MODEL_NAMES.join(', ')}`,
          ].join('\n'),
        );
    }
  } catch (err) {
    logger.error({ event: 'research_failed', err }, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
