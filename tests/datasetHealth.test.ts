import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { datasetHealth, DEFAULT_THRESHOLDS } from '@/src/integrity/datasetHealth';
import type { Sql } from '@/src/persistence/db';
import { listCoverage, markAwaitingFirstMarket, markSubscribed, registerConfiguredSeries } from '@/src/persistence/repositories/coverage';
import { freshTestDb, testDbAvailable, truncateAll } from './fixtures/testDb';

/**
 * One status to alert on. CRITICAL must mean "the dataset is being damaged or
 * is not being collected"; anything less specific makes the alert useless.
 */

const available = await testDbAvailable();
const describeDb = available ? describe : describe.skip;

let sql: Sql;

beforeAll(async () => {
  if (!available) return;
  sql = await freshTestDb('health');
});

beforeEach(async () => {
  if (!available) return;
  await truncateAll(sql);
  await sql`TRUNCATE series_coverage`;
});

afterAll(async () => {
  if (!available) return;
  await sql.end({ timeout: 5 });
});

async function liveSession(heartbeatAgeSeconds = 0): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO collector_sessions (session_id, mode, started_at, config_hash, last_heartbeat_at)
    VALUES (${id}, 'daemon', now(), 'test', now() - make_interval(secs => ${heartbeatAgeSeconds}))
  `;
  return id;
}

describeDb('dataset health', () => {
  it('is CRITICAL when no collector session is open', async () => {
    const h = await datasetHealth(sql);
    expect(h.level).toBe('CRITICAL');
    expect(h.critical.join()).toMatch(/nothing is being recorded/);
  });

  it('is HEALTHY with a live heartbeat and nothing wrong', async () => {
    await liveSession(1);
    const h = await datasetHealth(sql);
    expect(h.level).toBe('HEALTHY');
    expect(h.critical).toEqual([]);
  });

  it('is CRITICAL when the heartbeat goes stale', async () => {
    await liveSession(120);
    const h = await datasetHealth(sql);
    expect(h.level).toBe('CRITICAL');
    expect(h.critical.join()).toMatch(/stale/);
  });

  it('is CRITICAL on an unrecovered sequence gap', async () => {
    const session = await liveSession(1);
    await sql`
      INSERT INTO sequence_gaps (session_id, stream_id, channel, detected_at, status)
      VALUES (${session}, ${randomUUID()}, 'orderbook_delta', now(), 'failed')
    `;
    const h = await datasetHealth(sql);
    expect(h.level).toBe('CRITICAL');
    expect(h.critical.join()).toMatch(/unrecovered/);
  });

  it('is HEALTHY when a gap was recorded and recovered', async () => {
    const session = await liveSession(1);
    await sql`
      INSERT INTO sequence_gaps (session_id, stream_id, channel, detected_at, status)
      VALUES (${session}, ${randomUUID()}, 'orderbook_delta', now(), 'recovered')
    `;
    const h = await datasetHealth(sql);
    expect(h.level).toBe('HEALTHY');
    expect(h.checks.find((c) => c.name === 'sequence_recovery')!.detail).toMatch(/all recovered/);
  });

  it('is CRITICAL on an ingest ordinal hole', async () => {
    const session = await liveSession(1);
    // A hole means a frame was observed but never persisted.
    for (const ordinal of [1, 2, 5]) {
      await sql`
        INSERT INTO raw_ingest_events (
          session_id, received_at, received_at_ms, ingest_ordinal,
          message_type, payload_hash, payload
        ) VALUES (
          ${session}, now(), ${Date.now()}, ${ordinal},
          'orderbook_delta', sha256('x'::bytea), '{}'::jsonb
        )
      `;
    }
    const h = await datasetHealth(sql);
    expect(h.level).toBe('CRITICAL');
    expect(h.critical.join()).toMatch(/ordinal hole/);
  });

  it('is CRITICAL when database writes are failing', async () => {
    const session = await liveSession(1);
    await sql`
      INSERT INTO integrity_events (session_id, detected_at, type, severity, details)
      VALUES (${session}, now(), 'buffer_overflow', 'critical', '{}'::jsonb)
    `;
    const h = await datasetHealth(sql);
    expect(h.level).toBe('CRITICAL');
    expect(h.critical.join()).toMatch(/write failure/);
  });

  it('treats an overdue archive as DEGRADED while retention is off, CRITICAL when on', async () => {
    await liveSession(1);
    await sql`
      INSERT INTO raw_partition_archive_state (partition_name, partition_start, partition_end, status)
      VALUES ('raw_ingest_events_2020_01_01', '2020-01-01', '2020-01-02', 'pending')
    `;

    // Nothing can be lost while retention is disabled.
    const off = await datasetHealth(sql, { ...DEFAULT_THRESHOLDS, retentionEnabled: false });
    expect(off.level).toBe('DEGRADED');
    expect(off.degraded.join()).toMatch(/nothing can be lost/);

    // With retention on, unarchived data is one job away from deletion.
    const on = await datasetHealth(sql, { ...DEFAULT_THRESHOLDS, retentionEnabled: true });
    expect(on.level).toBe('CRITICAL');
  });

  it('reports a confirmed REST mismatch as DEGRADED, not CRITICAL', async () => {
    const session = await liveSession(1);
    await sql`
      INSERT INTO book_validations (market_ticker, checked_at, session_id, matched, match_kind)
      VALUES ('KXHIGHNY-26SEP14-B74.5', now(), ${session}, false, 'mismatch_confirmed')
    `;
    const h = await datasetHealth(sql);
    // Worth attention, but history is still being captured correctly.
    expect(h.level).toBe('DEGRADED');
  });
});

describeDb('series coverage', () => {
  it('distinguishes a series awaiting its first market from a failing one', async () => {
    await registerConfiguredSeries(sql, ['KXHIGHNY', 'KXLOWNY', 'KXLOWLAX']);
    await markSubscribed(sql, 'KXHIGHNY', 'KXHIGHNY-26SEP14-B74.5', 12);
    await markAwaitingFirstMarket(sql, ['KXLOWNY', 'KXLOWLAX']);

    const coverage = await listCoverage(sql);
    const byTicker = new Map(coverage.map((c) => [c.series_ticker, c]));

    expect(byTicker.get('KXHIGHNY')!.status).toBe('exercised');
    expect(byTicker.get('KXHIGHNY')!.markets_seen).toBe(12);
    expect(byTicker.get('KXHIGHNY')!.first_subscribed_at).not.toBeNull();

    // Configured and known-absent, not silently broken.
    expect(byTicker.get('KXLOWNY')!.status).toBe('awaiting_first_market');
    expect(byTicker.get('KXLOWLAX')!.status).toBe('awaiting_first_market');
  });

  it('promotes a waiting series the first time it lists a market', async () => {
    await registerConfiguredSeries(sql, ['KXLOWNY']);
    await markAwaitingFirstMarket(sql, ['KXLOWNY']);
    expect((await listCoverage(sql))[0]!.status).toBe('awaiting_first_market');

    await markSubscribed(sql, 'KXLOWNY', 'KXLOWNY-26DEC01-B30.5', 8);

    const after = (await listCoverage(sql))[0]!;
    expect(after.status).toBe('exercised');
    expect(after.first_subscribed_at).not.toBeNull();
    expect(after.last_market_ticker).toBe('KXLOWNY-26DEC01-B30.5');
  });

  it('does not regress an exercised series when markets go absent again', async () => {
    // Daily markets close every day; that is not a loss of coverage.
    await registerConfiguredSeries(sql, ['KXHIGHNY']);
    await markSubscribed(sql, 'KXHIGHNY', 'KXHIGHNY-26SEP14-B74.5', 12);
    await markAwaitingFirstMarket(sql, ['KXHIGHNY']);

    expect((await listCoverage(sql))[0]!.status).toBe('exercised');
  });
});
