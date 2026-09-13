import { beforeEach, describe, expect, it } from 'vitest';
import { BookManager } from '@/src/book/bookManager';
import { BookValidator } from '@/src/integrity/validator';

/**
 * A REST snapshot is created at an unobservable instant between our request and
 * our receipt of the response. Comparing it only against the book "now" reports
 * a mismatch on any actively traded market -- and acting on that would let the
 * validator destabilise a perfectly healthy recorder.
 */

const T = 'KXHIGHNY-26SEP14-B74.5';
const SESSION = '11111111-1111-1111-1111-111111111111';

type RestBook = { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };

function makeValidator(restBooks: () => Map<string, RestBook>, clock: () => number) {
  const books = new BookManager();
  const rest = { getOrderbooks: async () => restBooks() };
  const validator = new BookValidator({
    rest: rest as never,
    books,
    toleranceMs: 2_000,
    mismatchEscalationThreshold: 2,
    clock,
  });
  return { books, validator };
}

/** Seeds a book and applies deltas at explicit timestamps. */
function seed(books: BookManager, atMs: number) {
  const book = books.getOrCreate(T);
  book.replaceWithSnapshot(
    { yesBids: [['0.4200', '150.00']], noBids: [['0.5700', '100.00']] },
    { atMs },
  );
  return book;
}

describe('REST validation outcomes', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => { now = 1_000_000; });

  it('reports match_current when REST agrees with the book as it stands', async () => {
    const { books, validator } = makeValidator(
      () => new Map([[T, { yes_dollars: [['0.4200', '150.00']], no_dollars: [['0.5700', '100.00']] }]]),
      clock,
    );
    seed(books, now);

    const out = await validator.validate([T], SESSION);
    expect(out.results[0]!.kind).toBe('match_current');
    expect(out.matchedCurrent).toBe(1);
    expect(out.recoveryNeeded).toEqual([]);
    expect(out.rows[0]!.values.matched).toBe(true);
  });

  it('reports match_recent when REST matches a state held during the request', async () => {
    // REST captured the book BEFORE two further deltas landed locally.
    const { books, validator } = makeValidator(
      () => new Map([[T, { yes_dollars: [['0.4200', '150.00']], no_dollars: [['0.5700', '100.00']] }]]),
      clock,
    );
    const book = seed(books, now);

    // Two deltas arrive while the REST request is in flight.
    book.applyDelta({ side: 'yes', price: '0.4200', delta: '25.00', seq: 2n, atMs: now + 10 });
    book.applyDelta({ side: 'no', price: '0.5700', delta: '-5.00', seq: 3n, atMs: now + 30 });
    now += 60; // response arrives

    const out = await validator.validate([T], SESSION);
    const r = out.results[0]!;

    expect(r.kind).toBe('match_recent');
    expect(r.statesConsidered).toBeGreaterThan(1);
    // Still counts as agreement: the book genuinely held that state.
    expect(out.rows[0]!.values.matched).toBe(true);
    expect(out.rows[0]!.values.match_kind).toBe('match_recent');
    expect(out.recoveryNeeded).toEqual([]);
  });

  it('does not trigger recovery on a first unexplained mismatch', async () => {
    const { books, validator } = makeValidator(
      () => new Map([[T, { yes_dollars: [['0.9900', '1.00']] }]]),
      clock,
    );
    seed(books, now);

    const out = await validator.validate([T], SESSION);
    expect(out.results[0]!.kind).toBe('mismatch_transient');
    expect(out.recoveryNeeded).toEqual([]);
    expect(out.escalate).toBe(false);
    // And it is queued for an independent re-check.
    expect(validator.awaitingRecheck).toEqual([T]);
    expect(out.rows[0]!.values.matched).toBe(false);
  });

  it('confirms a mismatch only on an independent re-check', async () => {
    const { books, validator } = makeValidator(
      () => new Map([[T, { yes_dollars: [['0.9900', '1.00']] }]]),
      clock,
    );
    seed(books, now);

    await validator.validate([T], SESSION);
    now += 1_500;
    const second = await validator.validate([T], SESSION);

    expect(second.results[0]!.kind).toBe('mismatch_confirmed');
    expect(second.recoveryNeeded).toEqual([T]);
    expect(second.rows.some((r) => r.table === 'integrity_events')).toBe(true);
    // A confirmed mismatch records the level-by-level difference.
    expect(second.rows[0]!.values.difference).toBeTruthy();
  });

  it('clears the pending re-check when the book agrees again', async () => {
    let restState: RestBook = { yes_dollars: [['0.9900', '1.00']] };
    const { books, validator } = makeValidator(() => new Map([[T, restState]]), clock);
    seed(books, now);

    await validator.validate([T], SESSION);
    expect(validator.awaitingRecheck).toEqual([T]);

    restState = { yes_dollars: [['0.4200', '150.00']], no_dollars: [['0.5700', '100.00']] };
    const second = await validator.validate([T], SESSION);

    expect(second.results[0]!.kind).toBe('match_current');
    expect(validator.awaitingRecheck).toEqual([]);
  });

  it('escalates only after repeated confirmed mismatches', async () => {
    const { books, validator } = makeValidator(
      () => new Map([[T, { yes_dollars: [['0.9900', '1.00']] }]]),
      clock,
    );
    seed(books, now);

    await validator.validate([T], SESSION);        // transient
    const c1 = await validator.validate([T], SESSION); // confirmed #1
    expect(c1.escalate).toBe(false);

    await validator.validate([T], SESSION);        // transient again
    const c2 = await validator.validate([T], SESSION); // confirmed #2
    expect(c2.escalate).toBe(true);
  });

  it('skips books already known to be invalid', async () => {
    const { books, validator } = makeValidator(() => new Map(), clock);
    const book = seed(books, now);
    book.invalidate('sequence gap');

    const out = await validator.validate([T], SESSION);
    expect(out.checked).toBe(0);
  });
});

describe('book state rewinding', () => {
  it('reconstructs the states the book passed through', () => {
    const books = new BookManager();
    const book = books.getOrCreate(T);
    book.replaceWithSnapshot({ yesBids: [['0.4200', '100.00']], noBids: [] }, { atMs: 1000 });
    const h0 = book.getStateHash();

    book.applyDelta({ side: 'yes', price: '0.4200', delta: '10.00', seq: 2n, atMs: 1010 });
    const h1 = book.getStateHash();
    book.applyDelta({ side: 'yes', price: '0.4300', delta: '5.00', seq: 3n, atMs: 1020 });
    const h2 = book.getStateHash();

    const states = book.historicalStates(900);
    expect(states[0]!.hash).toBe(h2);
    expect(states.map((s) => s.hash)).toContain(h1);
    expect(states.map((s) => s.hash)).toContain(h0);

    // Rewinding must not mutate the live book.
    expect(book.getStateHash()).toBe(h2);
    expect(book.yesBids.get('0.430000')!.toString()).toBe('5');
  });

  it('does not rewind past a snapshot, which is a hard reset', () => {
    const books = new BookManager();
    const book = books.getOrCreate(T);
    book.replaceWithSnapshot({ yesBids: [['0.4200', '100.00']], noBids: [] }, { atMs: 1000 });
    book.applyDelta({ side: 'yes', price: '0.4200', delta: '10.00', seq: 2n, atMs: 1010 });

    // A replacement snapshot clears the journal: earlier deltas no longer
    // describe how this state was reached.
    book.replaceWithSnapshot({ yesBids: [['0.5000', '7.00']], noBids: [] }, { atMs: 1020 });

    expect(book.journalSize).toBe(0);
    expect(book.historicalStates(0)).toHaveLength(1);
  });

  it('bounds the journal by time', () => {
    const books = new BookManager();
    const book = books.getOrCreate(T);
    book.replaceWithSnapshot({ yesBids: [], noBids: [] }, { atMs: 0 });

    for (let i = 1; i <= 50; i++) {
      book.applyDelta({ side: 'yes', price: '0.5000', delta: '1.00', seq: BigInt(i), atMs: i * 1000 });
    }
    // Default window is 10s, so only the last handful survive.
    expect(book.journalSize).toBeLessThanOrEqual(11);
  });
});
