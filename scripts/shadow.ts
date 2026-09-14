#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env, kalshiEndpoints } from '@/src/config/env';
import { KalshiSigner } from '@/src/kalshi/auth';
import { KalshiRestClient } from '@/src/kalshi/restClient';
import { LiveKalshiDataSource } from '@/src/research/data/liveKalshiSource';
import { BacktestEngine } from '@/src/research/engine/backtestEngine';
import { computeMarkouts, summarizeMarkouts } from '@/src/research/metrics/markouts';
import { computeExecutionQuality } from '@/src/research/metrics/executionQuality';
import { makeFillModel, makeLatencyModel, makeStrategy, STRATEGY_NAMES } from '@/src/research/registry';
import { makeFeeModel } from '@/src/research/registry';
import {
  toShadowFillRecords,
  toShadowOrderRecords,
} from '@/src/research/shadow/shadowRecord';
import { logger } from '@/src/logging/logger';

/**
 * SHADOW mode: run a strategy against the live Kalshi feed and submit nothing.
 *
 *   npm run shadow -- --strategy join-bbo --series KXHIGHNY --minutes 30
 *
 * The strategy is the same object a backtest runs. It cannot tell the
 * difference, which is the point: this compares the backtest's mechanics
 * against the same day's live market at zero capital risk.
 *
 * ---------------------------------------------------------------------------
 * The limitation, stated up front
 * ---------------------------------------------------------------------------
 * Shadow trading CANNOT calibrate queue position. Nothing is ever on the
 * exchange, so the exchange cannot report where in the FIFO it would have
 * been, and every queue figure in the output is the model's belief rather than
 * an observation. What this run validates is timing, signal behaviour and the
 * sensitivity of hypothetical fills to the queue assumption. Calibrating the
 * assumption itself needs real resting orders -- CALIBRATION mode -- and no
 * output here should be read as evidence about it.
 *
 * This process is NOT a collector. It opens a read-only subscription, writes
 * no session row, no raw frames and nothing to the recorded dataset.
 */

interface Args {
  flags: Map<string, string>;
  bools: Set<string>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
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
  return { flags, bools };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const e = env();

  const list = (name: string) =>
    args.flags.get(name)?.split(',').map((s) => s.trim()).filter(Boolean);

  const strategyName = args.flags.get('strategy') ?? 'join-bbo';
  const minutes = Number(args.flags.get('minutes') ?? 15);
  const latencyMs = Number(args.flags.get('latency-ms') ?? 100);
  const primaryFill = args.flags.get('fill-model') ?? 'conservative_queue';
  const counterfactualNames = (list('counterfactual-fills') ?? ['touch', 'queue_decay']).filter(
    (n) => n !== primaryFill,
  );

  if (!STRATEGY_NAMES.includes(strategyName as never)) {
    throw new Error(`unknown strategy "${strategyName}". Known: ${STRATEGY_NAMES.join(', ')}`);
  }
  if (!e.KALSHI_API_KEY_ID || !e.KALSHI_PRIVATE_KEY_PEM) {
    throw new Error('shadow mode needs KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PEM');
  }

  const signer = new KalshiSigner(e.KALSHI_API_KEY_ID, e.KALSHI_PRIVATE_KEY_PEM);
  const endpoints = kalshiEndpoints(e);
  const rest = new KalshiRestClient({ baseUrl: endpoints.rest, signer });

  const source = new LiveKalshiDataSource({
    wsUrl: endpoints.ws,
    restClient: rest,
    signer,
    marketTickers: list('markets'),
    runForMs: minutes * 60_000,
  });

  const request = {
    datasetId: e.DATASET_ID,
    // A live run has no historical window; the bounds are wide enough that no
    // event is ever filtered out by them.
    startTime: new Date(0),
    endTime: new Date(Date.now() + minutes * 60_000 + 3_600_000),
    seriesTickers: list('series'),
    marketTickers: list('markets'),
    includeTrades: true,
  };

  const strategy = makeStrategy(strategyName, JSON.parse(args.flags.get('strategy-params') ?? '{}'));

  const engine = new BacktestEngine({
    source,
    request,
    strategy,
    fillModel: makeFillModel(primaryFill),
    counterfactualFillModels: counterfactualNames.map((n) => makeFillModel(n)),
    // Fees are irrelevant to a hypothetical fill and would only add an
    // unverified number to a record that is about mechanics.
    feeModel: await makeFeeModel('zero'),
    latency: makeLatencyModel(latencyMs),
    // Live data has no independently recorded hashes to check against.
    verifyCheckpoints: false,
  });

  logger.info(
    {
      event: 'shadow_start',
      strategy: strategyName,
      minutes,
      latency_ms: latencyMs,
      primary_fill: primaryFill,
      counterfactuals: counterfactualNames,
    },
    `shadow: ${strategyName} for ${minutes} minute(s), submitting nothing`,
  );

  const started = new Date();
  const result = await engine.run();

  const markouts = computeMarkouts(result.fills, result.midSeries);
  const summary = summarizeMarkouts(markouts);
  const quality = computeExecutionQuality(result.orders, result.fills);
  const latencyDescribed = makeLatencyModel(latencyMs).describe();

  const runId = `shadow-${started.toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')}`;
  const dir = path.join(process.cwd(), 'research', 'shadow', runId);
  await mkdir(dir, { recursive: true });

  const orders = toShadowOrderRecords(result.orders, strategyName, {
    decisionMs: 0,
    submitMs: latencyMs,
  });

  const fillsByModel = [
    { model: primaryFill, fills: result.fills, markouts },
    ...result.counterfactuals.map((c) => ({
      model: c.fillModel,
      fills: c.fills,
      markouts: computeMarkouts(c.fills, result.midSeries),
    })),
  ];

  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        runId,
        mode: 'shadow',
        strategy: strategyName,
        strategyVersion: strategy.version,
        strategyParameters: strategy.parameters(),
        datasetId: e.DATASET_ID,
        primaryFillModel: primaryFill,
        counterfactualFillModels: counterfactualNames,
        latencyModel: latencyDescribed,
        markets: result.slice.marketTickers,
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        eventsObserved: result.counts.events,
        eventsDropped: source.droppedEvents,
        limitation:
          'Nothing was submitted, so no queue figure here is an observation. ' +
          'Queue position can only be calibrated by real resting orders.',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  await writeFile(
    path.join(dir, 'orders.json'),
    JSON.stringify(orders, null, 2) + '\n',
    'utf8',
  );
  for (const group of fillsByModel) {
    await writeFile(
      path.join(dir, `fills.${group.model}.json`),
      JSON.stringify(toShadowFillRecords(group.model, group.fills, group.markouts), null, 2) + '\n',
      'utf8',
    );
  }

  console.log(`\n=== shadow run ${runId} ===\n`);
  console.log(`  markets            ${result.slice.marketTickers.length}`);
  console.log(`  events observed    ${result.counts.events}` +
    (source.droppedEvents > 0 ? `  (${source.droppedEvents} DROPPED: consumer too slow)` : ''));
  console.log(`  hypothetical orders ${result.orders.length}`);
  console.log('');
  console.log('  hypothetical fills by queue assumption');
  for (const group of fillsByModel) {
    console.log(`    ${group.model.padEnd(22)} ${String(group.fills.length).padStart(6)}`);
  }
  console.log('');
  console.log(`  primary (${primaryFill}) execution edge, cents per contract`);
  for (const m of summary) {
    console.log(
      `    ${String(m.horizonMs).padStart(6)}ms  capture ${fmt(m.meanSpreadCapture)}  ` +
        `drift ${fmt(m.meanMidDrift)}  edge ${fmt(m.realizedEdge)}  n ${m.observations}`,
    );
  }
  console.log('');
  console.log(`  fill rate ${quality.fillRate} | cancel/fill ${quality.cancelToFillRatio ?? 'n/a'}`);
  console.log('');
  console.log(`  artifacts ${dir}`);
  console.log('');
  console.log('  NOTE  nothing was submitted. Every queue figure above is the model\'s belief,');
  console.log('        not an observation. Calibrating it needs real resting orders.');
  console.log('');
}

const fmt = (v: string | null) =>
  v === null ? '   n/a' : (Number(v) * 100).toFixed(3).padStart(7);

void main().catch((err) => {
  logger.error({ event: 'shadow_failed', err }, err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
