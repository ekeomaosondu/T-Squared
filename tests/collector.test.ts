import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Collector } from '@/src/collector/collector';
import { BookManager } from '@/src/book/bookManager';
import { parseCollectorConfig } from '@/src/config/collectorConfig';
import type { IngestUnit, NormalizedRow } from '@/src/persistence/types';
import {
  FakeWebSocketClient,
  deltaFrame,
  lifecycleFrame,
  snapshotFrame,
  tickerFrame,
  tradeFrame,
} from './fixtures/syntheticFeed';
import { fakeSql } from './fixtures/fakeSql';

const TICKER = 'KXHIGHNY-26SEP14-B74.5';
const OTHER = 'KXHIGHNY-26SEP14-B76.5';

/** Captures everything handed to the writer, in order. */
class RecordingWriter {
  readonly units: IngestUnit[] = [];
  readonly derived: NormalizedRow[] = [];
  enqueue(u: IngestUnit) { this.units.push(u); }
  enqueueDerived(rows: NormalizedRow[]) { this.derived.push(...rows); }
  rowsFor(table: string): NormalizedRow[] {
    return this.units.flatMap((u) => u.normalized).concat(this.derived).filter((r) => r.table === table);
  }
  get rawSeqs(): (string | null)[] {
    return this.units.map((u) => (u.raw?.seq === null || u.raw?.seq === undefined ? null : u.raw.seq.toString()));
  }
}

function makeCollector(overrides: { capture?: Record<string, boolean>; tracked?: string[] } = {}) {
  const ws = new FakeWebSocketClient();
  const writer = new RecordingWriter();
  const books = new BookManager();
  const tracked = new Set(overrides.tracked ?? [TICKER, OTHER]);

  const universe = {
    isTracked: (t: string) => tracked.has(t),
    queueMetadataRefresh: vi.fn(),
    queueEventRefresh: vi.fn(),
    trackedTickers: [...tracked],
  };

  const config = parseCollectorConfig({
    selectors: [{ id: 'test', seriesAllowlist: ['KXHIGHNY'] }],
    capture: { orderbookDeltas: true, trades: true, tickerUpdates: true, lifecycleEvents: true, ...overrides.capture },
    sampling: { bboIntervalsMs: [1000], fullBookIntervalsMs: [5000], eventLadderIntervalsMs: [1000] },
  });

  const collector = new Collector({
    sql: fakeSql(),
    ws: ws as never,
    rest: {} as never,
    universe: universe as never,
    writer: writer as never,
    books,
    config,
    sessionId: '11111111-1111-1111-1111-111111111111',
  });
  collector.start();
  return { collector, ws, writer, books, universe };
}

/** Subscribes and acks the orderbook_delta channel, returning its sid. */
async function connect(c: ReturnType<typeof makeCollector>): Promise<number> {
  await c.collector.subscribeAll([TICKER, OTHER]);
  const sid = c.ws.ackSubscribe('orderbook_delta', c.ws.sent[0]!.id);
  c.ws.ackSubscribe('trade', c.ws.sent[1]!.id);
  c.ws.ackSubscribe('ticker', c.ws.sent[2]!.id);
  c.ws.ackSubscribe('market_lifecycle_v2', c.ws.sent[3]!.id);
  return sid;
}

describe('Collector raw capture', () => {
  let c: ReturnType<typeof makeCollector>;
  beforeEach(() => { c = makeCollector(); });

  it('captures a raw event for every data frame, before normalising', async () => {
    const sid = await connect(c);
    c.ws.deliver(snapshotFrame({ sid, seq: 1, ticker: TICKER, yes: [['0.4200', '150.00']] }));
    c.ws.deliver(deltaFrame({ sid, seq: 2, ticker: TICKER, side: 'yes', price: '0.4200', delta: '50.00' }));

    expect(c.writer.units).toHaveLength(2);
    expect(c.writer.units.every((u) => u.raw && u.raw.payloadHash.length === 32)).toBe(true);
    // The payload is the verbatim envelope.
    expect((c.writer.units[0]!.raw.payload as { type: string }).type).toBe('orderbook_snapshot');
  });

  it('preserves arrival order in the raw log', async () => {
    const sid = await connect(c);
    c.ws.deliver(snapshotFrame({ sid, seq: 1, ticker: TICKER, yes: [['0.4200', '150.00']] }));
    for (let s = 2; s <= 30; s++) {
      c.ws.deliver(deltaFrame({ sid, seq: s, ticker: TICKER, side: 'yes', price: '0.4200', delta: '1.00' }));
    }
    // Ordering must be exact: replay walks rows in insertion order.
    expect(c.writer.rawSeqs).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));
  });

  it('still captures a frame whose payload cannot be parsed', () => {
    c.ws.deliverRaw('{not json');
    expect(c.writer.units).toHaveLength(1);
    expect(c.writer.units[0]!.raw.messageType).toBe('unparseable');
    expect(c.writer.rowsFor('integrity_events')).toHaveLength(1);
  });

  it('captures a raw event even when normalisation fails', async () => {
    const sid = await connect(c);
    // A delta missing required fields: the raw frame must survive regardless.
    c.ws.deliver({ type: 'orderbook_delta', sid, seq: 1, msg: { market_ticker: TICKER } });

    expect(c.writer.units).toHaveLength(1);
    expect(c.writer.units[0]!.raw.messageType).toBe('orderbook_delta');
    expect(c.writer.rowsFor('integrity_events')[0]!.values.type).toBe('unexpected_schema');
  });
});

describe('Collector book reconstruction', () => {
  let c: ReturnType<typeof makeCollector>;
  beforeEach(() => { c = makeCollector(); });

  it('builds a valid book from the initial snapshot and applies deltas', async () => {
    const sid = await connect(c);
    c.ws.deliver(snapshotFrame({ sid, seq: 1, ticker: TICKER, yes: [['0.4200', '150.00']], no: [['0.5700', '100.00']] }));
    c.ws.deliver(deltaFrame({ sid, seq: 2, ticker: TICKER, side: 'yes', price: '0.4200', delta: '50.00' }));

    const book = c.books.get(TICKER)!;
    expect(book.valid).toBe(true);
    expect(book.yesBids.get('0.420000')!.toString()).toBe('200');
    expect(book.getYesBBO().ask!.toFixed(4)).toBe('0.4300');

    const deltas = c.writer.rowsFor('orderbook_deltas');
    expect(deltas[0]!.values).toMatchObject({ applied: true, level_action: 'increase' });
    expect(deltas[0]!.values.post_count).toBe('200.000000');
  });

  it('records a delta as unapplied and invalidates the book on a negative post-count', async () => {
    const sid = await connect(c);
    c.ws.deliver(snapshotFrame({ sid, seq: 1, ticker: TICKER, yes: [['0.4200', '10.00']] }));
    c.ws.deliver(deltaFrame({ sid, seq: 2, ticker: TICKER, side: 'yes', price: '0.4200', delta: '-99.00' }));

    const delta = c.writer.rowsFor('orderbook_deltas').at(-1)!;
    expect(delta.values.applied).toBe(false);
    expect(String(delta.values.apply_error)).toMatch(/negative level quantity/);

    expect(c.books.get(TICKER)!.valid).toBe(false);
    // Level left untouched, never clamped.
    expect(c.books.get(TICKER)!.yesBids.get('0.420000')!.toString()).toBe('10');

    expect(c.writer.rowsFor('integrity_events').some((r) => r.values.type === 'negative_level_quantity')).toBe(true);
    // And a fresh snapshot is requested.
    expect(c.ws.commandsOfType('get_snapshot')).toHaveLength(1);
  });

  it('does not apply deltas to a market whose book has no snapshot yet', async () => {
    const sid = await connect(c);
    c.ws.deliver(deltaFrame({ sid, seq: 1, ticker: TICKER, side: 'yes', price: '0.4200', delta: '50.00' }));

    const delta = c.writer.rowsFor('orderbook_deltas')[0]!;
    expect(delta.values.applied).toBe(false);
    expect(c.books.get(TICKER)!.valid).toBe(false);
  });
});

describe('Collector sequence gap and recovery', () => {
  let c: ReturnType<typeof makeCollector>;
  beforeEach(() => { c = makeCollector(); });

  it('opens exactly one gap episode and requests recovery once', async () => {
    const sid = await connect(c);
    c.ws.deliver(snapshotFrame({ sid, seq: 1, ticker: TICKER, yes: [['0.4200', '150.00']] }));
    c.ws.deliver(snapshotFrame({ sid, seq: 2, ticker: OTHER, yes: [['0.3000', '10.00']] }));

    // Jump the sequence, then keep sending: one discontinuity, many messages.
    c.ws.deliver(deltaFrame({ sid, seq: 50, ticker: TICKER, side: 'yes', price: '0.4200', delta: '1.00' }));
    for (let s = 51; s <= 70; s++) {
      c.ws.deliver(deltaFrame({ sid, seq: s, ticker: TICKER, side: 'yes', price: '0.4200', delta: '1.00' }));
    }

    const gapEvents = c.writer.rowsFor('integrity_events').filter((r) => r.values.type === 'sequence_gap');
    expect(gapEvents).toHaveLength(1);
    // One recovery request, not one per subsequent frame.
    expect(c.ws.commandsOfType('get_snapshot')).toHaveLength(1);

    // Every book on the subscription is invalidated, and deltas stop applying.
    expect(c.books.get(TICKER)!.valid).toBe(false);
    expect(c.books.get(OTHER)!.valid).toBe(false);
    const applied = c.writer.rowsFor('orderbook_deltas').filter((r) => r.values.applied);
    expect(applied).toHaveLength(0);

    // But every message is still captured raw.
    expect(c.writer.units).toHaveLength(23);
  });

  it('returns to healthy only after every affected market is re-snapshotted', async () => {
    const sid = await connect(c);
    c.ws.deliver(snapshotFrame({ sid, seq: 1, ticker: TICKER, yes: [['0.4200', '150.00']] }));
    c.ws.deliver(snapshotFrame({ sid, seq: 2, ticker: OTHER, yes: [['0.3000', '10.00']] }));
    c.ws.deliver(deltaFrame({ sid, seq: 50, ticker: TICKER, side: 'yes', price: '0.4200', delta: '1.00' }));

    // Only the first market recovers: the stream must stay degraded.
    c.ws.deliver(snapshotFrame({ sid, seq: 51, ticker: TICKER, yes: [['0.4200', '999.00']] }));
    c.ws.deliver(deltaFrame({ sid, seq: 52, ticker: TICKER, side: 'yes', price: '0.4200', delta: '1.00' }));
    expect(c.writer.rowsFor('orderbook_deltas').at(-1)!.values.applied).toBe(false);

    // Now the second recovers, closing the episode.
    c.ws.deliver(snapshotFrame({ sid, seq: 53, ticker: OTHER, yes: [['0.3000', '77.00']] }));
    c.ws.deliver(deltaFrame({ sid, seq: 54, ticker: TICKER, side: 'yes', price: '0.4200', delta: '1.00' }));

    expect(c.writer.rowsFor('orderbook_deltas').at(-1)!.values.applied).toBe(true);
    expect(c.books.get(TICKER)!.yesBids.get('0.420000')!.toString()).toBe('1000');

    const recoveries = c.writer.rowsFor('orderbook_snapshots').filter((r) => r.values.source === 'ws_recovery');
    expect(recoveries).toHaveLength(2);
  });

  it('never reports gaps on the unsequenced ticker channel', async () => {
    const sid = await connect(c);
    c.ws.deliver(tickerFrame({ sid: sid + 2, ticker: TICKER }));
    c.ws.deliver(tickerFrame({ sid: sid + 2, ticker: TICKER }));
    expect(c.writer.rowsFor('integrity_events').filter((r) => r.values.type === 'sequence_gap')).toHaveLength(0);
    expect(c.writer.rowsFor('ticker_updates')).toHaveLength(2);
  });
});

describe('Collector trades', () => {
  let c: ReturnType<typeof makeCollector>;
  beforeEach(() => { c = makeCollector(); });

  it('preserves all three exchange aggressor fields verbatim', async () => {
    const sid = await connect(c);
    c.ws.deliver(tradeFrame({
      sid, seq: 1, ticker: TICKER, tradeId: 'trade-1', yesPrice: '0.4200', count: '41.39',
      takerOutcomeSide: 'no', takerBookSide: 'ask',
    }));

    const row = c.writer.rowsFor('public_trades')[0]!;
    expect(row.values).toMatchObject({
      trade_id: 'trade-1',
      taker_side: 'no',
      taker_outcome_side: 'no',
      taker_book_side: 'ask',
    });
  });

  it('keeps fractional trade quantities exactly', async () => {
    const sid = await connect(c);
    c.ws.deliver(tradeFrame({ sid, seq: 1, ticker: TICKER, tradeId: 't', yesPrice: '0.0200', count: '41.39' }));
    // Quantities are fixed-point, not integers.
    expect(c.writer.rowsFor('public_trades')[0]!.values.count).toBe('41.39');
  });

  it('records both exchange and receipt timestamps', async () => {
    const sid = await connect(c);
    const tsMs = 1_789_323_649_574;
    c.ws.deliver(tradeFrame({ sid, seq: 1, ticker: TICKER, tradeId: 't', yesPrice: '0.5', count: '1', tsMs }));

    const row = c.writer.rowsFor('public_trades')[0]!;
    expect(row.values.exchange_ts_ms).toBe(String(tsMs));
    expect(Number(row.values.received_at_ms)).toBeGreaterThan(0);
    expect(row.values.exchange_ts).toEqual(new Date(tsMs));
  });
});

describe('Collector lifecycle scoping', () => {
  it('queues a metadata refresh for a tracked market', async () => {
    const c = makeCollector();
    const sid = await connect(c);
    c.ws.deliver(lifecycleFrame({ sid: sid + 3, seq: 1, ticker: TICKER, eventType: 'close_date_updated' }));

    expect(c.universe.queueMetadataRefresh).toHaveBeenCalledWith(TICKER);
    expect(c.writer.rowsFor('market_lifecycle_events')).toHaveLength(1);
  });

  it('keeps the raw frame but skips normalising lifecycle for untracked markets', async () => {
    // market_lifecycle_v2 is a global channel; most events are other sports.
    const c = makeCollector();
    const sid = await connect(c);
    c.ws.deliver(lifecycleFrame({ sid: sid + 3, seq: 1, ticker: 'KXMLBGAME-26SEP13-ABC', eventType: 'settled' }));

    expect(c.writer.units).toHaveLength(1);
    expect(c.writer.rowsFor('market_lifecycle_events')).toHaveLength(0);
    expect(c.universe.queueMetadataRefresh).not.toHaveBeenCalled();
  });
});

describe('Collector disconnect handling', () => {
  it('invalidates every book on disconnect and never reapplies old state', async () => {
    const c = makeCollector();
    const sid = await connect(c);
    c.ws.deliver(snapshotFrame({ sid, seq: 1, ticker: TICKER, yes: [['0.4200', '150.00']] }));
    expect(c.books.get(TICKER)!.valid).toBe(true);

    await c.ws.close();
    await new Promise((r) => setTimeout(r, 10));

    expect(c.books.get(TICKER)!.valid).toBe(false);
    expect(c.books.get(TICKER)!.invalidReason).toMatch(/disconnected/);
    expect(c.collector.subscriptions.size).toBe(0);
  });

  it('refuses to subscribe twice on one connection', async () => {
    const c = makeCollector();
    await connect(c);
    const before = c.ws.sent.length;
    await c.collector.subscribeAll([TICKER, OTHER]);
    expect(c.ws.sent.length).toBe(before);
  });
});
