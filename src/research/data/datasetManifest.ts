import { createHash } from 'node:crypto';

/**
 * Identifying the exact data a run consumed.
 *
 * "Same dataset id" is not enough: the lake is append-only per day but a day
 * can be re-exported, and a run that cannot name the bytes it read is not
 * reproducible. The fingerprint is therefore over the object list -- path,
 * size and row count -- of everything actually scanned.
 */
export interface LakeObject {
  path: string;
  rows: number;
  /**
   * Row groups in the file. Cheap to read (the footer alone) and it changes
   * whenever the file is rewritten, so together with the row count it
   * distinguishes a re-export from the original even when both hold the same
   * number of rows.
   */
  rowGroups: number;
}

export function fingerprintObjects(objects: readonly LakeObject[]): string {
  const canonical = [...objects]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((o) => `${o.path}\t${o.rows}\t${o.rowGroups}`)
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Lake layout. Mirrors SILVER_TABLES in the recorder; changing one breaks the other. */
export const LAKE_TABLES = {
  deltas: 'orderbook_deltas',
  snapshots: 'snapshots',
  trades: 'trades',
  ticker: 'ticker',
  /** Dated snapshots of market definitions, determinations and fee treatment. */
  marketState: 'market_state',
  /** Every observed change to a market's metadata, for provenance. */
  marketStateHistory: 'market_state_history',
} as const;

export type LakeTable = (typeof LAKE_TABLES)[keyof typeof LAKE_TABLES];

/**
 * Hive-partitioned glob for one table.
 *
 * The layout is `silver/<table>/date=YYYY-MM-DD/series=TICKER/part-*.parquet`,
 * so date and series are directory names. DuckDB turns them into columns and
 * prunes whole directories from the scan before opening a single file, which
 * is what makes a remote lake usable interactively.
 */
export function lakeGlob(bucket: string, table: LakeTable): string {
  return `s3://${bucket}/silver/${table}/*/*/*.parquet`;
}

/** Every UTC day touched by a half-open [start, end) window. */
export function utcDaysBetween(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  for (let t = cursor; t < end.getTime(); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
