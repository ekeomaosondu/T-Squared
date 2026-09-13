import { BookManager } from '@/src/book/bookManager';
import type { MarketBook } from '@/src/book/book';
import { MarketStateCache } from '@/src/collector/marketState';
import type { Sql } from '@/src/persistence/db';
import { replay } from '@/src/replay/replay';
import { BookSampler } from '@/src/sampling/bookSampler';
import type { NormalizedRow } from '@/src/persistence/types';
import { logger } from '@/src/logging/logger';

/**
 * Offline research materialization.
 *
 * There is no single correct sampling frequency. A microprice predictor may
 * want 10ms, a queue-depletion study wants event time, and a slow inventory
 * strategy wants 30s. Committing the database to one grid is both expensive and
 * the wrong abstraction, so the live collector persists only a coarse 60s grid
 * for dashboards and health, and research horizons are generated here on demand
 * from the delta stream.
 *
 * The critical property is that this drives the SAME BookSampler the live
 * collector uses, over the same reconstructed book, so:
 *
 *     offline sample at interval X  ==  what live sampling at X would have produced
 *
 * If those diverged, every backtest would be measuring something the live
 * strategy will never see.
 */

export type MaterializeMode = 'clock' | 'event-time';

export interface MaterializeOptions {
  marketTickers: string[];
  fromMs: bigint;
  toMs: bigint;
  mode: MaterializeMode;
  /** Required for clock mode. */
  intervalMs?: number;
  /**
   * Receives each produced row.
   *
   * Synchronous by design: it is called from replay's event hooks, and an
   * async callback there would let bucket advancement interleave and silently
   * drop grid points. Writers buffer internally instead.
   */
  onRow: (row: Record<string, unknown>) => void;
}

export interface MaterializeResult {
  markets: number;
  rows: number;
  skippedMarkets: string[];
}

/** Pseudo session id recorded on materialized rows, so their origin is obvious. */
const OFFLINE_SESSION = '00000000-0000-0000-0000-000000000000';

/**
 * Samples a single reconstructed book with the production sampler.
 *
 * A fresh BookManager and BookSampler per market keeps the sampler's internal
 * bucket dedupe scoped correctly, exactly as it is per-process live.
 */
function samplerFor(book: MarketBook, intervalMs: number, marketState: MarketStateCache) {
  const books = new BookManager();
  // Register the live replay book itself, not a copy: the sampler must observe
  // the same object the replay is mutating.
  (books as unknown as { books: Map<string, MarketBook> }).books.set(book.marketTicker, book);

  return new BookSampler({
    books,
    marketState,
    bboIntervalsMs: [intervalMs],
    fullBookIntervalsMs: [],
  });
}

export async function materialize(sql: Sql, opts: MaterializeOptions): Promise<MaterializeResult> {
  const result: MaterializeResult = { markets: 0, rows: 0, skippedMarkets: [] };

  if (opts.mode === 'clock' && !opts.intervalMs) {
    throw new Error('clock mode requires --interval-ms');
  }

  for (const marketTicker of opts.marketTickers) {
    const marketState = new MarketStateCache();
    let sampler: BookSampler | undefined;
    let bound: MarketBook | null = null;
    let produced = 0;

    const interval = opts.intervalMs ?? 0;
    // Align to the interval grid so offline buckets land exactly where live
    // buckets would, making runs comparable across dates and machines.
    let nextBucket = interval > 0 ? (opts.fromMs / BigInt(interval)) * BigInt(interval) : 0n;

    const emitRows = (rows: NormalizedRow[], bucketMs: bigint): void => {
      for (const row of rows) {
        if (row.table !== 'book_samples') continue;
        produced += 1;
        opts.onRow({
          ...row.values,
          bucket_ts_ms: bucketMs.toString(),
          bucket_ts: new Date(Number(bucketMs)).toISOString(),
          market_ticker: marketTicker,
        });
      }
    };

    const bind = (book: MarketBook) => {
      if (bound === book) return;
      bound = book;
      if (interval > 0) sampler = samplerFor(book, interval, marketState);
    };

    /** Flush every grid point strictly before `atMs`, using pre-event state. */
    const flushClockTo = (atMs: bigint): void => {
      const active = sampler;
      if (interval <= 0 || !active) return;
      while (nextBucket < atMs && nextBucket <= opts.toMs) {
        if (nextBucket >= opts.fromMs) {
          emitRows(active.sample(Number(nextBucket), OFFLINE_SESSION), nextBucket);
        }
        nextBucket += BigInt(interval);
      }
    };

    const r = await replay(sql, {
      marketTicker,
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      onBeforeEvent: ({ atMs, book }) => {
        bind(book);
        // Sampling must reflect state as of the bucket, i.e. BEFORE the first
        // event after it. Sampling afterwards would fold in information the
        // live sampler could not have had at that instant.
        flushClockTo(atMs);
      },
      onPosition: ({ atMs, book }) => {
        bind(book);
        if (opts.mode === 'event-time') {
          produced += 1;
          opts.onRow(eventTimeRow(book, atMs));
        }
      },
    });

    if (!r.finalBook) {
      result.skippedMarkets.push(marketTicker);
      continue;
    }

    // Trailing grid points after the last event.
    const finalSampler = sampler;
    if (opts.mode === 'clock' && finalSampler) {
      while (nextBucket <= opts.toMs) {
        if (nextBucket >= opts.fromMs) {
          emitRows(finalSampler.sample(Number(nextBucket), OFFLINE_SESSION), nextBucket);
        }
        nextBucket += BigInt(interval);
      }
    }

    result.markets += 1;
    result.rows += produced;
  }

  logger.info(
    { event: 'materialize_complete', mode: opts.mode, markets: result.markets, rows: result.rows },
    `materialized ${result.rows} row(s) across ${result.markets} market(s)`,
  );

  return result;
}

/**
 * One row per book-changing event.
 *
 * Event time is what queue-depletion and order-flow studies actually want; a
 * clock grid either misses events or repeats unchanged state.
 */
function eventTimeRow(book: MarketBook, atMs: bigint): Record<string, unknown> {
  const bbo = book.getYesBBO();
  const d1 = book.getDepth(1);
  const d3 = book.getDepth(3);
  const d5 = book.getDepth(5);
  const d10 = book.getDepth(10);

  return {
    market_ticker: book.marketTicker,
    event_ts_ms: atMs.toString(),
    event_ts: new Date(Number(atMs)).toISOString(),
    seq: book.lastSeq?.toString() ?? null,
    yes_bid: bbo.bid?.toFixed(6) ?? null,
    yes_ask: bbo.ask?.toFixed(6) ?? null,
    bid_size: bbo.bidSize?.toFixed(6) ?? null,
    ask_size: bbo.askSize?.toFixed(6) ?? null,
    spread: bbo.spread?.toFixed(6) ?? null,
    mid: bbo.mid?.toFixed(6) ?? null,
    microprice: book.getMicroprice()?.toFixed(6) ?? null,
    bid_depth_1: d1.bid.toFixed(6),
    ask_depth_1: d1.ask.toFixed(6),
    bid_depth_3: d3.bid.toFixed(6),
    ask_depth_3: d3.ask.toFixed(6),
    bid_depth_5: d5.bid.toFixed(6),
    ask_depth_5: d5.ask.toFixed(6),
    bid_depth_10: d10.bid.toFixed(6),
    ask_depth_10: d10.ask.toFixed(6),
    imbalance_1: book.getImbalance(1)?.toFixed(8) ?? null,
    imbalance_3: book.getImbalance(3)?.toFixed(8) ?? null,
    imbalance_5: book.getImbalance(5)?.toFixed(8) ?? null,
    imbalance_10: book.getImbalance(10)?.toFixed(8) ?? null,
    yes_levels: book.levelCount.yes,
    no_levels: book.levelCount.no,
    book_state_hash: book.getStateHash(),
    book_valid: book.valid,
  };
}
