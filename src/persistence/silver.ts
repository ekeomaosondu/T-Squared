import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { one, type Sql } from '@/src/persistence/db';
import { sha256, type ArchiveStore } from '@/src/persistence/archiveStore';
import { logger } from '@/src/logging/logger';

/**
 * Silver layer: research-friendly Parquet in object storage.
 *
 * Bronze (the raw archive) is the ultimate source of truth. Silver is the
 * canonical RESEARCH representation -- normalized, columnar, partitioned by day
 * and series so DuckDB can push filters and column selection into the scan
 * instead of loading whole files.
 *
 * Because silver is reproducible from bronze, and Postgres rows are
 * reproducible from both, normalized data can expire from the database once its
 * silver export is verified. That is what keeps the operational database a
 * small hot store rather than a warehouse.
 *
 * Nothing expires until its export row count matches the database exactly.
 */

/**
 * Explicit Parquet column types.
 *
 * postgres.js returns BIGINT and NUMERIC as strings to preserve exactness, so
 * a naive JSON round-trip lands them in Parquet as VARCHAR. That is not merely
 * untidy: ORDER BY or min/max on a VARCHAR ordinal sorts lexicographically --
 * 100 before 99 -- which is precisely the class of bug that made replay apply
 * deltas out of order. Types are therefore declared, not inferred.
 *
 * Prices and sizes become DECIMAL rather than DOUBLE so exchange values stay
 * exact all the way into research.
 */
export const SILVER_COLUMN_TYPES: Record<string, string> = {
  ingest_ordinal: 'BIGINT',
  seq: 'BIGINT',
  sid: 'INTEGER',
  exchange_ts_ms: 'BIGINT',
  received_at_ms: 'BIGINT',
  snapshot_id: 'BIGINT',
  yes_level_count: 'INTEGER',
  no_level_count: 'INTEGER',

  price: 'DECIMAL(12,6)',
  delta_count: 'DECIMAL(24,6)',
  pre_count: 'DECIMAL(24,6)',
  post_count: 'DECIMAL(24,6)',
  yes_price: 'DECIMAL(12,6)',
  no_price: 'DECIMAL(12,6)',
  count: 'DECIMAL(24,6)',
  yes_bid: 'DECIMAL(12,6)',
  yes_ask: 'DECIMAL(12,6)',
  yes_bid_size: 'DECIMAL(24,6)',
  yes_ask_size: 'DECIMAL(24,6)',
  last_trade_size: 'DECIMAL(24,6)',
  volume: 'DECIMAL(24,6)',
  open_interest: 'DECIMAL(24,6)',
  dollar_volume: 'DECIMAL(24,6)',
  dollar_open_interest: 'DECIMAL(24,6)',
  best_yes_bid: 'DECIMAL(12,6)',
  best_yes_bid_size: 'DECIMAL(24,6)',
  best_yes_ask: 'DECIMAL(12,6)',
  best_yes_ask_size: 'DECIMAL(24,6)',
  spread: 'DECIMAL(12,6)',
  mid: 'DECIMAL(12,6)',
};

/** Builds the typed projection for the Parquet COPY. */
export function typedProjection(columns: string[]): string {
  return columns
    .map((c) => {
      const type = SILVER_COLUMN_TYPES[c];
      return type ? `CAST("${c}" AS ${type}) AS "${c}"` : `"${c}"`;
    })
    .join(', ');
}

export interface SilverTableSpec {
  /** Postgres table being exported. */
  table: string;
  /** Lake path segment. */
  lake: string;
  /** Column used to bucket rows into UTC days. */
  dayColumn: string;
  /** SELECT list, already joined to markets for series/event context. */
  select: string;
  /** FROM/JOIN clause. */
  from: string;
  /** Deterministic ordering, table-qualified. */
  orderBy: string;
}

/**
 * Delta files are ordered by (session_id, ingest_ordinal): the exact order the
 * collector observed events, which is the order a backtest must replay. Within
 * a single market, (stream_id, seq) remains the exchange's own ordering.
 */
export const SILVER_TABLES: SilverTableSpec[] = [
  {
    table: 'orderbook_deltas',
    lake: 'orderbook_deltas',
    dayColumn: 'd.received_at',
    select: `d.session_id, d.ingest_ordinal, d.market_ticker, m.event_ticker, m.series_ticker,
             d.stream_id, d.seq, d.sid, d.exchange_ts_ms, d.received_at_ms,
             d.side, d.price, d.delta_count, d.pre_count, d.post_count,
             d.level_action, d.applied, d.apply_error`,
    from: 'orderbook_deltas d LEFT JOIN markets m ON m.market_ticker = d.market_ticker',
    orderBy: 'd.session_id, d.ingest_ordinal, d.id',
  },
  {
    table: 'public_trades',
    lake: 'trades',
    dayColumn: 't.received_at',
    select: `t.trade_id, t.session_id, t.ingest_ordinal, t.market_ticker, m.event_ticker,
             m.series_ticker, t.stream_id, t.seq, t.yes_price, t.no_price, t.count,
             t.taker_side, t.taker_outcome_side, t.taker_book_side, t.is_block_trade,
             t.exchange_ts_ms, t.received_at_ms`,
    from: 'public_trades t LEFT JOIN markets m ON m.market_ticker = t.market_ticker',
    orderBy: 't.session_id, t.ingest_ordinal, t.trade_id',
  },
  {
    table: 'ticker_updates',
    lake: 'ticker',
    dayColumn: 'u.received_at',
    select: `u.session_id, u.ingest_ordinal, u.market_ticker, m.event_ticker, m.series_ticker,
             u.price, u.yes_bid, u.yes_ask, u.yes_bid_size, u.yes_ask_size,
             u.last_trade_size, u.volume, u.open_interest, u.dollar_volume,
             u.dollar_open_interest, u.exchange_ts_ms, u.received_at_ms`,
    from: 'ticker_updates u LEFT JOIN markets m ON m.market_ticker = u.market_ticker',
    orderBy: 'u.session_id, u.ingest_ordinal, u.id',
  },
  {
    table: 'orderbook_snapshots',
    lake: 'snapshots',
    dayColumn: 's.received_at',
    select: `s.snapshot_id, s.session_id, s.stream_id, s.market_ticker, m.event_ticker,
             m.series_ticker, s.source, s.sid, s.seq, s.received_at_ms,
             s.yes_bids::text AS yes_bids_json, s.no_bids::text AS no_bids_json,
             s.yes_level_count, s.no_level_count,
             s.best_yes_bid, s.best_yes_bid_size, s.best_yes_ask, s.best_yes_ask_size,
             s.spread, s.mid, s.state_hash`,
    from: 'orderbook_snapshots s LEFT JOIN markets m ON m.market_ticker = s.market_ticker',
    orderBy: 's.received_at_ms, s.snapshot_id',
  },
];

export interface SilverOptions {
  sql: Sql;
  store: ArchiveStore;
  datasetId: string;
  /** Only days strictly before this are exported; today is still accumulating. */
  clock?: () => Date;
}

export interface SilverResult {
  exported: { table: string; date: string; series: string | null; rows: number; bytes: number }[];
  verified: number;
  failed: { table: string; date: string; error: string }[];
  skipped: string[];
}

/**
 * Exports one completed UTC day to Parquet, per table and series.
 *
 * Parquet is written by DuckDB, the same engine used to read it back, so
 * compatibility is guaranteed rather than assumed.
 */
export class SilverExporter {
  private readonly sql: Sql;
  private readonly store: ArchiveStore;
  private readonly datasetId: string;
  private readonly clock: () => Date;

  constructor(opts: SilverOptions) {
    this.sql = opts.sql;
    this.store = opts.store;
    this.datasetId = opts.datasetId;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** UTC days with data that have fully elapsed. */
  async completedDays(): Promise<string[]> {
    const today = this.clock().toISOString().slice(0, 10);
    const rows = await this.sql<{ day: string }[]>`
      SELECT DISTINCT to_char(date_trunc('day', d.received_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day
        FROM orderbook_deltas d
       ORDER BY 1
    `;
    return rows.map((r) => r.day).filter((d) => d < today);
  }

  async exportDay(day: string): Promise<SilverResult> {
    const result: SilverResult = { exported: [], verified: 0, failed: [], skipped: [] };

    if (day >= this.clock().toISOString().slice(0, 10)) {
      // A snapshot keeps each file internally consistent, but the day itself is
      // still growing, so the export will be incomplete and must be redone.
      logger.warn(
        { event: 'silver_incomplete_day', day },
        'exporting a day that has not closed; the result is a partial snapshot and must be re-exported',
      );
    }

    const { DuckDBInstance } = await import('@duckdb/node-api');
    const scratch = await mkdtemp(path.join(tmpdir(), 'kx-silver-'));

    try {
      for (const spec of SILVER_TABLES) {
        // Partition by series so a study touching one city scans one directory.
        const groups = await this.sql<{ series_ticker: string | null; n: string }[]>`
          SELECT s.series_ticker, count(*) AS n FROM (
            SELECT m.series_ticker
              FROM ${this.sql.unsafe(spec.from)}
             WHERE ${this.sql.unsafe(spec.dayColumn)} >= ${`${day} 00:00:00+00`}::timestamptz
               AND ${this.sql.unsafe(spec.dayColumn)} <  ${`${day} 00:00:00+00`}::timestamptz + interval '1 day'
          ) s
          GROUP BY s.series_ticker
        `;

        for (const g of groups) {
          const rows = Number(g.n);
          if (rows === 0) continue;
          void rows;

          const objectPath =
            `silver/${spec.lake}/date=${day}/` +
            `series=${g.series_ticker ?? 'unknown'}/part-000.parquet`;

          try {
            const { bytes, exported, sourceCount } = await this.writeParquet(
              DuckDBInstance,
              scratch,
              spec,
              day,
              g.series_ticker,
              objectPath,
            );

            // Compared against the count taken in the SAME snapshot as the read.
            if (exported !== sourceCount) {
              throw new Error(`row count mismatch: database ${sourceCount}, parquet ${exported}`);
            }

            result.exported.push({
              table: spec.table,
              date: day,
              series: g.series_ticker,
              rows: exported,
              bytes,
            });
            result.verified += 1;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result.failed.push({ table: spec.table, date: day, error: message });
            await this.recordFailure(spec.table, day, g.series_ticker, message);
          }
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    logger.info(
      {
        event: 'silver_day_exported',
        day,
        files: result.exported.length,
        rows: result.exported.reduce((n, e) => n + e.rows, 0),
        failed: result.failed.length,
      },
      `silver export for ${day}: ${result.exported.length} file(s)`,
    );

    return result;
  }

  private async writeParquet(
    DuckDBInstance: typeof import('@duckdb/node-api').DuckDBInstance,
    scratch: string,
    spec: SilverTableSpec,
    day: string,
    series: string | null,
    objectPath: string,
  ): Promise<{ bytes: number; exported: number; sourceCount: number }> {
    // Stream rows out of Postgres as NDJSON, then let DuckDB write Parquet.
    // Going through DuckDB guarantees the file is readable by the engine that
    // will query it, and ZSTD keeps these files small enough to scan remotely.
    const seriesPredicate = series === null ? 'm.series_ticker IS NULL' : `m.series_ticker = $3`;
    const params: unknown[] = [`${day} 00:00:00+00`, `${day} 00:00:00+00`];
    if (series !== null) params.push(series);

    // Count and read inside ONE repeatable-read snapshot. Otherwise rows
    // inserted between the two queries make the counts disagree and the export
    // is rejected -- which is exactly what happens when a day is exported while
    // it is still being written to.
    const { rows, sourceCount } = await this.sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

      const counted = await tx.unsafe(
        `SELECT count(*) AS n
           FROM ${spec.from}
          WHERE ${spec.dayColumn} >= $1::timestamptz
            AND ${spec.dayColumn} < $2::timestamptz + interval '1 day'
            AND ${seriesPredicate}`,
        params as never,
      );

      const selected = await tx.unsafe(
        `SELECT ${spec.select}
           FROM ${spec.from}
          WHERE ${spec.dayColumn} >= $1::timestamptz
            AND ${spec.dayColumn} < $2::timestamptz + interval '1 day'
            AND ${seriesPredicate}
          ORDER BY ${spec.orderBy}`,
        params as never,
      );

      return {
        rows: selected as unknown as Record<string, unknown>[],
        sourceCount: Number((counted as unknown as { n: string }[])[0]!.n),
      };
    });

    const ndjson = path.join(scratch, `${spec.lake}-${day}-${series ?? 'unknown'}.ndjson`);
    const parquet = path.join(scratch, `${spec.lake}-${day}-${series ?? 'unknown'}.parquet`);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      ndjson,
      rows
        .map((r) =>
          JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v)),
        )
        .join('\n') + '\n',
      'utf8',
    );

    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    const esc = (p: string) => p.replace(/'/g, "''");

    // Declare types rather than letting them be inferred from JSON strings.
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    const projection = columns.length > 0 ? typedProjection(columns) : '*';

    await conn.run(
      `COPY (SELECT ${projection} FROM read_json_auto('${esc(ndjson)}')) ` +
        `TO '${esc(parquet)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );

    const counted = await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${esc(parquet)}')`);
    const exported = Number((counted.getRowObjects()[0] as { n: unknown }).n);

    const body = await readFile(parquet);
    await this.store.put(objectPath, body);

    // Verify by reading the object back, not by trusting the upload.
    const readBack = await this.store.get(objectPath);
    const digest = sha256(body);
    if (!sha256(readBack).equals(digest)) {
      throw new Error(`checksum mismatch after upload: ${objectPath}`);
    }

    await this.sql`
      INSERT INTO silver_exports (
        export_id, dataset_id, source_table, trading_date, series_ticker,
        source_row_count, exported_row_count, object_path, compressed_bytes,
        sha256, exported_at, verified_at, status
      ) VALUES (
        ${randomUUID()}, ${this.datasetId}, ${spec.table}, ${day}::date, ${series},
        ${exported}, ${exported}, ${objectPath}, ${body.byteLength},
        ${digest}, now(), now(), 'verified'
      )
      ON CONFLICT (source_table, trading_date, series_ticker) DO UPDATE SET
        exported_row_count = EXCLUDED.exported_row_count,
        source_row_count   = EXCLUDED.source_row_count,
        object_path        = EXCLUDED.object_path,
        compressed_bytes   = EXCLUDED.compressed_bytes,
        sha256             = EXCLUDED.sha256,
        exported_at        = now(),
        verified_at        = now(),
        verification_error = NULL,
        status             = 'verified'
    `;

    return { bytes: body.byteLength, exported, sourceCount };
  }

  private async recordFailure(
    table: string,
    day: string,
    series: string | null,
    error: string,
  ): Promise<void> {
    await this.sql`
      INSERT INTO silver_exports (
        export_id, dataset_id, source_table, trading_date, series_ticker,
        source_row_count, exported_row_count, object_path, status, verification_error
      ) VALUES (
        ${randomUUID()}, ${this.datasetId}, ${table}, ${day}::date, ${series},
        0, 0, '', 'failed', ${error}
      )
      ON CONFLICT (source_table, trading_date, series_ticker) DO UPDATE SET
        status = 'failed', verification_error = EXCLUDED.verification_error
    `.catch(() => {});
  }

  /**
   * Expires normalized rows for a day, but only once EVERY silver export for
   * that day is verified. Mirrors the raw archive gate: nothing is deleted from
   * Postgres that is not already proven to exist in object storage.
   */
  async expireDay(day: string, opts: { enabled: boolean }): Promise<{ deleted: number; reason?: string }> {
    if (!opts.enabled) return { deleted: 0, reason: 'normalized retention disabled' };

    const pending = await this.sql<{ n: string }[]>`
      SELECT count(*) AS n FROM silver_exports e
       WHERE e.trading_date = ${day}::date AND e.status <> 'verified'
    `;
    if (Number(one(pending).n) > 0) {
      return { deleted: 0, reason: `${one(pending).n} unverified silver export(s) for ${day}` };
    }

    const exported = await this.sql<{ n: string }[]>`
      SELECT count(*) AS n FROM silver_exports e WHERE e.trading_date = ${day}::date
    `;
    if (Number(one(exported).n) === 0) {
      return { deleted: 0, reason: `no silver exports recorded for ${day}` };
    }

    const from = `${day} 00:00:00+00`;
    let deleted = 0;
    const tables: string[] = [];

    for (const spec of SILVER_TABLES) {
      const col = spec.dayColumn.split('.')[1]!;
      const res = await this.sql.unsafe(
        `DELETE FROM ${spec.table}
          WHERE ${col} >= $1::timestamptz
            AND ${col} <  $1::timestamptz + interval '1 day'`,
        [from] as never,
      );
      deleted += (res as unknown as { count: number }).count ?? 0;
      tables.push(spec.table);
    }

    await this.sql`
      INSERT INTO normalized_retention (trading_date, expired_at, rows_deleted, tables_expired)
      VALUES (${day}::date, now(), ${deleted}, ${this.sql.json(tables as never)})
      ON CONFLICT (trading_date) DO UPDATE SET
        expired_at = now(), rows_deleted = EXCLUDED.rows_deleted, updated_at = now()
    `;

    logger.info(
      { event: 'normalized_expired', day, rows: deleted, tables: tables.length },
      `expired ${deleted} normalized row(s) for ${day} after verified silver export`,
    );

    return { deleted };
  }
}
