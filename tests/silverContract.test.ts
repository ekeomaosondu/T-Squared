import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBConnection } from '@duckdb/node-api';
import { checkSchema, checkSemantics, validateSilverFile } from '@/src/persistence/silverContract';

/**
 * The silver contract exists because Parquet type drift does NOT fail loudly.
 * A VARCHAR ordering key still queries fine while sorting 100 before 99, and a
 * DOUBLE price accumulates error that looks like microstructure. Both would
 * invalidate research without an obvious failure, so both are rejected at
 * export time.
 */

let conn: DuckDBConnection;
let dir: string;

beforeAll(async () => {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  conn = await (await DuckDBInstance.create(':memory:')).connect();
  dir = await mkdtemp(path.join(tmpdir(), 'kx-contract-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a Parquet file from an inline SELECT. */
async function write(name: string, select: string): Promise<string> {
  const p = path.join(dir, `${name}.parquet`);
  await conn.run(`COPY (${select}) TO '${p}' (FORMAT PARQUET)`);
  return p;
}

const GOOD_DELTAS = `
  SELECT * FROM (VALUES
    ('s1', 1::BIGINT, 10::BIGINT, CAST(0.42 AS DECIMAL(12,6)), CAST(5 AS DECIMAL(24,6)),
     CAST(100 AS DECIMAL(24,6)), CAST(105 AS DECIMAL(24,6)), true, 1789400000000::BIGINT),
    ('s1', 2::BIGINT, 11::BIGINT, CAST(0.43 AS DECIMAL(12,6)), CAST(-5 AS DECIMAL(24,6)),
     CAST(105 AS DECIMAL(24,6)), CAST(100 AS DECIMAL(24,6)), true, 1789400000100::BIGINT),
    ('s1', 100::BIGINT, 12::BIGINT, CAST(0.99 AS DECIMAL(12,6)), CAST(1 AS DECIMAL(24,6)),
     CAST(100 AS DECIMAL(24,6)), CAST(101 AS DECIMAL(24,6)), true, 1789400000200::BIGINT)
  ) AS t(session_id, ingest_ordinal, seq, price, delta_count, pre_count, post_count, applied, received_at_ms)`;

describe('silver schema contract', () => {
  it('accepts a correctly typed file', async () => {
    const p = await write('good', GOOD_DELTAS);
    expect(await validateSilverFile(conn, p)).toEqual([]);
  });

  it('rejects an ordering key stored as VARCHAR', async () => {
    // Exactly the bug R2 surfaced: min/max then sort lexicographically.
    const p = await write(
      'varchar_ordinal',
      GOOD_DELTAS.replace('ingest_ordinal, seq', 'ingest_ordinal, seq').replace(
        'SELECT * FROM (VALUES',
        'SELECT * FROM (VALUES',
      ),
    );
    const cast = await write(
      'varchar_ordinal2',
      `SELECT session_id, CAST(ingest_ordinal AS VARCHAR) AS ingest_ordinal, seq, price,
              delta_count, pre_count, post_count, applied, received_at_ms
         FROM read_parquet('${p}')`,
    );

    const violations = await checkSchema(conn, cast);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.column).toBe('ingest_ordinal');
    expect(violations[0]!.detail).toMatch(/100 before 99/);
  });

  it('rejects a price stored as DOUBLE', async () => {
    const good = await write('px_good', GOOD_DELTAS);
    const bad = await write(
      'px_double',
      `SELECT session_id, ingest_ordinal, seq, CAST(price AS DOUBLE) AS price,
              delta_count, pre_count, post_count, applied, received_at_ms
         FROM read_parquet('${good}')`,
    );

    const violations = await checkSchema(conn, bad);
    expect(violations.some((v) => v.column === 'price')).toBe(true);
    expect(violations.find((v) => v.column === 'price')!.detail).toMatch(/must not become floats/);
  });

  it('ignores critical columns a table legitimately lacks', async () => {
    // Trades have no delta_count; absence is not drift.
    const p = await write(
      'trades',
      `SELECT 't1' AS trade_id, 1::BIGINT AS ingest_ordinal,
              CAST(0.42 AS DECIMAL(12,6)) AS yes_price, CAST(10 AS DECIMAL(24,6)) AS "count"`,
    );
    expect(await checkSchema(conn, p)).toEqual([]);
  });
});

describe('silver semantic contract', () => {
  it('accepts data whose invariants hold', async () => {
    const p = await write('sem_good', GOOD_DELTAS);
    expect(await checkSemantics(conn, p)).toEqual([]);
  });

  it('rejects a file where post_count != pre_count + delta_count', async () => {
    // The core invariant of the whole dataset.
    const p = await write(
      'sem_arith',
      `SELECT 's1' AS session_id, 1::BIGINT AS ingest_ordinal, 10::BIGINT AS seq,
              CAST(0.42 AS DECIMAL(12,6)) AS price, CAST(5 AS DECIMAL(24,6)) AS delta_count,
              CAST(100 AS DECIMAL(24,6)) AS pre_count, CAST(999 AS DECIMAL(24,6)) AS post_count,
              true AS applied, 1789400000000::BIGINT AS received_at_ms`,
    );
    const violations = await checkSemantics(conn, p);
    expect(violations.some((v) => v.detail.includes('post_count <> pre_count + delta_count'))).toBe(true);
  });

  it('rejects prices outside [0, 1]', async () => {
    const p = await write(
      'sem_px',
      `SELECT 's1' AS session_id, 1::BIGINT AS ingest_ordinal, 10::BIGINT AS seq,
              CAST(1.5 AS DECIMAL(12,6)) AS price, CAST(5 AS DECIMAL(24,6)) AS delta_count,
              CAST(100 AS DECIMAL(24,6)) AS pre_count, CAST(105 AS DECIMAL(24,6)) AS post_count,
              true AS applied, 1789400000000::BIGINT AS received_at_ms`,
    );
    const violations = await checkSemantics(conn, p);
    expect(violations.some((v) => v.detail.includes('outside [0, 1]'))).toBe(true);
  });

  it('rejects a file whose ordering key never advances', async () => {
    const p = await write(
      'sem_flat',
      `SELECT * FROM (VALUES
        ('s1', 7::BIGINT, 10::BIGINT, 1789400000000::BIGINT),
        ('s1', 7::BIGINT, 11::BIGINT, 1789400000100::BIGINT)
      ) AS t(session_id, ingest_ordinal, seq, received_at_ms)`,
    );
    const violations = await checkSemantics(conn, p);
    expect(violations.some((v) => v.detail.includes('does not advance'))).toBe(true);
  });

  it('rejects a file where every ordinal is null', async () => {
    const p = await write(
      'sem_null',
      `SELECT 's1' AS session_id, CAST(NULL AS BIGINT) AS ingest_ordinal,
              10::BIGINT AS seq, 1789400000000::BIGINT AS received_at_ms`,
    );
    const violations = await checkSemantics(conn, p);
    expect(violations.some((v) => v.detail.includes('observation order cannot be reconstructed'))).toBe(true);
  });

  it('passes an empty file rather than inventing violations', async () => {
    const p = await write(
      'sem_empty',
      `SELECT 's1' AS session_id, 1::BIGINT AS ingest_ordinal WHERE false`,
    );
    expect(await checkSemantics(conn, p)).toEqual([]);
  });
});
