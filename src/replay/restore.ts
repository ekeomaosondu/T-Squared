import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { Collector } from '@/src/collector/collector';
import { parseCollectorConfig } from '@/src/config/collectorConfig';
import type { RawFrame } from '@/src/kalshi/websocketClient';
import { sha256, type ArchiveStore } from '@/src/persistence/archiveStore';
import { BatchWriter } from '@/src/persistence/batchWriter';
import type { Sql } from '@/src/persistence/db';
import { startSession, endSession, closeStream } from '@/src/persistence/repositories/sessions';
import { replay } from '@/src/replay/replay';
import { logger } from '@/src/logging/logger';

/**
 * Restore an archived partition and prove it reconstructs exactly.
 *
 * Archive verification only proves `bytes written == bytes read`. What actually
 * matters is the whole chain:
 *
 *     archived bytes -> restore -> parse -> normalize -> replay -> exact book
 *
 * So this reads the archive back, replays every frame through the REAL
 * collector (same parsing, same sequence handling, same book reconstruction) into
 * a scratch database, then compares the resulting book state against the
 * snapshots the live recorder wrote at the time.
 *
 * Driving the production collector rather than a parallel parser is the point:
 * it demonstrates the raw log alone is sufficient to rebuild the dataset.
 */

export interface RestoreOptions {
  /** Production database: archive manifests and the original snapshots. */
  sourceSql: Sql;
  /** Scratch database the restored data is written into. */
  targetSql: Sql;
  store: ArchiveStore;
  partitionName: string;
}

export interface RestoreResult {
  partitionName: string;
  parts: number;
  bytes: number;
  /** Parts whose stored SHA-256 matched the manifest. */
  checksumsVerified: number;
  rowsRestored: number;
  framesReplayed: number;
  sessionsRestored: number;
  /** Original snapshots compared against the restored reconstruction. */
  compared: number;
  matched: number;
  mismatches: { marketTicker: string; seq: string; expected: string; actual: string }[];
  unreachable: { marketTicker: string; seq: string }[];
}

interface OriginalSnapshot {
  market_ticker: string;
  stream_id: string | null;
  seq: string;
  state_hash: string;
}

interface ArchivedRow {
  id: string;
  session_id: string;
  stream_id: string | null;
  ingest_ordinal: string | null;
  received_at_ms: string;
  channel: string | null;
  message_type: string;
  sid: number | null;
  seq: string | null;
  market_ticker: string | null;
  payload: Record<string, unknown> | null;
}

const RESTORE_CONFIG = parseCollectorConfig({
  selectors: [{ id: 'restore', seriesPrefixes: ['K'] }],
  capture: { orderbookDeltas: true, trades: true, tickerUpdates: true, lifecycleEvents: true },
  sampling: { bboIntervalsMs: [], fullBookIntervalsMs: [], eventLadderIntervalsMs: [] },
});

/** Minimal socket stand-in that replays archived envelopes in capture order. */
class RestoreSocket extends EventEmitter {
  open = true;
  private nextId = 1;
  readonly subscribed: { id: number; channel: string }[] = [];

  get isOpen(): boolean { return this.open; }
  getState(): string { return 'open'; }
  get url(): string { return 'restore://archive'; }
  allocateCommandId(): number { return this.nextId++; }

  subscribe(channels: string[]): number {
    const id = this.allocateCommandId();
    this.subscribed.push({ id, channel: channels[0]! });
    return id;
  }
  addMarkets(): number { return this.allocateCommandId(); }
  deleteMarkets(): number { return this.allocateCommandId(); }
  // A restore must never request live data; recovery is a no-op here and any
  // gap present in the archive stays present in the reconstruction.
  requestSnapshot(): number { return this.allocateCommandId(); }
  unsubscribe(): number { return this.allocateCommandId(); }
  close(): Promise<void> { this.open = false; return Promise.resolve(); }

  deliver(envelope: Record<string, unknown>, receivedAtMs: number): void {
    const text = JSON.stringify(envelope);
    this.emit('frame', {
      receivedAt: new Date(receivedAtMs),
      receivedAtMs,
      recvMonotonicNs: process.hrtime.bigint(),
      text,
      envelope: envelope as never,
    } satisfies RawFrame);
  }
}

export async function restoreAndVerify(opts: RestoreOptions): Promise<RestoreResult> {
  const { sourceSql, targetSql, store, partitionName } = opts;

  const result: RestoreResult = {
    partitionName,
    parts: 0,
    bytes: 0,
    checksumsVerified: 0,
    rowsRestored: 0,
    framesReplayed: 0,
    sessionsRestored: 0,
    compared: 0,
    matched: 0,
    mismatches: [],
    unreachable: [],
  };

  // ---- 1. read the archive back, checking every checksum -----------------
  // The partition's own time bounds. A single-partition restore can only
  // reconstruct state WITHIN that window, so comparisons must be bounded by it.
  const bounds = await sourceSql<{ partition_start: Date; partition_end: Date }[]>`
    SELECT s.partition_start, s.partition_end
      FROM raw_partition_archive_state s
     WHERE s.partition_name = ${partitionName}
  `;
  if (bounds.length === 0) {
    throw new Error(`no archive state recorded for ${partitionName}`);
  }
  const partitionStart = bounds[0]!.partition_start;
  const partitionEnd = bounds[0]!.partition_end;

  const manifests = await sourceSql<
    { blob_path: string; sha256: Buffer; row_count: string }[]
  >`
    SELECT a.blob_path, a.sha256, a.row_count
      FROM raw_archives a
     WHERE a.partition_name = ${partitionName}
     ORDER BY a.blob_path
  `;

  if (manifests.length === 0) {
    throw new Error(`no archive manifests found for ${partitionName}`);
  }

  const rows: ArchivedRow[] = [];
  for (const m of manifests) {
    const bytes = await store.get(m.blob_path);
    result.parts += 1;
    result.bytes += bytes.byteLength;

    if (!sha256(bytes).equals(Buffer.from(m.sha256))) {
      throw new Error(`checksum mismatch restoring ${m.blob_path}`);
    }
    result.checksumsVerified += 1;

    const text = gunzipSync(bytes).toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length !== Number(m.row_count)) {
      throw new Error(
        `row count mismatch in ${m.blob_path}: manifest ${m.row_count}, archive ${lines.length}`,
      );
    }
    for (const line of lines) rows.push(JSON.parse(line) as ArchivedRow);
  }

  result.rowsRestored = rows.length;

  // Capture order. `id` is provenance, but within one partition it is also the
  // order rows were flushed, and ingest_ordinal breaks ties authoritatively.
  rows.sort((a, b) => {
    if (a.session_id !== b.session_id) return a.session_id < b.session_id ? -1 : 1;
    const ao = a.ingest_ordinal === null ? Number(a.id) : Number(a.ingest_ordinal);
    const bo = b.ingest_ordinal === null ? Number(b.id) : Number(b.ingest_ordinal);
    return ao - bo;
  });

  // ---- 2. replay every frame through the real collector ------------------
  const bySession = new Map<string, ArchivedRow[]>();
  for (const r of rows) {
    const list = bySession.get(r.session_id) ?? [];
    list.push(r);
    bySession.set(r.session_id, list);
  }

  /** original stream_id -> restored stream_id */
  const streamMap = new Map<string, string>();

  for (const [originalSessionId, sessionRows] of bySession) {
    const socket = new RestoreSocket();
    const writer = new BatchWriter({ sql: targetSql, maxRows: 500, maxWaitMs: 50 });

    const sessionId = await startSession(targetSql, {
      mode: 'daemon',
      configHash: `restore:${partitionName}`,
      wsUrl: 'restore://archive',
    });
    result.sessionsRestored += 1;

    const collector = new Collector({
      sql: targetSql,
      ws: socket as never,
      rest: {} as never,
      universe: {
        isTracked: () => true,
        queueMetadataRefresh: () => {},
        queueEventRefresh: () => {},
        trackedTickers: [],
      } as never,
      writer,
      config: RESTORE_CONFIG,
      sessionId,
    });
    collector.start();

    /** original stream_id -> the restored subscription carrying it */
    const bound = new Map<string, { restoredStreamId: string; sid: number }>();
    /** sid -> the original stream currently bound to it */
    const sidOwner = new Map<number, string>();

    // Each restored subscription must carry the same markets the original did.
    // Without them the subscription manager's market index is empty, so a
    // recovery request finds no stream to ask, the episode is abandoned as
    // unavailable, and every delta after the gap is withheld -- the archive
    // would look unreplayable when it is not.
    const streamMarkets = new Map<string, Set<string>>();
    for (const row of sessionRows) {
      if (!row.stream_id || !row.market_ticker) continue;
      const set = streamMarkets.get(row.stream_id) ?? new Set<string>();
      set.add(row.market_ticker);
      streamMarkets.set(row.stream_id, set);
    }

    for (const row of sessionRows) {
      if (!row.payload || typeof row.payload !== 'object') continue;

      // Bind the frame's stream before delivering, reproducing the sid it was
      // captured on so the collector resolves it identically.
      if (row.stream_id && row.sid !== null && row.channel) {
        if (!bound.has(row.stream_id)) {
          // A reconnect reuses a sid; close the previous holder first so the
          // live-sid uniqueness constraint still holds.
          const previous = sidOwner.get(row.sid);
          if (previous) {
            const prev = bound.get(previous);
            if (prev) await closeStream(targetSql, prev.restoredStreamId).catch(() => {});
          }

          const created = await collector.subscribeChannel(
            row.channel,
            [...(streamMarkets.get(row.stream_id) ?? [])],
          );
          if (created) {
            socket.emit('frame', {
              receivedAt: new Date(Number(row.received_at_ms)),
              receivedAtMs: Number(row.received_at_ms),
              recvMonotonicNs: process.hrtime.bigint(),
              text: '',
              envelope: {
                type: 'subscribed',
                id: created.commandId,
                msg: { channel: row.channel, sid: row.sid },
              } as never,
            } satisfies RawFrame);

            bound.set(row.stream_id, { restoredStreamId: created.streamId, sid: row.sid });
            sidOwner.set(row.sid, row.stream_id);
            streamMap.set(row.stream_id, created.streamId);
          }
        }
      }

      socket.deliver(row.payload, Number(row.received_at_ms));
      result.framesReplayed += 1;
    }

    await writer.close();
    await collector.flushDeferred();
    await endSession(targetSql, sessionId, `restored:${originalSessionId}`);
  }

  // ---- 3. compare against what the live recorder recorded ----------------
  const originals = await sourceSql<OriginalSnapshot[]>`
    SELECT s.market_ticker, s.stream_id, s.seq, s.state_hash
      FROM orderbook_snapshots s
     WHERE s.source = 'local_materialized'
       AND s.seq IS NOT NULL
       AND s.stream_id IS NOT NULL
       AND s.stream_id = ANY(${[...streamMap.keys()]}::uuid[])
       -- Only snapshots inside the restored partition's window. A session can
       -- span midnight, and its later snapshots belong to the NEXT partition;
       -- this restore has no data for those and could never reach them.
       AND s.received_at >= ${partitionStart}
       AND s.received_at < ${partitionEnd}
     ORDER BY s.market_ticker, s.received_at_ms
  `;

  const byMarket = new Map<string, OriginalSnapshot[]>();
  for (const o of originals) {
    const list: OriginalSnapshot[] = byMarket.get(o.market_ticker) ?? [];
    list.push(o);
    byMarket.set(o.market_ticker, list);
  }

  for (const [marketTicker, targets] of byMarket) {
    const wanted = new Map<string, { expected: string; seq: string }>();
    for (const t of targets) {
      const restoredStream = streamMap.get(t.stream_id!);
      if (!restoredStream) continue;
      wanted.set(`${restoredStream}:${t.seq}`, { expected: t.state_hash, seq: t.seq });
    }
    if (wanted.size === 0) continue;

    const seen = new Set<string>();
    await replay(targetSql, {
      marketTicker,
      fromMs: 0n,
      toMs: 9_999_999_999_999n,
      onPosition: ({ streamId, seq, book }) => {
        if (seq === null || streamId === null) return;
        const key = `${streamId}:${seq}`;
        const want = wanted.get(key);
        if (!want || seen.has(key)) return;
        seen.add(key);

        result.compared += 1;
        const actual = book.getStateHash();
        if (actual === want.expected) result.matched += 1;
        else result.mismatches.push({ marketTicker, seq: want.seq, expected: want.expected, actual });
      },
    });

    for (const [key, want] of wanted) {
      if (!seen.has(key)) result.unreachable.push({ marketTicker, seq: want.seq });
    }
  }

  logger.info(
    {
      event: 'restore_complete',
      partition: partitionName,
      parts: result.parts,
      rows: result.rowsRestored,
      compared: result.compared,
      matched: result.matched,
      mismatches: result.mismatches.length,
    },
    'restore and reconstruction complete',
  );

  return result;
}
