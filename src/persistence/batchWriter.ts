import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isMissingPartitionError, isRetryableDbError, sleep, type Sql } from '@/src/persistence/db';
import type { FlushStats, IngestUnit, NormalizedRow, NormalizedTable } from '@/src/persistence/types';
import { logger } from '@/src/logging/logger';

/**
 * Batched, transactional writer.
 *
 * Design rules, in priority order:
 *
 *   1. No event is EVER silently dropped. If the database is unavailable the
 *      buffer grows; if it reaches the hard ceiling we spool to disk (daemon)
 *      or raise a critical integrity event (Vercel, where local disk is not
 *      durable). Dropping is not an option either way.
 *   2. Raw and normalised rows for a message are written in ONE transaction,
 *      so a normalised row without its raw provenance is impossible.
 *   3. One INSERT per table per flush, never one per delta.
 */

/**
 * JSONB columns per table.
 *
 * The dynamic INSERT passes JSON as a stringified positional parameter. Without
 * an explicit ::jsonb cast, Postgres stores that string as a JSON *string*
 * rather than as the array/object it represents -- which then reads back as a
 * string and breaks reconstruction. Every JSONB column must be listed here.
 */
const JSONB_COLUMNS: Partial<Record<NormalizedTable, readonly string[]>> = {
  orderbook_snapshots: ['yes_bids', 'no_bids'],
  market_lifecycle_events: ['payload'],
  sequence_gaps: ['affected_markets'],
  integrity_events: ['details'],
  book_validations: ['difference'],
  user_order_updates: ['payload'],
  user_fills: ['payload'],
  external_observations: ['raw'],
};

/**
 * Insert order within a flush.
 *
 * Tables are grouped by name and inserted table-by-table, so a child row can
 * reach the database before its parent unless the order is pinned. The only
 * foreign key among batched tables is
 * event_ladder_samples -> event_ladder_sample_groups, but ordering everything
 * explicitly means adding a related pair later cannot silently reintroduce the
 * problem. Tables not listed here are inserted afterwards in encounter order.
 */
const TABLE_INSERT_ORDER: readonly NormalizedTable[] = [
  'event_ladder_sample_groups',
  'event_ladder_samples',
];

/** Per-table conflict handling. Duplicates are expected and are not errors. */
/**
 * Postgres accepts at most 65,535 bind parameters per statement.
 *
 * A multi-row INSERT uses one parameter per column per row, so a large enough
 * batch exceeds it -- and MAX_PARAMETERS_EXCEEDED is not retryable, so the
 * flush would fail forever and the buffer would grow without bound. This is
 * reachable in normal operation: it is exactly what a database stall produces,
 * since the buffer is designed to keep growing rather than drop events.
 *
 * Statements are therefore chunked by parameter count, with headroom.
 */
const MAX_BIND_PARAMETERS = 60_000;

/** Largest row count that keeps one statement under the parameter limit. */
export function maxRowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(MAX_BIND_PARAMETERS / Math.max(1, columnCount)));
}

/** Splits rows into statement-sized chunks. */
export function chunkRows<T>(rows: T[], columnCount: number): T[][] {
  const size = maxRowsPerStatement(columnCount);
  if (rows.length <= size) return [rows];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const CONFLICT_CLAUSE: Partial<Record<NormalizedTable, string>> = {
  // A repeated transport frame must not produce a second delta row; the
  // duplicate is still preserved in raw_ingest_events.
  orderbook_deltas: 'ON CONFLICT (session_id, stream_id, seq) DO NOTHING',
  // Trades are deduplicated by exchange trade_id, per spec.
  public_trades: 'ON CONFLICT (trade_id) DO NOTHING',
  book_samples: 'ON CONFLICT (market_ticker, interval_ms, bucket_ts) DO NOTHING',
  event_ladder_sample_groups: 'ON CONFLICT (event_ticker, interval_ms, sampled_at) DO NOTHING',
  event_ladder_samples: 'ON CONFLICT (sample_group_id, market_ticker) DO NOTHING',
  orderflow_windows: 'ON CONFLICT (market_ticker, window_ms, bucket_ts) DO NOTHING',
  user_fills: 'ON CONFLICT (fill_id) DO NOTHING',
};

export interface BatchWriterOptions {
  sql: Sql;
  maxRows?: number;
  maxWaitMs?: number;
  /** Hard in-memory ceiling before spooling / alerting. */
  maxBufferedRows?: number;
  /** 'daemon' may spool to local disk; 'vercel_rolling' may not. */
  mode?: 'daemon' | 'vercel_rolling';
  spoolDir?: string;
  clock?: () => number;
}

export interface BatchWriterEvents {
  flushed: [FlushStats];
  error: [{ err: unknown; attempt: number; bufferedRows: number }];
  /** Emitted when the buffer ceiling is hit. Callers raise integrity events. */
  overflow: [{ bufferedRows: number; spooled: boolean; spoolPath?: string }];
  partitionMissing: [{ err: unknown }];
}

export class BatchWriter extends EventEmitter {
  // Typed event surface, declared as overrides rather than by merging an
  // interface into the class.
  override on<K extends keyof BatchWriterEvents>(
    event: K,
    listener: (...args: BatchWriterEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof BatchWriterEvents>(
    event: K,
    ...args: BatchWriterEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  private readonly sql: Sql;
  private readonly maxRows: number;
  private readonly maxWaitMs: number;
  private readonly maxBufferedRows: number;
  private readonly mode: 'daemon' | 'vercel_rolling';
  private readonly spoolDir: string;
  private readonly clock: () => number;

  private buffer: IngestUnit[] = [];
  private bufferedRowCount = 0;
  private oldestEnqueuedAt: number | null = null;

  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  readonly stats: FlushStats = {
    batches: 0,
    rawRows: 0,
    normalizedRows: 0,
    durationMs: 0,
    errors: 0,
  };

  /** Rolling flush latencies for the health-metrics aggregator. */
  private flushLatencies: number[] = [];

  constructor(opts: BatchWriterOptions) {
    super();
    this.sql = opts.sql;
    this.maxRows = opts.maxRows ?? 500;
    this.maxWaitMs = opts.maxWaitMs ?? 250;
    this.maxBufferedRows = opts.maxBufferedRows ?? 200_000;
    this.mode = opts.mode ?? 'daemon';
    this.spoolDir = opts.spoolDir ?? path.join(process.cwd(), '.spool');
    this.clock = opts.clock ?? Date.now;
  }

  get bufferedRows(): number {
    return this.bufferedRowCount;
  }

  get bufferedUnits(): number {
    return this.buffer.length;
  }

  /**
   * Enqueues one message's work. Returns immediately -- the socket handler
   * must never wait on the database.
   */
  enqueue(unit: IngestUnit): void {
    this.buffer.push(unit);
    this.bufferedRowCount += 1 + unit.normalized.length;
    this.oldestEnqueuedAt ??= this.clock();

    if (this.bufferedRowCount >= this.maxBufferedRows) {
      void this.handleOverflow();
      return;
    }

    if (this.closed || this.bufferedRowCount >= this.maxRows) {
      // After close, flush immediately rather than rejecting: a row that
      // arrives late during shutdown must still reach the database.
      void this.flush().catch((err) =>
        logger.error({ event: 'late_flush_failed', err: String(err) }, 'late flush failed'),
      );
      return;
    }

    this.armTimer();
  }

  /** Enqueues rows with no raw provenance (samples, health, validations). */
  enqueueDerived(rows: NormalizedRow[]): void {
    if (rows.length === 0) return;

    this.buffer.push({ raw: null as never, normalized: rows });
    this.bufferedRowCount += rows.length;
    this.oldestEnqueuedAt ??= this.clock();

    if (this.closed || this.bufferedRowCount >= this.maxRows) {
      void this.flush().catch((err) =>
        logger.error({ event: 'late_flush_failed', err: String(err) }, 'late flush failed'),
      );
    } else {
      this.armTimer();
    }
  }

  private armTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.maxWaitMs);
    this.timer.unref?.();
  }

  /**
   * Flushes the buffer. Concurrent calls coalesce onto the in-flight flush so
   * batches cannot interleave and reorder within a stream.
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;

    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const units = this.buffer;
    const rowCount = this.bufferedRowCount;
    this.buffer = [];
    this.bufferedRowCount = 0;
    this.oldestEnqueuedAt = null;

    if (units.length === 0) return;

    const started = this.clock();
    let attempt = 0;

    // Retry indefinitely on retryable errors: the alternative is data loss.
    // Non-retryable errors are re-thrown after the units are returned to the
    // buffer so nothing is lost on the way out either.
    for (;;) {
      attempt += 1;
      try {
        await this.writeUnits(units);
        break;
      } catch (err) {
        this.stats.errors += 1;
        // EventEmitter throws on an unhandled 'error' event, which would turn a
        // recoverable write failure into a process crash.
        if (this.listenerCount('error') > 0) {
          this.emit('error', { err, attempt, bufferedRows: rowCount });
        }

        if (isMissingPartitionError(err)) {
          // Partition maintenance has failed. Retrying will not help until a
          // partition exists, but the data must be kept.
          logger.error(
            { event: 'raw_partition_missing', err: String(err) },
            'no partition for incoming raw events; partition maintenance must run',
          );
          this.emit('partitionMissing', { err });
        } else if (!isRetryableDbError(err)) {
          this.requeue(units);
          logger.error(
            { event: 'db_write_failed_fatal', err: String(err), attempt },
            'non-retryable database error; rows returned to buffer',
          );
          throw err;
        }

        const backoff = Math.min(30_000, 100 * 2 ** Math.min(attempt - 1, 8));
        const jittered = backoff / 2 + Math.random() * (backoff / 2);
        logger.warn(
          { event: 'db_write_retry', attempt, delayMs: Math.round(jittered), err: String(err) },
          'database write failed; retrying',
        );
        await sleep(jittered);
      }
    }

    const durationMs = this.clock() - started;
    this.stats.batches += 1;
    this.stats.durationMs += durationMs;
    this.flushLatencies.push(durationMs);
    if (this.flushLatencies.length > 5000) this.flushLatencies = this.flushLatencies.slice(-2500);

    this.emit('flushed', {
      batches: 1,
      rawRows: units.filter((u) => u.raw).length,
      normalizedRows: units.reduce((n, u) => n + u.normalized.length, 0),
      durationMs,
      errors: 0,
    });
  }

  /** Puts units back at the FRONT so stream order is preserved. */
  private requeue(units: IngestUnit[]): void {
    this.buffer = [...units, ...this.buffer];
    this.bufferedRowCount += units.reduce((n, u) => n + (u.raw ? 1 : 0) + u.normalized.length, 0);
  }

  /**
   * Writes raw rows and their normalised children in one transaction.
   *
   * Raw ids are assigned by a single INSERT ... VALUES, so the identity
   * sequence hands them out in row order; sorting RETURNING ids ascending
   * therefore reproduces the input order exactly without relying on the
   * (unspecified) order of the RETURNING result set.
   */
  private async writeUnits(units: IngestUnit[]): Promise<void> {
    const withRaw = units.filter((u) => u.raw);

    await this.sql.begin(async (tx) => {
      let rawIds: { id: string; received_at: Date }[] = [];

      if (withRaw.length > 0) {
        const rawRows = withRaw.map((u) => ({
          session_id: u.raw.sessionId,
          stream_id: u.raw.streamId ?? null,
          ingest_ordinal: u.raw.ingestOrdinal.toString(),
          received_at: u.raw.receivedAt,
          received_at_ms: u.raw.receivedAtMs.toString(),
          recv_monotonic_ns: u.raw.recvMonotonicNs.toString(),
          channel: u.raw.channel ?? null,
          message_type: u.raw.messageType,
          sid: u.raw.sid ?? null,
          seq: u.raw.seq === null || u.raw.seq === undefined ? null : u.raw.seq.toString(),
          market_ticker: u.raw.marketTicker ?? null,
          market_id: u.raw.marketId ?? null,
          exchange_ts_ms:
            u.raw.exchangeTsMs === null || u.raw.exchangeTsMs === undefined
              ? null
              : u.raw.exchangeTsMs.toString(),
          payload_hash: u.raw.payloadHash,
          payload: tx.json(u.raw.payload as never),
          parse_version: u.raw.parseVersion,
        }));

        // Chunked to stay under the bind-parameter limit. Ordering across
        // chunks is preserved because the identity sequence hands ids out in
        // statement order and the results are sorted by id afterwards.
        const columnCount = Object.keys(rawRows[0] ?? {}).length;
        const returned: { id: string; received_at: Date }[] = [];

        for (const chunk of chunkRows(rawRows, columnCount)) {
          const part = await tx<{ id: string; received_at: Date }[]>`
            INSERT INTO raw_ingest_events ${tx(chunk)}
            RETURNING id, received_at
          `;
          returned.push(...part);
        }

        if (returned.length !== withRaw.length) {
          throw new Error(
            `raw insert returned ${returned.length} ids for ${withRaw.length} rows`,
          );
        }

        rawIds = [...returned].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      }

      // Attach provenance, then group by table.
      const byTable = new Map<NormalizedTable, Record<string, unknown>[]>();

      const pushRow = (row: NormalizedRow) => {
        const list = byTable.get(row.table) ?? [];
        list.push(row.values);
        byTable.set(row.table, list);
      };

      let rawIdx = 0;
      for (const unit of units) {
        let link: { id: string; received_at: Date } | null = null;
        if (unit.raw) {
          link = rawIds[rawIdx] ?? null;
          rawIdx += 1;
        }

        for (const row of unit.normalized) {
          if (row.linkRawEvent && link) {
            row.values.raw_event_id = link.id;
            row.values.raw_event_received_at = link.received_at;
            // Observation order, carried directly so silver exports need not
            // join back to raw_ingest_events, which is deleted after its
            // retention window.
            if (unit.raw) row.values.ingest_ordinal = unit.raw.ingestOrdinal.toString();
          }
          pushRow(row);
        }
      }

      for (const table of orderedTables(byTable)) {
        const rows = byTable.get(table)!;
        if (rows.length === 0) continue;

        const conflict = CONFLICT_CLAUSE[table] ?? '';
        const columnCount = new Set(rows.flatMap((r) => Object.keys(r))).size;

        for (const chunk of chunkRows(rows, columnCount)) {
          const aligned = alignColumns(chunk);
          await tx.unsafe(
            `INSERT INTO ${table} ${buildValuesPlaceholder(aligned, JSONB_COLUMNS[table])} ${conflict}`,
            flattenValues(aligned),
          );
        }
      }
    });

    this.stats.rawRows += withRaw.length;
    this.stats.normalizedRows += units.reduce((n, u) => n + u.normalized.length, 0);
  }

  /**
   * Buffer ceiling reached. Daemon mode spools to local disk; Vercel cannot,
   * because a function's filesystem is not durable -- there the caller must
   * raise a critical integrity event.
   */
  private async handleOverflow(): Promise<void> {
    const units = this.buffer;
    const rows = this.bufferedRowCount;

    if (this.mode !== 'daemon') {
      logger.error(
        { event: 'buffer_overflow', bufferedRows: rows, mode: this.mode },
        'write buffer ceiling reached and local disk is not durable here',
      );
      this.emit('overflow', { bufferedRows: rows, spooled: false });
      // Keep buffering and keep retrying; do NOT drop.
      void this.flush();
      return;
    }

    this.buffer = [];
    this.bufferedRowCount = 0;

    const spoolPath = path.join(this.spoolDir, `spool-${Date.now()}-${process.pid}.ndjson`);
    try {
      await mkdir(this.spoolDir, { recursive: true });
      const lines = units
        .map((u) =>
          JSON.stringify(
            { raw: u.raw, normalized: u.normalized },
            (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Buffer ? v.toString('base64') : v),
          ),
        )
        .join('\n');
      await appendFile(spoolPath, `${lines}\n`, 'utf8');

      logger.error(
        { event: 'buffer_spooled', bufferedRows: rows, spoolPath },
        'write buffer ceiling reached; spooled to local disk for later replay',
      );
      this.emit('overflow', { bufferedRows: rows, spooled: true, spoolPath });
    } catch (err) {
      // Spooling failed: put the units back rather than lose them.
      this.requeue(units);
      logger.error({ event: 'spool_failed', err: String(err) }, 'failed to spool buffered rows');
      this.emit('overflow', { bufferedRows: rows, spooled: false });
    }
  }

  /** Flush latency percentiles since the last call, then resets the window. */
  drainFlushLatencies(): { avg: number; max: number; p50: number; p95: number; p99: number } | null {
    if (this.flushLatencies.length === 0) return null;
    const s = [...this.flushLatencies].sort((a, b) => a - b);
    this.flushLatencies = [];
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
    return {
      avg: s.reduce((a, b) => a + b, 0) / s.length,
      max: s[s.length - 1]!,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
    };
  }

  /**
   * Marks the writer closed and drains everything buffered.
   *
   * Late enqueues are still accepted and flushed -- dropping them would lose
   * events that exist nowhere else.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    // A deferred task may have enqueued during that flush.
    if (this.buffer.length > 0) await this.flush();
  }
}

// ---------------------------------------------------------------------------
// Dynamic multi-row INSERT construction
// ---------------------------------------------------------------------------

interface Aligned {
  columns: string[];
  rows: unknown[][];
}

/**
 * Rows for one table may carry different optional columns. Align them to the
 * union of keys, filling gaps with null, so a single multi-row INSERT works.
 */
/** Parents first, then everything else in encounter order. */
export function orderedTables(byTable: Map<NormalizedTable, unknown>): NormalizedTable[] {
  const present = [...byTable.keys()];
  const ranked = TABLE_INSERT_ORDER.filter((t) => byTable.has(t));
  const rest = present.filter((t) => !TABLE_INSERT_ORDER.includes(t));
  return [...ranked, ...rest];
}

export function alignColumns(rows: Record<string, unknown>[]): Aligned {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return {
    columns,
    rows: rows.map((r) => columns.map((c) => (c in r ? r[c] : null))),
  };
}

export function buildValuesPlaceholder(
  aligned: Aligned,
  jsonbColumns: readonly string[] = [],
): string {
  const { columns, rows } = aligned;
  const jsonb = new Set(jsonbColumns);
  const cols = columns.map((c) => `"${c}"`).join(', ');
  let n = 0;
  const tuples = rows
    .map(
      () =>
        `(${columns.map((c) => `$${++n}${jsonb.has(c) ? '::jsonb' : ''}`).join(', ')})`,
    )
    .join(', ');
  return `(${cols}) VALUES ${tuples}`;
}

export function flattenValues(aligned: Aligned): unknown[] {
  return aligned.rows.flat();
}
