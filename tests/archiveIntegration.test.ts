import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ArchiveWorker } from '@/src/persistence/archive';
import { LocalArchiveStore, sha256 } from '@/src/persistence/archiveStore';
import type { Sql } from '@/src/persistence/db';
import { ensureRawPartitions } from '@/src/persistence/partitions';
import { freshTestDb, testDbAvailable } from './fixtures/testDb';

/**
 * End-to-end archival against a real database.
 *
 * The property that matters is that nothing is dropped until the bytes in
 * object storage have been read back and proven to match, both by checksum and
 * by row count.
 */

const available = await testDbAvailable();
const describeDb = available ? describe : describe.skip;

let sql: Sql;
let root: string;
let store: LocalArchiveStore;

function partitionNameFor(day: Date): string {
  return `raw_ingest_events_${day.toISOString().slice(0, 10).replace(/-/g, '_')}`;
}

/** A day that has fully elapsed, so its partition can be sealed. */
function pastDay(daysAgo: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function seedRawEvents(sessionId: string, day: Date, count: number, channel = 'orderbook_delta') {
  const rows = Array.from({ length: count }, (_, i) => {
    const at = new Date(day.getTime() + 3_600_000 + i * 1000);
    return {
      session_id: sessionId,
      received_at: at,
      received_at_ms: String(at.getTime()),
      ingest_ordinal: String(i + 1),
      recv_monotonic_ns: String(1_000_000n + BigInt(i)),
      channel,
      message_type: channel,
      seq: String(i + 1),
      market_ticker: 'KXHIGHNY-26SEP14-B74.5',
      payload_hash: sha256(Buffer.from(`row-${i}`)),
      payload: sql.json({ type: channel, seq: i + 1 } as never),
      parse_version: 1,
    };
  });
  await sql`INSERT INTO raw_ingest_events ${sql(rows)}`;
}

beforeAll(async () => {
  if (!available) return;
  sql = await freshTestDb('archive');
  root = await mkdtemp(path.join(tmpdir(), 'kx-archive-int-'));
  store = new LocalArchiveStore(root);
});

afterAll(async () => {
  if (!available) return;
  await sql.end({ timeout: 5 });
  await rm(root, { recursive: true, force: true });
});

describeDb('archive lifecycle', () => {
  it('seals, archives and verifies a completed partition', async () => {
    const sessionId = randomUUID();
    const day = pastDay(2);
    await seedRawEvents(sessionId, day, 120);

    const worker = new ArchiveWorker({
      sql, store, retentionHours: 48, retentionEnabled: false,
    });
    const result = await worker.run();

    const partition = partitionNameFor(day);
    expect(result.verified).toContain(partition);
    expect(result.failed).toEqual([]);

    const [state] = (await sql`
      SELECT s.status, s.sealed_row_count, s.archived_row_count, s.part_count, s.verified_at
        FROM raw_partition_archive_state s WHERE s.partition_name = ${partition}
    `) as unknown as {
      status: string; sealed_row_count: string; archived_row_count: string;
      part_count: number; verified_at: Date | null;
    }[];

    expect(state!.status).toBe('verified');
    expect(state!.sealed_row_count).toBe('120');
    expect(state!.archived_row_count).toBe('120');
    expect(state!.verified_at).not.toBeNull();
  });

  it('writes a manifest whose checksum matches the stored bytes', async () => {
    const parts = (await sql`
      SELECT a.blob_path, a.sha256, a.row_count, a.compressed_bytes, a.uncompressed_bytes, a.verified_at
        FROM raw_archives a ORDER BY a.blob_path
    `) as unknown as {
      blob_path: string; sha256: Buffer; row_count: string;
      compressed_bytes: string; uncompressed_bytes: string; verified_at: Date | null;
    }[];

    expect(parts.length).toBeGreaterThan(0);

    for (const part of parts) {
      expect(part.verified_at).not.toBeNull();
      const bytes = await store.get(part.blob_path);
      expect(sha256(bytes).equals(Buffer.from(part.sha256))).toBe(true);

      // And the archived content is the raw payloads, one JSON object per line.
      const lines = gunzipSync(bytes).toString('utf8').trim().split('\n');
      expect(lines).toHaveLength(Number(part.row_count));
      const first = JSON.parse(lines[0]!);
      expect(first).toHaveProperty('payload');
      expect(first).toHaveProperty('ingest_ordinal');
      expect(first).toHaveProperty('seq');
    }
  });

  it('refuses to drop while retention is disabled, even once verified', async () => {
    const worker = new ArchiveWorker({ sql, store, retentionHours: 0, retentionEnabled: false });
    const result = await worker.run();

    expect(result.dropped).toEqual([]);
    const [state] = (await sql`
      SELECT s.status FROM raw_partition_archive_state s WHERE s.status = 'verified' LIMIT 1
    `) as unknown as { status: string }[];
    expect(state!.status).toBe('verified');
  });

  it('drops only after verification AND the retention floor', async () => {
    const partition = partitionNameFor(pastDay(2));

    // Retention floor not yet reached: still no drop.
    const early = new ArchiveWorker({ sql, store, retentionHours: 240, retentionEnabled: true });
    expect((await early.run()).dropped).not.toContain(partition);

    // Floor elapsed and archive verified: now it may go.
    const worker = new ArchiveWorker({ sql, store, retentionHours: 1, retentionEnabled: true });
    const result = await worker.run();
    expect(result.dropped).toContain(partition);

    const [state] = (await sql`
      SELECT s.status, s.detached_at, s.dropped_at
        FROM raw_partition_archive_state s WHERE s.partition_name = ${partition}
    `) as unknown as { status: string; detached_at: Date | null; dropped_at: Date | null }[];

    expect(state!.status).toBe('dropped');
    expect(state!.detached_at).not.toBeNull();
    expect(state!.dropped_at).not.toBeNull();
  });

  it('keeps the archived rows retrievable after the partition is gone', async () => {
    // The whole point: the database rows are gone, the data is not.
    const partition = partitionNameFor(pastDay(2));

    const gone = (await sql`
      SELECT to_regclass(${'public.' + partition}) AS rel
    `) as unknown as { rel: string | null }[];
    expect(gone[0]!.rel).toBeNull();

    const parts = (await sql`
      SELECT a.blob_path, a.row_count FROM raw_archives a
       WHERE a.partition_name = ${partition} ORDER BY a.blob_path
    `) as unknown as { blob_path: string; row_count: string }[];
    expect(parts.length).toBeGreaterThan(0);

    let recovered = 0;
    for (const p of parts) {
      const lines = gunzipSync(await store.get(p.blob_path)).toString('utf8').trim().split('\n');
      recovered += lines.length;
      expect(JSON.parse(lines[0]!)).toHaveProperty('message_type');
    }
    expect(recovered).toBe(120);
  });

  it('fails verification when a stored object is corrupted, and does not drop', async () => {
    const sessionId = randomUUID();
    const day = pastDay(3);
    // The drop test removes every eligible past partition, including empty
    // ones, so recreate this day's before seeding it.
    await ensureRawPartitions(sql, 7, 3);
    await seedRawEvents(sessionId, day, 30, 'trade');

    // Archive and verify, but do NOT drop yet -- the corruption has to be
    // discovered while the partition still exists.
    const worker = new ArchiveWorker({ sql, store, retentionHours: 0, retentionEnabled: false });
    await worker.run();

    const partition = partitionNameFor(day);
    const [part] = (await sql`
      SELECT a.blob_path FROM raw_archives a WHERE a.partition_name = ${partition} LIMIT 1
    `) as unknown as { blob_path: string }[];

    // Corrupt the stored bytes behind the manifest's back.
    await store.put(part!.blob_path, Buffer.from('corrupted'));

    await sql`
      UPDATE raw_partition_archive_state SET status = 'archived', verified_at = NULL
       WHERE partition_name = ${partition}
    `;

    const rerun = new ArchiveWorker({ sql, store, retentionHours: 0, retentionEnabled: true });
    const result = await rerun.run();

    // Re-archiving a resurrected partition must not silently skip it.
    expect(result.failed.some((f) => f.partition === partition)).toBe(true);
    expect(result.dropped).not.toContain(partition);

    const [state] = (await sql`
      SELECT s.status FROM raw_partition_archive_state s WHERE s.partition_name = ${partition}
    `) as unknown as { status: string }[];
    expect(state!.status).toBe('failed');
  });
});
