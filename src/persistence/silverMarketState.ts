import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sql } from '@/src/persistence/db';
import { sha256, type ArchiveStore } from '@/src/persistence/archiveStore';
import { logger } from '@/src/logging/logger';

/**
 * Market definitions, determinations and fee treatment, exported to the lake.
 *
 * Without this a backtest cannot settle. A binary contract does not end at the
 * last mid -- it ends at exactly $0 or $1, decided by an authority outside the
 * order book -- so a run that marks its residual inventory is reporting a
 * guess where a fact exists.
 *
 * ---------------------------------------------------------------------------
 * Why this is a dated SNAPSHOT rather than an event stream
 * ---------------------------------------------------------------------------
 * A determination arrives long after the trading it settles. Daily temperature
 * markets close in the small hours and are determined from the following
 * morning's climate report, so the fact that settles Monday's book is not
 * known until Tuesday. Partitioning by trading day would file it under a day
 * the exchange had not yet spoken about.
 *
 * So each export writes the state of every market AS KNOWN on the export date,
 * and research reads the most recent snapshot. Re-running yesterday's export
 * cannot lose a determination that has since arrived, and the history of
 * observations is exported alongside so the moment a result first appeared is
 * always recoverable.
 *
 * Nothing here is inferred from weather data. The exchange's own record is the
 * only authority: preliminary observations disagree with the final climate
 * report often enough that a backtest settled from them would be measuring the
 * wrong thing.
 */

export interface MarketStateExportResult {
  snapshotDate: string;
  files: { table: string; series: string | null; rows: number; bytes: number }[];
  failed: { table: string; error: string }[];
}

const STATE_SELECT = `
  SELECT m.market_ticker,
         m.event_ticker,
         m.series_ticker,
         m.market_type,
         m.status,
         m.result,
         m.settlement_value,
         m.expiration_value,
         m.is_provisional,
         m.notional_value,
         m.strike_type,
         m.floor_strike,
         m.cap_strike,
         (EXTRACT(EPOCH FROM m.open_time) * 1000)::bigint        AS open_time_ms,
         (EXTRACT(EPOCH FROM m.close_time) * 1000)::bigint       AS close_time_ms,
         (EXTRACT(EPOCH FROM m.expiration_time) * 1000)::bigint  AS expiration_time_ms,
         (EXTRACT(EPOCH FROM m.settlement_ts) * 1000)::bigint    AS settlement_ts_ms,
         (EXTRACT(EPOCH FROM m.last_refreshed_at) * 1000)::bigint AS last_refreshed_at_ms,
         (EXTRACT(EPOCH FROM v.result_first_observed_at) * 1000)::bigint AS result_first_observed_at_ms,
         s.fee_type,
         s.fee_multiplier,
         (EXTRACT(EPOCH FROM s.last_updated_ts) * 1000)::bigint  AS fee_updated_at_ms,
         s.settlement_sources::text AS settlement_sources_json
    FROM markets m
    LEFT JOIN series s ON s.series_ticker = m.series_ticker
    LEFT JOIN LATERAL (
      -- When this exact result was FIRST seen. Metadata versions are written
      -- only on change, so the earliest row carrying the current result is the
      -- moment the exchange's answer became visible to us.
      SELECT min(mv.observed_at) AS result_first_observed_at
        FROM market_metadata_versions mv
       WHERE mv.market_ticker = m.market_ticker
         AND mv.result IS NOT NULL
         AND mv.result <> ''
         AND mv.result = m.result
    ) v ON true
`;

const HISTORY_SELECT = `
  SELECT mv.market_ticker,
         m.event_ticker,
         m.series_ticker,
         (EXTRACT(EPOCH FROM mv.observed_at) * 1000)::bigint AS observed_at_ms,
         mv.version_hash,
         mv.status,
         mv.result,
         (EXTRACT(EPOCH FROM mv.close_time) * 1000)::bigint  AS close_time_ms
    FROM market_metadata_versions mv
    LEFT JOIN markets m ON m.market_ticker = mv.market_ticker
`;

export class MarketStateExporter {
  constructor(
    private readonly sql: Sql,
    private readonly store: ArchiveStore,
    private readonly datasetId: string,
  ) {}

  /**
   * Writes the current state of every market, filed under `snapshotDate`.
   *
   * @param snapshotDate UTC day to file the snapshot under. Defaults to today,
   *                     because "what we know now" is what a settlement lookup
   *                     wants and yesterday's snapshot is strictly staler.
   */
  async export(snapshotDate?: string): Promise<MarketStateExportResult> {
    const day = snapshotDate ?? new Date().toISOString().slice(0, 10);
    const result: MarketStateExportResult = { snapshotDate: day, files: [], failed: [] };

    const { DuckDBInstance } = await import('@duckdb/node-api');
    const scratch = await mkdtemp(path.join(tmpdir(), 'kx-market-state-'));

    try {
      for (const spec of [
        { table: 'market_state', select: STATE_SELECT, order: 'm.market_ticker' },
        {
          table: 'market_state_history',
          select: HISTORY_SELECT,
          order: 'mv.market_ticker, mv.observed_at',
        },
      ]) {
        const groups = await this.sql<{ series_ticker: string | null }[]>`
          SELECT DISTINCT m.series_ticker FROM markets m ORDER BY m.series_ticker
        `;

        for (const group of groups) {
          const series = group.series_ticker;
          try {
            const written = await this.writeGroup(
              DuckDBInstance,
              scratch,
              spec,
              day,
              series,
            );
            if (written) result.files.push({ table: spec.table, series, ...written });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result.failed.push({ table: spec.table, error: `${series}: ${message}` });
          }
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    logger.info(
      {
        event: 'market_state_exported',
        snapshot_date: day,
        files: result.files.length,
        rows: result.files.reduce((n, f) => n + f.rows, 0),
        failed: result.failed.length,
      },
      `market state snapshot ${day}: ${result.files.length} file(s)`,
    );

    return result;
  }

  private async writeGroup(
    DuckDBInstance: typeof import('@duckdb/node-api').DuckDBInstance,
    scratch: string,
    spec: { table: string; select: string; order: string },
    day: string,
    series: string | null,
  ): Promise<{ rows: number; bytes: number } | null> {
    const predicate =
      series === null ? 'm.series_ticker IS NULL' : 'm.series_ticker = $1';
    const params = series === null ? [] : [series];

    const rows = (await this.sql.unsafe(
      `${spec.select} WHERE ${predicate} ORDER BY ${spec.order}`,
      params as never,
    )) as unknown as Record<string, unknown>[];

    if (rows.length === 0) return null;

    const label = `${spec.table}-${day}-${series ?? 'unknown'}`;
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

    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    await conn.run(`SET TimeZone = 'UTC'`);
    const esc = (p: string) => p.replace(/'/g, "''");

    // Declared types, for the same reason the rest of the lake declares them:
    // an inferred VARCHAR ordering key sorts 100 before 99 and a price that
    // becomes a float stops being exact, and neither failure is loud.
    const types: Record<string, string> = {
      open_time_ms: 'BIGINT',
      close_time_ms: 'BIGINT',
      expiration_time_ms: 'BIGINT',
      settlement_ts_ms: 'BIGINT',
      last_refreshed_at_ms: 'BIGINT',
      result_first_observed_at_ms: 'BIGINT',
      fee_updated_at_ms: 'BIGINT',
      observed_at_ms: 'BIGINT',
      settlement_value: 'DECIMAL(12,6)',
      notional_value: 'DECIMAL(12,6)',
      floor_strike: 'DECIMAL(20,8)',
      cap_strike: 'DECIMAL(20,8)',
      fee_multiplier: 'DECIMAL(18,8)',
      is_provisional: 'BOOLEAN',
    };
    const projection = Object.keys(rows[0]!)
      .map((c) => (types[c] ? `CAST("${c}" AS ${types[c]}) AS "${c}"` : `"${c}"`))
      .join(', ');

    await conn.run(
      `COPY (SELECT ${projection} FROM read_json_auto('${esc(ndjson)}')) ` +
        `TO '${esc(parquet)}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    conn.closeSync();

    const body = await readFile(parquet);
    const objectPath =
      `silver/${spec.table}/date=${day}/series=${series ?? 'unknown'}/part-000.parquet`;
    await this.store.put(objectPath, body);

    // Verified by reading it back, not by trusting the upload.
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
        ${randomUUID()}, ${this.datasetId}, ${spec.table}, ${day}::date, ${series},
        ${rows.length}, ${rows.length}, ${objectPath}, ${body.byteLength},
        ${sha256(body)}, now(), now(), 'verified'
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

    return { rows: rows.length, bytes: body.byteLength };
  }
}
