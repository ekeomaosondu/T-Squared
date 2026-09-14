import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BacktestRunResult } from '@/src/research/engine/backtestEngine';
import type { RunManifest } from '@/src/research/results/runManifest';
import type { RunSummary } from '@/src/research/metrics/performance';
import type { FillMarkout } from '@/src/research/metrics/markouts';
import { collateralRequired } from '@/src/research/portfolio/accounting';
import { logger } from '@/src/logging/logger';

/**
 * Writes a run's artifacts.
 *
 * Local files by default. Object storage goes through {@link ResultPublisher}
 * and is strictly optional: needing network access to run a backtest would
 * make the fastest part of the research loop depend on the slowest.
 *
 * Parquet is written by DuckDB with EXPLICIT column types, for the same reason
 * the silver lake does. Inferred types silently make an ordering key a VARCHAR
 * and a price a DOUBLE, and neither failure announces itself -- the queries
 * still run, they are just wrong. Prices and quantities are DECIMAL(24,6),
 * timestamps are BIGINT.
 */

export interface ResultPublisher {
  readonly kind: string;
  publish(runId: string, relativePath: string, body: Buffer): Promise<void>;
}

export interface ResultWriterOptions {
  /** Root for run directories. Default `research/backtests`. */
  root?: string;
  publisher?: ResultPublisher;
}

/** Explicit Parquet types per output table. */
const COLUMN_TYPES: Record<string, string> = {
  // timestamps and counters
  submitted_at_ms: 'BIGINT',
  effective_at_ms: 'BIGINT',
  rested_at_ms: 'BIGINT',
  cancel_requested_at_ms: 'BIGINT',
  cancel_effective_at_ms: 'BIGINT',
  terminal_at_ms: 'BIGINT',
  arrived_at_ms: 'BIGINT',
  filled_at_ms: 'BIGINT',
  at_ms: 'BIGINT',
  horizon_ms: 'BIGINT',
  fill_count: 'INTEGER',

  // exact money and size
  price: 'DECIMAL(24,6)',
  yes_price: 'DECIMAL(24,6)',
  quantity: 'DECIMAL(24,6)',
  filled_quantity: 'DECIMAL(24,6)',
  remaining_quantity: 'DECIMAL(24,6)',
  fee: 'DECIMAL(24,6)',
  queue_ahead_at_entry: 'DECIMAL(24,6)',
  queue_ahead_before_fill: 'DECIMAL(24,6)',
  mid_at_fill: 'DECIMAL(24,6)',
  spread_at_fill: 'DECIMAL(24,6)',
  depth_1_at_fill: 'DECIMAL(24,6)',
  imbalance_1_at_fill: 'DECIMAL(24,8)',
  reference_price: 'DECIMAL(24,6)',
  markout: 'DECIMAL(24,8)',
  markout_dollars: 'DECIMAL(24,6)',
  average_entry_price: 'DECIMAL(24,6)',
  realized_pnl: 'DECIMAL(24,6)',
  unrealized_pnl: 'DECIMAL(24,6)',
  gross_pnl: 'DECIMAL(24,6)',
  net_pnl: 'DECIMAL(24,6)',
  fees_paid: 'DECIMAL(24,6)',
  cash: 'DECIMAL(24,6)',
  net_inventory: 'DECIMAL(24,6)',
  abs_inventory: 'DECIMAL(24,6)',
  collateral: 'DECIMAL(24,6)',
  unmarked_quantity: 'DECIMAL(24,6)',
  unmarked_positions: 'INTEGER',
};

function typedProjection(columns: string[]): string {
  return columns
    .map((c) => {
      const type = COLUMN_TYPES[c];
      return type ? `CAST("${c}" AS ${type}) AS "${c}"` : `"${c}"`;
    })
    .join(', ');
}

export class ResultWriter {
  private readonly root: string;
  private readonly publisher?: ResultPublisher;

  constructor(opts: ResultWriterOptions = {}) {
    this.root = opts.root ?? path.join(process.cwd(), 'research', 'backtests');
    this.publisher = opts.publisher;
  }

  runDirectory(runId: string): string {
    return path.join(this.root, runId);
  }

  async write(
    manifest: RunManifest,
    summary: RunSummary,
    result: BacktestRunResult,
    markouts: readonly FillMarkout[],
  ): Promise<{ directory: string; files: string[] }> {
    const dir = this.runDirectory(manifest.runId);
    await mkdir(dir, { recursive: true });

    const files: string[] = [];
    const json = async (name: string, value: unknown) => {
      const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
      await writeFile(path.join(dir, name), body);
      await this.publisher?.publish(manifest.runId, name, body);
      files.push(name);
    };

    await json('manifest.json', manifest);
    await json('summary.json', summary);

    await this.parquet(dir, 'orders.parquet', ordersRows(result), files, manifest.runId);
    await this.parquet(dir, 'fills.parquet', fillsRows(result), files, manifest.runId);
    await this.parquet(dir, 'positions.parquet', positionsRows(result), files, manifest.runId);
    await this.parquet(dir, 'pnl.parquet', pnlRows(result), files, manifest.runId);
    await this.parquet(dir, 'markouts.parquet', markoutRows(markouts), files, manifest.runId);

    logger.info(
      { event: 'research_run_written', run_id: manifest.runId, directory: dir, files: files.length },
      `run ${manifest.runId}: ${files.length} artifact(s) in ${dir}`,
    );

    return { directory: dir, files };
  }

  /**
   * Writes one table.
   *
   * An EMPTY table still produces a file. A missing fills.parquet is
   * ambiguous -- did the strategy never trade, or did the run fail? -- and
   * ambiguity in a results directory is how a broken run gets read as a
   * negative finding.
   */
  private async parquet(
    dir: string,
    name: string,
    rows: Record<string, unknown>[],
    files: string[],
    runId: string,
  ): Promise<void> {
    const target = path.join(dir, name);
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const conn = await (await DuckDBInstance.create(':memory:')).connect();
    await conn.run(`SET TimeZone = 'UTC'`);

    const esc = (p: string) => p.replace(/'/g, "''");

    if (rows.length === 0) {
      await conn.run(
        `COPY (SELECT NULL::VARCHAR AS run_id WHERE false) TO '${esc(target)}' ` +
          `(FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
    } else {
      const ndjson = path.join(dir, `.${name}.ndjson`);
      await writeFile(
        ndjson,
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8',
      );
      const projection = typedProjection(Object.keys(rows[0]!));
      await conn.run(
        `COPY (SELECT ${projection} FROM read_json_auto('${esc(ndjson)}')) ` +
          `TO '${esc(target)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
      await rm(ndjson, { force: true });
    }

    conn.closeSync();
    files.push(name);

    if (this.publisher) {
      const { readFile } = await import('node:fs/promises');
      await this.publisher.publish(runId, name, await readFile(target));
    }
  }
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

const s = (v: { toFixed(dp: number): string } | null | undefined, dp = 6): string | null =>
  v === null || v === undefined ? null : v.toFixed(dp);
const b = (v: bigint | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();

function ordersRows(result: BacktestRunResult): Record<string, unknown>[] {
  return result.orders.map((o) => ({
    order_id: o.orderId,
    client_order_id: o.clientOrderId,
    market_ticker: o.marketTicker,
    side: o.side,
    action: o.action,
    yes_action: o.yesAction,
    price: s(o.price),
    yes_price: s(o.yesPrice),
    quantity: s(o.quantity),
    filled_quantity: s(o.filledQuantity),
    status: o.status,
    time_in_force: o.timeInForce,
    tag: o.tag ?? null,
    submitted_at_ms: b(o.submittedAtMs),
    effective_at_ms: b(o.effectiveAtMs),
    rested_at_ms: b(o.restedAtMs),
    cancel_requested_at_ms: b(o.cancelRequestedAtMs),
    cancel_effective_at_ms: b(o.cancelEffectiveAtMs),
    terminal_at_ms: b(o.terminalAtMs),
    reject_reason: o.rejectReason,
  }));
}

function fillsRows(result: BacktestRunResult): Record<string, unknown>[] {
  return result.fills.map((f) => ({
    fill_id: f.fillId,
    order_id: f.orderId,
    client_order_id: f.clientOrderId,
    market_ticker: f.marketTicker,
    side: f.side,
    action: f.action,
    yes_action: f.yesAction,
    price: s(f.price),
    yes_price: s(f.yesPrice),
    quantity: s(f.quantity),
    liquidity: f.liquidity,
    reason: f.reason,
    fee: s(f.fee),
    submitted_at_ms: b(f.submittedAtMs),
    arrived_at_ms: b(f.arrivedAtMs),
    filled_at_ms: b(f.filledAtMs),
    queue_ahead_at_entry: s(f.queueAheadAtEntry),
    queue_ahead_before_fill: s(f.queueAheadBeforeFill),
    fill_model: f.fillModel,
    book_state_hash: f.bookStateHash,
    triggering_trade_id: f.triggeringTradeId,
    mid_at_fill: s(f.midAtFill),
    spread_at_fill: s(f.spreadAtFill),
    depth_1_at_fill: s(f.depth1AtFill),
    imbalance_1_at_fill: s(f.imbalance1AtFill, 8),
    tag: f.tag ?? null,
  }));
}

function positionsRows(result: BacktestRunResult): Record<string, unknown>[] {
  return result.portfolio.allPositions().map((p) => ({
    market_ticker: p.marketTicker,
    quantity: s(p.quantity),
    average_entry_price: s(p.averageEntryPrice),
    realized_pnl: s(p.realizedPnl),
    fees_paid: s(p.feesPaid),
    bought_quantity: s(p.boughtQuantity),
    sold_quantity: s(p.soldQuantity),
    notional: s(p.notional),
    fill_count: p.fillCount,
    collateral: s(collateralRequired(p)),
    settled: p.settled,
    settlement_outcome: p.settlementOutcome,
  }));
}

function pnlRows(result: BacktestRunResult): Record<string, unknown>[] {
  return result.equityCurve.map((row) => ({
    at_ms: row.atMs,
    cash: row.cash,
    realized_pnl: row.realizedPnl,
    unrealized_pnl: row.unrealizedPnl,
    gross_pnl: row.grossPnl,
    net_pnl: row.netPnl,
    fees_paid: row.feesPaid,
    net_inventory: row.netInventory,
    abs_inventory: row.absInventory,
    collateral: row.collateral,
    unmarked_positions: row.unmarkedPositions,
    unmarked_quantity: row.unmarkedQuantity,
  }));
}

/** One row per (fill, horizon): tall, so a new horizon is a filter not a column. */
function markoutRows(markouts: readonly FillMarkout[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const m of markouts) {
    for (const [horizon, value] of Object.entries(m.markouts)) {
      rows.push({
        fill_id: m.fillId,
        order_id: m.orderId,
        market_ticker: m.marketTicker,
        filled_at_ms: m.filledAtMs,
        liquidity: m.liquidity,
        reason: m.reason,
        yes_action: m.yesAction,
        yes_price: m.yesPrice,
        quantity: m.quantity,
        reference: m.reference,
        reference_price: m.referencePrice,
        horizon_ms: horizon,
        markout: value,
        markout_dollars: m.markoutDollars[horizon] ?? null,
      });
    }
  }
  return rows;
}
