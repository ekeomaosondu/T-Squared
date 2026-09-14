#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { env } from '@/src/config/env';
import { S3ArchiveStore, sha256 } from '@/src/persistence/archiveStore';
import { closeDb, db } from '@/src/persistence/db';

/**
 * R2 credential rotation.
 *
 *   1. Create a NEW R2 API token in the Cloudflare dashboard with Object
 *      Read & Write on the archive bucket.
 *   2. Replace ARCHIVE_ACCESS_KEY_ID and ARCHIVE_SECRET_ACCESS_KEY in
 *      .env.local with the new values. Do not paste them anywhere else.
 *   3. npm run rotate:r2 -- --verify     checks the new credentials work
 *   4. npm run rotate:r2 -- --apply      pushes them to Fly and redeploys
 *   5. Delete the OLD token in the dashboard.
 *   6. npm run rotate:r2 -- --verify     confirms nothing broke
 *
 * Credentials are read from the environment and never printed, echoed or
 * passed as a command-line argument -- an argument is visible in `ps` and in
 * shell history, which for a rotation being performed BECAUSE the old
 * credentials leaked would be an unusually pointed mistake.
 *
 * Verification is deliberately end to end: writing a probe object proves the
 * token can write, and re-reading a REAL archive and matching its recorded
 * SHA-256 proves it can still read what the old token wrote. A token with
 * write-only scope would pass a naive check and then silently break every
 * restore.
 */

const fingerprint = (value: string) =>
  value.length === 0
    ? '(unset)'
    : `${value.slice(0, 4)}…${sha256(Buffer.from(value, 'utf8')).toString('hex').slice(0, 8)}`;

async function verify(): Promise<boolean> {
  const e = env();
  console.log('\n=== R2 credential verification ===\n');
  console.log(`  bucket        ${e.ARCHIVE_BUCKET}`);
  console.log(`  endpoint      ${e.ARCHIVE_ENDPOINT}`);
  console.log(`  access key    ${fingerprint(e.ARCHIVE_ACCESS_KEY_ID)}`);
  console.log(`  secret        ${e.ARCHIVE_SECRET_ACCESS_KEY ? '(set)' : '(UNSET)'}\n`);

  if (!e.ARCHIVE_ACCESS_KEY_ID || !e.ARCHIVE_SECRET_ACCESS_KEY) {
    console.error('FAIL: ARCHIVE_ACCESS_KEY_ID and ARCHIVE_SECRET_ACCESS_KEY must both be set');
    return false;
  }

  const store = new S3ArchiveStore({
    bucket: e.ARCHIVE_BUCKET,
    endpoint: e.ARCHIVE_ENDPOINT,
    region: e.ARCHIVE_REGION,
    accessKeyId: e.ARCHIVE_ACCESS_KEY_ID,
    secretAccessKey: e.ARCHIVE_SECRET_ACCESS_KEY,
    flavour: 'r2',
  });

  let ok = true;
  const check = (name: string, passed: boolean, detail: string) => {
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
    if (!passed) ok = false;
  };

  // --- write, read back, checksum, delete --------------------------------
  const probePath = `_rotation-probe/${randomUUID()}.bin`;
  const body = Buffer.from(randomUUID(), 'utf8');
  try {
    await store.put(probePath, body);
    const readBack = await store.get(probePath);
    check(
      'write and read back a probe',
      sha256(readBack).equals(sha256(body)),
      `${body.byteLength} bytes round-tripped`,
    );
    await store.delete(probePath);
    check('delete the probe', !(await store.exists(probePath)), probePath);
  } catch (err) {
    check('write and read back a probe', false, err instanceof Error ? err.message : String(err));
  }

  // --- read a REAL archive and match its recorded checksum ---------------
  const sql = db();
  try {
    const rows = (await sql`
      SELECT a.blob_path, a.sha256, a.row_count
        FROM raw_archives a
       WHERE a.verified_at IS NOT NULL
       ORDER BY a.verified_at DESC
       LIMIT 1
    `) as unknown as { blob_path: string; sha256: Buffer; row_count: string }[];

    const archive = rows[0];
    if (!archive) {
      check('read an existing archive', false, 'no verified archive to read; cannot confirm read scope');
    } else {
      const bytes = await store.get(archive.blob_path);
      check(
        'read an existing archive',
        sha256(bytes).equals(archive.sha256),
        `${archive.blob_path.split('/').slice(-1)[0]} (${archive.row_count} rows)`,
      );
    }

    const silver = (await sql`
      SELECT s.object_path FROM silver_exports s WHERE s.status = 'verified' LIMIT 1
    `) as unknown as { object_path: string }[];
    if (silver[0]) {
      const bytes = await store.get(silver[0].object_path);
      check('read the silver lake', bytes.byteLength > 0, silver[0].object_path);
    }
  } finally {
    await closeDb();
  }

  console.log(`\n${ok ? 'PASS' : 'FAIL'}: the configured credentials ${ok ? 'work' : 'do NOT work'}\n`);
  return ok;
}

/**
 * Pushes the credentials in the environment to Fly and redeploys.
 *
 * `fly secrets set` is given the values through argv, which is unavoidable
 * with that CLI, so this is the one place they touch a process argument. They
 * are never logged here and the command itself is not echoed.
 */
function apply(): void {
  const e = env();
  console.log('\nsetting Fly secrets (values not shown)...');
  execFileSync(
    'fly',
    [
      'secrets',
      'set',
      `ARCHIVE_ACCESS_KEY_ID=${e.ARCHIVE_ACCESS_KEY_ID}`,
      `ARCHIVE_SECRET_ACCESS_KEY=${e.ARCHIVE_SECRET_ACCESS_KEY}`,
      '--stage',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  console.log('\nstaged. Deploy with the commit baked in:\n\n  npm run deploy:fly\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--apply')) {
    if (!(await verify())) {
      console.error('refusing to deploy credentials that do not work');
      process.exitCode = 1;
      return;
    }
    apply();
    return;
  }
  if (!(await verify())) process.exitCode = 1;
}

void main();
