#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { env } from '@/src/config/env';
import { selectArchiveStore } from '@/src/persistence/archiveStore';
import { closeDb, createDb, db } from '@/src/persistence/db';
import { migrate } from '@/src/persistence/migrate';
import { ensureRawPartitions } from '@/src/persistence/partitions';
import { restoreAndVerify } from '@/src/replay/restore';
import { logger } from '@/src/logging/logger';

/**
 * Archive restore acceptance test.
 *
 *   npm run restore -- --partition raw_ingest_events_2026_09_14 \
 *                      --scratch postgres://.../kalshi_restore_check
 *
 * Archive verification proves only that the bytes written are the bytes read
 * back. This proves the thing actually worth proving:
 *
 *     archived bytes -> restore -> parse -> normalize -> replay -> exact book
 *
 * Exits non-zero unless every original snapshot is reproduced exactly from the
 * archive alone. Treat a pass as the gate for enabling retention.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const partition = get('--partition');
  if (!partition) {
    console.error(
      'usage: npm run restore -- --partition <name> [--scratch <postgres url>]\n' +
        '  --partition  the partition to restore, e.g. raw_ingest_events_2026_09_14\n' +
        '  --scratch    scratch database URL (default: <DATABASE_URL>_restore_check)',
    );
    process.exit(1);
  }

  const e = env();
  const sourceSql = db();

  const scratchUrl = get('--scratch') ?? defaultScratchUrl(e.DATABASE_URL);
  await ensureScratchDatabase(scratchUrl);

  const targetSql = createDb({ connectionString: scratchUrl, max: 4 });
  await migrate(targetSql);
  await targetSql.unsafe(`
    TRUNCATE raw_ingest_events, orderbook_deltas, orderbook_snapshots,
             public_trades, ticker_updates, market_lifecycle_events,
             sequence_gaps, integrity_events, subscription_streams,
             collector_sessions
    RESTART IDENTITY CASCADE
  `);
  await ensureRawPartitions(targetSql, 7, 30);

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

  logger.info(
    { event: 'restore_start', partition, store: store.kind, scratch: scratchUrl.split('@').pop() },
    `restoring ${partition} into a scratch database`,
  );

  const result = await restoreAndVerify({ sourceSql, targetSql, store, partitionName: partition });

  console.log('\n=== archive restore acceptance ===\n');
  console.log(`  partition            ${result.partitionName}`);
  console.log(`  parts read           ${result.parts} (${(result.bytes / 1e6).toFixed(2)} MB compressed)`);
  console.log(`  checksums verified   ${result.checksumsVerified}/${result.parts}`);
  console.log(`  rows restored        ${result.rowsRestored}`);
  console.log(`  frames replayed      ${result.framesReplayed} across ${result.sessionsRestored} session(s)`);
  console.log(`  snapshots compared   ${result.compared}`);
  console.log(`  reproduced exactly   ${result.matched}`);
  console.log(`  mismatches           ${result.mismatches.length}`);
  console.log(`  never reached        ${result.unreachable.length}`);

  for (const m of result.mismatches.slice(0, 5)) {
    console.log(`    MISMATCH ${m.marketTicker} seq=${m.seq}: expected ${m.expected.slice(0, 12)}, got ${m.actual.slice(0, 12)}`);
  }
  for (const u of result.unreachable.slice(0, 5)) {
    console.log(`    UNREACHED ${u.marketTicker} seq=${u.seq}`);
  }

  const pass =
    result.compared > 0 &&
    result.matched === result.compared &&
    result.mismatches.length === 0 &&
    result.unreachable.length === 0 &&
    result.checksumsVerified === result.parts;

  console.log(`\n  ${pass ? 'PASS' : 'FAIL'} -- archived bytes ${pass ? 'reconstruct exactly' : 'did NOT reconstruct'}\n`);

  await targetSql.end({ timeout: 5 });
  await closeDb();
  if (!pass) process.exit(2);
}

function defaultScratchUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `${u.pathname.replace(/\/$/, '')}_restore_check`;
  return u.toString();
}

/** Creates the scratch database if it does not exist. */
async function ensureScratchDatabase(scratchUrl: string): Promise<void> {
  const u = new URL(scratchUrl);
  const name = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';

  const admin = createDb({ connectionString: u.toString(), max: 1 });
  try {
    const existing = await admin<{ n: string }[]>`
      SELECT count(*) AS n FROM pg_database d WHERE d.datname = ${name}
    `;
    if (Number(existing[0]!.n) === 0) {
      await admin.unsafe(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      logger.info({ event: 'scratch_db_created', database: name }, 'created scratch database');
    }
  } finally {
    await admin.end({ timeout: 2 });
  }
}

main().catch(async (err) => {
  logger.error({ event: 'restore_failed', err: String(err), stack: (err as Error)?.stack }, 'restore failed');
  console.error(String(err));
  await closeDb().catch(() => {});
  process.exit(1);
});
