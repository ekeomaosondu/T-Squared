import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { archivePath } from '@/src/persistence/archive';
import { LocalArchiveStore, selectArchiveStore, sha256 } from '@/src/persistence/archiveStore';

const roots: string[] = [];
async function tempStore(): Promise<LocalArchiveStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'kx-archive-'));
  roots.push(root);
  return new LocalArchiveStore(root);
}

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('archive object paths', () => {
  it('follows the documented channel/date/hour layout', () => {
    const p = archivePath({
      channel: 'orderbook_delta',
      hourStart: new Date('2026-09-13T17:00:00Z'),
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      firstId: '123',
      lastId: '456',
    });
    expect(p).toBe(
      'kalshi/raw/channel=orderbook_delta/date=2026-09-13/hour=17/' +
        'part-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-123-456.jsonl.gz',
    );
  });

  it('partitions by hour within a day', () => {
    const base = { channel: 'trade', sessionId: 's', firstId: '1', lastId: '2' };
    expect(archivePath({ ...base, hourStart: new Date('2026-09-13T00:00:00Z') })).toContain('hour=00');
    expect(archivePath({ ...base, hourStart: new Date('2026-09-13T23:00:00Z') })).toContain('hour=23');
  });

  it('names a null channel explicitly rather than leaving a hole in the path', () => {
    const p = archivePath({
      channel: null,
      hourStart: new Date('2026-09-13T17:00:00Z'),
      sessionId: 's',
      firstId: '1',
      lastId: '2',
    });
    expect(p).toContain('channel=unknown');
  });
});

describe('archive store round trip', () => {
  it('stores and returns identical bytes', async () => {
    const store = await tempStore();
    const body = gzipSync(Buffer.from('{"id":"1"}\n{"id":"2"}\n', 'utf8'), { level: 9 });

    const stored = await store.put('kalshi/raw/channel=trade/date=2026-09-13/hour=17/part-a-1-2.jsonl.gz', body);
    expect(stored.size).toBe(body.byteLength);

    const read = await store.get(stored.path);
    // The checksum in the manifest is over the gzipped bytes exactly as
    // uploaded, so the round trip must be byte-identical.
    expect(sha256(read).equals(sha256(body))).toBe(true);
    expect(gunzipSync(read).toString('utf8')).toContain('{"id":"1"}');
  });

  it('reports absence without throwing', async () => {
    const store = await tempStore();
    expect(await store.exists('kalshi/raw/nope.jsonl.gz')).toBe(false);
  });

  it('refuses a path that escapes the archive root', async () => {
    const store = await tempStore();
    await expect(store.put('../../escape.gz', Buffer.from('x'))).rejects.toThrow(/escapes root/);
  });
});

describe('archive backend selection', () => {
  it('uses PRIVATE Vercel Blob when a token is present', () => {
    // A public archive would expose the whole order-book history to anyone
    // with the URL.
    const sel = selectArchiveStore({ blobToken: 'vercel_blob_rw_test', mode: 'daemon' });
    expect(sel.store.kind).toBe('vercel-blob-private');
  });

  it('uses R2 when configured, since it charges no egress for repeated scans', () => {
    const sel = selectArchiveStore({
      blobToken: '',
      mode: 'daemon',
      storage: 'r2',
      s3: {
        bucket: 'kalshi',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        region: 'auto',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
      },
    });
    expect(sel.store.kind).toBe('r2');
    expect(sel.durable).toBe(true);
  });

  it('refuses R2 without credentials rather than silently falling back', () => {
    // Falling back to local disk would let retention later drop partitions
    // believing they were archived.
    expect(() =>
      selectArchiveStore({ blobToken: '', mode: 'daemon', storage: 'r2' }),
    ).toThrow(/requires ARCHIVE_BUCKET/);
  });

  it('allows a local backend in daemon mode', () => {
    const sel = selectArchiveStore({ blobToken: '', mode: 'daemon', localRoot: '/tmp/kx-test' });
    expect(sel.store.kind).toBe('local');
  });

  it('refuses a local backend on Vercel, where the filesystem is not durable', () => {
    // Falling back to local disk there would produce archives that vanish --
    // and retention would then drop partitions believing they were safe.
    expect(() => selectArchiveStore({ blobToken: '', mode: 'vercel_rolling' })).toThrow(
      /not durable/,
    );
  });
});

describe('gzip determinism', () => {
  it('produces identical bytes for identical input', () => {
    // The manifest checksum is only meaningful if re-serialising the same rows
    // reproduces the same bytes.
    const body = Buffer.from('{"id":"1","payload":{"a":1}}\n', 'utf8');
    const a = gzipSync(body, { level: 9 });
    const b = gzipSync(body, { level: 9 });
    expect(a.equals(b)).toBe(true);
    expect(sha256(a).equals(sha256(b))).toBe(true);
  });
});
