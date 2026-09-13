import { MarketBook } from '@/src/book/book';
import type { BookManager } from '@/src/book/bookManager';
import type { KalshiRestClient } from '@/src/kalshi/restClient';
import { MAX_ORDERBOOK_BATCH } from '@/src/kalshi/schemas';
import type { NormalizedRow } from '@/src/persistence/types';
import { integrityRow } from '@/src/persistence/repositories/integrity';
import { logger } from '@/src/logging/logger';

/**
 * REST order-book validation.
 *
 * The WebSocket stream is authoritative for history; REST is an INDEPENDENT
 * second opinion used to detect corruption. A mismatch never overwrites the
 * live book directly -- the correct response is to request a WebSocket recovery
 * snapshot, and only if that repeatedly fails does the session reconnect.
 *
 * Every validation result is persisted, matched or not, so the match rate over
 * any window is computable after the fact.
 */

export interface ValidatorOptions {
  rest: KalshiRestClient;
  books: BookManager;
  maxMarketsPerBatch?: number;
  /** Consecutive mismatches for one market before escalating to a reconnect. */
  mismatchEscalationThreshold?: number;
}

export interface ValidationOutcome {
  rows: NormalizedRow[];
  checked: number;
  matched: number;
  mismatched: string[];
  /** Markets that need a fresh WebSocket snapshot. */
  recoveryNeeded: string[];
  /** True when mismatches have persisted enough to warrant reconnecting. */
  escalate: boolean;
}

export class BookValidator {
  private readonly rest: KalshiRestClient;
  private readonly books: BookManager;
  private readonly maxBatch: number;
  private readonly escalationThreshold: number;

  private readonly consecutiveMismatches = new Map<string, number>();

  constructor(opts: ValidatorOptions) {
    this.rest = opts.rest;
    this.books = opts.books;
    this.maxBatch = Math.min(opts.maxMarketsPerBatch ?? MAX_ORDERBOOK_BATCH, MAX_ORDERBOOK_BATCH);
    this.escalationThreshold = opts.mismatchEscalationThreshold ?? 3;
  }

  /**
   * Compares local canonical books against REST books.
   *
   * Only VALID books are compared: a book we have already flagged as
   * untrustworthy would produce a mismatch that tells us nothing new.
   */
  async validate(tickers: string[], sessionId: string): Promise<ValidationOutcome> {
    const candidates = tickers.filter((t) => this.books.get(t)?.valid);
    const outcome: ValidationOutcome = {
      rows: [],
      checked: 0,
      matched: 0,
      mismatched: [],
      recoveryNeeded: [],
      escalate: false,
    };
    if (candidates.length === 0) return outcome;

    for (let i = 0; i < candidates.length; i += this.maxBatch) {
      const batch = candidates.slice(i, i + this.maxBatch);

      const requestStartedAt = new Date();
      let books: Map<string, { yes_dollars?: [string, string][] | null; no_dollars?: [string, string][] | null }>;
      try {
        books = await this.rest.getOrderbooks(batch);
      } catch (err) {
        logger.warn(
          { event: 'rest_validation_failed', err: String(err), marketCount: batch.length },
          'REST validation request failed',
        );
        outcome.rows.push(
          integrityRow({
            sessionId,
            type: 'rest_snapshot_mismatch',
            severity: 'warning',
            details: { stage: 'request_failed', error: String(err), markets: batch.length },
          }),
        );
        continue;
      }
      const requestCompletedAt = new Date();
      const latencyMs = requestCompletedAt.getTime() - requestStartedAt.getTime();

      for (const ticker of batch) {
        const local = this.books.get(ticker);
        const remote = books.get(ticker);
        if (!local || !remote) continue;

        // Rebuild the REST book through the same canonicalisation path as the
        // live book, so the hashes are comparable by construction.
        const restBook = new MarketBook(ticker);
        restBook.replaceWithSnapshot({
          yesBids: remote.yes_dollars ?? [],
          noBids: remote.no_dollars ?? [],
        });

        const localHash = local.getStateHash();
        const restHash = restBook.getStateHash();
        const matched = localHash === restHash;

        outcome.checked += 1;
        if (matched) {
          outcome.matched += 1;
          this.consecutiveMismatches.delete(ticker);
        } else {
          outcome.mismatched.push(ticker);
          outcome.recoveryNeeded.push(ticker);
          const streak = (this.consecutiveMismatches.get(ticker) ?? 0) + 1;
          this.consecutiveMismatches.set(ticker, streak);
          if (streak >= this.escalationThreshold) outcome.escalate = true;
        }

        outcome.rows.push({
          table: 'book_validations',
          values: {
            market_ticker: ticker,
            checked_at: requestCompletedAt,
            session_id: sessionId,
            local_seq: local.lastSeq?.toString() ?? null,
            local_state_hash: localHash,
            rest_state_hash: restHash,
            matched,
            local_level_count: local.levelCount.yes + local.levelCount.no,
            rest_level_count: restBook.levelCount.yes + restBook.levelCount.no,
            difference: matched ? null : diffBooks(local, restBook),
            request_started_at: requestStartedAt,
            request_completed_at: requestCompletedAt,
            request_latency_ms: latencyMs,
          },
        });

        if (!matched) {
          outcome.rows.push(
            integrityRow({
              sessionId,
              marketTicker: ticker,
              type: 'rest_snapshot_mismatch',
              severity: 'warning',
              details: {
                local_state_hash: localHash,
                rest_state_hash: restHash,
                local_seq: local.lastSeq?.toString() ?? null,
                consecutive: this.consecutiveMismatches.get(ticker),
              },
            }),
          );
        }
      }
    }

    if (outcome.mismatched.length > 0) {
      logger.warn(
        {
          event: 'book_validation_mismatch',
          checked: outcome.checked,
          mismatched: outcome.mismatched.length,
          escalate: outcome.escalate,
        },
        'local book disagreed with REST',
      );
    } else if (outcome.checked > 0) {
      logger.debug(
        { event: 'book_validation_ok', checked: outcome.checked },
        'all validated books matched REST',
      );
    }

    return outcome;
  }

  reset(ticker: string): void {
    this.consecutiveMismatches.delete(ticker);
  }
}

export interface BookDiff {
  yes: { price: string; local: string | null; rest: string | null }[];
  no: { price: string; local: string | null; rest: string | null }[];
}

/** Level-by-level difference, recorded so a mismatch can be diagnosed later. */
export function diffBooks(local: MarketBook, rest: MarketBook, maxEntries = 50): BookDiff {
  const out: BookDiff = { yes: [], no: [] };

  for (const side of ['yes', 'no'] as const) {
    const l = side === 'yes' ? local.yesBids : local.noBids;
    const r = side === 'yes' ? rest.yesBids : rest.noBids;

    for (const price of new Set([...l.keys(), ...r.keys()])) {
      const lv = l.get(price) ?? null;
      const rv = r.get(price) ?? null;
      if (lv === null || rv === null || !lv.eq(rv)) {
        out[side].push({
          price,
          local: lv?.toString() ?? null,
          rest: rv?.toString() ?? null,
        });
        if (out[side].length >= maxEntries) break;
      }
    }
  }

  return out;
}
