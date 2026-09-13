import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Collector } from '@/src/collector/collector';
import { parseCollectorConfig } from '@/src/config/collectorConfig';
import { ArchiveWorker } from '@/src/persistence/archive';
import { LocalArchiveStore } from '@/src/persistence/archiveStore';
import { BatchWriter } from '@/src/persistence/batchWriter';
import type { Sql } from '@/src/persistence/db';
import { startSession, endSession } from '@/src/persistence/repositories/sessions';
import { restoreAndVerify } from '@/src/replay/restore';
import { BookSampler } from '@/src/sampling/bookSampler';
import { freshTestDb, testDbAvailable } from './fixtures/testDb';
import { FakeWebSocketClient, deltaFrame, snapshotFrame, tradeFrame } from './fixtures/syntheticFeed';

/**
 * ARCHIVE RESTORE ACCEPTANCE.
 *
 * Archive verification proves only `bytes written == bytes read`. This proves
 * the chain that actually matters:
 *
 *     archived bytes -> restore -> parse -> normalize -> replay -> exact book
 *
 * Passing this is the gate for enabling destructive retention.
 */

const available = await testDbAvailable();
const describeDb = available ? describe : describe.skip;

const MARKETS = ['KXHIGHNY-26SEP14-B74.5', 'KXHIGHNY-26SEP14-B76.5'];

let sourceSql: Sql;
let targetSql: Sql;
let root: string;
let store: LocalArchiveStore;

beforeAll(async () => {
  if (!available) return;
  sourceSql = await freshTestDb('restore_src');
  targetSql = await freshTestDb('restore_dst');
  root = await mkdtemp(path.join(tmpdir(), 'kx-restore-'));
  store = new LocalArchiveStore(root);
});

afterAll(async () => {
  if (!available) return;
  await sourceSql.end({ timeout: 5 });
  await targetSql.end({ timeout: 5 });
  await rm(root, { recursive: true, force: true });
});

describeDb('archive restore acceptance', () => {
  let partitionName: string;

  it('captures a realistic session, including a gap and a recovery', async () => {
    const sessionId = await startSession(sourceSql, {
      sessionId: randomUUID(),
      mode: 'daemon',
      configHash: 'restore-test',
      wsUrl: 'wss://test',
    });

    const ws = new FakeWebSocketClient();
    const writer = new BatchWriter({ sql: sourceSql, maxRows: 100, maxWaitMs: 20 });

    const collector = new Collector({
      sql: sourceSql,
      ws: ws as never,
      rest: {} as never,
      universe: {
        isTracked: () => true,
        queueMetadataRefresh: () => {},
        queueEventRefresh: () => {},
        trackedTickers: MARKETS,
      } as never,
      writer,
      config: parseCollectorConfig({
        selectors: [{ id: 't', seriesAllowlist: ['KXHIGHNY'] }],
        capture: { orderbookDeltas: true, trades: true, tickerUpdates: false, lifecycleEvents: false },
        sampling: { bboIntervalsMs: [], fullBookIntervalsMs: [], eventLadderIntervalsMs: [] },
      }),
      sessionId,
    });
    collector.start();

    await collector.subscribeAll(MARKETS);
    ws.ackSubscribe('orderbook_delta', ws.sent[0]!.id, 1);
    ws.ackSubscribe('trade', ws.sent[1]!.id, 2);

    const sampler = new BookSampler({
      books: collector.books,
      marketState: collector.marketState,
      bboIntervalsMs: [],
      fullBookIntervalsMs: [1],
    });
    const materialise = () => writer.enqueueDerived(sampler.sample(Date.now(), sessionId));

    let seq = 1;
    for (const ticker of MARKETS) {
      ws.deliver(
        snapshotFrame({
          sid: 1, seq: seq++, ticker,
          yes: [['0.4200', '150.00'], ['0.4100', '300.00']],
          no: [['0.5700', '100.00'], ['0.5600', '250.00']],
        }),
      );
    }

    for (let i = 0; i < 120; i++) {
      const ticker = MARKETS[i % MARKETS.length]!;
      ws.deliver(deltaFrame({
        sid: 1, seq: seq++, ticker,
        side: i % 3 === 0 ? 'no' : 'yes',
        price: i % 3 === 0 ? '0.5700' : '0.4200',
        delta: i % 4 === 0 ? '-2.00' : '5.00',
      }));
      if (i % 25 === 24) materialise();
    }

    ws.deliver(tradeFrame({ sid: 2, seq: 1, ticker: MARKETS[0]!, tradeId: randomUUID(), yesPrice: '0.4200', count: '12.50' }));

    // A real discontinuity, then recovery for every affected market.
    seq += 30;
    ws.deliver(deltaFrame({ sid: 1, seq: seq++, ticker: MARKETS[0]!, side: 'yes', price: '0.4200', delta: '1.00' }));
    for (const ticker of MARKETS) {
      ws.deliver(snapshotFrame({ sid: 1, seq: seq++, ticker, yes: [['0.4300', '99.00']], no: [['0.5500', '77.00']] }));
    }
    for (let i = 0; i < 60; i++) {
      ws.deliver(deltaFrame({
        sid: 1, seq: seq++, ticker: MARKETS[i % MARKETS.length]!, side: 'yes', price: '0.4300', delta: '3.00',
      }));
      if (i % 20 === 19) materialise();
    }
    materialise();

    await writer.close();
    await collector.flushDeferred();
    await endSession(sourceSql, sessionId, 'restore_test_complete');

    const counts = (await sourceSql`
      SELECT (SELECT count(*) FROM raw_ingest_events) AS raw,
             (SELECT count(*) FROM orderbook_deltas) AS deltas,
             (SELECT count(*) FROM orderbook_snapshots WHERE source = 'local_materialized') AS samples,
             (SELECT count(*) FROM sequence_gaps) AS gaps
    `) as unknown as { raw: string; deltas: string; samples: string; gaps: string }[];

    expect(Number(counts[0]!.raw)).toBeGreaterThan(150);
    expect(Number(counts[0]!.samples)).toBeGreaterThan(5);
    expect(Number(counts[0]!.gaps)).toBe(1);
  });

  it('seals, archives and verifies the partition', async () => {
    // The collector wrote into today's partition, which is not yet complete.
    // A clock set to tomorrow makes it complete without fabricating any data.
    const tomorrow = new Date(Date.now() + 26 * 3_600_000);
    const worker = new ArchiveWorker({
      sql: sourceSql, store, retentionHours: 48, retentionEnabled: false, clock: () => tomorrow,
    });

    const result = await worker.run();
    expect(result.failed).toEqual([]);

    const today = new Date();
    partitionName = `raw_ingest_events_${today.toISOString().slice(0, 10).replace(/-/g, '_')}`;
    expect(result.verified).toContain(partitionName);
  });

  it('reconstructs the exact book state from archived bytes alone', async () => {
    const result = await restoreAndVerify({ sourceSql, targetSql, store, partitionName });

    // Nothing from the live database is consulted except the manifests and the
    // snapshots being compared against.
    expect(result.checksumsVerified).toBe(result.parts);
    expect(result.rowsRestored).toBeGreaterThan(150);
    expect(result.framesReplayed).toBe(result.rowsRestored);

    expect(result.compared).toBeGreaterThan(5);
    expect(result.mismatches).toEqual([]);
    expect(result.unreachable).toEqual([]);
    expect(result.matched).toBe(result.compared);
  });

  it('rebuilt the normalized tables independently in the scratch database', async () => {
    // The restore did not copy normalized rows; it re-derived them by replaying
    // raw frames through the real collector.
    const restored = (await targetSql`
      SELECT (SELECT count(*) FROM orderbook_deltas) AS deltas,
             (SELECT count(*) FROM public_trades) AS trades,
             (SELECT count(*) FROM orderbook_snapshots) AS snapshots,
             (SELECT count(*) FROM sequence_gaps) AS gaps
    `) as unknown as { deltas: string; trades: string; snapshots: string; gaps: string }[];

    const original = (await sourceSql`
      SELECT (SELECT count(*) FROM orderbook_deltas) AS deltas,
             (SELECT count(*) FROM public_trades) AS trades
    `) as unknown as { deltas: string; trades: string }[];

    expect(restored[0]!.deltas).toBe(original[0]!.deltas);
    expect(restored[0]!.trades).toBe(original[0]!.trades);
    // The gap in the archive is reproduced, not smoothed over.
    expect(Number(restored[0]!.gaps)).toBe(1);
  });
});
