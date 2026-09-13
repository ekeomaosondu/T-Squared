import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/bookReplay.json';
import { MarketBook } from '@/src/book/book';
import { Decimal, canonicalPrice, yesAskFromNoBid } from '@/src/book/decimal';
import { OrderbookDeltaMsg, OrderbookSnapshotMsg } from '@/src/kalshi/schemas';

/** Builds a book from a Kalshi orderbook_snapshot frame. */
function bookFromSnapshot(frame: { sid: number; seq: number; msg: unknown }): MarketBook {
  const msg = OrderbookSnapshotMsg.parse(frame.msg);
  const book = new MarketBook(msg.market_ticker);
  book.replaceWithSnapshot(
    { yesBids: msg.yes_dollars_fp ?? [], noBids: msg.no_dollars_fp ?? [] },
    { seq: BigInt(frame.seq) },
  );
  return book;
}

describe('MarketBook snapshot loading', () => {
  it('loads YES and NO sides from a snapshot', () => {
    const book = bookFromSnapshot(fixtures.scenarios[0]!.initialSnapshot);
    expect(book.valid).toBe(true);
    expect(book.levelCount).toEqual({ yes: 2, no: 2 });
    expect(book.lastSeq).toBe(100n);
  });

  it('treats an omitted side as empty rather than failing', () => {
    // Kalshi omits the key entirely when a side is empty.
    const book = bookFromSnapshot(fixtures.scenarios[2]!.initialSnapshot);
    expect(book.levelCount.yes).toBe(0);
    expect(book.levelCount.no).toBe(2);
    expect(book.getYesBBO().bid).toBeNull();
  });

  it('starts invalid before any snapshot is applied', () => {
    const book = new MarketBook('KXHIGHNY-26SEP14-B74.5');
    expect(book.valid).toBe(false);
  });
});

describe('MarketBook delta mechanics', () => {
  const fresh = () => bookFromSnapshot(fixtures.scenarios[0]!.initialSnapshot);

  it('inserts a new price level', () => {
    const r = fresh().applyDelta({ side: 'yes', price: '0.4300', delta: '75.00' });
    expect(r).toMatchObject({ applied: true, levelAction: 'insert' });
    expect(r.postCount!.toString()).toBe('75');
  });

  it('increases an existing level', () => {
    const r = fresh().applyDelta({ side: 'yes', price: '0.4200', delta: '50.00' });
    expect(r.levelAction).toBe('increase');
    expect(r.preCount.toString()).toBe('150');
    expect(r.postCount!.toString()).toBe('200');
  });

  it('decreases an existing level', () => {
    const r = fresh().applyDelta({ side: 'yes', price: '0.4100', delta: '-100.00' });
    expect(r.levelAction).toBe('decrease');
    expect(r.postCount!.toString()).toBe('200');
  });

  it('deletes a level when the post-count reaches exactly zero', () => {
    const book = fresh();
    const r = book.applyDelta({ side: 'no', price: '0.5700', delta: '-100.00' });
    expect(r.levelAction).toBe('delete');
    expect(book.noBids.has(canonicalPrice('0.5700'))).toBe(false);
  });

  it('applies deltas to the NO side independently of the YES side', () => {
    const book = fresh();
    book.applyDelta({ side: 'no', price: '0.5600', delta: '25.00' });
    expect(book.noBids.get(canonicalPrice('0.56'))!.toString()).toBe('275');
    expect(book.yesBids.get(canonicalPrice('0.42'))!.toString()).toBe('150');
  });

  it('preserves fractional quantities exactly', () => {
    // Kalshi quantities are fixed-point, not integers. Truncating here would
    // silently lose real resting size.
    const book = fresh();
    const r = book.applyDelta({ side: 'yes', price: '0.4200', delta: '-0.37' });
    expect(r.postCount!.toFixed(2)).toBe('149.63');
  });

  it('rejects a delta that would drive a level negative, without clamping', () => {
    const book = fresh();
    const r = book.applyDelta({ side: 'yes', price: '0.4200', delta: '-200.00' });

    expect(r.applied).toBe(false);
    expect(r.postCount!.isNegative()).toBe(true);
    expect(r.error).toMatch(/negative level quantity/);

    // The book is marked untrustworthy and the level is left untouched --
    // never silently clamped to zero.
    expect(book.valid).toBe(false);
    expect(book.invalidReason).toMatch(/negative level quantity/);
    expect(book.yesBids.get(canonicalPrice('0.42'))!.toString()).toBe('150');
  });

  it('does not use floating point for price keys', () => {
    const book = new MarketBook('T');
    book.replaceWithSnapshot({ yesBids: [], noBids: [] });
    book.applyDelta({ side: 'yes', price: 0.1, delta: '1' });
    book.applyDelta({ side: 'yes', price: 0.2, delta: '1' });
    // Keys are canonical fixed-point strings, so 0.1 + 0.2 can never produce
    // a phantom level.
    expect([...book.yesBids.keys()].sort()).toEqual(['0.100000', '0.200000']);
    expect(book.yesBids.has('0.300000000000000004')).toBe(false);
    // And the derived ladder is price-ordered regardless of insertion order.
    expect(book.yesBidLevels().map(([p]) => p)).toEqual(['0.200000', '0.100000']);
  });
});

describe('YES-side ask conversion', () => {
  it('derives the YES ask from the best NO bid as 1 - q', () => {
    const book = bookFromSnapshot(fixtures.scenarios[0]!.initialSnapshot);
    const bbo = book.getYesBBO();

    // best NO bid 0.57 -> best YES ask 0.43
    expect(bbo.ask!.toFixed(4)).toBe('0.4300');
    expect(bbo.bid!.toFixed(4)).toBe('0.4200');
    // Ask size is the size resting on that NO level.
    expect(bbo.askSize!.toFixed(2)).toBe('100.00');
    expect(bbo.spread!.toFixed(4)).toBe('0.0100');
    expect(bbo.mid!.toFixed(5)).toBe('0.42500');
  });

  it('orders the derived ask ladder from best (lowest) ask upward', () => {
    const book = bookFromSnapshot(fixtures.scenarios[0]!.initialSnapshot);
    expect(book.yesAskLevels().map(([p]) => p)).toEqual(['0.430000', '0.440000']);
  });

  it('keeps the raw YES/NO representation intact alongside the derived view', () => {
    const book = bookFromSnapshot(fixtures.scenarios[0]!.initialSnapshot);
    book.getYesBBO();
    expect(book.serializeCanonical().no_bids).toEqual([
      ['0.570000', '100.000000'],
      ['0.560000', '250.000000'],
    ]);
  });

  it('yesAskFromNoBid is exact at cent granularity', () => {
    expect(yesAskFromNoBid('0.5700').toFixed(4)).toBe('0.4300');
    expect(yesAskFromNoBid('0.0100').toFixed(4)).toBe('0.9900');
  });

  it('returns null BBO fields for a one-sided book instead of imputing', () => {
    const book = bookFromSnapshot(fixtures.scenarios[2]!.initialSnapshot);
    const bbo = book.getYesBBO();
    expect(bbo.bid).toBeNull();
    expect(bbo.spread).toBeNull();
    expect(bbo.mid).toBeNull();
  });
});

describe('depth, imbalance and microprice', () => {
  const book = bookFromSnapshot(fixtures.scenarios[0]!.initialSnapshot);

  it('sums depth across the top k levels on each side', () => {
    expect(book.getDepth(1).bid.toString()).toBe('150');
    expect(book.getDepth(1).ask.toString()).toBe('100');
    expect(book.getDepth(3).bid.toString()).toBe('450'); // 150 + 300
    expect(book.getDepth(3).ask.toString()).toBe('350'); // 100 + 250
  });

  it('computes imbalance as (bid - ask) / (bid + ask)', () => {
    expect(book.getImbalance(1)!.toFixed(8)).toBe('0.20000000');
    expect(book.getImbalance(3)!.toFixed(8)).toBe('0.12500000');
  });

  it('returns null imbalance when the denominator is zero', () => {
    const empty = new MarketBook('T');
    empty.replaceWithSnapshot({ yesBids: [], noBids: [] });
    expect(empty.getImbalance(1)).toBeNull();
  });

  it('weights microprice toward the thinner side', () => {
    // (ask*bid_size + bid*ask_size) / (bid_size + ask_size)
    // (0.43*150 + 0.42*100) / 250 = 0.426
    expect(book.getMicroprice()!.toFixed(6)).toBe('0.426000');
  });
});

describe('state hashing', () => {
  it('is stable across insertion order', () => {
    const a = new MarketBook('T');
    a.replaceWithSnapshot({ yesBids: [['0.41', '300'], ['0.42', '150']], noBids: [] });
    const b = new MarketBook('T');
    b.replaceWithSnapshot({ yesBids: [['0.42', '150'], ['0.41', '300']], noBids: [] });
    expect(a.getStateHash()).toBe(b.getStateHash());
  });

  it('normalises equivalent decimal representations', () => {
    const a = new MarketBook('T');
    a.replaceWithSnapshot({ yesBids: [['0.4200', '150.00']], noBids: [] });
    const b = new MarketBook('T');
    b.replaceWithSnapshot({ yesBids: [[new Decimal('0.42'), new Decimal(150)]], noBids: [] });
    expect(a.getStateHash()).toBe(b.getStateHash());
  });

  it('distinguishes the YES and NO sides', () => {
    const a = new MarketBook('T');
    a.replaceWithSnapshot({ yesBids: [['0.42', '150']], noBids: [] });
    const b = new MarketBook('T');
    b.replaceWithSnapshot({ yesBids: [], noBids: [['0.42', '150']] });
    expect(a.getStateHash()).not.toBe(b.getStateHash());
  });

  it('includes the market ticker, so identical ladders on different markets differ', () => {
    const a = new MarketBook('KXHIGHNY-26SEP14-B74.5');
    a.replaceWithSnapshot({ yesBids: [['0.42', '150']], noBids: [] });
    const b = new MarketBook('KXLOWNY-26SEP14-B74.5');
    b.replaceWithSnapshot({ yesBids: [['0.42', '150']], noBids: [] });
    expect(a.getStateHash()).not.toBe(b.getStateHash());
  });

  it('changes when the book changes and reverts when the change is undone', () => {
    const book = bookFromSnapshot(fixtures.scenarios[0]!.initialSnapshot);
    const before = book.getStateHash();
    book.applyDelta({ side: 'yes', price: '0.4200', delta: '50' });
    expect(book.getStateHash()).not.toBe(before);
    book.applyDelta({ side: 'yes', price: '0.4200', delta: '-50' });
    expect(book.getStateHash()).toBe(before);
  });

  it('treats a removed level and a never-present level as the same state', () => {
    const a = new MarketBook('T');
    a.replaceWithSnapshot({ yesBids: [['0.42', '150'], ['0.41', '100']], noBids: [] });
    a.applyDelta({ side: 'yes', price: '0.41', delta: '-100' });

    const b = new MarketBook('T');
    b.replaceWithSnapshot({ yesBids: [['0.42', '150']], noBids: [] });

    expect(a.getStateHash()).toBe(b.getStateHash());
  });
});

// ---------------------------------------------------------------------------
// The central invariant: S0 + D1..Dn must equal a later exchange snapshot.
// If this fails, the recorder cannot reconstruct history and is not complete.
// ---------------------------------------------------------------------------
describe('exact book-replay invariant (S0 + deltas = Sn)', () => {
  for (const scenario of fixtures.scenarios) {
    it(`reproduces the exchange snapshot exactly: ${scenario.name}`, () => {
      const book = bookFromSnapshot(scenario.initialSnapshot);

      for (const raw of scenario.deltas) {
        const delta = OrderbookDeltaMsg.parse({
          market_ticker: scenario.marketTicker,
          price_dollars: raw.price_dollars,
          delta_fp: raw.delta_fp,
          side: raw.side,
        });

        const result = book.applyDelta({
          side: delta.side,
          price: delta.price_dollars,
          delta: delta.delta_fp,
          seq: BigInt(raw.seq),
        });

        expect(result.applied, `${raw.label} (seq ${raw.seq}) must apply`).toBe(true);
        // post = pre + delta, always.
        expect(result.postCount!.toString()).toBe(result.preCount.plus(delta.delta_fp).toString());
      }

      const expected = bookFromSnapshot(scenario.expectedFinalSnapshot);

      expect(book.getStateHash()).toBe(expected.getStateHash());
      expect(book.serializeCanonical()).toEqual(expected.serializeCanonical());
      expect(book.lastSeq).toBe(expected.lastSeq);
    });
  }

  it('reaches an identical hash whether replayed incrementally or loaded whole', () => {
    const scenario = fixtures.scenarios[0]!;
    const incremental = bookFromSnapshot(scenario.initialSnapshot);
    for (const d of scenario.deltas) {
      incremental.applyDelta({ side: d.side as 'yes' | 'no', price: d.price_dollars, delta: d.delta_fp });
    }

    // Round-trip through the canonical JSON that gets stored in Postgres.
    const roundTripped = MarketBook.fromCanonical(
      scenario.marketTicker,
      incremental.serializeCanonical(),
    );
    expect(roundTripped.getStateHash()).toBe(incremental.getStateHash());
  });
});
