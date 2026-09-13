import { MarketBook, type ApplyDeltaResult, type BookSide } from '@/src/book/book';
import { toNumericString } from '@/src/persistence/convert';
import { PRICE_DP, SIZE_DP, ZERO, type DecimalInput } from '@/src/book/decimal';
import type { NormalizedRow } from '@/src/persistence/types';
import { snapshotRow, type SnapshotSource } from '@/src/persistence/repositories/snapshots';
import { logger } from '@/src/logging/logger';

/**
 * Owns the in-memory book for every tracked market.
 *
 * Book logic is kept entirely separate from WebSocket lifecycle: this class
 * never touches a socket and never writes to the database. It produces ROWS,
 * which the collector hands to the batch writer. That separation is what lets
 * the replay CLI reuse exactly the same reconstruction code offline.
 */

export interface DeltaInput {
  marketTicker: string;
  marketId?: string | null;
  side: BookSide;
  price: DecimalInput;
  delta: DecimalInput;
  seq: bigint;
  sid?: number | null;
  sessionId: string;
  streamId: string;
  exchangeTsMs?: bigint | null;
  receivedAt: Date;
  receivedAtMs: bigint;
}

export interface SnapshotApplyInput {
  marketTicker: string;
  marketId?: string | null;
  yesBids: Iterable<readonly [DecimalInput, DecimalInput]>;
  noBids: Iterable<readonly [DecimalInput, DecimalInput]>;
  seq: bigint | null;
  sid?: number | null;
  sessionId: string;
  streamId: string;
  source: SnapshotSource;
  receivedAt: Date;
  receivedAtMs: bigint;
}

export interface DeltaOutcome {
  result: ApplyDeltaResult;
  row: NormalizedRow;
  /** True when the book must be rebuilt from a fresh exchange snapshot. */
  needsRecovery: boolean;
}

export class BookManager {
  private readonly books = new Map<string, MarketBook>();
  /** Which markets are carried by which subscription stream. */
  private readonly streamMarkets = new Map<string, Set<string>>();

  get(marketTicker: string): MarketBook | undefined {
    return this.books.get(marketTicker);
  }

  getOrCreate(marketTicker: string): MarketBook {
    let book = this.books.get(marketTicker);
    if (!book) {
      book = new MarketBook(marketTicker);
      this.books.set(marketTicker, book);
    }
    return book;
  }

  has(marketTicker: string): boolean {
    return this.books.has(marketTicker);
  }

  get size(): number {
    return this.books.size;
  }

  tickers(): string[] {
    return [...this.books.keys()];
  }

  all(): MarketBook[] {
    return [...this.books.values()];
  }

  validBooks(): MarketBook[] {
    return this.all().filter((b) => b.valid);
  }

  invalidBooks(): MarketBook[] {
    return this.all().filter((b) => !b.valid);
  }

  /** Drops a market entirely, e.g. after it is unsubscribed and retained past. */
  remove(marketTicker: string): void {
    this.books.delete(marketTicker);
    for (const set of this.streamMarkets.values()) set.delete(marketTicker);
  }

  // -------------------------------------------------------------------------
  // Stream association
  // -------------------------------------------------------------------------

  associate(streamId: string, marketTicker: string): void {
    const set = this.streamMarkets.get(streamId) ?? new Set<string>();
    set.add(marketTicker);
    this.streamMarkets.set(streamId, set);
  }

  marketsForStream(streamId: string): string[] {
    return [...(this.streamMarkets.get(streamId) ?? [])];
  }

  releaseStream(streamId: string): string[] {
    const markets = this.marketsForStream(streamId);
    this.streamMarkets.delete(streamId);
    return markets;
  }

  /**
   * Invalidates every book carried by a stream. Called on a sequence gap: once
   * continuity is broken we cannot vouch for ANY book on that subscription,
   * because we do not know which markets the missed messages belonged to.
   */
  invalidateStream(streamId: string, reason: string): string[] {
    const affected = this.marketsForStream(streamId);
    for (const ticker of affected) this.books.get(ticker)?.invalidate(reason);

    logger.warn(
      { event: 'stream_books_invalidated', stream_id: streamId, marketCount: affected.length, reason },
      'invalidated all books on stream',
    );
    return affected;
  }

  /** Invalidates everything, e.g. on disconnect. */
  invalidateAll(reason: string): string[] {
    const all = this.tickers();
    for (const book of this.books.values()) book.invalidate(reason);
    return all;
  }

  // -------------------------------------------------------------------------
  // Application
  // -------------------------------------------------------------------------

  /**
   * Replaces a book from an exchange snapshot. This is the only path that makes
   * a book valid again after invalidation.
   */
  applySnapshot(input: SnapshotApplyInput): NormalizedRow {
    const book = this.getOrCreate(input.marketTicker);

    book.replaceWithSnapshot(
      { yesBids: input.yesBids, noBids: input.noBids },
      {
        seq: input.seq,
        atMs: Number(input.receivedAtMs),
        sessionId: input.sessionId,
        streamId: input.streamId,
      },
    );
    this.associate(input.streamId, input.marketTicker);

    return snapshotRow({
      book,
      source: input.source,
      sessionId: input.sessionId,
      streamId: input.streamId,
      sid: input.sid ?? null,
      seq: input.seq,
      receivedAt: input.receivedAt,
      receivedAtMs: input.receivedAtMs,
      marketId: input.marketId ?? null,
      linkRawEvent: input.source === 'ws_initial' || input.source === 'ws_recovery',
    });
  }

  /**
   * Applies a delta and produces its row.
   *
   * A delta is persisted either way. `applied = false` rows record exactly what
   * the exchange sent and why we could not fold it into canonical state -- they
   * are the audit trail for every discontinuity in the dataset.
   */
  applyDelta(input: DeltaInput, options: { canApply: boolean; skipReason?: string } = { canApply: true }): DeltaOutcome {
    const book = this.getOrCreate(input.marketTicker);
    this.associate(input.streamId, input.marketTicker);

    const baseValues: Record<string, unknown> = {
      session_id: input.sessionId,
      stream_id: input.streamId,
      market_ticker: input.marketTicker,
      market_id: input.marketId ?? null,
      sid: input.sid ?? null,
      seq: input.seq.toString(),
      exchange_ts_ms: input.exchangeTsMs?.toString() ?? null,
      exchange_ts: input.exchangeTsMs ? new Date(Number(input.exchangeTsMs)) : null,
      received_at: input.receivedAt,
      received_at_ms: input.receivedAtMs.toString(),
      side: input.side,
      price: toNumericString(input.price as never, PRICE_DP),
      delta_count: toNumericString(input.delta as never, SIZE_DP),
    };

    // The book is not trustworthy (gap, prior violation, no snapshot yet), so
    // the delta is recorded but NOT folded into canonical state.
    if (!options.canApply || !book.valid) {
      const reason =
        options.skipReason ?? book.invalidReason ?? 'book invalid; awaiting recovery snapshot';
      return {
        result: { applied: false, preCount: ZERO, postCount: null, levelAction: 'unknown', error: reason },
        row: {
          table: 'orderbook_deltas',
          linkRawEvent: true,
          values: {
            ...baseValues,
            pre_count: null,
            post_count: null,
            level_action: 'unknown',
            applied: false,
            apply_error: reason,
          },
        },
        needsRecovery: true,
      };
    }

    const result = book.applyDelta({
      side: input.side,
      price: input.price,
      delta: input.delta,
      seq: input.seq,
      atMs: Number(input.receivedAtMs),
    });

    return {
      result,
      row: {
        table: 'orderbook_deltas',
        linkRawEvent: true,
        values: {
          ...baseValues,
          pre_count: toNumericString(result.preCount, SIZE_DP),
          post_count: toNumericString(result.postCount, SIZE_DP),
          level_action: result.levelAction,
          applied: result.applied,
          apply_error: result.error ?? null,
        },
      },
      // A negative post-count means our state diverged from the exchange's.
      needsRecovery: !result.applied,
    };
  }

  /**
   * Point-in-time copies of every valid book, taken synchronously so that a
   * ladder sample is genuinely simultaneous across strikes rather than a set of
   * independently timed reads.
   */
  snapshotAll(tickers?: string[]): Map<string, MarketBook> {
    const out = new Map<string, MarketBook>();
    const list = tickers ?? this.tickers();
    for (const ticker of list) {
      const book = this.books.get(ticker);
      if (book) out.set(ticker, book.clone());
    }
    return out;
  }

  clear(): void {
    this.books.clear();
    this.streamMarkets.clear();
  }
}
