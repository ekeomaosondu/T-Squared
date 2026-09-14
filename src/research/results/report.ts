import { Decimal } from '@/src/book/decimal';
import type { RunSummary } from '@/src/research/metrics/performance';
import type { RunManifest } from '@/src/research/results/runManifest';
import type { CompletedRun } from '@/src/research/engine/runBacktest';

/**
 * Human-readable run and comparison reports.
 *
 * Deliberately opinionated about what appears FIRST. Absolute PnL is not the
 * headline, because at Phase 1 it is not the trustworthy number: the queue
 * model is uncalibrated, so the fill count -- and therefore the PnL -- is a
 * modelling choice. Replay equality comes first because nothing below it means
 * anything if the book was wrong, and markouts come before PnL because they
 * survive being wrong about the queue.
 */

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);
const money = (v: string | null | undefined) =>
  v === null || v === undefined ? 'n/a' : new Decimal(v).toFixed(2);
const cents = (v: string | null | undefined) =>
  v === null || v === undefined ? 'n/a' : new Decimal(v).mul(100).toFixed(3);
const rate = (v: string | null | undefined) =>
  v === null || v === undefined ? 'n/a' : new Decimal(v).toFixed(3);

export function renderRun(manifest: RunManifest, summary: RunSummary): string {
  const lines: string[] = [];
  const eq = summary.replayEquality;

  lines.push('');
  lines.push(`run ${manifest.runId}`);
  lines.push(
    `  ${manifest.strategyName} v${manifest.strategyVersion} | fill=${manifest.fillModel} | ` +
      `latency=${JSON.stringify(manifest.latencyModel)} | ` +
      `fees=${JSON.stringify(manifest.feeModel)}`,
  );
  lines.push(`  dataset ${manifest.datasetId} @ ${manifest.datasetFingerprint.slice(0, 12)}`);
  lines.push(`  ${manifest.startTime} -> ${manifest.endTime}`);
  lines.push('');

  lines.push(
    `  replay equality   ${eq.matched}/${eq.compared} ${eq.exact ? 'EXACT' : '*** MISMATCH ***'}`,
  );
  if (eq.compared === 0) {
    lines.push('                    (no recorded checkpoints in this window; book unverified)');
  }
  lines.push(
    `  coverage          ${summary.coverage.markets} markets | ${summary.coverage.events} events | ` +
      `${summary.coverage.captureGaps} capture gap(s) | ${summary.coverage.invalidIntervals} invalid interval(s)`,
  );
  lines.push('');

  const x = summary.execution;
  lines.push(
    `  orders            ${x.ordersSubmitted} submitted | ${x.ordersRested} rested | ` +
      `${x.ordersCancelled} cancelled | ${x.ordersRejected} rejected`,
  );
  lines.push(
    `  fills             ${x.fills} (${x.makerFills} maker, ${x.takerFills} taker) | ` +
      `fill rate ${x.fillRate} | cancel/fill ${x.cancelToFillRatio ?? 'n/a'}`,
  );
  lines.push(
    `  volume            ${new Decimal(x.contractVolume).toFixed(1)} contracts | ` +
      `$${new Decimal(x.notional).toFixed(2)} notional | $${new Decimal(x.fees).toFixed(2)} fees`,
  );
  lines.push(
    `  spread captured   ${cents(x.averageSpreadCaptured)}c/contract over ${x.spreadCapturedObservations} maker fill(s)`,
  );
  lines.push(
    `  queue ahead       ${x.meanQueueAheadAtEntry ?? 'n/a'} mean at entry | reasons ${JSON.stringify(x.fillReasons)}`,
  );
  lines.push('');

  lines.push('  markouts (cents per contract, positive = favourable)');
  lines.push(
    `    ${pad('horizon', 10)}${rpad('markout', 10)}${rpad('median', 10)}` +
      `${rpad('drift', 10)}${rpad('adverse', 9)}${rpad('n', 8)}${rpad('unobs', 8)}`,
  );
  for (const m of summary.markouts) {
    lines.push(
      `    ${pad(`${m.horizonMs}ms`, 10)}${rpad(cents(m.meanMarkout), 10)}` +
        `${rpad(cents(m.medianMarkout), 10)}${rpad(cents(m.meanMidDrift), 10)}` +
        `${rpad(rate(m.adverseRate), 9)}` +
        `${rpad(String(m.observations), 8)}${rpad(String(m.unobserved), 8)}`,
    );
  }
  lines.push(
    '    markout is measured from the FILL PRICE and therefore includes the half-spread a',
  );
  lines.push(
    '    maker earns by construction. drift removes it: it is the same measurement from the',
  );
  lines.push(
    '    mid at the fill, and it is the one that says whether we were picked off.',
  );
  lines.push('');

  const p = summary.pnl;
  lines.push(`  gross PnL         $${money(p.grossPnl)}`);
  lines.push(`  fees              $${money(p.fees)}`);
  lines.push(`  net PnL           $${money(p.netPnl)}   (per day $${money(p.pnlPerDay)})`);
  lines.push(`  max drawdown      $${money(p.maxDrawdown)}`);
  lines.push(
    `  inventory         mean |q| ${summary.inventory.meanAbsInventory ?? 'n/a'} | ` +
      `max |q| ${new Decimal(summary.inventory.maxAbsInventory).toFixed(1)} | ` +
      `max collateral $${money(summary.inventory.maxCollateral)}`,
  );
  if (Number(p.finalAbsInventory) > 0) {
    lines.push(
      `  NOTE              ${new Decimal(p.finalAbsInventory).toFixed(1)} contracts still open across ` +
        `${p.finalPositionsOpen} market(s); that part of net PnL is a mark, not a result. ` +
        'Phase 1 does not settle -- the lake carries no lifecycle events.',
    );
  }
  if (p.unmarkedPositions > 0) {
    lines.push(
      `  NOTE              ${p.unmarkedPositions} open position(s), ` +
        `${new Decimal(p.unmarkedQuantity).toFixed(1)} contracts, have NO mark (one-sided book) ` +
        'and are excluded from the PnL above rather than priced at a guess.',
    );
  }
  lines.push('');
  lines.push(
    `  ${summary.performance.eventsPerSecond} events/s | ${summary.performance.wallClockMs}ms wall | ` +
      `${(summary.performance.peakRssBytes / 1e6).toFixed(0)}MB peak RSS`,
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * The comparison table.
 *
 * Ordered so the execution-quality columns sit to the LEFT of PnL. A reader
 * scanning left to right meets fill rate, spread captured and markout before
 * they meet a dollar figure, which is the order in which those numbers deserve
 * to be trusted at this stage.
 */
export function renderComparison(runs: readonly CompletedRun[]): string {
  const header = [
    pad('strategy', 22),
    pad('fill', 20),
    rpad('lat', 5),
    rpad('fills', 7),
    rpad('rate', 7),
    rpad('spr(c)', 8),
    rpad('mk1s', 8),
    rpad('dr100', 8),
    rpad('dr1s', 8),
    rpad('dr30s', 8),
    rpad('adv', 7),
    rpad('mean|q|', 9),
    rpad('max|q|', 8),
    rpad('net$', 10),
    rpad('fees$', 8),
  ].join('');

  const rows = runs.map((run) => {
    const s = run.summary;
    const at = (h: number) => s.markouts.find((x) => x.horizonMs === h);
    return [
      pad(run.manifest.strategyName, 22),
      pad(run.manifest.fillModel, 20),
      rpad(String((run.manifest.latencyModel.marketDataMs as number | undefined) ?? 0), 5),
      rpad(String(s.execution.fills), 7),
      rpad(new Decimal(s.execution.fillRate).toFixed(3), 7),
      rpad(cents(s.execution.averageSpreadCaptured), 8),
      rpad(cents(at(1_000)?.meanMarkout), 8),
      rpad(cents(at(100)?.meanMidDrift), 8),
      rpad(cents(at(1_000)?.meanMidDrift), 8),
      rpad(cents(at(30_000)?.meanMidDrift), 8),
      rpad(rate(s.adverseSelectionRate), 7),
      rpad(
        s.inventory.meanAbsInventory === null
          ? 'n/a'
          : new Decimal(s.inventory.meanAbsInventory).toFixed(1),
        9,
      ),
      rpad(new Decimal(s.inventory.maxAbsInventory).toFixed(0), 8),
      rpad(money(s.pnl.netPnl), 10),
      rpad(money(s.pnl.fees), 8),
    ].join('');
  });

  const equality = runs
    .map((r) => r.summary.replayEquality)
    .filter((e) => e.compared > 0);
  const allExact = equality.length > 0 && equality.every((e) => e.exact);

  return [
    '',
    header,
    '-'.repeat(header.length),
    ...rows,
    '',
    'columns, all in cents per contract, positive = favourable:',
    '  spr    mean half-spread captured per maker fill',
    '  mk1s   total markout at 1s, from the fill price -- includes spr by construction',
    '  drNN   mid DRIFT at that horizon, i.e. the same measurement with spr removed.',
    '         This is the adverse-selection column. mk minus spr should equal dr.',
    '  adv    share of fills the mid moved against within 1s',
    '',
    equality.length === 0
      ? 'book NOT verified: no recorded checkpoints in this window.'
      : allExact
        ? `book verified: ${equality[0]!.matched}/${equality[0]!.compared} checkpoint hashes exact.`
        : '*** BOOK MISMATCH: these results were computed on a book that is not the one that existed. ***',
    '',
    'Absolute PnL is NOT a prediction of live performance. The queue model is not yet',
    'calibrated against real fills, so the fill count -- and everything downstream of it --',
    'is a modelling assumption. Read the relative ordering and the drift columns.',
    '',
    'net$ also carries end-of-window inventory marked at the last mid, because Phase 1',
    'does not settle. Where mean|q| is large, net$ is mostly that mark.',
    '',
  ].join('\n');
}
