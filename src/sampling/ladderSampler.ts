import { randomUUID } from 'node:crypto';
import type { BookManager } from '@/src/book/bookManager';
import { PRICE_DP, SIZE_DP, toNumeric } from '@/src/book/decimal';
import { hashLadderState } from '@/src/book/hashing';
import type { MarketStateCache } from '@/src/collector/marketState';
import type { LadderMarketRow } from '@/src/persistence/repositories/metadata';
import type { NormalizedRow } from '@/src/persistence/types';
import { bucketFor } from '@/src/sampling/bookSampler';

/**
 * Synchronised event-ladder sampling.
 *
 * For KXHIGH/KXLOW an event is a set of mutually exclusive temperature
 * buckets, and the interesting questions are cross-strike: distribution shape,
 * probability-mass migration, liquidity migration, relative value. Those are
 * only answerable if every strike in the ladder is read at ONE instant.
 *
 * So the books are cloned synchronously into a point-in-time set before any
 * feature computation happens. Contracts are never read at slightly different
 * moments and later presented as simultaneous.
 *
 * Probabilities are NOT normalised to sum to one. What the market actually
 * showed is what gets stored, including when it is internally inconsistent --
 * that inconsistency is frequently the signal.
 */

export interface LadderSamplerOptions {
  books: BookManager;
  marketState: MarketStateCache;
  intervalsMs: number[];
}

export interface LadderSampleResult {
  rows: NormalizedRow[];
  groups: number;
}

export class LadderSampler {
  private readonly books: BookManager;
  private readonly marketState: MarketStateCache;
  private readonly intervals: number[];
  private readonly lastBucket = new Map<string, number>();

  constructor(opts: LadderSamplerOptions) {
    this.books = opts.books;
    this.marketState = opts.marketState;
    this.intervals = [...opts.intervalsMs].sort((a, b) => a - b);
  }

  get sampleIntervals(): number[] {
    return [...this.intervals];
  }

  /**
   * @param ladders event_ticker -> the event's markets, from the OFFICIAL
   *   event/market relationship persisted at discovery time.
   */
  sample(
    nowMs: number,
    ladders: Map<string, LadderMarketRow[]>,
    seriesByEvent: (eventTicker: string) => string | null,
  ): LadderSampleResult {
    const rows: NormalizedRow[] = [];
    let groups = 0;

    for (const intervalMs of this.intervals) {
      const bucket = bucketFor(nowMs, intervalMs);

      for (const [eventTicker, markets] of ladders) {
        const key = `${intervalMs}:${eventTicker}`;
        if (this.lastBucket.get(key) === bucket) continue;
        this.lastBucket.set(key, bucket);

        const seriesTicker = seriesByEvent(eventTicker);
        if (!seriesTicker) continue;

        // ---- the synchronised instant ------------------------------------
        // Clone every book in the ladder before computing anything, so all
        // strikes reflect the same moment.
        const frozen = this.books.snapshotAll(markets.map((m) => m.market_ticker));

        const groupId = randomUUID();
        const sampleRows: NormalizedRow[] = [];
        const hashInputs: [string, string | null][] = [];
        let captured = 0;

        for (const market of markets) {
          const book = frozen.get(market.market_ticker);
          if (!book) {
            hashInputs.push([market.market_ticker, null]);
            continue;
          }

          captured += 1;
          const bbo = book.getYesBBO();
          const state = this.marketState.get(market.market_ticker);
          hashInputs.push([market.market_ticker, book.valid ? book.getStateHash() : null]);

          sampleRows.push({
            table: 'event_ladder_samples',
            values: {
              sample_group_id: groupId,
              market_ticker: market.market_ticker,
              floor_strike: market.floor_strike,
              cap_strike: market.cap_strike,
              strike_type: market.strike_type,
              functional_strike: market.functional_strike,
              yes_bid: toNumeric(bbo.bid, PRICE_DP),
              yes_ask: toNumeric(bbo.ask, PRICE_DP),
              bid_size: toNumeric(bbo.bidSize, SIZE_DP),
              ask_size: toNumeric(bbo.askSize, SIZE_DP),
              mid: toNumeric(bbo.mid, PRICE_DP),
              microprice: toNumeric(book.getMicroprice(), PRICE_DP),
              last_trade_price: toNumeric(state?.lastTradePrice ?? null, PRICE_DP),
              volume: toNumeric(state?.volume ?? null, SIZE_DP),
              open_interest: toNumeric(state?.openInterest ?? null, SIZE_DP),
              source_seq: book.lastSeq?.toString() ?? null,
              book_state_hash: book.getStateHash(),
              book_valid: book.valid,
            },
          });
        }

        if (sampleRows.length === 0) continue;

        groups += 1;
        rows.push({
          table: 'event_ladder_sample_groups',
          values: {
            sample_group_id: groupId,
            event_ticker: eventTicker,
            series_ticker: seriesTicker,
            interval_ms: intervalMs,
            sampled_at: new Date(bucket),
            sampled_at_ms: String(bucket),
            expected_market_count: markets.length,
            captured_market_count: captured,
            // False when any strike in the official ladder was missing, so
            // research can exclude partial cross-strike observations.
            complete: captured === markets.length,
            ladder_state_hash: hashLadderState(hashInputs),
          },
        });
        rows.push(...sampleRows);
      }
    }

    return { rows, groups };
  }
}
