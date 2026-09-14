import { MarketBook, type BookSide } from '@/src/book/book';
import { Decimal, ZERO, canonicalPrice } from '@/src/book/decimal';
import {
  depthAhead,
  publicLevelFor,
  yesPriceOfPublicLevel,
  type AheadDepth,
} from '@/src/book/ladder';
import type { LevelPair } from '@/src/book/hashing';
import type {
  BookDeltaEvent,
  BookSnapshotEvent,
  CaptureGapEvent,
} from '@/src/research/events/researchEvent';

/**
 * The book state a backtest runs against.
 *
 * This is a THIN ordering-and-epoch layer over `MarketBook`, the same class
 * the recorder and its replay verification use. No book arithmetic happens
 * here: prices, sizes, level insertion and removal, negative-quantity
 * detection and state hashing are all the recorder's, unchanged. A second
 * implementation would be a second set of bugs, and the hash equality test
 * that proves this layer correct would be testing it against itself.
 *
 * What this layer adds is the policy that a multi-market replay needs and a
 * single-market replay did not:
 *
 *   - a book belongs to exactly one stream at a time, and a delta from an
 *     older stream is DROPPED rather than applied to newer state
 *   - a book is invalid until an exchange snapshot seeds it, and becomes
 *     invalid again on a capture gap
 *   - "valid" is a first-class question a strategy can ask, because trading on
 *     a book we cannot vouch for is the failure mode this whole system exists
 *     to prevent
 */

export interface YesBbo {
  bid: Decimal | null;
  bidSize: Decimal | null;
  ask: Decimal | null;
  askSize: Decimal | null;
  spread: Decimal | null;
  mid: Decimal | null;
}

/**
 * A BBO known to have both sides.
 *
 * Narrowing here rather than at each use keeps the "is there a market at all?"
 * check in one place. A one-sided book is common in these markets and quoting
 * against an imputed other side is how a maker ends up alone at a price
 * nobody wants.
 */
export interface TwoSidedBbo extends YesBbo {
  bid: Decimal;
  ask: Decimal;
  spread: Decimal;
  mid: Decimal;
}

/** Read-only book access. Strategies get this, never the mutable book. */
export interface BookView {
  readonly marketTicker: string;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly lastUpdateMs: number;
  bbo(): YesBbo;
  microprice(): Decimal | null;
  depth(k: number): { bid: Decimal; ask: Decimal };
  imbalance(k: number): Decimal | null;
  yesBidLevels(): LevelPair[];
  yesAskLevels(): LevelPair[];
  /** Resting size at a YES bid price. Zero when the level is empty. */
  yesBidSizeAt(price: Decimal): Decimal;
  /** Resting size at a YES ask price, i.e. the NO bid at 1 - price. */
  yesAskSizeAt(price: Decimal): Decimal;
  /**
   * Depth ahead of an order on this ladder: better prices AND our own level.
   *
   * The `better` term is what a same-price-only model omits, and a probe that
   * does not reprice accumulates it whenever the market improves past it.
   */
  depthAhead(side: 'bid' | 'ask', yesPrice: Decimal): AheadDepth;
  stateHash(): string;
}

class MarketBookView implements BookView {
  constructor(private readonly book: MarketBook) {}

  get marketTicker(): string {
    return this.book.marketTicker;
  }
  get valid(): boolean {
    return this.book.valid;
  }
  get invalidReason(): string | null {
    return this.book.invalidReason;
  }
  get lastUpdateMs(): number {
    return this.book.lastUpdateAtMs;
  }
  /**
   * Best bid and offer, by a single linear scan of each ladder.
   *
   * `MarketBook.getYesBBO()` sorts both ladders to take their first element,
   * which is the right shape for the recorder -- it wants the sorted levels
   * anyway -- and the wrong shape here. The backtest asks for the BBO on every
   * delta, so a full day means several million sorts of a fifty-level map, and
   * they dominate the run.
   *
   * The values are identical: sorting price-descending and taking the head is
   * the same thing as taking the maximum. The ladder accessors below still
   * delegate, so there is exactly one implementation of everything that is not
   * a maximum.
   */
  bbo(): YesBbo {
    const best = (levels: ReadonlyMap<string, Decimal>): [Decimal, Decimal] | null => {
      let price: Decimal | null = null;
      let size: Decimal | null = null;
      for (const [key, value] of levels) {
        if (value.isZero()) continue;
        const candidate = new Decimal(key);
        if (price === null || candidate.gt(price)) {
          price = candidate;
          size = value;
        }
      }
      return price === null ? null : [price, size!];
    };

    const bestBid = best(this.book.yesBids);
    const bestNoBid = best(this.book.noBids);

    const bid = bestBid?.[0] ?? null;
    const bidSize = bestBid?.[1] ?? null;
    // The highest NO bid is the lowest YES ask. Derived by the shared mapping.
    const ask =
      bestNoBid === null ? null : new Decimal(yesPriceOfPublicLevel('no', bestNoBid[0]));
    const askSize = bestNoBid?.[1] ?? null;

    // Both sides required; a one-sided book yields null rather than an
    // imputed value.
    const spread = bid && ask ? ask.minus(bid) : null;
    const mid = bid && ask ? bid.plus(ask).div(2) : null;

    return { bid, bidSize, ask, askSize, spread, mid };
  }

  microprice(): Decimal | null {
    const { bid, ask, bidSize, askSize } = this.bbo();
    if (!bid || !ask || !bidSize || !askSize) return null;
    const denom = bidSize.plus(askSize);
    if (denom.isZero()) return null;
    return ask.mul(bidSize).plus(bid.mul(askSize)).div(denom);
  }
  depth(k: number): { bid: Decimal; ask: Decimal } {
    return this.book.getDepth(k);
  }
  imbalance(k: number): Decimal | null {
    return this.book.getImbalance(k);
  }
  yesBidLevels(): LevelPair[] {
    return this.book.yesBidLevels();
  }
  yesAskLevels(): LevelPair[] {
    return this.book.yesAskLevels();
  }
  yesBidSizeAt(price: Decimal): Decimal {
    return this.book.yesBids.get(canonicalPrice(price)) ?? ZERO;
  }
  yesAskSizeAt(price: Decimal): Decimal {
    // A YES ask at p is physically a NO bid at 1 - p. Derived by the shared
    // mapping rather than here, so the inversion exists in exactly one place.
    return this.book.noBids.get(publicLevelFor('ask', price).price) ?? ZERO;
  }

  depthAhead(side: 'bid' | 'ask', yesPrice: Decimal): AheadDepth {
    return depthAhead(side, yesPrice, { yesBids: this.book.yesBids, noBids: this.book.noBids });
  }
  stateHash(): string {
    return this.book.getStateHash();
  }
}

export interface ApplyOutcome {
  applied: boolean;
  reason?: string;
}

export interface MarketStateStats {
  snapshotsApplied: number;
  deltasApplied: number;
  deltasSkippedNotApplied: number;
  deltasSkippedStaleStream: number;
  deltasSkippedInvalidBook: number;
  deltasDiverged: number;
  gapsOpened: number;
}

export class MarketStateStore {
  private readonly books = new Map<string, MarketBook>();
  /** Stream that currently owns each book, and its rank in stream chronology. */
  private readonly owningStream = new Map<string, { streamId: string | null; rank: number }>();
  private readonly streamRanks = new Map<string, number>();

  readonly stats: MarketStateStats = {
    snapshotsApplied: 0,
    deltasApplied: 0,
    deltasSkippedNotApplied: 0,
    deltasSkippedStaleStream: 0,
    deltasSkippedInvalidBook: 0,
    deltasDiverged: 0,
    gapsOpened: 0,
  };

  /**
   * Stream chronology, assigned on first sight.
   *
   * The event stream already arrives in the collector's observation order, so
   * the order streams are first SEEN is their chronological order -- no second
   * source of truth to disagree with the first. What matters is only that the
   * rank never comes from the stream UUID: `seq` restarts on reconnect, so a
   * session that reconnected holds several streams with overlapping sequence
   * ranges, and ordering those by a random identifier interleaves them
   * arbitrarily.
   */
  private rankOf(streamId: string | null): number {
    if (streamId === null) return -1;
    let rank = this.streamRanks.get(streamId);
    if (rank === undefined) {
      rank = this.streamRanks.size;
      this.streamRanks.set(streamId, rank);
    }
    return rank;
  }

  tickers(): string[] {
    return [...this.books.keys()];
  }

  has(ticker: string): boolean {
    return this.books.has(ticker);
  }

  view(ticker: string): BookView | undefined {
    const book = this.books.get(ticker);
    return book ? new MarketBookView(book) : undefined;
  }

  /** All views, including invalid books; validity is the caller's to check. */
  views(): BookView[] {
    return [...this.books.values()].map((b) => new MarketBookView(b));
  }

  /** Internal access for the simulated exchange, which needs exact levels. */
  book(ticker: string): MarketBook | undefined {
    return this.books.get(ticker);
  }

  applySnapshot(event: BookSnapshotEvent): ApplyOutcome {
    let book = this.books.get(event.marketTicker);
    if (!book) {
      book = new MarketBook(event.marketTicker);
      this.books.set(event.marketTicker, book);
    }

    book.replaceWithSnapshot(
      { yesBids: event.yesBids, noBids: event.noBids },
      {
        seq: event.seq,
        atMs: Number(event.receiveTimeMs),
        sessionId: event.sessionId,
        streamId: event.streamId ?? undefined,
      },
    );

    this.owningStream.set(event.marketTicker, {
      streamId: event.streamId,
      rank: this.rankOf(event.streamId),
    });
    this.stats.snapshotsApplied += 1;
    return { applied: true };
  }

  applyDelta(event: BookDeltaEvent): ApplyOutcome {
    // A delta the RECORDER rejected is rejected here too. Applying it would
    // build a book the recorder never believed in, and the divergence would
    // never surface.
    if (!event.applied) {
      this.stats.deltasSkippedNotApplied += 1;
      return { applied: false, reason: 'recorder_did_not_apply' };
    }

    const book = this.books.get(event.marketTicker);
    if (!book || !book.valid) {
      this.stats.deltasSkippedInvalidBook += 1;
      return { applied: false, reason: 'book_not_seeded' };
    }

    // Stale-stream guard. Two streams can carry frames for the same market
    // across a reconnect, and at millisecond resolution the tail of the old
    // stream can sort after the seed of the new one. Applying it would rewind
    // the book onto state that already superseded it.
    const owner = this.owningStream.get(event.marketTicker);
    if (owner && event.streamId !== owner.streamId && this.rankOf(event.streamId) < owner.rank) {
      this.stats.deltasSkippedStaleStream += 1;
      return { applied: false, reason: 'stale_stream' };
    }

    const outcome = book.applyDelta({
      side: event.side as BookSide,
      price: event.price,
      delta: event.deltaCount,
      seq: event.seq,
      atMs: Number(event.receiveTimeMs),
    });

    if (!outcome.applied) {
      // MarketBook has already invalidated itself; a negative resting quantity
      // is never clamped away.
      this.stats.deltasDiverged += 1;
      return { applied: false, reason: outcome.error ?? 'diverged' };
    }

    if (event.streamId !== null && (!owner || owner.streamId !== event.streamId)) {
      this.owningStream.set(event.marketTicker, {
        streamId: event.streamId,
        rank: this.rankOf(event.streamId),
      });
    }

    this.stats.deltasApplied += 1;
    return { applied: true };
  }

  /**
   * Coverage was lost. Every affected book becomes invalid immediately.
   *
   * Not "probably still fine for a few seconds": while we were not listening
   * the book could have moved anywhere, and the next event we see will be a
   * delta against a state we never observed. Only a fresh exchange snapshot
   * restores validity.
   */
  applyCaptureGap(event: CaptureGapEvent): string[] {
    const affected =
      event.affectedMarkets.length > 0 ? event.affectedMarkets : [...this.books.keys()];
    const invalidated: string[] = [];
    for (const ticker of affected) {
      const book = this.books.get(ticker);
      if (!book || !book.valid) continue;
      book.invalidate(`capture gap ${event.gapId} (${event.reason})`);
      invalidated.push(ticker);
    }
    this.stats.gapsOpened += 1;
    return invalidated;
  }
}
