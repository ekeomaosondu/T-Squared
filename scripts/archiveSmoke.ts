#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { gzipSync, gunzipSync } from 'node:zlib';
import { env } from '@/src/config/env';
import { S3ArchiveStore, selectArchiveStore, sha256 } from '@/src/persistence/archiveStore';

/**
 * Archive storage connectivity check.
 *
 *   npm run archive:smoke
 *
 * put -> read back -> SHA-256 equality -> delete, against whatever
 * ARCHIVE_STORAGE points at. Deliberately does not touch the active daily
 * partition: it writes to a throwaway key under _smoke/ and removes it.
 *
 * Run this before enabling retention. An archive you cannot read back is worse
 * than no archive, because retention would then delete data believing it safe.
 */
async function main(): Promise<void> {
  const e = env();
  const { store } = selectArchiveStore({
    blobToken: e.BLOB_READ_WRITE_TOKEN,
    mode: e.COLLECTOR_MODE,
    storage: e.ARCHIVE_STORAGE,
    s3: {
      bucket: e.ARCHIVE_BUCKET,
      endpoint: e.ARCHIVE_ENDPOINT,
      region: e.ARCHIVE_REGION,
      accessKeyId: e.ARCHIVE_ACCESS_KEY_ID,
      secretAccessKey: e.ARCHIVE_SECRET_ACCESS_KEY,
    },
  });

  console.log(`\n=== archive storage smoke test: ${store.kind} ===\n`);
  const steps: { name: string; ok: boolean; detail: string }[] = [];
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ name, ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${detail}`);
  };

  if (store instanceof S3ArchiveStore) {
    const state = await store.ensureBucket();
    step('bucket', true, `${e.ARCHIVE_BUCKET} (${state})`);
  }

  // Shaped like a real archive part so any path or content-type handling that
  // would bite in production bites here instead.
  const key = `_smoke/${e.DATASET_ID}/part-${Date.now()}.jsonl.gz`;
  const payload = Buffer.from(
    `${JSON.stringify({ id: '1', message_type: 'orderbook_delta', payload: { seq: 1 } })}\n`,
    'utf8',
  );
  const body = gzipSync(payload, { level: 9 });
  const expected = sha256(body);

  const put = await store.put(key, body);
  step('put', put.size === body.byteLength, `${key} (${body.byteLength} bytes)`);

  const readBack = await store.get(key);
  const actual = sha256(readBack);
  const checksumOk = actual.equals(expected);
  step('sha256 equality', checksumOk, `${expected.toString('hex').slice(0, 16)}…`);

  const roundTripped = gunzipSync(readBack).toString('utf8');
  step('content round trip', roundTripped === payload.toString('utf8'), 'gzip payload identical');

  let deleted = false;
  if (store instanceof S3ArchiveStore) {
    await store.delete(key);
    deleted = !(await store.exists(key));
    step('delete', deleted, 'test object removed');
  } else {
    step('delete', true, 'skipped (backend has no delete; nothing left behind matters)');
    deleted = true;
  }

  const pass = steps.every((s) => s.ok);
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'} -- ${store.kind} is ${pass ? 'usable' : 'NOT usable'} for archives\n`);
  if (!pass) process.exit(2);
}

main().catch((err) => {
  console.error('\nFAIL:', err instanceof Error ? err.message : String(err), '\n');
  process.exit(1);
});
