import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Collector } from '@/src/collector/collector';
import { parseCollectorConfig } from '@/src/config/collectorConfig';
import { BatchWriter } from '@/src/persistence/batchWriter';
import type { Sql } from '@/src/persistence/db';
import { startSession, endSession } from '@/src/persistence/repositories/sessions';
import { replay, verifyReplay } from '@/src/replay/replay';
import { BookSampler } from '@/src/sampling/bookSampler';
import { freshTestDb, testDbAvailable, truncateAll } from './fixtures/testDb';
import { FakeWebSocketClient, deltaFrame, snapshotFrame } from './fixtures/syntheticFeed';

/**
 * REPLAY EQUALITY -- the recorder's core invariant.
 *
 * Drives the real Collector, the real BatchWriter and a real database with a
 * synthetic feed, then reconstructs every book from the recorded delta stream
 * and compares SHA-256 state hashes against the snapshots the recorder wrote
 * independently.
 *
 * Every serious defect found in this project was caught by this property and by
 * nothing else: a reordered raw log, deltas applied in lexicographic sequence
 * order, and streams interleaved by random UUID after a reconnect. All three
 * left the application looking perfectly healthy.
 *
 * Treat this as mandatory for any change touching ingestion, persistence,
 * sequence handling or SQL ordering.
 */

const available = await testDbAvailable();
const describeDb = available ? describe : describe.skip;

const MARKETS = ['KXHIGHNY-26SEP14-B74.5', 'KXHIGHNY-26SEP14-B76.5', 'KXHIGHNY-26SEP14-T81'];

let sql: Sql;

beforeAll(async () => {
  if (!available) return;
  sql = await freshTestDb('replay');
});

beforeEach(async () => {
  if (!available) return;
  // Each case reuses the same market tickers, and verifyReplay scans by market
  // and time rather than by session, so state must not leak between tests.
  await truncateAll(sql);
});

afterAll(async () => {
  if (!available) return;
  await sql.end({ timeout: 5 });
});

interface Harness {
  collector: Collector;
  ws: FakeWebSocketClient;
  writer: BatchWriter;
  sessionId: string;
}

async function harness(): Promise<Harness> {
  const sessionId = randomUUID();
  await startSession(sql, {
    sessionId,
    mode: 'daemon',
    configHash: 'test',
    wsUrl: 'wss://test',
  });

  const ws = new FakeWebSocketClient();
  const writer = new BatchWriter({ sql, maxRows: 50, maxWaitMs: 20 });

  const collector = new Collector({
    sql,
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
      capture: { orderbookDeltas: true, trades: false, tickerUpdates: false, lifecycleEvents: false },
      sampling: { bboIntervalsMs: [], fullBookIntervalsMs: [], eventLadderIntervalsMs: [] },
    }),
    sessionId,
  });
  collector.start();

  await collector.subscribeAll(MARKETS);
  ws.ackSubscribe('orderbook_delta', ws.sent[0]!.id);

  return { collector, ws, writer, sessionId };
}

/** Materialises the current books, exactly as the periodic sampler would. */
function materialise(h: Harness, atMs: number): void {
  const sampler = new BookSampler({
    books: h.collector.books,
    marketState: h.collector.marketState,
    bboIntervalsMs: [],
    fullBookIntervalsMs: [1],
  });
  h.writer.enqueueDerived(sampler.sample(atMs, h.sessionId));
}

/** Deterministic pseudo-random walk, so a failure is reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describeDb('replay equality', () => {
  it('reproduces every materialised snapshot from the recorded delta stream', async () => {
    const h = await harness();
    const rng = makeRng(42);
    let seq = 1;

    // Seed each market with a two-sided book.
    for (const ticker of MARKETS) {
      h.ws.deliver(
        snapshotFrame({
          sid: 1,
          seq: seq++,
          ticker,
          yes: [['0.4000', '100.00'], ['0.3900', '250.00']],
          no: [['0.5800', '80.00'], ['0.5700', '300.00']],
        }),
      );
    }

    // A long interleaved walk across all three markets, materialising as we go.
    for (let step = 0; step < 900; step++) {
      const ticker = MARKETS[Math.floor(rng() * MARKETS.length)]!;
      const side = rng() < 0.5 ? 'yes' : 'no';
      const price = side === 'yes' ? (rng() < 0.5 ? '0.4000' : '0.3900') : (rng() < 0.5 ? '0.5800' : '0.5700');
      // Only ever add, or subtract less than is resting, so the book stays valid.
      const delta = rng() < 0.6 ? (1 + Math.floor(rng() * 20)).toFixed(2) : `-${(1 + Math.floor(rng() * 5)).toFixed(2)}`;

      h.ws.deliver(deltaFrame({ sid: 1, seq: seq++, ticker, side, price, delta }));

      if (step % 60 === 59) materialise(h, Date.now() + step);
    }

    await h.writer.close();
    await h.collector.flushDeferred();
    await endSession(sql, h.sessionId, 'test_complete');

    const bounds = (await sql`
      SELECT min(s.received_at_ms) AS from_ms, max(s.received_at_ms) AS to_ms
        FROM orderbook_snapshots s
    `) as unknown as { from_ms: string; to_ms: string }[];

    let checked = 0;
    let matched = 0;
    for (const ticker of MARKETS) {
      const v = await verifyReplay(
        sql, ticker, BigInt(bounds[0]!.from_ms) - 1n, BigInt(bounds[0]!.to_ms), 100,
      );
      checked += v.checked;
      matched += v.matched;
      expect(v.mismatches, `${ticker} must reconstruct exactly`).toEqual([]);
    }

    expect(checked).toBeGreaterThan(10);
    expect(matched).toBe(checked);
  });

  it('reproduces state across a sequence gap and recovery', async () => {
    const h = await harness();
    let seq = 1;

    for (const ticker of MARKETS) {
      h.ws.deliver(snapshotFrame({ sid: 1, seq: seq++, ticker, yes: [['0.5000', '100.00']] }));
    }
    for (let i = 0; i < 40; i++) {
      h.ws.deliver(deltaFrame({ sid: 1, seq: seq++, ticker: MARKETS[0]!, side: 'yes', price: '0.5000', delta: '1.00' }));
    }
    materialise(h, Date.now());

    // Open a real gap, then recover every affected market.
    seq += 25;
    h.ws.deliver(deltaFrame({ sid: 1, seq: seq++, ticker: MARKETS[0]!, side: 'yes', price: '0.5000', delta: '1.00' }));

    for (const ticker of MARKETS) {
      h.ws.deliver(snapshotFrame({ sid: 1, seq: seq++, ticker, yes: [['0.5000', '777.00']] }));
    }
    for (let i = 0; i < 30; i++) {
      h.ws.deliver(deltaFrame({ sid: 1, seq: seq++, ticker: MARKETS[0]!, side: 'yes', price: '0.5000', delta: '2.00' }));
    }
    materialise(h, Date.now() + 1000);

    await h.writer.close();
    await h.collector.flushDeferred();
    await endSession(sql, h.sessionId, 'test_complete');

    const gaps = (await sql`
      SELECT count(*) AS n FROM sequence_gaps g WHERE g.session_id = ${h.sessionId}
    `) as unknown as { n: string }[];
    // One episode for one discontinuity, however many frames followed.
    expect(Number(gaps[0]!.n)).toBe(1);

    const bounds = (await sql`
      SELECT min(s.received_at_ms) AS from_ms, max(s.received_at_ms) AS to_ms
        FROM orderbook_snapshots s WHERE s.session_id = ${h.sessionId}
    `) as unknown as { from_ms: string; to_ms: string }[];

    const v = await verifyReplay(
      sql, MARKETS[0]!, BigInt(bounds[0]!.from_ms) - 1n, BigInt(bounds[0]!.to_ms), 100,
    );
    expect(v.mismatches).toEqual([]);
    expect(v.matched).toBe(v.checked);
    expect(v.checked).toBeGreaterThan(0);
  });

  it('reproduces state across a reconnect, where seq restarts', async () => {
    // The case that ordering by stream_id got wrong: two streams in one
    // session with overlapping sequence ranges.
    const h = await harness();
    let seq = 1;

    h.ws.deliver(snapshotFrame({ sid: 1, seq: seq++, ticker: MARKETS[0]!, yes: [['0.5000', '100.00']] }));
    for (let i = 0; i < 50; i++) {
      h.ws.deliver(deltaFrame({ sid: 1, seq: seq++, ticker: MARKETS[0]!, side: 'yes', price: '0.5000', delta: '3.00' }));
    }
    materialise(h, Date.now());
    await h.writer.flush();

    // Reconnect: books invalidated, new stream, sequence restarts from 1.
    await h.ws.close();
    await new Promise((r) => setTimeout(r, 20));
    await h.collector.flushDeferred();

    h.ws.open = true;
    await h.collector.subscribeAll(MARKETS);
    const ack = h.ws.sent.filter((c) => c.cmd === 'subscribe').at(-1)!;
    h.ws.ackSubscribe('orderbook_delta', ack.id);

    let seq2 = 1;
    h.ws.deliver(snapshotFrame({ sid: 2, seq: seq2++, ticker: MARKETS[0]!, yes: [['0.5000', '500.00']] }));
    for (let i = 0; i < 50; i++) {
      h.ws.deliver(deltaFrame({ sid: 2, seq: seq2++, ticker: MARKETS[0]!, side: 'yes', price: '0.5000', delta: '7.00' }));
    }
    materialise(h, Date.now() + 2000);

    await h.writer.close();
    await h.collector.flushDeferred();
    await endSession(sql, h.sessionId, 'test_complete');

    const bounds = (await sql`
      SELECT min(s.received_at_ms) AS from_ms, max(s.received_at_ms) AS to_ms
        FROM orderbook_snapshots s WHERE s.session_id = ${h.sessionId}
    `) as unknown as { from_ms: string; to_ms: string }[];

    const v = await verifyReplay(
      sql, MARKETS[0]!, BigInt(bounds[0]!.from_ms) - 1n, BigInt(bounds[0]!.to_ms), 100,
    );
    expect(v.mismatches).toEqual([]);
    expect(v.matched).toBe(v.checked);

    // And replay reports the epoch boundary rather than pretending continuity.
    const r = await replay(sql, {
      marketTicker: MARKETS[0]!,
      fromMs: BigInt(bounds[0]!.from_ms) - 1n,
      toMs: BigInt(bounds[0]!.to_ms),
    });
    expect(r.epochs.length).toBeGreaterThan(1);
  });
});
