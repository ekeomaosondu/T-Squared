import type { Sql } from '@/src/persistence/db';

/**
 * Export table registry.
 *
 * Each entry says how to filter a table by time and by market, and how to reach
 * `markets` for series/event filters. Grouping always goes through the official
 * event/series relationship rather than a ticker prefix.
 */

export interface ExportTable {
  name: string;
  /** Column used for --from / --to. */
  timeColumn: string;
  /** Column holding the market ticker, when the table is market-scoped. */
  tickerColumn?: string;
  /** Extra FROM/JOIN needed to resolve series and event filters. */
  joins?: string;
  /** Column expression for event filtering. */
  eventColumn?: string;
  /** Column expression for series filtering. */
  seriesColumn?: string;
  /** Deterministic output ordering, table-qualified. */
  orderBy: string;
}

export const EXPORT_TABLES: Record<string, ExportTable> = {
  raw_ingest_events: {
    name: 'raw_ingest_events',
    timeColumn: 't.received_at',
    tickerColumn: 't.market_ticker',
    joins: 'LEFT JOIN markets m ON m.market_ticker = t.market_ticker',
    eventColumn: 'm.event_ticker',
    seriesColumn: 'm.series_ticker',
    orderBy: 't.received_at, t.id',
  },
  orderbook_deltas: {
    name: 'orderbook_deltas',
    timeColumn: 't.received_at',
    tickerColumn: 't.market_ticker',
    joins: 'LEFT JOIN markets m ON m.market_ticker = t.market_ticker',
    eventColumn: 'm.event_ticker',
    seriesColumn: 'm.series_ticker',
    // Stream chronology then exchange sequence -- see the ordering rules.
    orderBy: 't.received_at, t.session_id, t.stream_id, t.seq',
  },
  orderbook_snapshots: {
    name: 'orderbook_snapshots',
    timeColumn: 't.received_at',
    tickerColumn: 't.market_ticker',
    joins: 'LEFT JOIN markets m ON m.market_ticker = t.market_ticker',
    eventColumn: 'm.event_ticker',
    seriesColumn: 'm.series_ticker',
    orderBy: 't.received_at, t.snapshot_id',
  },
  public_trades: {
    name: 'public_trades',
    timeColumn: 't.received_at',
    tickerColumn: 't.market_ticker',
    joins: 'LEFT JOIN markets m ON m.market_ticker = t.market_ticker',
    eventColumn: 'm.event_ticker',
    seriesColumn: 'm.series_ticker',
    orderBy: 't.received_at, t.trade_id',
  },
  ticker_updates: {
    name: 'ticker_updates',
    timeColumn: 't.received_at',
    tickerColumn: 't.market_ticker',
    joins: 'LEFT JOIN markets m ON m.market_ticker = t.market_ticker',
    eventColumn: 'm.event_ticker',
    seriesColumn: 'm.series_ticker',
    orderBy: 't.received_at, t.id',
  },
  book_samples: {
    name: 'book_samples',
    timeColumn: 't.bucket_ts',
    tickerColumn: 't.market_ticker',
    joins: 'LEFT JOIN markets m ON m.market_ticker = t.market_ticker',
    eventColumn: 'm.event_ticker',
    seriesColumn: 'm.series_ticker',
    orderBy: 't.bucket_ts, t.market_ticker, t.interval_ms',
  },
  event_ladder_samples: {
    name: 'event_ladder_samples',
    timeColumn: 'g.sampled_at',
    tickerColumn: 't.market_ticker',
    joins: 'JOIN event_ladder_sample_groups g ON g.sample_group_id = t.sample_group_id',
    eventColumn: 'g.event_ticker',
    seriesColumn: 'g.series_ticker',
    orderBy: 'g.sampled_at, g.event_ticker, t.market_ticker',
  },
  market_lifecycle_events: {
    name: 'market_lifecycle_events',
    timeColumn: 't.received_at',
    tickerColumn: 't.market_ticker',
    orderBy: 't.received_at, t.id',
  },
  sequence_gaps: {
    name: 'sequence_gaps',
    timeColumn: 't.detected_at',
    orderBy: 't.detected_at, t.id',
  },
  integrity_events: {
    name: 'integrity_events',
    timeColumn: 't.detected_at',
    tickerColumn: 't.market_ticker',
    orderBy: 't.detected_at, t.id',
  },
  book_validations: {
    name: 'book_validations',
    timeColumn: 't.checked_at',
    tickerColumn: 't.market_ticker',
    orderBy: 't.checked_at, t.id',
  },
  ingest_health_minutes: {
    name: 'ingest_health_minutes',
    timeColumn: 't.minute',
    orderBy: 't.minute, t.session_id',
  },
  markets: {
    name: 'markets',
    timeColumn: 't.last_refreshed_at',
    tickerColumn: 't.market_ticker',
    eventColumn: 't.event_ticker',
    seriesColumn: 't.series_ticker',
    orderBy: 't.market_ticker',
  },
};

export interface ExportFilter {
  table: string;
  fromMs?: number;
  toMs?: number;
  tickers?: string[];
  eventTickers?: string[];
  seriesTickers?: string[];
  limit?: number;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export function buildExportQuery(filter: ExportFilter): BuiltQuery {
  const spec = EXPORT_TABLES[filter.table];
  if (!spec) {
    throw new Error(
      `unknown table "${filter.table}". Available: ${Object.keys(EXPORT_TABLES).sort().join(', ')}`,
    );
  }

  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (v: unknown) => `$${params.push(v)}`;

  if (filter.fromMs !== undefined) where.push(`${spec.timeColumn} >= to_timestamp(${bind(filter.fromMs / 1000)})`);
  if (filter.toMs !== undefined) where.push(`${spec.timeColumn} <= to_timestamp(${bind(filter.toMs / 1000)})`);

  if (filter.tickers?.length) {
    if (!spec.tickerColumn) throw new Error(`${spec.name} is not market-scoped; --ticker cannot be used`);
    where.push(`${spec.tickerColumn} = ANY(${bind(filter.tickers)}::text[])`);
  }
  if (filter.eventTickers?.length) {
    if (!spec.eventColumn) throw new Error(`${spec.name} cannot be filtered by event`);
    where.push(`${spec.eventColumn} = ANY(${bind(filter.eventTickers)}::text[])`);
  }
  if (filter.seriesTickers?.length) {
    if (!spec.seriesColumn) throw new Error(`${spec.name} cannot be filtered by series`);
    where.push(`${spec.seriesColumn} = ANY(${bind(filter.seriesTickers)}::text[])`);
  }

  const needsJoin =
    spec.joins &&
    (filter.eventTickers?.length || filter.seriesTickers?.length || spec.name === 'event_ladder_samples');

  const sql =
    `SELECT t.* FROM ${spec.name} t` +
    (needsJoin ? ` ${spec.joins}` : '') +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${spec.orderBy}` +
    (filter.limit ? ` LIMIT ${Number(filter.limit)}` : '');

  return { sql, params };
}

/** Streams result rows in chunks so a large export never buys the whole table. */
export async function* streamExport(
  sql: Sql,
  filter: ExportFilter,
  chunkSize = 5_000,
): AsyncGenerator<Record<string, unknown>[]> {
  const { sql: text, params } = buildExportQuery(filter);
  const cursor = sql.unsafe(text, params as never).cursor(chunkSize);
  for await (const rows of cursor) {
    yield rows as unknown as Record<string, unknown>[];
  }
}

/** CSV escaping. JSON and Buffer values are rendered losslessly. */
export function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toJsonValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return v;
}

export function rowToJsonLine(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = toJsonValue(v);
  return JSON.stringify(out);
}
