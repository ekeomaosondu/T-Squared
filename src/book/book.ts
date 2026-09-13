import {
  canonicalPrice,
  canonicalSize,
  D,
  Decimal,
  type DecimalInput,
  ONE,
  ZERO,
} from '@/src/book/decimal';
import { canonicalLevels, hashBookState, type LevelPair } from '@/src/book/hashing';

/**
 * In-memory order book for one market.
 *
 * Kalshi represents the book as YES bids and NO bids. Both are stored EXACTLY
 * as received and are never collapsed into a single bid/ask ladder on the way
 * in. The conventional YES-side bid/ask view is derived on demand:
 *
 *     best_yes_bid = max(YES bid prices)
 *     best_yes_ask = 1 - max(NO bid prices)
 *
 * with the YES ask size being the size resting on that NO bid level.
 *
 * Price keys are canonical decimal strings ("0.420000"), never JS numbers:
 * 0.1 + 0.2 must not be able to create a phantom price level.
 */

export type BookSide = 'yes' | 'no';

export type LevelAction = 'insert' | 'increase' | 'decrease' | 'delete' | 'unknown';

export interface ApplyDeltaInput {
  side: BookSide;
  /** Price in dollars, 0..1. */
  price: DecimalInput;
  /** Signed change in resting quantity. */
  delta: DecimalInput;
  seq?: bigint | null;
  atMs?: number;
}

export interface ApplyDeltaResult {
  applied: boolean;
  preCount: Decimal;
  /** Null only when the delta was rejected before a post-count was reached. */
  postCount: Decimal | null;
  levelAction: LevelAction;
  error?: string;
}

export interface SnapshotLevels {
  yesBids: Iterable<readonly [DecimalInput, DecimalInput]>;
  noBids: Iterable<readonly [DecimalInput, DecimalInput]>;
}

export interface YesBbo {
  bid: Decimal | null;
  bidSize: Decimal | null;
  ask: Decimal | null;
  askSize: Decimal | null;
  spread: Decimal | null;
  mid: Decimal | null;
}

export interface Depth {
  bid: Decimal;
  ask: Decimal;
}

export interface CanonicalBook {
  yes_bids: [string, string][];
  no_bids: [string, string][];
}

/** Thrown when a delta would drive a level's resting quantity below zero. */
export class NegativeLevelQuantityError extends Error {
  constructor(
    readonly marketTicker: string,
    readonly side: BookSide,
    readonly price: string,
    readonly preCount: string,
    readonly deltaCount: string,
    readonly postCount: string,
  ) {
    super(
      `negative level quantity for ${marketTicker} ${side}@${price}: ` +
        `${preCount} + ${deltaCount} = ${postCount}`,
    );
    this.name = 'NegativeLevelQuantityError';
  }
}

export class MarketBook {
  readonly marketTicker: string;

  readonly yesBids = new Map<string, Decimal>();
  readonly noBids = new Map<string, Decimal>();

  lastSeq: bigint | null = null;

  /**
   * False whenever we cannot vouch for the book: before the first snapshot,
   * after a sequence gap, and after an invariant violation. An invalid book is
   * never sampled and never silently repaired.
   */
  valid = false;

  /** Why the book is invalid, for integrity records and the dashboard. */
  invalidReason: string | null = null;

  lastSnapshotAtMs = 0;
  lastUpdateAtMs = 0;

  /** Session/stream that produced the current state; a new epoch resets it. */
  sessionId: string | null = null;
  streamId: string | null = null;

  private hashCache: string | null = null;

  constructor(marketTicker: string) {
    this.marketTicker = marketTicker;
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /**
   * Replaces the entire book from an exchange snapshot. This is the ONLY way a
   * book becomes valid -- there is no path that repairs state incrementally.
   */
  replaceWithSnapshot(
    levels: SnapshotLevels,
    opts: { seq?: bigint | null; atMs?: number; sessionId?: string; streamId?: string } = {},
  ): void {
    this.yesBids.clear();
    this.noBids.clear();

    for (const [price, size] of levels.yesBids) this.setLevel('yes', price, size);
    for (const [price, size] of levels.noBids) this.setLevel('no', price, size);

    this.lastSeq = opts.seq ?? null;
    this.valid = true;
    this.invalidReason = null;
    this.lastSnapshotAtMs = opts.atMs ?? Date.now();
    this.lastUpdateAtMs = this.lastSnapshotAtMs;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
    if (opts.streamId !== undefined) this.streamId = opts.streamId;
    this.hashCache = null;
  }

  /**
   * Applies a single delta.
   *
   * post_count = pre_count + delta_count
   *   > 0  level remains
   *   = 0  level removed
   *   < 0  invariant violation -- the book is marked invalid and the delta is
   *        reported as not applied. Quantities are NEVER clamped to zero.
   *
   * Returns a result rather than throwing for the negative case, because the
   * caller must still persist the delta row with applied = false.
   */
  applyDelta(input: ApplyDeltaInput): ApplyDeltaResult {
    const side = input.side;
    const priceKey = canonicalPrice(input.price);
    const delta = D(input.delta);

    const map = side === 'yes' ? this.yesBids : this.noBids;
    const pre = map.get(priceKey) ?? ZERO;
    const post = pre.plus(delta);

    if (post.isNegative()) {
      const err = new NegativeLevelQuantityError(
        this.marketTicker,
        side,
        priceKey,
        canonicalSize(pre),
        canonicalSize(delta),
        canonicalSize(post),
      );
      this.invalidate(err.message);
      return {
        applied: false,
        preCount: pre,
        postCount: post,
        levelAction: 'unknown',
        error: err.message,
      };
    }

    const levelAction: LevelAction = post.isZero()
      ? 'delete'
      : pre.isZero()
        ? 'insert'
        : delta.isPositive()
          ? 'increase'
          : delta.isZero()
            ? 'unknown'
            : 'decrease';

    if (post.isZero()) map.delete(priceKey);
    else map.set(priceKey, post);

    if (input.seq !== undefined && input.seq !== null) this.lastSeq = input.seq;
    this.lastUpdateAtMs = input.atMs ?? Date.now();
    this.hashCache = null;

    return { applied: true, preCount: pre, postCount: post, levelAction };
  }

  /** Marks the book untrustworthy. State is retained for diagnostics. */
  invalidate(reason: string): void {
    this.valid = false;
    this.invalidReason = reason;
  }

  private setLevel(side: BookSide, price: DecimalInput, size: DecimalInput): void {
    const key = canonicalPrice(price);
    const value = D(size);
    if (value.isZero()) return;
    (side === 'yes' ? this.yesBids : this.noBids).set(key, value);
  }

  // -------------------------------------------------------------------------
  // Derived views
  // -------------------------------------------------------------------------

  /** YES bid levels, best (highest) first. */
  yesBidLevels(): LevelPair[] {
    return canonicalLevels(this.yesBids.entries());
  }

  /** NO bid levels, best (highest) first. */
  noBidLevels(): LevelPair[] {
    return canonicalLevels(this.noBids.entries());
  }

  /**
   * YES ask ladder derived from NO bids: an ask at 1 - q for each NO bid q,
   * best (lowest) ask first. The highest NO bid becomes the lowest YES ask.
   */
  yesAskLevels(): LevelPair[] {
    return this.noBidLevels().map(
      ([price, size]) => [canonicalPrice(ONE.minus(price)), size] as LevelPair,
    );
  }

  getYesBBO(): YesBbo {
    const bids = this.yesBidLevels();
    const asks = this.yesAskLevels();

    const bestBid = bids[0];
    const bestAsk = asks[0];

    const bid = bestBid ? new Decimal(bestBid[0]) : null;
    const bidSize = bestBid ? new Decimal(bestBid[1]) : null;
    const ask = bestAsk ? new Decimal(bestAsk[0]) : null;
    const askSize = bestAsk ? new Decimal(bestAsk[1]) : null;

    // Both sides required; a one-sided book yields NULL rather than an
    // imputed value.
    const spread = bid && ask ? ask.minus(bid) : null;
    const mid = bid && ask ? bid.plus(ask).div(2) : null;

    return { bid, bidSize, ask, askSize, spread, mid };
  }

  /** Cumulative size across the best k levels on each YES-side. */
  getDepth(k: number): Depth {
    const sum = (levels: LevelPair[]) =>
      levels.slice(0, k).reduce((acc, [, size]) => acc.plus(size), ZERO);
    return { bid: sum(this.yesBidLevels()), ask: sum(this.yesAskLevels()) };
  }

  /**
   * (bid_depth_k - ask_depth_k) / (bid_depth_k + ask_depth_k).
   * Null when the denominator is zero -- never 0 as a stand-in.
   */
  getImbalance(k: number): Decimal | null {
    const { bid, ask } = this.getDepth(k);
    const denom = bid.plus(ask);
    if (denom.isZero()) return null;
    return bid.minus(ask).div(denom);
  }

  /**
   * (ask * bid_size + bid * ask_size) / (bid_size + ask_size).
   * Size-weighted toward the side with less resting size, per the usual
   * microprice convention.
   */
  getMicroprice(): Decimal | null {
    const { bid, ask, bidSize, askSize } = this.getYesBBO();
    if (!bid || !ask || !bidSize || !askSize) return null;
    const denom = bidSize.plus(askSize);
    if (denom.isZero()) return null;
    return ask.mul(bidSize).plus(bid.mul(askSize)).div(denom);
  }

  get levelCount(): { yes: number; no: number } {
    return { yes: this.yesBids.size, no: this.noBids.size };
  }

  get isEmpty(): boolean {
    return this.yesBids.size === 0 && this.noBids.size === 0;
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  /** Canonical JSON shape stored in orderbook_snapshots. */
  serializeCanonical(): CanonicalBook {
    return {
      yes_bids: this.yesBidLevels().map(([p, s]) => [p, s] as [string, string]),
      no_bids: this.noBidLevels().map(([p, s]) => [p, s] as [string, string]),
    };
  }

  /** SHA-256 over the canonical state. Cached until the next mutation. */
  getStateHash(): string {
    if (this.hashCache === null) {
      this.hashCache = hashBookState(this.marketTicker, this.yesBidLevels(), this.noBidLevels());
    }
    return this.hashCache;
  }

  /** Deep copy, used for synchronised ladder sampling and for tests. */
  clone(): MarketBook {
    const copy = new MarketBook(this.marketTicker);
    for (const [k, v] of this.yesBids) copy.yesBids.set(k, v);
    for (const [k, v] of this.noBids) copy.noBids.set(k, v);
    copy.lastSeq = this.lastSeq;
    copy.valid = this.valid;
    copy.invalidReason = this.invalidReason;
    copy.lastSnapshotAtMs = this.lastSnapshotAtMs;
    copy.lastUpdateAtMs = this.lastUpdateAtMs;
    copy.sessionId = this.sessionId;
    copy.streamId = this.streamId;
    return copy;
  }

  static fromCanonical(marketTicker: string, canonical: CanonicalBook): MarketBook {
    const book = new MarketBook(marketTicker);
    book.replaceWithSnapshot({ yesBids: canonical.yes_bids, noBids: canonical.no_bids });
    return book;
  }
}
