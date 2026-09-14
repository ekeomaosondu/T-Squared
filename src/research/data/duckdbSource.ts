import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import {
  fingerprintObjects,
  LAKE_TABLES,
  lakeGlob,
  utcDaysBetween,
  type LakeObject,
  type LakeTable,
} from '@/src/research/data/datasetManifest';
import type {
  BookCheckpoint,
  DatasetSlice,
  HistoricalDataSource,
  HistoricalRequest,
} from '@/src/research/data/historicalDataSource';
import {
  compareOrderKeys,
  orderKeyOf,
  type BookDeltaEvent,
  type BookSnapshotEvent,
  type CaptureGapEvent,
  type Level,
  type OrderKey,
  type ResearchEvent,
  type TradeEvent,
} from '@/src/research/events/researchEvent';
import { logger } from '@/src/logging/logger';

/**
 * Reads the silver Parquet lake in Cloudflare R2 directly, through DuckDB.
 *
 * Nothing is downloaded first. The lake is hive-partitioned as
 * `silver/<table>/date=.../series=.../part-*.parquet`, so date and series
 * become columns DuckDB can prune whole directories on before opening a file;
 * market and time predicates then push into the row groups. A one-day,
 * 24-market slice is a handful of range requests rather than a bulk copy.
 *
 * ---------------------------------------------------------------------------
 * Ordering
 * ---------------------------------------------------------------------------
 * Events come out in the collector's observation order, reproducing exactly
 * the rules the recorder's own replay proved:
 *
 *   - sessions in chronological order, NEVER by session UUID
 *   - streams in chronological order, NEVER by stream UUID -- `seq` restarts
 *     on every reconnect, so a session that reconnected holds several streams
 *     with overlapping sequence ranges
 *   - `seq` within a stream, as the exchange's own authority
 *   - `ingest_ordinal` for the collector's cross-market observation order
 *
 * Sorting is done on typed BIGINT columns. Never on their string forms: a
 * VARCHAR ordinal sorts 100 before 99, which is precisely the bug that once
 * made this dataset's deltas replay out of order.
 */

export interface DuckDBSourceOptions {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Rows pulled from DuckDB per chunk. Bounds memory on a multi-day scan. */
  chunkRows?: number;
}

interface RawDelta {
  session_id: string;
  /**
   * Null on rows recorded before ingest_ordinal existed. Ordering falls back
   * to (receive time, stream, seq) for those, which is exactly what the
   * recorder's own replay used at the time -- so the fallback is the original
   * semantics, not a degradation.
   */
  ingest_ordinal: bigint | null;
  market_ticker: string;
  event_ticker: string | null;
  series_ticker: string | null;
  stream_id: string;
  seq: bigint;
  exchange_ts_ms: bigint | null;
  received_at_ms: bigint;
  side: 'yes' | 'no';
  price: string;
  delta_count: string;
  pre_count: string | null;
  post_count: string | null;
  applied: boolean;
  apply_error: string | null;
}

interface RawTrade {
  trade_id: string;
  session_id: string;
  ingest_ordinal: bigint | null;
  market_ticker: string;
  event_ticker: string | null;
  series_ticker: string | null;
  stream_id: string | null;
  seq: bigint | null;
  yes_price: string;
  no_price: string;
  count: string;
  taker_outcome_side: string | null;
  taker_book_side: string | null;
  is_block_trade: boolean;
  exchange_ts_ms: bigint | null;
  received_at_ms: bigint;
}

interface RawSnapshot {
  snapshot_id: bigint;
  session_id: string;
  stream_id: string | null;
  market_ticker: string;
  event_ticker: string | null;
  series_ticker: string | null;
  source: string;
  seq: bigint | null;
  received_at_ms: bigint;
  yes_bids_json: string;
  no_bids_json: string;
  state_hash: string | null;
}

/** Snapshot sources the exchange actually sent. See BookSnapshotEvent. */
const EXCHANGE_SNAPSHOT_SOURCES = ['ws_initial', 'ws_recovery', 'session_handoff'] as const;

const sqlList = (values: readonly string[]) =>
  values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');

export class DuckDBHistoricalDataSource implements HistoricalDataSource {
  readonly kind = 'duckdb-r2';

  private instance: DuckDBInstance | null = null;
  private conn: DuckDBConnection | null = null;
  /** Streaming cursors, each on its own connection. See newConnection(). */
  private readonly cursorConns: DuckDBConnection[] = [];

  constructor(private readonly opts: DuckDBSourceOptions) {}

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  private async connection(): Promise<DuckDBConnection> {
    if (!this.conn) this.conn = await this.newConnection();
    return this.conn;
  }

  /**
   * A fresh connection onto the same in-memory instance.
   *
   * A DuckDB connection holds ONE streaming result at a time: issuing another
   * query on it invalidates the first. The merge reads deltas and trades
   * concurrently, so each cursor needs its own connection -- otherwise the
   * delta cursor silently ends after a single 2048-row vector and the backtest
   * runs on a fraction of the data while reporting success.
   */
  private async newConnection(): Promise<DuckDBConnection> {
    if (!this.instance) {
      const { DuckDBInstance: Instance } = await import('@duckdb/node-api');
      this.instance = await Instance.create(':memory:');
    }
    const conn = await this.instance.connect();

    // Everything in this dataset is UTC. DuckDB otherwise renders timestamps
    // in the host's zone, which silently shifts a "day" by the local offset --
    // enough to attribute an evening's trading to the wrong session.
    await conn.run(`SET TimeZone = 'UTC'`);

    const host = this.opts.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    await conn.run(`
      CREATE OR REPLACE SECRET research_lake (
        TYPE S3,
        KEY_ID '${this.opts.accessKeyId.replace(/'/g, "''")}',
        SECRET '${this.opts.secretAccessKey.replace(/'/g, "''")}',
        ENDPOINT '${host.replace(/'/g, "''")}',
        REGION '${(this.opts.region || 'auto').replace(/'/g, "''")}',
        URL_STYLE 'path',
        USE_SSL true
      )`);

    return conn;
  }

  async close(): Promise<void> {
    for (const c of this.cursorConns.splice(0)) c.closeSync();
    this.conn?.closeSync();
    this.conn = null;
    this.instance = null;
  }

  // -------------------------------------------------------------------------
  // Predicates
  // -------------------------------------------------------------------------

  /**
   * Filters shared by every table, written so DuckDB can push them down.
   *
   * `date` and `series` are hive partition columns, so restricting them prunes
   * directories before any file is opened. `received_at_ms` prunes row groups
   * inside the files that survive.
   */
  private predicates(alias: string, req: HistoricalRequest): string[] {
    const parts: string[] = [];

    const days = utcDaysBetween(req.startTime, req.endTime);
    if (days.length > 0) {
      parts.push(`${alias}.date IN (${days.map((d) => `DATE '${d}'`).join(', ')})`);
    }
    if (req.seriesTickers?.length) {
      parts.push(`${alias}.series IN (${sqlList(req.seriesTickers)})`);
    }
    if (req.eventTickers?.length) {
      parts.push(`${alias}.event_ticker IN (${sqlList(req.eventTickers)})`);
    }
    if (req.marketTickers?.length) {
      parts.push(`${alias}.market_ticker IN (${sqlList(req.marketTickers)})`);
    }
    parts.push(`${alias}.received_at_ms >= ${BigInt(req.startTime.getTime())}`);
    parts.push(`${alias}.received_at_ms < ${BigInt(req.endTime.getTime())}`);

    return parts;
  }

  private glob(table: LakeTable): string {
    return lakeGlob(this.opts.bucket, table);
  }

  // -------------------------------------------------------------------------
  // describe
  // -------------------------------------------------------------------------

  async describe(req: HistoricalRequest): Promise<DatasetSlice> {
    const conn = await this.connection();

    const objects: LakeObject[] = [];
    const rowCounts: Record<string, number> = {};

    for (const table of [LAKE_TABLES.deltas, LAKE_TABLES.snapshots, LAKE_TABLES.trades]) {
      // Footer-only read: identifies the physical files without scanning them.
      const meta = await this.rows<{ file_name: string; num_rows: bigint; num_row_groups: bigint }>(
        conn,
        `SELECT m.file_name, m.num_rows, m.num_row_groups
           FROM parquet_file_metadata('${this.glob(table)}') AS m
          ORDER BY m.file_name`,
      ).catch(() => []);
      for (const m of meta) {
        objects.push({
          path: m.file_name,
          rows: Number(m.num_rows),
          rowGroups: Number(m.num_row_groups),
        });
      }

      const counted = await this.rows<{ n: bigint }>(
        conn,
        `SELECT count(*) AS n FROM read_parquet('${this.glob(table)}', hive_partitioning = true) AS t
          WHERE ${this.predicates('t', req).join(' AND ')}`,
      ).catch(() => [{ n: 0n }]);
      rowCounts[table] = Number(counted[0]?.n ?? 0n);
    }

    const bounds = await this.rows<{
      first_ms: bigint | null;
      last_ms: bigint | null;
    }>(
      conn,
      `SELECT min(d.received_at_ms) AS first_ms, max(d.received_at_ms) AS last_ms
         FROM read_parquet('${this.glob(LAKE_TABLES.deltas)}', hive_partitioning = true) AS d
        WHERE ${this.predicates('d', req).join(' AND ')}`,
    );

    const universe = await this.rows<{ market_ticker: string; series_ticker: string | null }>(
      conn,
      `SELECT DISTINCT d.market_ticker, d.series_ticker
         FROM read_parquet('${this.glob(LAKE_TABLES.deltas)}', hive_partitioning = true) AS d
        WHERE ${this.predicates('d', req).join(' AND ')}
        ORDER BY d.market_ticker`,
    );

    const gaps = await this.deriveCaptureGaps(conn, req);

    return {
      datasetId: req.datasetId,
      fingerprint: fingerprintObjects(objects),
      objects,
      rowCounts,
      firstReceiveMs: bounds[0]?.first_ms ?? null,
      lastReceiveMs: bounds[0]?.last_ms ?? null,
      marketTickers: universe.map((u) => u.market_ticker),
      seriesTickers: [...new Set(universe.map((u) => u.series_ticker).filter((s): s is string => !!s))].sort(),
      captureGaps: gaps.map((g) => ({
        gapId: g.gapId,
        startedAtMs: g.startedAtMs,
        endedAtMs: g.endedAtMs,
        reason: g.reason,
        affectedMarkets: [...g.affectedMarkets],
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  /**
   * The collector's own book hashes, taken while it was recording.
   *
   * `local_materialized` snapshots are the recorder's periodic sample of the
   * book it maintained live from the same frames this replay is reading. If
   * the replay reproduces those hashes exactly then it has reconstructed the
   * identical ladder -- every price, every size, in the same order -- and not
   * merely something with the same best bid.
   *
   * This is the strongest check available without contacting the exchange, and
   * it is the reason these rows are excluded from the event stream: replaying
   * them as events would reseed the book from the very state being verified.
   */
  async checkpoints(req: HistoricalRequest): Promise<BookCheckpoint[]> {
    const conn = await this.connection();
    const rows = await this.rows<{
      market_ticker: string;
      received_at_ms: bigint;
      state_hash: string;
    }>(
      conn,
      `SELECT s.market_ticker, s.received_at_ms, s.state_hash
         FROM read_parquet('${this.glob(LAKE_TABLES.snapshots)}', hive_partitioning = true) AS s
        WHERE ${this.predicates('s', req).join(' AND ')}
          AND s.source = 'local_materialized'
          AND s.state_hash IS NOT NULL
        ORDER BY s.received_at_ms, s.market_ticker`,
    );
    return rows.map((r) => ({
      marketTicker: r.market_ticker,
      atMs: BigInt(r.received_at_ms),
      stateHash: r.state_hash,
    }));
  }

  // -------------------------------------------------------------------------
  // Capture gaps
  // -------------------------------------------------------------------------

  /**
   * Coverage gaps, derived from the lake rather than read from Postgres.
   *
   * The operational database records these with a reason, but it only keeps a
   * few days -- research must stay answerable from R2 alone, long after the
   * hot store has expired the rows. So the gaps are derived from what the data
   * itself proves: the order-book channel is one subscription, a reconnect or
   * restart opens a NEW stream, and the interval between the last frame of one
   * stream and the first frame of the next is time nobody was listening.
   *
   * The reason is consequently unknown here. That is a deliberate trade: the
   * INTERVAL is what a backtest must respect, and the interval is exact.
   */
  private async deriveCaptureGaps(
    conn: DuckDBConnection,
    req: HistoricalRequest,
  ): Promise<CaptureGapEvent[]> {
    const streams = await this.rows<{
      session_id: string;
      stream_id: string;
      first_ms: bigint;
      last_ms: bigint;
      markets: string;
    }>(
      conn,
      `SELECT CAST(g.session_id AS VARCHAR) AS session_id,
              CAST(g.stream_id AS VARCHAR) AS stream_id,
              g.first_ms, g.last_ms, g.markets
         FROM (
           SELECT d.session_id,
                  d.stream_id,
                  min(d.received_at_ms) AS first_ms,
                  max(d.received_at_ms) AS last_ms,
                  to_json(list(DISTINCT d.market_ticker)) AS markets
             FROM read_parquet('${this.glob(LAKE_TABLES.deltas)}', hive_partitioning = true) AS d
            WHERE ${this.predicates('d', req).join(' AND ')}
            GROUP BY d.session_id, d.stream_id
         ) AS g
        ORDER BY g.first_ms, g.stream_id`,
    );

    const gaps: CaptureGapEvent[] = [];
    for (let i = 1; i < streams.length; i++) {
      const prev = streams[i - 1]!;
      const next = streams[i]!;
      if (next.first_ms <= prev.last_ms) continue; // overlapping handoff: no gap

      let affected: string[] = [];
      try {
        affected = (JSON.parse(prev.markets) as string[]) ?? [];
      } catch {
        affected = [];
      }

      gaps.push({
        kind: 'capture_gap',
        gapId: `${prev.stream_id}->${next.stream_id}`,
        startedAtMs: prev.last_ms,
        endedAtMs: next.first_ms,
        reason: prev.session_id === next.session_id ? 'restart' : 'unknown',
        affectedMarkets: affected.sort(),
        exchangeTimeMs: null,
        receiveTimeMs: prev.last_ms,
        sessionId: prev.session_id,
        ingestOrdinal: null,
        streamId: prev.stream_id,
        seq: null,
      });
    }
    return gaps;
  }

  // -------------------------------------------------------------------------
  // stream
  // -------------------------------------------------------------------------

  async *stream(req: HistoricalRequest): AsyncIterable<ResearchEvent> {
    const conn = await this.connection();

    // Session and stream ranks by FIRST OBSERVED TIME. Computed once, up
    // front, so ordering never depends on a UUID.
    const { sessionRank, streamRank } = await this.ranks(conn, req);
    const rank = (sessionId: string, streamId: string | null) => ({
      s: sessionRank.get(sessionId) ?? Number.MAX_SAFE_INTEGER,
      t: streamId === null ? Number.MAX_SAFE_INTEGER : (streamRank.get(streamId) ?? Number.MAX_SAFE_INTEGER),
    });

    // Snapshots and capture gaps are few -- tens per day against millions of
    // deltas -- so they are materialized, while deltas and trades stream.
    const snapshots = await this.loadSnapshots(conn, req);
    const gaps = await this.deriveCaptureGaps(conn, req);

    const pending: { key: OrderKey; event: ResearchEvent }[] = [];
    for (const snap of snapshots) {
      const r = rank(snap.session_id, snap.stream_id);
      const event = toSnapshotEvent(snap);
      pending.push({ key: orderKeyOf(event, r.s, r.t, `snap:${snap.snapshot_id}`), event });
    }
    for (const gap of gaps) {
      const r = rank(gap.sessionId, gap.streamId);
      pending.push({ key: orderKeyOf(gap, r.s, r.t, `gap:${gap.gapId}`), event: gap });
    }
    pending.sort((a, b) => compareOrderKeys(a.key, b.key));

    let pendingIdx = 0;

    const deltaCursor = this.streamDeltas(req);
    const tradeCursor = req.includeTrades === false ? null : this.streamTrades(req);

    let delta = await nextOf(deltaCursor);
    let trade = tradeCursor ? await nextOf(tradeCursor) : null;

    const keyOfDelta = (d: RawDelta) => {
      const r = rank(d.session_id, d.stream_id);
      return orderKeyOf(toDeltaEvent(d), r.s, r.t, `delta:${d.session_id}:${d.ingest_ordinal}`);
    };
    const keyOfTrade = (t: RawTrade) => {
      const r = rank(t.session_id, t.stream_id);
      return orderKeyOf(toTradeEvent(t), r.s, r.t, `trade:${t.trade_id}`);
    };

    for (;;) {
      const candidates: { key: OrderKey; take: () => Promise<ResearchEvent> }[] = [];

      if (pendingIdx < pending.length) {
        const p = pending[pendingIdx]!;
        candidates.push({
          key: p.key,
          take: async () => {
            pendingIdx += 1;
            return p.event;
          },
        });
      }
      if (delta) {
        const d = delta;
        candidates.push({
          key: keyOfDelta(d),
          take: async () => {
            delta = await nextOf(deltaCursor);
            return toDeltaEvent(d);
          },
        });
      }
      if (trade) {
        const t = trade;
        candidates.push({
          key: keyOfTrade(t),
          take: async () => {
            trade = tradeCursor ? await nextOf(tradeCursor) : null;
            return toTradeEvent(t);
          },
        });
      }

      if (candidates.length === 0) break;

      let best = candidates[0]!;
      for (const c of candidates.slice(1)) {
        if (compareOrderKeys(c.key, best.key) < 0) best = c;
      }
      yield await best.take();
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private async ranks(
    conn: DuckDBConnection,
    req: HistoricalRequest,
  ): Promise<{ sessionRank: Map<string, number>; streamRank: Map<string, number> }> {
    // Ranks must cover every stream that can appear in the merged output, so
    // they are taken over the union of the tables the stream reads. A stream
    // missing from this map would fall to the end of the order and reorder the
    // book, so the union is not an optimisation -- it is a correctness
    // requirement.
    const union = `
      SELECT CAST(d.session_id AS VARCHAR) AS session_id,
             CAST(d.stream_id AS VARCHAR) AS stream_id, d.received_at_ms
        FROM read_parquet('${this.glob(LAKE_TABLES.deltas)}', hive_partitioning = true) AS d
       WHERE ${this.predicates('d', req).join(' AND ')}
      UNION ALL
      SELECT CAST(s.session_id AS VARCHAR) AS session_id,
             CAST(s.stream_id AS VARCHAR) AS stream_id, s.received_at_ms
        FROM read_parquet('${this.glob(LAKE_TABLES.snapshots)}', hive_partitioning = true) AS s
       WHERE ${this.predicates('s', req).join(' AND ')}
         AND s.source IN (${sqlList(EXCHANGE_SNAPSHOT_SOURCES)})
      UNION ALL
      SELECT CAST(t.session_id AS VARCHAR) AS session_id,
             CAST(t.stream_id AS VARCHAR) AS stream_id, t.received_at_ms
        FROM read_parquet('${this.glob(LAKE_TABLES.trades)}', hive_partitioning = true) AS t
       WHERE ${this.predicates('t', req).join(' AND ')}`;

    const sessions = await this.rows<{ session_id: string; first_ms: bigint }>(
      conn,
      `SELECT g.session_id, g.first_ms FROM (
         SELECT u.session_id, min(u.received_at_ms) AS first_ms FROM (${union}) AS u
          GROUP BY u.session_id
       ) AS g ORDER BY g.first_ms, g.session_id`,
    );
    const streams = await this.rows<{ stream_id: string | null; first_ms: bigint }>(
      conn,
      `SELECT g.stream_id, g.first_ms FROM (
         SELECT u.stream_id, min(u.received_at_ms) AS first_ms FROM (${union}) AS u
          WHERE u.stream_id IS NOT NULL
          GROUP BY u.stream_id
       ) AS g ORDER BY g.first_ms, g.stream_id`,
    );

    const sessionRank = new Map<string, number>();
    sessions.forEach((s, i) => sessionRank.set(s.session_id, i));
    const streamRank = new Map<string, number>();
    streams.forEach((s, i) => {
      if (s.stream_id !== null) streamRank.set(s.stream_id, i);
    });

    return { sessionRank, streamRank };
  }

  private async loadSnapshots(
    conn: DuckDBConnection,
    req: HistoricalRequest,
  ): Promise<RawSnapshot[]> {
    return this.rows<RawSnapshot>(
      conn,
      `SELECT s.snapshot_id, CAST(s.session_id AS VARCHAR) AS session_id,
              CAST(s.stream_id AS VARCHAR) AS stream_id, s.market_ticker, s.event_ticker,
              s.series_ticker, s.source, s.seq, s.received_at_ms,
              s.yes_bids_json, s.no_bids_json, s.state_hash
         FROM read_parquet('${this.glob(LAKE_TABLES.snapshots)}', hive_partitioning = true) AS s
        WHERE ${this.predicates('s', req).join(' AND ')}
          AND s.source IN (${sqlList(EXCHANGE_SNAPSHOT_SOURCES)})
        ORDER BY s.received_at_ms, s.snapshot_id`,
    );
  }

  private streamDeltas(req: HistoricalRequest): AsyncGenerator<RawDelta> {
    return this.chunked<RawDelta>(
      `SELECT CAST(d.session_id AS VARCHAR) AS session_id, d.ingest_ordinal, d.market_ticker, d.event_ticker, d.series_ticker,
              CAST(d.stream_id AS VARCHAR) AS stream_id,
              d.seq, d.exchange_ts_ms, d.received_at_ms, d.side,
              CAST(d.price AS VARCHAR) AS price,
              CAST(d.delta_count AS VARCHAR) AS delta_count,
              CAST(d.pre_count AS VARCHAR) AS pre_count,
              CAST(d.post_count AS VARCHAR) AS post_count,
              d.applied,
              CAST(d.apply_error AS VARCHAR) AS apply_error
         FROM read_parquet('${this.glob(LAKE_TABLES.deltas)}', hive_partitioning = true) AS d
        WHERE ${this.predicates('d', req).join(' AND ')}
        ORDER BY d.received_at_ms, d.ingest_ordinal, d.seq`,
    );
  }

  private streamTrades(req: HistoricalRequest): AsyncGenerator<RawTrade> {
    return this.chunked<RawTrade>(
      `SELECT CAST(t.trade_id AS VARCHAR) AS trade_id,
              CAST(t.session_id AS VARCHAR) AS session_id, t.ingest_ordinal,
              t.market_ticker, t.event_ticker, t.series_ticker,
              CAST(t.stream_id AS VARCHAR) AS stream_id, t.seq,
              CAST(t.yes_price AS VARCHAR) AS yes_price,
              CAST(t.no_price AS VARCHAR) AS no_price,
              CAST(t.count AS VARCHAR) AS count,
              t.taker_outcome_side, t.taker_book_side, t.is_block_trade,
              t.exchange_ts_ms, t.received_at_ms
         FROM read_parquet('${this.glob(LAKE_TABLES.trades)}', hive_partitioning = true) AS t
        WHERE ${this.predicates('t', req).join(' AND ')}
        ORDER BY t.received_at_ms, t.ingest_ordinal`,
    );
  }

  /** Fully materialized query. Only for small result sets. */
  private async rows<T>(conn: DuckDBConnection, sql: string): Promise<T[]> {
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjects() as unknown as T[];
  }

  /**
   * Streams a query chunk by chunk, so a multi-day scan never materializes.
   *
   * Runs on a DEDICATED connection: see newConnection().
   */
  private async *chunked<T>(sql: string): AsyncGenerator<T> {
    const conn = await this.newConnection();
    this.cursorConns.push(conn);
    const result = await conn.stream(sql);
    const columns = result.columnNames();
    for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      const rows = chunk.getRowObjects(columns) as unknown as T[];
      for (const row of rows) yield row;
    }
  }
}

async function nextOf<T>(gen: AsyncGenerator<T>): Promise<T | null> {
  const r = await gen.next();
  return r.done ? null : r.value;
}

// ---------------------------------------------------------------------------
// Row -> event
// ---------------------------------------------------------------------------

function parseLevels(json: string): Level[] {
  const parsed = JSON.parse(json) as [string, string][];
  return parsed.map(([p, s]) => [String(p), String(s)] as Level);
}

function toSnapshotEvent(r: RawSnapshot): BookSnapshotEvent {
  return {
    kind: 'book_snapshot',
    exchangeTimeMs: null,
    receiveTimeMs: BigInt(r.received_at_ms),
    sessionId: r.session_id,
    ingestOrdinal: null,
    streamId: r.stream_id,
    seq: r.seq === null ? null : BigInt(r.seq),
    marketTicker: r.market_ticker,
    eventTicker: r.event_ticker ?? undefined,
    seriesTicker: r.series_ticker ?? undefined,
    source: r.source as BookSnapshotEvent['source'],
    yesBids: parseLevels(r.yes_bids_json),
    noBids: parseLevels(r.no_bids_json),
    stateHash: r.state_hash,
  };
}

function toDeltaEvent(r: RawDelta): BookDeltaEvent {
  return {
    kind: 'book_delta',
    exchangeTimeMs: r.exchange_ts_ms === null ? null : BigInt(r.exchange_ts_ms),
    receiveTimeMs: BigInt(r.received_at_ms),
    sessionId: r.session_id,
    ingestOrdinal: r.ingest_ordinal === null ? null : BigInt(r.ingest_ordinal),
    streamId: r.stream_id,
    seq: BigInt(r.seq),
    marketTicker: r.market_ticker,
    eventTicker: r.event_ticker ?? undefined,
    seriesTicker: r.series_ticker ?? undefined,
    side: r.side,
    price: r.price,
    deltaCount: r.delta_count,
    preCount: r.pre_count,
    postCount: r.post_count,
    applied: r.applied,
    applyError: r.apply_error,
  };
}

function toTradeEvent(r: RawTrade): TradeEvent {
  const side = r.taker_outcome_side;
  return {
    kind: 'trade',
    exchangeTimeMs: r.exchange_ts_ms === null ? null : BigInt(r.exchange_ts_ms),
    receiveTimeMs: BigInt(r.received_at_ms),
    sessionId: r.session_id,
    ingestOrdinal: r.ingest_ordinal === null ? null : BigInt(r.ingest_ordinal),
    streamId: r.stream_id,
    seq: r.seq === null ? null : BigInt(r.seq),
    marketTicker: r.market_ticker,
    eventTicker: r.event_ticker ?? undefined,
    seriesTicker: r.series_ticker ?? undefined,
    tradeId: r.trade_id,
    yesPrice: r.yes_price,
    noPrice: r.no_price,
    count: r.count,
    // Never guessed. A null here disables passive fill attribution for this
    // trade rather than inventing an aggressor side.
    takerOutcomeSide: side === 'yes' || side === 'no' ? side : null,
    takerBookSide: r.taker_book_side,
    isBlockTrade: Boolean(r.is_block_trade),
  };
}

export function logSliceSummary(slice: DatasetSlice): void {
  logger.info(
    {
      event: 'research_slice',
      dataset_id: slice.datasetId,
      fingerprint: slice.fingerprint.slice(0, 16),
      objects: slice.objects.length,
      rows: slice.rowCounts,
      markets: slice.marketTickers.length,
      capture_gaps: slice.captureGaps.length,
    },
    `slice ${slice.fingerprint.slice(0, 12)}: ${slice.marketTickers.length} market(s), ` +
      `${slice.captureGaps.length} capture gap(s)`,
  );
}
