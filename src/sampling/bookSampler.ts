import type { BookManager } from '@/src/book/bookManager';
import { computeFeatures, featuresToSampleColumns } from '@/src/book/features';
import { SIZE_DP, PRICE_DP, toNumeric } from '@/src/book/decimal';
import type { MarketStateCache } from '@/src/collector/marketState';
import { snapshotRow } from '@/src/persistence/repositories/snapshots';
import type { NormalizedRow } from '@/src/persistence/types';

/**
 * Periodic derived sampling.
 *
 * Sampling horizons are configuration and affect ONLY these derived tables.
 * The raw delta stream is never downsampled to produce them, and a sample can
 * always be recomputed offline from raw history.
 *
 * Buckets are aligned to the interval (floor(now / interval) * interval) so
 * that samples from different processes and different sessions land on the same
 * grid and are directly comparable.
 */

export function bucketFor(nowMs: number, intervalMs: number): number {
  return Math.floor(nowMs / intervalMs) * intervalMs;
}

export interface BookSamplerOptions {
  books: BookManager;
  marketState: MarketStateCache;
  bboIntervalsMs: number[];
  fullBookIntervalsMs: number[];
  /**
   * When true, a materialised snapshot is skipped if the book hash is
   * unchanged since the previous sample at that interval.
   *
   * Default false: every scheduled sample is retained, because a regular grid
   * is far easier to work with in research than a change-only series, and the
   * storage cost is modest.
   */
  suppressUnchangedSnapshots?: boolean;
}

export class BookSampler {
  private readonly books: BookManager;
  private readonly marketState: MarketStateCache;
  private readonly bboIntervals: number[];
  private readonly fullBookIntervals: number[];
  private readonly suppressUnchanged: boolean;

  /** `${interval}:${ticker}` -> last emitted bucket, to avoid duplicates. */
  private readonly lastBucket = new Map<string, number>();
  private readonly lastHash = new Map<string, string>();

  constructor(opts: BookSamplerOptions) {
    this.books = opts.books;
    this.marketState = opts.marketState;
    this.bboIntervals = [...opts.bboIntervalsMs].sort((a, b) => a - b);
    this.fullBookIntervals = [...opts.fullBookIntervalsMs].sort((a, b) => a - b);
    this.suppressUnchanged = opts.suppressUnchangedSnapshots ?? false;
  }

  get intervals(): number[] {
    return [...new Set([...this.bboIntervals, ...this.fullBookIntervals])].sort((a, b) => a - b);
  }

  /**
   * Produces all sample rows due at `nowMs`.
   *
   * An invalid book still produces a BBO sample row, with book_valid = false
   * and null prices -- the absence of trustworthy state at a given instant is
   * itself information, and omitting the row would make a gap indistinguishable
   * from a collector outage. Full-book snapshots are NOT written for invalid
   * books, since a materialised snapshot asserts a state we cannot vouch for.
   */
  sample(nowMs: number, sessionId: string): NormalizedRow[] {
    const rows: NormalizedRow[] = [];

    for (const intervalMs of this.bboIntervals) {
      const bucket = bucketFor(nowMs, intervalMs);
      for (const book of this.books.all()) {
        const key = `${intervalMs}:${book.marketTicker}`;
        if (this.lastBucket.get(key) === bucket) continue;
        this.lastBucket.set(key, bucket);

        const f = computeFeatures(book);
        const state = this.marketState.get(book.marketTicker);

        rows.push({
          table: 'book_samples',
          values: {
            market_ticker: book.marketTicker,
            interval_ms: intervalMs,
            bucket_ts: new Date(bucket),
            bucket_ts_ms: String(bucket),
            ...featuresToSampleColumns(f),
            last_trade_price: toNumeric(state?.lastTradePrice ?? null, PRICE_DP),
            last_trade_count: toNumeric(state?.lastTradeCount ?? null, SIZE_DP),
            volume: toNumeric(state?.volume ?? null, SIZE_DP),
            open_interest: toNumeric(state?.openInterest ?? null, SIZE_DP),
          },
        });
      }
    }

    for (const intervalMs of this.fullBookIntervals) {
      const bucket = bucketFor(nowMs, intervalMs);
      for (const book of this.books.validBooks()) {
        const key = `full:${intervalMs}:${book.marketTicker}`;
        if (this.lastBucket.get(key) === bucket) continue;
        this.lastBucket.set(key, bucket);

        if (this.suppressUnchanged) {
          const hash = book.getStateHash();
          if (this.lastHash.get(key) === hash) continue;
          this.lastHash.set(key, hash);
        }

        rows.push(
          snapshotRow({
            book,
            source: 'local_materialized',
            sessionId,
            streamId: book.streamId,
            seq: book.lastSeq,
            // The ACTUAL instant the book was read, not the bucket boundary.
            //
            // The bucket is a scheduling concept; the state being recorded is
            // whatever the book held when it was sampled, a few hundred
            // milliseconds after the boundary. Stamping it with the boundary
            // would claim a state existed before the deltas that produced it,
            // and replaying to that timestamp could not reproduce it.
            // book_samples.bucket_ts carries the aligned grid separately.
            receivedAt: new Date(nowMs),
            receivedAtMs: BigInt(nowMs),
          }),
        );
      }
    }

    return rows;
  }

  /** Forgets per-market bucket state, e.g. when a market stops being tracked. */
  forget(marketTicker: string): void {
    for (const key of [...this.lastBucket.keys()]) {
      if (key.endsWith(`:${marketTicker}`)) this.lastBucket.delete(key);
    }
    for (const key of [...this.lastHash.keys()]) {
      if (key.endsWith(`:${marketTicker}`)) this.lastHash.delete(key);
    }
  }
}
