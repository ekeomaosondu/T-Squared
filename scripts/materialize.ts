#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env, gitCommitSha } from '@/src/config/env';
import { closeDb, db } from '@/src/persistence/db';
import { materialize, type MaterializeMode } from '@/src/sampling/materializer';
import { logger } from '@/src/logging/logger';

/**
 * Research materialization.
 *
 *   npm run materialize -- --series KXHIGHNY --from 2026-09-15 --to 2026-09-22 \
 *                          --mode clock --interval-ms 100
 *   npm run materialize -- --series KXHIGHNY --mode event-time
 *
 * The database keeps only a coarse 60s grid. Research horizons are generated
 * here from the delta stream, through the SAME sampler the live collector uses,
 * so an offline sample equals what live sampling would have produced.
 *
 * Output is Parquet written by DuckDB -- the same engine used to read it back,
 * so compatibility is guaranteed -- alongside a manifest recording exactly how
 * the dataset was produced.
 */

interface Args {
  series: string[];
  markets: string[];
  fromMs: bigint;
  toMs: bigint;
  mode: MaterializeMode;
  intervalMs?: number;
  out: string;
  format: 'parquet' | 'ndjson';
}

function parseArgs(argv: string[]): Args {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i === -1 ? undefined : argv[i + 1];
  };
  const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const ms = (v: string | undefined, dflt: number) => {
    if (!v) return BigInt(dflt);
    if (/^\d+$/.test(v)) return BigInt(v);
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new Error(`unparseable timestamp: ${v}`);
    return BigInt(t);
  };

  const mode = (get('--mode') ?? 'clock') as MaterializeMode;
  if (mode !== 'clock' && mode !== 'event-time') throw new Error(`unknown --mode ${mode}`);

  const intervalMs = get('--interval-ms') ? Number(get('--interval-ms')) : undefined;
  if (mode === 'clock' && !intervalMs) throw new Error('--mode clock requires --interval-ms');

  const now = Date.now();
  return {
    series: list(get('--series')),
    markets: list(get('--market')),
    fromMs: ms(get('--from'), now - 24 * 3_600_000),
    toMs: ms(get('--to'), now),
    mode,
    intervalMs,
    out: get('--out') ?? path.join(process.cwd(), 'research'),
    format: (get('--format') ?? 'parquet') as Args['format'],
  };
}

/**
 * Stable identity for a dataset: same parameters produce the same hash, so a
 * backtest can cite exactly which dataset it ran against.
 */
function datasetHash(args: Args, datasetId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        datasetId,
        series: [...args.series].sort(),
        markets: [...args.markets].sort(),
        from: args.fromMs.toString(),
        to: args.toMs.toString(),
        mode: args.mode,
        intervalMs: args.intervalMs ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const e = env();
  const sql = db();

  // Resolve markets through the OFFICIAL series relationship, never by parsing
  // ticker strings.
  let marketTickers = args.markets;
  if (marketTickers.length === 0) {
    if (args.series.length === 0) throw new Error('provide --series or --market');
    const rows = (await sql`
      SELECT DISTINCT m.market_ticker
        FROM markets m
       WHERE m.series_ticker = ANY(${args.series}::text[])
         AND EXISTS (SELECT 1 FROM orderbook_deltas d WHERE d.market_ticker = m.market_ticker)
       ORDER BY m.market_ticker
    `) as unknown as { market_ticker: string }[];
    marketTickers = rows.map((r) => r.market_ticker);
  }

  if (marketTickers.length === 0) {
    console.error('no markets matched; nothing to materialize');
    await closeDb();
    process.exit(1);
  }

  const hash = datasetHash(args, e.DATASET_ID);
  const dir = path.join(args.out, 'datasets', hash);
  await mkdir(dir, { recursive: true });

  const label = args.mode === 'clock' ? `clock-${args.intervalMs}ms` : 'event-time';
  const ndjsonPath = path.join(dir, `${label}.ndjson`);

  logger.info(
    {
      event: 'materialize_start',
      dataset_id: e.DATASET_ID,
      dataset_hash: hash,
      mode: args.mode,
      intervalMs: args.intervalMs ?? null,
      markets: marketTickers.length,
    },
    `materializing ${marketTickers.length} market(s) -> ${dir}`,
  );

  // Buffered NDJSON first: the materializer's hooks are synchronous, so the
  // writer must not await inside them.
  const chunks: string[] = [];
  const result = await materialize(sql, {
    marketTickers,
    fromMs: args.fromMs,
    toMs: args.toMs,
    mode: args.mode,
    intervalMs: args.intervalMs,
    onRow: (row) => chunks.push(JSON.stringify(row)),
  });

  await writeFile(ndjsonPath, chunks.join('\n') + (chunks.length ? '\n' : ''), 'utf8');

  let outputPath = ndjsonPath;
  if (args.format === 'parquet' && chunks.length > 0) {
    outputPath = path.join(dir, `${label}.parquet`);
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    // DuckDB reads the NDJSON and writes Parquet, so the file is guaranteed
    // readable by the same engine used for research.
    await conn.run(
      `COPY (SELECT * FROM read_json_auto('${ndjsonPath.replace(/'/g, "''")}')) ` +
        `TO '${outputPath.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
  }

  const manifest = {
    datasetId: e.DATASET_ID,
    deploymentEnv: e.DEPLOYMENT_ENV,
    datasetHash: hash,
    gitCommitSha: gitCommitSha(e),
    producedAt: new Date().toISOString(),
    mode: args.mode,
    intervalMs: args.intervalMs ?? null,
    from: new Date(Number(args.fromMs)).toISOString(),
    to: new Date(Number(args.toMs)).toISOString(),
    series: args.series,
    markets: marketTickers,
    marketsMaterialized: result.markets,
    marketsSkipped: result.skippedMarkets,
    rows: result.rows,
    outputs: [path.basename(outputPath)],
    // Recorded so a dataset is never mistaken for a source of truth: it is
    // regenerable from the delta stream at any time.
    regenerableFrom: 'orderbook_deltas + orderbook_snapshots',
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(JSON.stringify({ ...manifest, dir }, null, 2));
  console.log(`\nDuckDB:\n  SELECT * FROM read_parquet('${outputPath}') LIMIT 10;\n`);

  await closeDb();
}

main().catch(async (err) => {
  logger.error({ event: 'materialize_failed', err: String(err) }, 'materialize failed');
  console.error(String(err));
  await closeDb().catch(() => {});
  process.exit(1);
});
