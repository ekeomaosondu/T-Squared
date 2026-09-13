import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { one, withTryAdvisoryLock, LOCK_ARCHIVE_WORKER, type Sql } from '@/src/persistence/db';
import { partitionInventory, type PartitionInfo } from '@/src/persistence/partitions';
import { sha256, type ArchiveStore } from '@/src/persistence/archiveStore';
import { logger } from '@/src/logging/logger';

/**
 * Immutable raw archival.
 *
 * The lifecycle is deliberately one-way and every step is recorded, because the
 * last step destroys data:
 *
 *   partition completes
 *        -> SEAL      (row count fixed; no further inserts can land)
 *        -> ARCHIVE   (deterministic NDJSON, gzipped, uploaded per channel/hour)
 *        -> VERIFY    (re-read each object; SHA-256 and row count must match)
 *        -> retention floor elapses
 *        -> DETACH    (concurrently, so ingestion is not blocked)
 *        -> DROP
 *
 * A partition is never detached or dropped unless every part is verified AND
 * the archived row count equals the sealed count. Archive boundaries follow
 * PARTITION boundaries so that "the partition I dropped" and "the objects I
 * archived" are provably the same rows.
 */

/** Rows per part file. Bounds memory and keeps objects a sane size. */
const ROWS_PER_PART = 50_000;
/** Rows streamed per query while building a part. */
const FETCH_CHUNK = 10_000;

export type PartitionStatus =
  | 'pending'
  | 'sealing'
  | 'archiving'
  | 'archived'
  | 'verified'
  | 'detached'
  | 'dropped'
  | 'failed';

export interface ArchiveOptions {
  sql: Sql;
  store: ArchiveStore;
  /** Minimum age of a COMPLETED partition before it may be dropped. */
  retentionHours: number;
  /** Master switch for the destructive step. */
  retentionEnabled: boolean;
  clock?: () => Date;
}

export interface ArchiveRunResult {
  sealed: string[];
  archived: string[];
  verified: string[];
  dropped: string[];
  failed: { partition: string; error: string }[];
  skipped: string[];
}

interface RawRow {
  id: string;
  session_id: string;
  stream_id: string | null;
  ingest_ordinal: string | null;
  received_at: Date;
  received_at_ms: string;
  recv_monotonic_ns: string | null;
  channel: string | null;
  message_type: string;
  sid: number | null;
  seq: string | null;
  market_ticker: string | null;
  market_id: string | null;
  exchange_ts_ms: string | null;
  payload: unknown;
}

/**
 * One archived line.
 *
 * Key order is fixed so the serialisation is byte-for-byte reproducible: the
 * SHA-256 in the manifest is only meaningful if re-serialising the same rows
 * yields the same bytes.
 */
function serializeRow(r: RawRow): string {
  return JSON.stringify({
    id: r.id,
    session_id: r.session_id,
    stream_id: r.stream_id,
    ingest_ordinal: r.ingest_ordinal,
    received_at_ms: r.received_at_ms,
    recv_monotonic_ns: r.recv_monotonic_ns,
    channel: r.channel,
    message_type: r.message_type,
    sid: r.sid,
    seq: r.seq,
    market_ticker: r.market_ticker,
    market_id: r.market_id,
    exchange_ts_ms: r.exchange_ts_ms,
    payload: r.payload,
  });
}

export class ArchiveWorker {
  private readonly sql: Sql;
  private readonly store: ArchiveStore;
  private readonly retentionHours: number;
  private readonly retentionEnabled: boolean;
  private readonly clock: () => Date;

  constructor(opts: ArchiveOptions) {
    this.sql = opts.sql;
    this.store = opts.store;
    this.retentionHours = opts.retentionHours;
    this.retentionEnabled = opts.retentionEnabled;
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * Runs the whole pipeline once. Serialised by advisory lock so overlapping
   * workers cannot archive the same partition twice.
   */
  async run(): Promise<ArchiveRunResult> {
    const result = await withTryAdvisoryLock(this.sql, LOCK_ARCHIVE_WORKER, () => this.runLocked());
    if (result === null) {
      logger.info({ event: 'archive_skipped' }, 'another archive worker holds the lock');
      return { sealed: [], archived: [], verified: [], dropped: [], failed: [], skipped: ['locked'] };
    }
    return result;
  }

  private async runLocked(): Promise<ArchiveRunResult> {
    const out: ArchiveRunResult = {
      sealed: [], archived: [], verified: [], dropped: [], failed: [], skipped: [],
    };

    const partitions = await partitionInventory(this.sql);
    const now = this.clock();

    for (const p of partitions) {
      // Only a COMPLETED partition can be sealed: while its range is still
      // current, more rows can land and any count would be a guess.
      if (p.partition_end.getTime() > now.getTime()) {
        out.skipped.push(p.partition_name);
        continue;
      }

      try {
        let state = await this.ensureState(p);

        // A partition recorded as dropped but present again means partition
        // maintenance recreated the day and rows landed in it afterwards.
        // Skipping it forever would leave those rows unarchived and invisible,
        // so the state is reset and the partition re-enters the pipeline.
        if (state === 'dropped' || state === 'detached') {
          const rows = await this.sql<{ n: string }[]>`
            SELECT count(*) AS n FROM raw_ingest_events r
             WHERE r.received_at >= ${p.partition_start} AND r.received_at < ${p.partition_end}
          `;
          if (Number(one(rows).n) === 0) continue;

          logger.warn(
            { event: 'partition_resurrected', partition: p.partition_name, rows: one(rows).n },
            'partition marked dropped but present with rows; re-archiving',
          );
          await this.sql`
            UPDATE raw_partition_archive_state
               SET status = 'pending', sealed_at = NULL, sealed_row_count = NULL,
                   archived_row_count = 0, part_count = 0, archive_completed_at = NULL,
                   verified_at = NULL, detached_at = NULL, dropped_at = NULL,
                   last_error = NULL, updated_at = now()
             WHERE partition_name = ${p.partition_name}
          `;
          state = 'pending';
        }

        if (state === 'pending' || state === 'sealing') {
          await this.seal(p);
          out.sealed.push(p.partition_name);
        }

        const afterSeal = await this.statusOf(p.partition_name);
        if (afterSeal === 'sealing' || afterSeal === 'archiving') {
          await this.archive(p);
          out.archived.push(p.partition_name);
        }

        if ((await this.statusOf(p.partition_name)) === 'archived') {
          await this.verify(p.partition_name);
          out.verified.push(p.partition_name);
        }

        if (await this.tryDrop(p, now)) out.dropped.push(p.partition_name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.fail(p.partition_name, message);
        out.failed.push({ partition: p.partition_name, error: message });
        logger.error(
          { event: 'archive_failed', partition: p.partition_name, err: message },
          'archiving failed',
        );
      }
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  private async ensureState(p: PartitionInfo): Promise<PartitionStatus> {
    await this.sql`
      INSERT INTO raw_partition_archive_state (partition_name, partition_start, partition_end, status)
      VALUES (${p.partition_name}, ${p.partition_start}, ${p.partition_end}, 'pending')
      ON CONFLICT (partition_name) DO NOTHING
    `;
    return this.statusOf(p.partition_name);
  }

  private async statusOf(partitionName: string): Promise<PartitionStatus> {
    const rows = await this.sql<{ status: PartitionStatus }[]>`
      SELECT s.status FROM raw_partition_archive_state s WHERE s.partition_name = ${partitionName}
    `;
    return one(rows, 'partition state').status;
  }

  /** Fixes the row count. Nothing further can be inserted into this range. */
  private async seal(p: PartitionInfo): Promise<void> {
    const rows = await this.sql<{ n: string }[]>`
      SELECT count(*) AS n FROM raw_ingest_events r
       WHERE r.received_at >= ${p.partition_start} AND r.received_at < ${p.partition_end}
    `;
    const count = Number(one(rows).n);

    await this.sql`
      UPDATE raw_partition_archive_state
         SET sealed_at = now(), sealed_row_count = ${count}, status = 'sealing', updated_at = now()
       WHERE partition_name = ${p.partition_name}
    `;

    logger.info(
      { event: 'partition_sealed', partition: p.partition_name, rows: count },
      `sealed ${p.partition_name} at ${count} rows`,
    );
  }

  /** Uploads the partition as gzipped NDJSON parts, keyed by channel and hour. */
  private async archive(p: PartitionInfo): Promise<void> {
    await this.sql`
      UPDATE raw_partition_archive_state SET status = 'archiving', updated_at = now()
       WHERE partition_name = ${p.partition_name}
    `;

    const groups = await this.sql<{ channel: string | null; hour_start: Date; n: string }[]>`
      SELECT r.channel,
             date_trunc('hour', r.received_at) AS hour_start,
             count(*) AS n
        FROM raw_ingest_events r
       WHERE r.received_at >= ${p.partition_start} AND r.received_at < ${p.partition_end}
       GROUP BY r.channel, date_trunc('hour', r.received_at)
       ORDER BY date_trunc('hour', r.received_at), r.channel
    `;

    let archivedRows = 0;
    let parts = 0;

    for (const g of groups) {
      const hourEnd = new Date(g.hour_start.getTime() + 3_600_000);
      let afterId = '0';

      for (;;) {
        const batch = await this.fetchPart(p, g.channel, g.hour_start, hourEnd, afterId);
        if (batch.length === 0) break;

        const body = `${batch.map(serializeRow).join('\n')}\n`;
        const uncompressed = Buffer.from(body, 'utf8');
        const gzipped = gzipSync(uncompressed, { level: 9 });
        const digest = sha256(gzipped);

        const first = batch[0]!;
        const last = batch[batch.length - 1]!;
        const blobPath = archivePath({
          channel: g.channel,
          hourStart: g.hour_start,
          sessionId: first.session_id,
          firstId: first.id,
          lastId: last.id,
        });

        const stored = await this.store.put(blobPath, gzipped);

        await this.sql`
          INSERT INTO raw_archives (
            archive_id, partition_name, partition_start, partition_end, channel, hour_start,
            start_raw_id, end_raw_id, start_time, end_time, row_count, blob_path,
            uncompressed_bytes, compressed_bytes, sha256, uploaded_at
          ) VALUES (
            ${randomUUID()}, ${p.partition_name}, ${p.partition_start}, ${p.partition_end},
            ${g.channel}, ${g.hour_start},
            ${first.id}, ${last.id}, ${first.received_at}, ${last.received_at},
            ${batch.length}, ${blobPath},
            ${uncompressed.byteLength}, ${gzipped.byteLength}, ${digest}, now()
          )
          ON CONFLICT (blob_path) DO UPDATE SET
            row_count = EXCLUDED.row_count,
            compressed_bytes = EXCLUDED.compressed_bytes,
            sha256 = EXCLUDED.sha256,
            uploaded_at = EXCLUDED.uploaded_at,
            verified_at = NULL
        `;

        archivedRows += batch.length;
        parts += 1;
        afterId = last.id;

        logger.debug(
          { event: 'archive_part_uploaded', path: blobPath, rows: batch.length, bytes: stored.size },
          'uploaded archive part',
        );

        if (batch.length < ROWS_PER_PART) break;
      }
    }

    await this.sql`
      UPDATE raw_partition_archive_state
         SET archived_row_count = ${archivedRows}, part_count = ${parts},
             archive_completed_at = now(), status = 'archived', updated_at = now()
       WHERE partition_name = ${p.partition_name}
    `;

    logger.info(
      { event: 'partition_archived', partition: p.partition_name, rows: archivedRows, parts },
      `archived ${p.partition_name}: ${archivedRows} rows in ${parts} part(s)`,
    );
  }

  /** Streams one part's rows, ordered by id so parts are contiguous. */
  private async fetchPart(
    p: PartitionInfo,
    channel: string | null,
    hourStart: Date,
    hourEnd: Date,
    afterId: string,
  ): Promise<RawRow[]> {
    const rows: RawRow[] = [];
    let cursor = afterId;

    while (rows.length < ROWS_PER_PART) {
      const chunk = await this.sql<RawRow[]>`
        SELECT r.id, r.session_id, r.stream_id, r.ingest_ordinal, r.received_at,
               r.received_at_ms, r.recv_monotonic_ns, r.channel, r.message_type,
               r.sid, r.seq, r.market_ticker, r.market_id, r.exchange_ts_ms, r.payload
          FROM raw_ingest_events r
         WHERE r.received_at >= ${p.partition_start}
           AND r.received_at < ${p.partition_end}
           AND r.received_at >= ${hourStart}
           AND r.received_at < ${hourEnd}
           AND (${channel}::text IS NULL AND r.channel IS NULL OR r.channel = ${channel})
           AND r.id > ${cursor}
         ORDER BY r.id
         LIMIT ${Math.min(FETCH_CHUNK, ROWS_PER_PART - rows.length)}
      `;
      if (chunk.length === 0) break;
      rows.push(...chunk);
      cursor = chunk[chunk.length - 1]!.id;
    }

    return rows;
  }

  /**
   * Re-reads every part and compares checksums and counts.
   *
   * Verification reads back from the store rather than trusting the upload
   * call, because "the bytes are retrievable and correct" is the property the
   * subsequent DROP depends on.
   */
  private async verify(partitionName: string): Promise<void> {
    const parts = await this.sql<
      { archive_id: string; blob_path: string; sha256: Buffer; row_count: string }[]
    >`
      SELECT a.archive_id, a.blob_path, a.sha256, a.row_count
        FROM raw_archives a
       WHERE a.partition_name = ${partitionName}
       ORDER BY a.blob_path
    `;

    let verifiedRows = 0;

    for (const part of parts) {
      const body = await this.store.get(part.blob_path);
      const actual = sha256(body);

      if (!actual.equals(Buffer.from(part.sha256))) {
        await this.sql`
          UPDATE raw_archives
             SET verification_error = 'sha256 mismatch', verified_at = NULL
           WHERE archive_id = ${part.archive_id}::uuid
        `;
        throw new Error(`archive checksum mismatch for ${part.blob_path}`);
      }

      await this.sql`
        UPDATE raw_archives SET verified_at = now(), verification_error = NULL
         WHERE archive_id = ${part.archive_id}::uuid
      `;
      verifiedRows += Number(part.row_count);
    }

    const state = await this.sql<{ sealed_row_count: string | null; archived_row_count: string }[]>`
      SELECT s.sealed_row_count, s.archived_row_count
        FROM raw_partition_archive_state s WHERE s.partition_name = ${partitionName}
    `;
    const sealed = Number(one(state).sealed_row_count ?? -1);

    if (verifiedRows !== sealed) {
      throw new Error(
        `archive row count mismatch for ${partitionName}: sealed ${sealed}, archived ${verifiedRows}`,
      );
    }

    await this.sql`
      UPDATE raw_partition_archive_state
         SET verified_at = now(), status = 'verified', last_error = NULL, updated_at = now()
       WHERE partition_name = ${partitionName}
    `;

    logger.info(
      { event: 'partition_verified', partition: partitionName, rows: verifiedRows, parts: parts.length },
      `verified ${partitionName}: ${verifiedRows} rows across ${parts.length} part(s)`,
    );
  }

  /**
   * Detaches and drops a verified partition past its retention floor.
   *
   * RAW_DB_RETENTION_HOURS is a FLOOR on the age of a completed partition, not
   * an exact TTL: with daily partitions the effective retention is between that
   * and 24 hours more.
   */
  private async tryDrop(p: PartitionInfo, now: Date): Promise<boolean> {
    if (!this.retentionEnabled) return false;
    if ((await this.statusOf(p.partition_name)) !== 'verified') return false;

    const eligibleAt = p.partition_end.getTime() + this.retentionHours * 3_600_000;
    if (now.getTime() < eligibleAt) return false;

    // DETACH CONCURRENTLY cannot run inside a transaction block, and detaching
    // before dropping keeps the removal off the path of live inserts.
    await this.sql.unsafe(
      `ALTER TABLE raw_ingest_events DETACH PARTITION ${quoteIdent(p.partition_name)} CONCURRENTLY`,
    );
    await this.sql`
      UPDATE raw_partition_archive_state
         SET detached_at = now(), status = 'detached', updated_at = now()
       WHERE partition_name = ${p.partition_name}
    `;

    await this.sql.unsafe(`DROP TABLE IF EXISTS ${quoteIdent(p.partition_name)}`);
    await this.sql`
      UPDATE raw_partition_archive_state
         SET dropped_at = now(), status = 'dropped', updated_at = now()
       WHERE partition_name = ${p.partition_name}
    `;

    logger.info(
      { event: 'partition_dropped', partition: p.partition_name },
      `dropped ${p.partition_name} after verified archive`,
    );
    return true;
  }

  private async fail(partitionName: string, error: string): Promise<void> {
    await this.sql`
      UPDATE raw_partition_archive_state
         SET status = 'failed', last_error = ${error}, updated_at = now()
       WHERE partition_name = ${partitionName}
    `.catch(() => {});
  }
}

export function archivePath(opts: {
  channel: string | null;
  hourStart: Date;
  sessionId: string;
  firstId: string;
  lastId: string;
}): string {
  const iso = opts.hourStart.toISOString();
  const date = iso.slice(0, 10);
  const hour = iso.slice(11, 13);
  const channel = opts.channel ?? 'unknown';
  return (
    `kalshi/raw/channel=${channel}/date=${date}/hour=${hour}/` +
    `part-${opts.sessionId}-${opts.firstId}-${opts.lastId}.jsonl.gz`
  );
}

/** Partition names are generated internally, but never interpolate unquoted. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
