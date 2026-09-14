import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sql } from '@/src/persistence/db';
import { sha256, type ArchiveStore } from '@/src/persistence/archiveStore';
import { logger } from '@/src/logging/logger';

/**
 * The execution-calibration dataset, exported to the lake.
 *
 * Kept apart from the market-data tables because it is a different kind of
 * thing: those record what the exchange published to everyone, this records
 * what happened to OUR orders. Mixing them would make it easy to write a study
 * that silently conditions market-wide statistics on our own participation.
 *
 * Partitioned by the day of the run rather than by trading day. A calibration
 * run is an experiment with a start and an end; its rows belong together.
 */

interface Spec {
  table: string;
  lake: string;
  select: string;
  dayExpr: string;
  order: string;
}

const SPECS: Spec[] = [
  {
    table: 'calibration_probes',
    lake: 'probes',
    dayExpr: "to_char(date_trunc('day', p.decision_ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
    select: `p.probe_id, p.run_id, p.market_ticker, p.series_ticker, p.event_ticker,
             p.depth_stratum, p.flow_stratum, p.probe_side, p.planned_dwell_ms,
             p.decision_ts_ms, p.book_hash_at_decision,
             p.decision_bid, p.decision_ask, p.decision_bid_size, p.decision_ask_size,
             p.decision_mid, p.decision_imbalance_1, p.decision_imbalance_3,
             p.displayed_size_at_entry,
             p.client_order_id, p.order_id, p.order_side, p.price_cents, p.yes_price, p.quantity,
             p.http_send_ts_ms, p.http_ack_ts_ms, p.submit_latency_ms, p.http_status,
             p.private_ack_ts_ms,
             p.initial_queue_position, p.initial_queue_send_ts_ms, p.initial_queue_recv_ts_ms,
             p.cancel_decision_ts_ms, p.cancel_send_ts_ms, p.cancel_ack_ts_ms, p.cancel_latency_ms,
             p.fill_exchange_ts_ms, p.fill_receive_ts_ms, p.fill_price, p.fill_quantity,
             p.fill_fee, p.fill_queue_before,
             p.terminal_state, p.censored, p.reject_reason`,
    order: 'p.decision_ts_ms, p.probe_id',
  },
  {
    table: 'calibration_queue_observations',
    lake: 'queue_observations',
    dayExpr: "to_char(date_trunc('day', pr.decision_ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
    select: `p.probe_id, pr.run_id, pr.market_ticker, pr.probe_side, p.seq_no,
             p.poll_send_ts_ms, p.poll_receive_ts_ms, p.time_since_entry_ms,
             p.queue_position, p.displayed_level_size,
             p.best_bid, p.best_ask, p.best_bid_size, p.best_ask_size,
             p.imbalance_1, p.imbalance_3,
             p.cum_executed_at_price, p.cum_removed_at_price, p.cum_added_at_price,
             p.cum_trades_at_price`,
    order: 'p.probe_id, p.seq_no',
  },
  {
    table: 'calibration_counterfactuals',
    lake: 'counterfactuals',
    dayExpr: "to_char(date_trunc('day', pr.decision_ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
    select: `p.probe_id, pr.run_id, pr.market_ticker, pr.probe_side,
             pr.terminal_state AS real_outcome, pr.initial_queue_position AS real_queue_at_entry,
             p.fill_model, p.fill_model_parameters::text AS fill_model_parameters_json,
             p.would_fill, p.fill_time_ms, p.fill_reason,
             p.modelled_queue_at_entry, p.modelled_queue_before_fill`,
    order: 'p.probe_id, p.fill_model',
  },
];

const FROM: Record<string, string> = {
  calibration_probes: 'calibration_probes p',
  calibration_queue_observations:
    'calibration_queue_observations p JOIN calibration_probes pr ON pr.probe_id = p.probe_id',
  calibration_counterfactuals:
    'calibration_counterfactuals p JOIN calibration_probes pr ON pr.probe_id = p.probe_id',
};

/** Exact types, for the same reason the rest of the lake declares them. */
const TYPES: Record<string, string> = {
  planned_dwell_ms: 'INTEGER',
  decision_ts_ms: 'BIGINT',
  http_send_ts_ms: 'BIGINT',
  http_ack_ts_ms: 'BIGINT',
  submit_latency_ms: 'INTEGER',
  http_status: 'INTEGER',
  private_ack_ts_ms: 'BIGINT',
  initial_queue_send_ts_ms: 'BIGINT',
  initial_queue_recv_ts_ms: 'BIGINT',
  cancel_decision_ts_ms: 'BIGINT',
  cancel_send_ts_ms: 'BIGINT',
  cancel_ack_ts_ms: 'BIGINT',
  cancel_latency_ms: 'INTEGER',
  fill_exchange_ts_ms: 'BIGINT',
  fill_receive_ts_ms: 'BIGINT',
  poll_send_ts_ms: 'BIGINT',
  poll_receive_ts_ms: 'BIGINT',
  time_since_entry_ms: 'BIGINT',
  fill_time_ms: 'BIGINT',
  seq_no: 'INTEGER',
  price_cents: 'INTEGER',
  cum_trades_at_price: 'INTEGER',
  yes_price: 'DECIMAL(12,6)',
  quantity: 'DECIMAL(24,6)',
  decision_bid: 'DECIMAL(12,6)',
  decision_ask: 'DECIMAL(12,6)',
  decision_bid_size: 'DECIMAL(24,6)',
  decision_ask_size: 'DECIMAL(24,6)',
  decision_mid: 'DECIMAL(12,6)',
  decision_imbalance_1: 'DECIMAL(18,8)',
  decision_imbalance_3: 'DECIMAL(18,8)',
  displayed_size_at_entry: 'DECIMAL(24,6)',
  initial_queue_position: 'DECIMAL(24,6)',
  fill_price: 'DECIMAL(12,6)',
  fill_quantity: 'DECIMAL(24,6)',
  fill_fee: 'DECIMAL(12,6)',
  fill_queue_before: 'DECIMAL(24,6)',
  queue_position: 'DECIMAL(24,6)',
  displayed_level_size: 'DECIMAL(24,6)',
  best_bid: 'DECIMAL(12,6)',
  best_ask: 'DECIMAL(12,6)',
  best_bid_size: 'DECIMAL(24,6)',
  best_ask_size: 'DECIMAL(24,6)',
  imbalance_1: 'DECIMAL(18,8)',
  imbalance_3: 'DECIMAL(18,8)',
  cum_executed_at_price: 'DECIMAL(24,6)',
  cum_removed_at_price: 'DECIMAL(24,6)',
  cum_added_at_price: 'DECIMAL(24,6)',
  real_queue_at_entry: 'DECIMAL(24,6)',
  modelled_queue_at_entry: 'DECIMAL(24,6)',
  modelled_queue_before_fill: 'DECIMAL(24,6)',
};

export interface CalibrationExportResult {
  files: { table: string; date: string; rows: number; bytes: number }[];
  failed: { table: string; error: string }[];
}

export class CalibrationExporter {
  constructor(
    private readonly sql: Sql,
    private readonly store: ArchiveStore,
    private readonly datasetId: string,
  ) {}

  async export(day?: string): Promise<CalibrationExportResult> {
    const result: CalibrationExportResult = { files: [], failed: [] };
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const scratch = await mkdtemp(path.join(tmpdir(), 'kx-calib-'));

    try {
      for (const spec of SPECS) {
        const days = day
          ? [day]
          : (
              (await this.sql.unsafe(
                `SELECT DISTINCT ${spec.dayExpr} AS day FROM ${FROM[spec.table]} ORDER BY 1`,
              )) as unknown as { day: string }[]
            ).map((r) => r.day);

        for (const d of days) {
          try {
            const written = await this.writeDay(DuckDBInstance, scratch, spec, d);
            if (written) result.files.push({ table: spec.table, date: d, ...written });
          } catch (err) {
            result.failed.push({
              table: spec.table,
              error: `${d}: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    logger.info(
      {
        event: 'calibration_exported',
        files: result.files.length,
        rows: result.files.reduce((n, f) => n + f.rows, 0),
        failed: result.failed.length,
      },
      `execution calibration: ${result.files.length} file(s)`,
    );
    return result;
  }

  private async writeDay(
    DuckDBInstance: typeof import('@duckdb/node-api').DuckDBInstance,
    scratch: string,
    spec: Spec,
    day: string,
  ): Promise<{ rows: number; bytes: number } | null> {
    const rows = (await this.sql.unsafe(
      `SELECT ${spec.select} FROM ${FROM[spec.table]} WHERE ${spec.dayExpr} = $1 ORDER BY ${spec.order}`,
      [day] as never,
    )) as unknown as Record<string, unknown>[];
    if (rows.length === 0) return null;

    const label = `${spec.lake}-${day}`;
    const ndjson = path.join(scratch, `${label}.ndjson`);
    const parquet = path.join(scratch, `${label}.parquet`);

    await writeFile(
      ndjson,
      rows
        .map((r) =>
          JSON.stringify(r, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v,
          ),
        )
        .join('\n') + '\n',
      'utf8',
    );

    const conn = await (await DuckDBInstance.create(':memory:')).connect();
    await conn.run(`SET TimeZone = 'UTC'`);
    const esc = (p: string) => p.replace(/'/g, "''");
    const projection = Object.keys(rows[0]!)
      .map((c) => (TYPES[c] ? `CAST("${c}" AS ${TYPES[c]}) AS "${c}"` : `"${c}"`))
      .join(', ');

    await conn.run(
      `COPY (SELECT ${projection} FROM read_json_auto('${esc(ndjson)}')) ` +
        `TO '${esc(parquet)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    conn.closeSync();

    const body = await readFile(parquet);
    const objectPath = `silver/execution_calibration/${spec.lake}/date=${day}/part-000.parquet`;
    await this.store.put(objectPath, body);

    const readBack = await this.store.get(objectPath);
    if (!sha256(readBack).equals(sha256(body))) {
      throw new Error(`checksum mismatch after upload: ${objectPath}`);
    }

    await this.sql`
      INSERT INTO silver_exports (
        export_id, dataset_id, source_table, trading_date, series_ticker,
        source_row_count, exported_row_count, object_path, compressed_bytes,
        sha256, exported_at, verified_at, status
      ) VALUES (
        ${randomUUID()}, ${this.datasetId}, ${spec.table}, ${day}::date, NULL,
        ${rows.length}, ${rows.length}, ${objectPath}, ${body.byteLength},
        ${sha256(body)}, now(), now(), 'verified'
      )
      ON CONFLICT (source_table, trading_date, series_ticker) DO UPDATE SET
        exported_row_count = EXCLUDED.exported_row_count,
        source_row_count   = EXCLUDED.source_row_count,
        object_path        = EXCLUDED.object_path,
        compressed_bytes   = EXCLUDED.compressed_bytes,
        sha256             = EXCLUDED.sha256,
        exported_at        = now(), verified_at = now(),
        verification_error = NULL, status = 'verified'
    `;

    return { rows: rows.length, bytes: body.byteLength };
  }
}
