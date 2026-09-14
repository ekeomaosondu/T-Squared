import type {
  BookDeltaEvent,
  BookSnapshotEvent,
  CaptureGapEvent,
  Level,
  TradeEvent,
} from '@/src/research/events/researchEvent';

/**
 * Event builders for engine tests.
 *
 * Kept explicit rather than generated: a test that asserts "no fill happened
 * during the gap" is only meaningful if the reader can see the exact frames it
 * was fed, in order.
 */

export const SESSION = '11111111-1111-4111-8111-111111111111';
export const STREAM = '22222222-2222-4222-8222-222222222222';
export const STREAM_2 = '33333333-3333-4333-8333-333333333333';
export const MARKET = 'KXHIGHNY-26SEP13-B78.5';

let ordinal = 0n;
export function resetOrdinals(): void {
  ordinal = 0n;
}

export function snapshot(
  atMs: number,
  yesBids: Level[],
  noBids: Level[],
  opts: {
    seq?: number;
    streamId?: string;
    market?: string;
    source?: BookSnapshotEvent['source'];
    stateHash?: string | null;
  } = {},
): BookSnapshotEvent {
  return {
    kind: 'book_snapshot',
    exchangeTimeMs: null,
    receiveTimeMs: BigInt(atMs),
    sessionId: SESSION,
    ingestOrdinal: null,
    streamId: opts.streamId ?? STREAM,
    seq: BigInt(opts.seq ?? 1),
    marketTicker: opts.market ?? MARKET,
    seriesTicker: 'KXHIGHNY',
    eventTicker: 'KXHIGHNY-26SEP13',
    source: opts.source ?? 'ws_initial',
    yesBids,
    noBids,
    stateHash: opts.stateHash ?? null,
  };
}

export function delta(
  atMs: number,
  side: 'yes' | 'no',
  price: string,
  deltaCount: string,
  preCount: string,
  opts: { seq?: number; streamId?: string; market?: string; applied?: boolean } = {},
): BookDeltaEvent {
  const post = (Number(preCount) + Number(deltaCount)).toFixed(6);
  return {
    kind: 'book_delta',
    exchangeTimeMs: null,
    receiveTimeMs: BigInt(atMs),
    sessionId: SESSION,
    ingestOrdinal: ++ordinal,
    streamId: opts.streamId ?? STREAM,
    seq: BigInt(opts.seq ?? Number(ordinal)),
    marketTicker: opts.market ?? MARKET,
    seriesTicker: 'KXHIGHNY',
    eventTicker: 'KXHIGHNY-26SEP13',
    side,
    price,
    deltaCount,
    preCount,
    postCount: post,
    applied: opts.applied ?? true,
    applyError: null,
  };
}

export function trade(
  atMs: number,
  yesPrice: string,
  count: string,
  takerOutcomeSide: 'yes' | 'no' | null,
  opts: { streamId?: string; market?: string; tradeId?: string } = {},
): TradeEvent {
  return {
    kind: 'trade',
    exchangeTimeMs: null,
    receiveTimeMs: BigInt(atMs),
    sessionId: SESSION,
    ingestOrdinal: ++ordinal,
    streamId: opts.streamId ?? STREAM,
    seq: BigInt(Number(ordinal)),
    marketTicker: opts.market ?? MARKET,
    seriesTicker: 'KXHIGHNY',
    eventTicker: 'KXHIGHNY-26SEP13',
    tradeId: opts.tradeId ?? `t${ordinal}`,
    yesPrice,
    noPrice: (1 - Number(yesPrice)).toFixed(6),
    count,
    takerOutcomeSide,
    takerBookSide: takerOutcomeSide === 'yes' ? 'bid' : takerOutcomeSide === 'no' ? 'ask' : null,
    isBlockTrade: false,
  };
}

export function gap(
  atMs: number,
  endedAtMs: number | null,
  markets: string[] = [MARKET],
): CaptureGapEvent {
  return {
    kind: 'capture_gap',
    exchangeTimeMs: null,
    receiveTimeMs: BigInt(atMs),
    sessionId: SESSION,
    ingestOrdinal: null,
    streamId: STREAM,
    seq: null,
    gapId: `gap-${atMs}`,
    startedAtMs: BigInt(atMs),
    endedAtMs: endedAtMs === null ? null : BigInt(endedAtMs),
    reason: 'restart',
    affectedMarkets: markets,
  };
}

/** A plain two-sided book: YES bid 0.40 x 100, YES ask 0.45 x 100. */
export const OPENING_SNAPSHOT_LEVELS = {
  yesBids: [['0.400000', '100.000000']] as Level[],
  noBids: [['0.550000', '100.000000']] as Level[],
};

/**
 * A synthetic but INTERNALLY CONSISTENT event stream with a MOVING touch.
 *
 * Two properties matter and both are easy to get wrong:
 *
 *   consistency  every delta is generated against the running ladder, so
 *                `pre + delta` is never negative. The engine invalidates a
 *                book on a negative resting quantity, exactly as the recorder
 *                does, so a careless generator produces a run in which every
 *                order is rejected and every assertion passes vacuously.
 *
 *   movement     the best bid and offer must actually move. A quoting
 *                strategy only reprices when its target changes, so a book
 *                whose touch is pinned produces two orders in ten thousand
 *                events and tests nothing.
 *
 * Deterministic: a linear congruential generator seeded by the caller, never
 * Math.random.
 */
export function syntheticStream(
  steps = 300,
  seed = 12345,
): (BookSnapshotEvent | BookDeltaEvent | TradeEvent)[] {
  resetOrdinals();

  let rngState = seed >>> 0;
  const rnd = () => {
    rngState = (rngState * 1103515245 + 12345) >>> 0;
    return rngState / 0x1_0000_0000;
  };
  const pick = (n: number) => Math.floor(rnd() * n);

  // Ladders in whole cents, so every price lands on the exchange's grid.
  // `yes` holds YES bids; `no` holds NO bids, whose complement is the YES ask.
  const yes = new Map<number, number>();
  const no = new Map<number, number>();

  let bestBid = 40;
  let spread = 4;

  /** Three levels deep on each side, thinning away from the touch. */
  const target = (): { yes: Map<number, number>; no: Map<number, number> } => {
    const bestAsk = bestBid + spread;
    const y = new Map<number, number>();
    const n = new Map<number, number>();
    for (let i = 0; i < 3; i++) {
      y.set(bestBid - i, 40 + i * 30 + pick(20));
      n.set(100 - bestAsk - i, 40 + i * 30 + pick(20));
    }
    return { yes: y, no: n };
  };

  const events: (BookSnapshotEvent | BookDeltaEvent | TradeEvent)[] = [];
  let t = 1_000;
  let seq = 1;

  // Seed the ladders, then publish them as the opening snapshot.
  for (const [cents, size] of target().yes) yes.set(cents, size);
  for (const [cents, size] of target().no) no.set(cents, size);
  const levels = (m: Map<number, number>): Level[] =>
    [...m.entries()]
      .filter(([, size]) => size > 0)
      .sort((a, b) => b[0] - a[0])
      .map(([c, size]) => [(c / 100).toFixed(6), size.toFixed(6)] as Level);

  events.push(snapshot(t, levels(yes), levels(no), { seq: seq++ }));
  t += 50;

  /** Emits the deltas that turn `current` into `want`, one level at a time. */
  const reconcile = (side: 'yes' | 'no', current: Map<number, number>, want: Map<number, number>) => {
    for (const cents of new Set([...current.keys(), ...want.keys()])) {
      const pre = current.get(cents) ?? 0;
      const post = want.get(cents) ?? 0;
      if (pre === post) continue;
      current.set(cents, post);
      events.push(
        delta(t, side, (cents / 100).toFixed(6), (post - pre).toFixed(6), pre.toFixed(6), {
          seq: seq++,
        }),
      );
      t += 20;
    }
  };

  for (let i = 0; i < steps; i++) {
    // Move the touch about a third of the time, and vary the spread.
    const roll = pick(6);
    if (roll === 0 && bestBid > 20) bestBid -= 1;
    else if (roll === 1 && bestBid + spread < 80) bestBid += 1;
    else if (roll === 2) spread = 2 + pick(4);

    const want = target();
    reconcile('yes', yes, want.yes);
    reconcile('no', no, want.no);

    if (i % 3 === 0) {
      // A print at the touch, on whichever side the aggressor took.
      const buyYes = pick(2) === 0;
      const priceCents = buyYes ? bestBid + spread : bestBid;
      if (priceCents > 0 && priceCents < 100) {
        events.push(
          trade(t, (priceCents / 100).toFixed(6), String(1 + pick(40)), buyYes ? 'yes' : 'no'),
        );
        t += 25;
      }
    }
  }

  return events;
}
