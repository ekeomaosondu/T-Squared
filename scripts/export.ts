#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { closeDb, db } from '@/src/persistence/db';
import {
  EXPORT_TABLES,
  rowToJsonLine,
  streamExport,
  toCsvValue,
  type ExportFilter,
} from '@/src/persistence/export';
import { logger } from '@/src/logging/logger';

/**
 * Data export CLI.
 *
 *   npm run export -- --table orderbook_deltas --series KXHIGHNY \
 *                     --from 2026-09-13 --to 2026-09-14 --format ndjson.gz
 *
 * Filters: --ticker, --event, --series (repeatable or comma-separated).
 * Formats: csv, csv.gz, ndjson, ndjson.gz
 *
 * Rows are streamed through a cursor, so exporting a large table does not load
 * it into memory.
 */

const HELP = `
Export recorded Kalshi data.

  --table <name>      one of:
${Object.keys(EXPORT_TABLES).sort().map((t) => `                        ${t}`).join('\n')}

  --ticker <list>     market ticker(s), comma-separated
  --event <list>      event ticker(s)   -- official relationship, not parsed
  --series <list>     series ticker(s)  -- official relationship, not parsed
  --from <iso|epochMs>
  --to <iso|epochMs>
  --limit <n>
  --format csv | csv.gz | ndjson | ndjson.gz   (default ndjson.gz)
  --out <dir>         output directory (default ./exports)
  --stdout            write to stdout instead of a file
`;

function list(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function toMs(v: string | undefined): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  const parsed = Date.parse(v);
  if (Number.isNaN(parsed)) throw new Error(`unparseable timestamp: ${v}`);
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP);
    return;
  }

  const table = get('--table');
  if (!table || !EXPORT_TABLES[table]) {
    console.error(`--table is required.\n${HELP}`);
    process.exit(1);
  }

  const format = (get('--format') ?? 'ndjson.gz') as 'csv' | 'csv.gz' | 'ndjson' | 'ndjson.gz';
  if (!['csv', 'csv.gz', 'ndjson', 'ndjson.gz'].includes(format)) {
    console.error(`unknown format "${format}"`);
    process.exit(1);
  }

  const filter: ExportFilter = {
    table,
    fromMs: toMs(get('--from')),
    toMs: toMs(get('--to')),
    tickers: list(get('--ticker')),
    eventTickers: list(get('--event')),
    seriesTickers: list(get('--series')),
    limit: get('--limit') ? Number(get('--limit')) : undefined,
  };

  const sql = db();
  const gzip = format.endsWith('.gz');
  const csv = format.startsWith('csv');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = get('--out') ?? path.join(process.cwd(), 'exports');
  const outPath = path.join(outDir, `${table}-${stamp}.${format}`);

  let rowCount = 0;
  let columns: string[] | null = null;

  async function* lines(): AsyncGenerator<string> {
    for await (const chunk of streamExport(sql, filter)) {
      if (chunk.length === 0) continue;

      if (csv && columns === null) {
        columns = Object.keys(chunk[0]!);
        yield `${columns.join(',')}\n`;
      }

      for (const row of chunk) {
        rowCount += 1;
        yield csv
          ? `${columns!.map((c) => toCsvValue(row[c])).join(',')}\n`
          : `${rowToJsonLine(row)}\n`;
      }
    }
  }

  const source = Readable.from(lines());

  if (argv.includes('--stdout')) {
    if (gzip) await pipeline(source, createGzip({ level: 9 }), process.stdout);
    else await pipeline(source, process.stdout);
  } else {
    await mkdir(outDir, { recursive: true });
    const sink = createWriteStream(outPath);
    if (gzip) await pipeline(source, createGzip({ level: 9 }), sink);
    else await pipeline(source, sink);

    logger.info(
      { event: 'export_complete', table, rows: rowCount, path: outPath, format },
      `exported ${rowCount} row(s) to ${outPath}`,
    );
    console.error(`exported ${rowCount} row(s) -> ${outPath}`);
  }

  await closeDb();
}

main().catch(async (err) => {
  logger.error({ event: 'export_failed', err: String(err) }, 'export failed');
  console.error(String(err));
  await closeDb().catch(() => {});
  process.exit(1);
});
