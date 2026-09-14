#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { env, kalshiEndpoints } from '@/src/config/env';
import { KalshiSigner } from '@/src/kalshi/auth';
import { KalshiRestClient } from '@/src/kalshi/restClient';
import { KalshiTradingClient } from '@/src/kalshi/tradingClient';
import { closeDb, db } from '@/src/persistence/db';
import { LiveKalshiDataSource } from '@/src/research/data/liveKalshiSource';
import { KalshiPrivateFeed } from '@/src/research/calibration/privateFeed';
import {
  CalibrationRunner,
  CALIBRATION_DEFAULTS,
  type CalibrationConfig,
} from '@/src/research/calibration/calibrationRunner';
import { CALIBRATION_V0 } from '@/src/research/calibration/riskEnvelope';
import { makeFillModel } from '@/src/research/registry';
import { logger } from '@/src/logging/logger';

/**
 * CALIBRATION mode.
 *
 *   npm run calibrate -- preflight              verify everything, place nothing
 *   npm run calibrate -- run --dry-run --minutes 10
 *   npm run calibrate -- run --minutes 60       REAL ORDERS
 *
 * `preflight` exists because this is the first code in the repository that
 * spends money. It exercises every private endpoint the runner depends on and
 * prints what came back, so a shape mismatch or a permission problem surfaces
 * before an order does rather than in the middle of one.
 *
 * A live run needs --i-understand-this-places-real-orders. Not ceremony: the
 * difference between this and every other command here is that a typo costs
 * cash, and one deliberate flag is cheap insurance against a wrong shell
 * history recall.
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

const DEFAULT_SERIES = ['KXHIGHNY', 'KXHIGHLAX'];

function clients() {
  const e = env();
  if (!e.KALSHI_API_KEY_ID || !e.KALSHI_PRIVATE_KEY_PEM) {
    throw new Error('calibration needs KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PEM');
  }
  const signer = new KalshiSigner(e.KALSHI_API_KEY_ID, e.KALSHI_PRIVATE_KEY_PEM);
  const endpoints = kalshiEndpoints(e);
  return {
    e,
    signer,
    endpoints,
    rest: new KalshiRestClient({ baseUrl: endpoints.rest, signer }),
    trading: new KalshiTradingClient({ baseUrl: endpoints.rest, signer }),
  };
}

/**
 * Exercises every private read path and the private feed. Places nothing.
 *
 * Failures here are expected on the first run and are the point: they tell us
 * which endpoint path or response shape differs from what the client assumes,
 * while the cost of being wrong is a printed error rather than a stray order.
 */
async function preflight(args: Args): Promise<void> {
  const { e, signer, endpoints, trading } = clients();
  const results: { name: string; ok: boolean; detail: string; ms: number | null }[] = [];

  const check = async <T>(name: string, fn: () => Promise<{ timing: { latencyMs: number } } & { value: T }>, describe: (v: T) => string) => {
    try {
      const out = await fn();
      results.push({ name, ok: true, detail: describe(out.value), ms: out.timing.latencyMs });
    } catch (err) {
      results.push({
        name,
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
        ms: null,
      });
    }
  };

  console.log(`\n=== calibration preflight (${e.KALSHI_ENV}) ===\n`);
  console.log(`  rest  ${endpoints.rest}`);
  console.log(`  ws    ${endpoints.ws}`);
  console.log(`  key   ${e.KALSHI_API_KEY_ID.slice(0, 6)}…\n`);

  await check('portfolio balance', () => trading.getBalance(), (v) => `balance ${v.dollars ?? 'unknown'}`);
  await check('resting orders', () => trading.listOrders({ status: 'resting' }), (v) => `${v.length} resting`);
  // Scoped to a real market, because the endpoint rejects an unscoped request.
  // With no resting orders it should return an empty list rather than an error,
  // which is what confirms the path and the scoping are right.
  const probeMarkets = (args.flags.get('series')?.split(',') ?? DEFAULT_SERIES)[0];
  let scopeTicker: string | null = null;
  try {
    const markets = await clients().rest.getMarkets({ seriesTicker: probeMarkets, status: 'open' });
    scopeTicker = markets[0]?.ticker ?? null;
  } catch {
    scopeTicker = null;
  }
  if (scopeTicker) {
    await check(
      'bulk queue positions',
      () => trading.getQueuePositions([scopeTicker!]),
      (v) => `scoped to ${scopeTicker}: ${v.length} order(s) reported`,
    );
  } else {
    results.push({
      name: 'bulk queue positions',
      ok: false,
      detail: 'no open market to scope the request to',
      ms: null,
    });
  }
  await check('positions', () => trading.getPositions(), (v) => `${v.length} market position(s)`);

  // The V2 create-order path, verified WITHOUT placing an order.
  //
  // A real market with an impossible price: if the path, auth and body shape
  // are right the exchange answers 400 invalid_parameters, and nothing can
  // rest or fill at a price of zero. This is the check that would have caught
  // the 410 deprecated_v1_order_endpoint before a run rather than after 23
  // rejected probes.
  if (scopeTicker) {
    const path = '/trade-api/v2/portfolio/events/orders';
    try {
      const res = await fetch(`${endpoints.rest}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...signer.headers('POST', path),
        },
        body: JSON.stringify({
          ticker: scopeTicker,
          side: 'bid',
          count: '1.00',
          price: '0.0000',
          time_in_force: 'good_till_canceled',
          self_trade_prevention_type: 'maker',
          post_only: true,
          cancel_order_on_pause: true,
          client_order_id: `preflight-${Date.now()}`,
        }),
      });
      const text = (await res.text()).slice(0, 160);
      results.push({
        name: 'v2 create-order path',
        // 400 is the PASS: the route existed, authenticated, resolved the
        // market and got as far as validating the price. The exact error code
        // varies (invalid_price, invalid_parameters), so the STATUS is what is
        // asserted -- 404 means the path moved, 410 means it was deprecated,
        // and those are the failures this check exists to catch.
        ok: res.status === 400,
        detail:
          res.status === 400
            ? `route reachable; rejected the impossible price as expected (${text})`
            : `${res.status} ${text}`,
        ms: null,
      });
    } catch (err) {
      results.push({ name: 'v2 create-order path', ok: false, detail: String(err), ms: null });
    }
  }

  // The private feed, connected and subscribed but never used to trade.
  const feed = new KalshiPrivateFeed({ wsUrl: endpoints.ws, signer });
  let feedUp = false;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        feed.once('up', () => {
          feedUp = true;
          resolve();
        });
      }),
      feed.start().then(() => new Promise<void>((r) => setTimeout(r, 4_000))),
    ]);
  } catch (err) {
    results.push({ name: 'private feed', ok: false, detail: String(err), ms: null });
  }
  if (feedUp) {
    results.push({ name: 'private feed', ok: true, detail: 'connected and subscribed', ms: null });
  } else if (!results.some((r) => r.name === 'private feed')) {
    results.push({
      name: 'private feed',
      ok: false,
      detail: 'did not report subscribed within 4s',
      ms: null,
    });
  }
  await feed.stop();

  // Market data and book health, from the same source the runner will use.
  const source = new LiveKalshiDataSource({
    wsUrl: endpoints.ws,
    restClient: clients().rest,
    signer,
    runForMs: 8_000,
  });
  try {
    const request = {
      datasetId: e.DATASET_ID,
      startTime: new Date(0),
      endTime: new Date(Date.now() + 3_600_000),
      seriesTickers: args.flags.get('series')?.split(',') ?? DEFAULT_SERIES,
      includeTrades: true,
    };
    const slice = await source.describe(request);
    results.push({
      name: 'market universe',
      ok: slice.marketTickers.length > 0,
      detail: `${slice.marketTickers.length} open market(s) across ${request.seriesTickers.length} series`,
      ms: null,
    });
  } catch (err) {
    results.push({ name: 'market universe', ok: false, detail: String(err), ms: null });
  } finally {
    await source.close();
  }

  for (const r of results) {
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(24)} ${r.detail}` +
        (r.ms === null ? '' : `  (${r.ms}ms)`),
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? '\nPASS: every private endpoint the runner needs is reachable.\n'
      : `\nFAIL: ${failed.length} check(s) failed. Fix these before placing any order.\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

async function run(args: Args): Promise<void> {
  const { e, signer, endpoints, rest, trading } = clients();
  const dryRun = args.bools.has('dry-run');

  if (!dryRun && !args.bools.has('i-understand-this-places-real-orders')) {
    console.error(
      '\nA live calibration run places REAL orders with real money.\n' +
        'Re-run with --i-understand-this-places-real-orders, or add --dry-run.\n',
    );
    process.exitCode = 1;
    return;
  }
  if (!dryRun && e.KALSHI_ENV !== 'production' && !args.bools.has('allow-demo')) {
    console.error(`\nKALSHI_ENV is "${e.KALSHI_ENV}". Pass --allow-demo to run there anyway.\n`);
    process.exitCode = 1;
    return;
  }

  const minutes = Number(args.flags.get('minutes') ?? 30);
  const series = args.flags.get('series')?.split(',').map((s) => s.trim()) ?? DEFAULT_SERIES;

  const source = new LiveKalshiDataSource({
    wsUrl: endpoints.ws,
    restClient: rest,
    signer,
    runForMs: minutes * 60_000,
  });
  const privateFeed = new KalshiPrivateFeed({ wsUrl: endpoints.ws, signer });

  const config: CalibrationConfig = {
    envelope: CALIBRATION_V0,
    seriesTickers: series,
    runForMs: minutes * 60_000,
    queuePollIntervalMs: Number(
      args.flags.get('queue-poll-ms') ?? CALIBRATION_DEFAULTS.queuePollIntervalMs,
    ),
    cooldownMinMs: CALIBRATION_DEFAULTS.cooldownMinMs,
    cooldownMaxMs: CALIBRATION_DEFAULTS.cooldownMaxMs,
    expirationSlackMs: CALIBRATION_DEFAULTS.expirationSlackMs,
    dryRun,
    // Every historical fill model, evaluated on the same real orders. This is
    // the comparison the whole experiment exists to make possible.
    fillModels: ['touch', 'conservative_queue', 'queue_decay'].map((n) => makeFillModel(n)),
  };

  const sql = db();
  const runner = new CalibrationRunner(
    { sql, source, trading, privateFeed, datasetId: e.DATASET_ID, kalshiEnv: e.KALSHI_ENV },
    config,
  );

  console.log(`\n=== calibration ${dryRun ? 'DRY RUN' : 'LIVE'} ===`);
  console.log(`  series      ${series.join(', ')}`);
  console.log(`  duration    ${minutes} minute(s)`);
  console.log(`  size        ${config.envelope.orderSize} contract, post-only, no repricing`);
  console.log(`  resting     max ${config.envelope.maxRestingOrders} total, ${config.envelope.maxRestingPerMarket} per market`);
  console.log(`  exposure    max $${config.envelope.maxWorstCaseExposureUsd} worst case`);
  console.log(`  queue poll  every ${config.queuePollIntervalMs}ms, bulk endpoint\n`);

  const stop = () => {
    logger.warn({ event: 'calibration_interrupt' }, 'interrupt received; cancelling probes');
    void source.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const outcome = await runner.run();
    console.log(`\nrun ${outcome.runId} ended: ${outcome.stopReason}` +
      (outcome.detail ? ` -- ${outcome.detail}` : ''));
    await printSummary(sql, outcome.runId);
  } finally {
    await source.close().catch(() => {});
    await privateFeed.stop().catch(() => {});
    await closeDb();
  }
}

async function printSummary(sql: ReturnType<typeof db>, runId: string): Promise<void> {
  const probes = (await sql`
    SELECT g.terminal_state, g.n FROM (
      SELECT p.terminal_state, count(*) AS n
        FROM calibration_probes p WHERE p.run_id = ${runId}
       GROUP BY p.terminal_state) AS g ORDER BY g.n DESC
  `) as unknown as Record<string, unknown>[];

  const obs = (await sql`
    SELECT count(*) AS n FROM calibration_queue_observations o
     WHERE o.probe_id IN (SELECT p.probe_id FROM calibration_probes p WHERE p.run_id = ${runId})
  `) as unknown as Record<string, unknown>[];

  const blocked = (await sql`
    SELECT g.reason, g.n FROM (
      SELECT c.reason, count(*) AS n FROM calibration_events c
       WHERE c.run_id = ${runId} AND c.kind = 'blocked' GROUP BY c.reason) AS g
     ORDER BY g.n DESC LIMIT 8
  `) as unknown as Record<string, unknown>[];

  console.log('\n  probes by outcome');
  for (const r of probes) console.log(`    ${String(r.terminal_state).padEnd(14)} ${r.n}`);
  console.log(`\n  queue observations  ${obs[0]?.n ?? 0}`);
  if (blocked.length > 0) {
    console.log('\n  probes declined, by reason');
    for (const r of blocked) console.log(`    ${String(r.reason).padEnd(26)} ${r.n}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case 'preflight':
        return await preflight(args);
      case 'run':
        return await run(args);
      default:
        console.log(
          [
            'usage: npm run calibrate -- <command> [flags]',
            '',
            '  preflight   verify every private endpoint and the feeds; place nothing',
            '  run         run the probe loop',
            '',
            'flags:',
            '  --dry-run                                    full loop, no orders sent',
            '  --i-understand-this-places-real-orders       required for a live run',
            '  --minutes N        --series A,B              --queue-poll-ms N',
          ].join('\n'),
        );
    }
  } catch (err) {
    logger.error({ event: 'calibration_failed', err }, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main().finally(() => {
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
