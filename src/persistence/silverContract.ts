import type { DuckDBConnection } from '@duckdb/node-api';

/**
 * Silver schema contract.
 *
 * Parquet type drift is uniquely dangerous for microstructure research because
 * it does not fail loudly. An ordering key that silently becomes VARCHAR sorts
 * 100 before 99, so every study that orders or buckets by it is wrong while
 * every query still "works". A price that becomes DOUBLE accumulates error that
 * looks like microstructure.
 *
 * So the contract is checked on every export, and a violation FAILS the export
 * rather than producing a file that looks fine.
 *
 * Two levels:
 *   schema    the declared physical type of each critical column
 *   semantics properties that must hold of the data itself
 */

/** Columns that must be exact integers. Ordering and bucketing depend on them. */
export const REQUIRED_BIGINT = [
  'ingest_ordinal',
  'seq',
  'exchange_ts_ms',
  'received_at_ms',
] as const;

/**
 * Columns that must be exact decimals.
 *
 * DOUBLE is not acceptable: these are exchange values, and a float turns
 * 0.1 + 0.2 into microstructure noise.
 */
export const REQUIRED_DECIMAL = [
  'price',
  'delta_count',
  'pre_count',
  'post_count',
  'yes_price',
  'no_price',
  'count',
  'yes_bid',
  'yes_ask',
  'yes_bid_size',
  'yes_ask_size',
  'best_yes_bid',
  'best_yes_bid_size',
  'best_yes_ask',
  'best_yes_ask_size',
  'spread',
  'mid',
  'volume',
  'open_interest',
  'floor_strike',
  'cap_strike',
] as const;

export interface ContractViolation {
  kind: 'schema' | 'semantics';
  column?: string;
  detail: string;
}

interface DescribedColumn {
  column_name: string;
  column_type: string;
}

/**
 * Asserts the physical types of every critical column present in the file.
 *
 * Columns absent from a given table are not an error -- trades have no
 * `delta_count` -- but a column that IS present must carry the right type.
 */
export async function checkSchema(
  conn: DuckDBConnection,
  parquetPath: string,
): Promise<ContractViolation[]> {
  const esc = parquetPath.replace(/'/g, "''");
  const described = await conn.runAndReadAll(
    `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet('${esc}'))`,
  );
  const columns = described.getRowObjects() as unknown as DescribedColumn[];
  const byName = new Map(columns.map((c) => [c.column_name, String(c.column_type)]));

  const violations: ContractViolation[] = [];

  for (const col of REQUIRED_BIGINT) {
    const type = byName.get(col);
    if (type === undefined) continue;
    if (!/^(BIGINT|HUGEINT|INTEGER)$/.test(type)) {
      violations.push({
        kind: 'schema',
        column: col,
        detail: `expected an exact integer type, found ${type}. A VARCHAR ordering key sorts 100 before 99.`,
      });
    }
  }

  for (const col of REQUIRED_DECIMAL) {
    const type = byName.get(col);
    if (type === undefined) continue;
    if (!/^DECIMAL\(/.test(type)) {
      violations.push({
        kind: 'schema',
        column: col,
        detail: `expected DECIMAL, found ${type}. Exchange values must not become floats or strings.`,
      });
    }
  }

  return violations;
}

/**
 * Asserts properties of the data, not just its declared types.
 *
 * A file can pass the schema check and still be wrong -- for example if a cast
 * silently produced nulls, or if ordering keys did not actually advance.
 */
export async function checkSemantics(
  conn: DuckDBConnection,
  parquetPath: string,
): Promise<ContractViolation[]> {
  const esc = parquetPath.replace(/'/g, "''");
  const src = `read_parquet('${esc}')`;
  const violations: ContractViolation[] = [];

  const described = await conn.runAndReadAll(
    `SELECT column_name FROM (DESCRIBE SELECT * FROM ${src})`,
  );
  const present = new Set(
    (described.getRowObjects() as unknown as { column_name: string }[]).map((c) => c.column_name),
  );

  const scalar = async (sql: string): Promise<string | null> => {
    const r = await conn.runAndReadAll(sql);
    const row = r.getRowObjects()[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const v = Object.values(row)[0];
    return v === null || v === undefined ? null : String(v);
  };

  const rowCount = Number(await scalar(`SELECT count(*) FROM ${src}`));
  if (rowCount === 0) return violations;

  // --- ordering keys must actually advance -------------------------------
  if (present.has('ingest_ordinal')) {
    const nulls = Number(await scalar(`SELECT count(*) FROM ${src} WHERE ingest_ordinal IS NULL`));
    if (nulls === rowCount) {
      violations.push({
        kind: 'semantics',
        column: 'ingest_ordinal',
        detail: 'every ingest_ordinal is null; observation order cannot be reconstructed',
      });
    } else if (rowCount > 1) {
      const spread = await scalar(
        `SELECT CASE WHEN max(ingest_ordinal) > min(ingest_ordinal) THEN 'ok' ELSE 'flat' END FROM ${src}`,
      );
      if (spread !== 'ok') {
        violations.push({
          kind: 'semantics',
          column: 'ingest_ordinal',
          detail: 'min(ingest_ordinal) is not less than max; ordering key does not advance',
        });
      }

      // Numeric ordering must be monotonic. Under a VARCHAR type this fails
      // exactly where lexicographic and numeric order diverge.
      const nonMonotonic = Number(
        await scalar(`
          SELECT count(*) FROM (
            SELECT f.ingest_ordinal,
                   lag(f.ingest_ordinal) OVER (PARTITION BY f.session_id ORDER BY f.ingest_ordinal) AS prev
              FROM ${src} AS f WHERE f.ingest_ordinal IS NOT NULL
          ) AS w WHERE w.prev IS NOT NULL AND w.ingest_ordinal < w.prev`),
      );
      if (nonMonotonic > 0) {
        violations.push({
          kind: 'semantics',
          column: 'ingest_ordinal',
          detail: `${nonMonotonic} row(s) where the numeric ordering is not monotonic`,
        });
      }
    }
  }

  // --- book arithmetic must be exact -------------------------------------
  if (present.has('pre_count') && present.has('post_count') && present.has('delta_count')) {
    // The core invariant of the whole dataset. If DECIMAL had silently become
    // DOUBLE, this is where the rounding would surface.
    const broken = Number(
      await scalar(`
        SELECT count(*) FROM ${src}
         WHERE applied
           AND pre_count IS NOT NULL AND post_count IS NOT NULL
           AND post_count <> pre_count + delta_count`),
    );
    if (broken > 0) {
      violations.push({
        kind: 'semantics',
        column: 'post_count',
        detail: `${broken} applied delta(s) where post_count <> pre_count + delta_count`,
      });
    }
  }

  // --- prices must remain probabilities ----------------------------------
  if (present.has('price')) {
    const outOfRange = Number(
      await scalar(`SELECT count(*) FROM ${src} WHERE price IS NOT NULL AND (price < 0 OR price > 1)`),
    );
    if (outOfRange > 0) {
      violations.push({
        kind: 'semantics',
        column: 'price',
        detail: `${outOfRange} row(s) with price outside [0, 1]`,
      });
    }

    // Exact arithmetic check: under DECIMAL this is exactly zero; under DOUBLE
    // it would not be.
    const inexact = Number(
      await scalar(
        `SELECT count(*) FROM ${src} WHERE price IS NOT NULL AND (price * 100) - CAST(price * 100 AS BIGINT) <> 0`,
      ),
    );
    if (inexact > 0) {
      violations.push({
        kind: 'semantics',
        column: 'price',
        detail: `${inexact} price(s) are not exact at cent granularity; the column is probably a float`,
      });
    }
  }

  return violations;
}

export async function validateSilverFile(
  conn: DuckDBConnection,
  parquetPath: string,
): Promise<ContractViolation[]> {
  return [...(await checkSchema(conn, parquetPath)), ...(await checkSemantics(conn, parquetPath))];
}

export function describeViolations(violations: ContractViolation[]): string {
  return violations
    .map((v) => `${v.kind}${v.column ? ` [${v.column}]` : ''}: ${v.detail}`)
    .join('; ');
}
