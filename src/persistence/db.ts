import postgres from 'postgres';
import { env, redactDatabaseUrl } from '@/src/config/env';
import { logger } from '@/src/logging/logger';

/**
 * ===========================================================================
 * SQL ORDERING RULES  (project-wide, enforced by tests/sqlConventions.test.ts)
 * ===========================================================================
 *
 * PostgreSQL resolves a bare name in ORDER BY / GROUP BY / DISTINCT ON to an
 * OUTPUT COLUMN ALIAS in preference to an input column. So this:
 *
 *     SELECT d.seq::text AS seq FROM orderbook_deltas d ORDER BY seq;
 *
 * sorts the TEXT result -- 100, 101, 1111, 13, 130 -- not the number. That
 * silently applied order-book deltas in the wrong order and was only caught
 * because replay equality failed.
 *
 * Two rules follow:
 *
 *   1. Never cast a numeric or temporal ORDERING KEY into its display
 *      representation inside the query that performs the ordering. It is not
 *      needed anyway: this driver is configured to return int8 as a string and
 *      postgres.js returns numeric as a string, so values arrive decimal-safe
 *      without any cast. If a cast is genuinely required, alias it to a name
 *      that cannot shadow a column (e.g. `AS day_text`).
 *
 *   2. Every ORDER BY / GROUP BY / DISTINCT ON referring to a source column
 *      must be table-qualified:  ORDER BY d.seq,  not  ORDER BY seq.
 *
 * ===========================================================================
 *
 * Lightweight typed SQL over postgres.js. No ORM in the ingest hot path.
 *
 * Decimal safety: NUMERIC and BIGINT are ALWAYS returned as strings and handed
 * to decimal.js / BigInt explicitly. A NUMERIC that silently became a JS float
 * on the way out of the database would defeat the entire point of storing
 * exchange state as NUMERIC in the first place.
 */

export type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Unwraps a query that must return exactly one row. Preferred over array
 * destructuring so that an unexpectedly empty result fails at the call site
 * instead of surfacing later as `undefined`.
 */
export function one<T>(rows: readonly T[], context = 'query'): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${context}: expected at least one row, got none`);
  return row;
}

let instance: Sql | null = null;

export interface DbOptions {
  connectionString?: string;
  max?: number;
  /** Applied to every statement; guards against a hung query wedging ingest. */
  statementTimeoutMs?: number;
  onnotice?: (notice: postgres.Notice) => void;
}

export function createDb(opts: DbOptions = {}): Sql {
  const connectionString = opts.connectionString ?? env().DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; the recorder cannot run without a database.');
  }

  const isNeon = /neon\.tech/i.test(connectionString);

  return postgres(connectionString, {
    max: opts.max ?? 10,
    // Neon terminates idle connections aggressively; reconnect rather than
    // surfacing a dead socket to the batch writer.
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    ssl: isNeon ? 'require' : undefined,
    prepare: !isNeon, // PgBouncer-compatible when pooled.
    onnotice:
      opts.onnotice ??
      ((notice) => {
        // Postgres NOTICEs are informational; a missing-partition ERROR is what
        // we actually care about and that surfaces as a thrown error.
        logger.debug({ event: 'pg_notice', message: notice.message }, 'postgres notice');
      }),
    types: {
      // int8 -> string. Callers convert to BigInt deliberately.
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: bigint | number | string) => v.toString(),
        parse: (v: string) => v,
      },
    },
    transform: { undefined: null },
    connection: {
      application_name: 'kalshi-market-recorder',
      ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
    },
  }) as unknown as Sql;
}

export function db(): Sql {
  if (!instance) {
    instance = createDb();
    logger.info(
      { event: 'db_connected', database: redactDatabaseUrl(env().DATABASE_URL) },
      'database pool created',
    );
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.end({ timeout: 5 });
    instance = null;
  }
}

/** Test seam. */
export function setDb(sql: Sql | null): void {
  instance = sql;
}

// ---------------------------------------------------------------------------
// Advisory locks
// ---------------------------------------------------------------------------

/** Partition maintenance. Shared with ensure_raw_ingest_partitions(). */
export const LOCK_PARTITION_MAINTENANCE = 81_726_391;
/** Lease ownership transitions. */
export const LOCK_COLLECTOR_LEASE = 81_726_392;
/** Archive worker; only one may seal/upload a partition at a time. */
export const LOCK_ARCHIVE_WORKER = 81_726_393;

/**
 * Runs `fn` while holding a session-level advisory lock. Returns null without
 * running `fn` if the lock is already held elsewhere -- callers treat that as
 * "another worker is doing this", not as an error.
 */
export async function withTryAdvisoryLock<T>(
  sql: Sql,
  key: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const rows = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${key}::bigint) AS locked
  `;
  if (!one(rows).locked) return null;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(${key}::bigint)`;
  }
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/** Postgres error codes worth retrying: transient connectivity and deadlocks. */
const RETRYABLE_CODES = new Set([
  '08000', '08003', '08006', '08001', '08004', // connection exceptions
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P01', '57P02', '57P03', // admin shutdown / crash shutdown / cannot connect now
  '53300', // too_many_connections
]);

export function isRetryableDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const msg = err instanceof Error ? err.message : '';
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|Connection terminated/i.test(msg);
}

/**
 * A missing partition is NOT retryable and must be loud: it means partition
 * maintenance has failed and raw events cannot be durably written.
 */
export function isMissingPartitionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return code === '23514' || /no partition of relation .* found for row/i.test(msg);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  signal?: AbortSignal;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 100;
  const max = opts.maxDelayMs ?? 10_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryableDbError(err)) throw err;

      const exp = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.round(exp / 2 + Math.random() * (exp / 2)); // full-ish jitter
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
