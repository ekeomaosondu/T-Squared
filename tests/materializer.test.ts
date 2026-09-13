import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Collector } from '@/src/collector/collector';
import { parseCollectorConfig } from '@/src/config/collectorConfig';
import { BatchWriter } from '@/src/persistence/batchWriter';
import type { Sql } from '@/src/persistence/db';
import { startSession, endSession } from '@/src/persistence/repositories/sessions';
import { BookSampler } from '@/src/sampling/bookSampler';
import { materialize } from '@/src/sampling/materializer';
import { freshTestDb, testDbAvailable, truncateAll } from './fixtures/testDb';
import { FakeWebSocketClient, deltaFrame, snapshotFrame } from './fixtures/syntheticFeed';

/**
 * SAMPLER EQUIVALENCE.
 *
 * The database now persists only a coarse 60s grid; research horizons are
 * materialized offline from the delta stream. That is only sound if:
 *
 *     offline sample at interval X == what live sampling at X would produce
 *
 * If those diverge, every backtest measures something the live strategy will
 * never see. This drives the live collector AND the offline materializer over
 * the same events and requires identical output.
 */

const available = await testDbAvailable();
const describeDb = available ? describe : describe.skip;

const TICKER = 'KXHIGHNY-26SEP14-B74.5';
let sql: Sql;

beforeAll(async () => {
  if (!available) return;
  sql = await freshTestDb('materializer');
});

beforeEach(async () => {
  if (!available) return;
  await truncateAll(sql);
});

afterAll(async () => {
  if (!available) return;
  await sql.end({ timeout: 5 });
});

/**
 * Captures a deterministic session while ALSO sampling live at `intervalMs`,
 * returning the live samples for comparison.
 */
async function captureWithLiveSampling(intervalMs: number, baseMs: number) {
  const sessionId = await startSession(sql, {
    sessionId: randomUUID(), mode: 'daemon', configHash: 'equiv', wsUrl: 'wss://test',
  });

  const ws = new FakeWebSocketClient();
  const writer = new BatchWriter({ sql, maxRows: 200, maxWaitMs: 20 });

  const collector = new Collector({
    sql, ws: ws as never, rest: {} as never,
    universe: {
      isTracked: () => true, queueMetadataRefresh: () => {}, queueEventRefresh: () => {}, trackedTickers: [TICKER],
    } as never,
    writer,
    config: parseCollectorConfig({
      selectors: [{ id: 't', seriesAllowlist: ['KXHIGHNY'] }],
      capture: { orderbookDeltas: true, trades: false, tickerUpdates: false, lifecycleEvents: false },
      sampling: { bboIntervalsMs: [], fullBookIntervalsMs: [], eventLadderIntervalsMs: [] },
    }),
    sessionId,
  });
  collector.start();
  await collector.subscribeAll([TICKER]);
  ws.ackSubscribe('orderbook_delta', ws.sent[0]!.id, 1);

  // The live sampler, driven exactly as the session runner drives it.
  const liveSampler = new BookSampler({
    books: collector.books,
    marketState: collector.marketState,
    bboIntervalsMs: [intervalMs],
    fullBookIntervalsMs: [],
  });

  const liveSamples: Record<string, unknown>[] = [];
  const sampleLive = (atMs: number) => {
    for (const row of liveSampler.sample(atMs, sessionId)) {
      if (row.table === 'book_samples') liveSamples.push(row.values);
    }
  };

  // Deterministic event stream at known timestamps.
  let seq = 1;
  const events: { atMs: number; side: 'yes' | 'no'; price: string; delta: string }[] = [];
  for (let i = 0; i < 60; i++) {
    events.push({
      atMs: baseMs + 137 * i,
      side: i % 3 === 0 ? 'no' : 'yes',
      price: i % 3 === 0 ? '0.5700' : i % 2 === 0 ? '0.4200' : '0.4100',
      delta: i % 5 === 0 ? '-2.00' : '7.00',
    });
  }

  ws.deliver(
    snapshotFrame({
      sid: 1, seq: seq++, ticker: TICKER,
      yes: [['0.4200', '150.00'], ['0.4100', '300.00']],
      no: [['0.5700', '100.00'], ['0.5600', '250.00']],
    }),
    baseMs - 1,
  );

  // Emit the grid point BEFORE each event that crosses it, which is exactly
  // when a live timer would have fired relative to the socket handler.
  let nextBucket = Math.floor(baseMs / intervalMs) * intervalMs;
  for (const e of events) {
    while (nextBucket < e.atMs) {
      sampleLive(nextBucket);
      nextBucket += intervalMs;
    }
    // Same receipt clock the live sampler is stepping through, so replay and
    // live sampling are comparing one timeline rather than two.
    ws.deliver(
      deltaFrame({ sid: 1, seq: seq++, ticker: TICKER, side: e.side, price: e.price, delta: e.delta }),
      e.atMs,
    );
  }

  await writer.close();
  await collector.flushDeferred();
  await endSession(sql, sessionId, 'equiv_complete');

  return { sessionId, liveSamples, lastEventMs: events.at(-1)!.atMs };
}

describeDb('sampler equivalence', () => {
  it('offline clock materialization matches the live sampler exactly', async () => {
    // Deterministic base so bucket alignment is reproducible.
    const baseMs = 1_789_400_000_000;
    const intervalMs = 1000;

    const { liveSamples, lastEventMs } = await captureWithLiveSampling(intervalMs, baseMs);
    expect(liveSamples.length).toBeGreaterThan(3);

    const offline: Record<string, unknown>[] = [];
    await materialize(sql, {
      marketTickers: [TICKER],
      fromMs: BigInt(baseMs),
      toMs: BigInt(lastEventMs),
      mode: 'clock',
      intervalMs,
      onRow: (row) => { offline.push(row); },
    });

    // Compare the fields a strategy would actually consume.
    const fields = [
      'yes_bid', 'yes_ask', 'bid_size', 'ask_size', 'spread', 'mid', 'microprice',
      'bid_depth_1', 'ask_depth_1', 'bid_depth_3', 'ask_depth_3',
      'imbalance_1', 'imbalance_3', 'book_state_hash', 'book_valid',
    ];

    const norm = (rows: Record<string, unknown>[]) =>
      rows
        .map((r) => ({ bucket: String(r.bucket_ts_ms), ...Object.fromEntries(fields.map((f) => [f, r[f] ?? null])) }))
        .sort((a, b) => Number(a.bucket) - Number(b.bucket));

    const liveNorm = norm(liveSamples);
    const offlineNorm = norm(offline).filter((o) => liveNorm.some((l) => l.bucket === o.bucket));

    expect(offlineNorm.length).toBe(liveNorm.length);
    expect(offlineNorm).toEqual(liveNorm);
  });

  it('produces a row per book-changing event in event-time mode', async () => {
    const baseMs = 1_789_400_000_000;
    const { lastEventMs } = await captureWithLiveSampling(1000, baseMs);

    const rows: Record<string, unknown>[] = [];
    await materialize(sql, {
      marketTickers: [TICKER],
      fromMs: BigInt(baseMs),
      toMs: BigInt(lastEventMs),
      mode: 'event-time',
      onRow: (row) => { rows.push(row); },
    });

    const applied = (await sql`
      SELECT count(*) AS n FROM orderbook_deltas d WHERE d.applied
    `) as unknown as { n: string }[];

    // One row per applied delta, plus the seeding snapshot.
    expect(rows.length).toBe(Number(applied[0]!.n) + 1);
    // Event time carries the exchange sequence, which a clock grid cannot.
    expect(rows.at(-1)!.seq).not.toBeNull();
    expect(rows.at(-1)!.book_state_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('aligns offline buckets to the interval grid, so runs are comparable', async () => {
    const baseMs = 1_789_400_000_123; // deliberately off-grid
    const { lastEventMs } = await captureWithLiveSampling(1000, baseMs);

    const rows: Record<string, unknown>[] = [];
    await materialize(sql, {
      marketTickers: [TICKER],
      fromMs: BigInt(baseMs),
      toMs: BigInt(lastEventMs),
      mode: 'clock',
      intervalMs: 1000,
      onRow: (row) => { rows.push(row); },
    });

    for (const r of rows) {
      expect(Number(r.bucket_ts_ms) % 1000).toBe(0);
    }
  });
});
