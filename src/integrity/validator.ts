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
 * live book: the correct response is to request a WebSocket recovery snapshot,
 * and only persistent disagreement escalates to a reconnect.
 *
 * Timing is the hard part. A REST snapshot is created at some unobservable
 * instant between our request and our receipt of the response:
 *
 *     t0            request sent
 *     t0 + 10ms     local delta applied
 *     t0 + 20ms     REST server builds its snapshot   <-- the state we receive
 *     t0 + 30ms     local delta applied
 *     t1 = t0+60ms  response arrives
 *
 * Comparing that snapshot against the book "now" reports a mismatch on any
 * actively traded market, even though nothing is wrong. So a non-matching hash
 * is checked against every state the book actually passed through in
 * [t0 - tolerance, t1 + tolerance], reconstructed by rewinding the delta
 * journal. Only a book that matches NONE of those states is suspicious, and
 * even then it must fail a second, independent check before recovery is
 * triggered -- otherwise the validator itself destabilises a healthy recorder.
 */

export type ValidationOutcomeKind =
  /** REST agrees with the book as it stands right now. */
  | 'match_current'
  /** REST agrees with a state the book genuinely held during the request. */
  | 'match_recent'
  /** No match, but this is the first observation; re-checked before acting. */
  | 'mismatch_transient'
  /** No match on an independent re-check. This is actionable. */
  | 'mismatch_confirmed';

export interface ValidatorOptions {
  rest: KalshiRestClient;
  books: BookManager;
  maxMarketsPerBatch?: number;
  /**
   * How far either side of the request window a local state may lie and still
   * count as a match. Covers clock skew and REST-side staleness.
   */
  toleranceMs?: number;
  /** Consecutive CONFIRMED mismatches for one market before reconnecting. */
  mismatchEscalationThreshold?: number;
  clock?: () => number;
}

export interface MarketValidation {
  marketTicker: string;
  kind: ValidationOutcomeKind;
  localHash: string;
  restHash: string;
  /** For match_recent: when the matching local state was observed. */
  matchedAtMs: number | null;
  matchedSeq: bigint | null;
  statesConsidered: number;
}

export interface ValidationOutcome {
  rows: NormalizedRow[];
  checked: number;
  matchedCurrent: number;
  matchedRecent: number;
  transient: number;
  confirmed: number;
  results: MarketValidation[];
  /** Markets needing a WebSocket recovery snapshot (confirmed only). */
  recoveryNeeded: string[];
  /** True when confirmed mismatches have persisted enough to reconnect. */
  escalate: boolean;
}

interface RestBook {
  yes_dollars?: [string, string][] | null;
  no_dollars?: [string, string][] | null;
}

export class BookValidator {
  private readonly rest: KalshiRestClient;
  private readonly books: BookManager;
  private readonly maxBatch: number;
  private readonly toleranceMs: number;
  private readonly escalationThreshold: number;
  private readonly clock: () => number;

  /** Markets whose previous check was an unconfirmed mismatch. */
  private readonly pendingRecheck = new Set<string>();
  private readonly consecutiveConfirmed = new Map<string, number>();

  constructor(opts: ValidatorOptions) {
    this.rest = opts.rest;
    this.books = opts.books;
    this.maxBatch = Math.min(opts.maxMarketsPerBatch ?? MAX_ORDERBOOK_BATCH, MAX_ORDERBOOK_BATCH);
    this.toleranceMs = opts.toleranceMs ?? 2_000;
    this.escalationThreshold = opts.mismatchEscalationThreshold ?? 2;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Compares local canonical books against REST books.
   *
   * Only VALID books are compared: one we have already flagged as untrustworthy
   * would mismatch for reasons we already know about.
   */
  async validate(tickers: string[], sessionId: string): Promise<ValidationOutcome> {
    const candidates = tickers.filter((t) => this.books.get(t)?.valid);

    const outcome: ValidationOutcome = {
      rows: [],
      checked: 0,
      matchedCurrent: 0,
      matchedRecent: 0,
      transient: 0,
      confirmed: 0,
      results: [],
      recoveryNeeded: [],
      escalate: false,
    };
    if (candidates.length === 0) return outcome;

    for (let i = 0; i < candidates.length; i += this.maxBatch) {
      const batch = candidates.slice(i, i + this.maxBatch);

      const t0 = this.clock();
      const requestStartedAt = new Date(t0);
      let books: Map<string, RestBook>;
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
      const t1 = this.clock();
      const requestCompletedAt = new Date(t1);

      for (const ticker of batch) {
        const local = this.books.get(ticker);
        const remote = books.get(ticker);
        if (!local || !remote) continue;

        const result = this.compare(local, remote, t0, t1);
        outcome.checked += 1;
        outcome.results.push(result);

        this.tally(outcome, result);

        outcome.rows.push({
          table: 'book_validations',
          values: {
            market_ticker: ticker,
            checked_at: requestCompletedAt,
            session_id: sessionId,
            local_seq: local.lastSeq?.toString() ?? null,
            local_state_hash: result.localHash,
            rest_state_hash: result.restHash,
            // A state the book genuinely held during the request counts as
            // agreement; only an unexplainable book is a mismatch.
            matched: result.kind === 'match_current' || result.kind === 'match_recent',
            match_kind: result.kind,
            matched_at_ms: result.matchedAtMs === null ? null : String(result.matchedAtMs),
            matched_local_seq: result.matchedSeq?.toString() ?? null,
            states_considered: result.statesConsidered,
            local_level_count: local.levelCount.yes + local.levelCount.no,
            rest_level_count: countLevels(remote),
            difference:
              result.kind === 'mismatch_confirmed' ? diffBooks(local, restBookOf(ticker, remote)) : null,
            request_started_at: requestStartedAt,
            request_completed_at: requestCompletedAt,
            request_latency_ms: t1 - t0,
          },
        });

        if (result.kind === 'mismatch_confirmed') {
          outcome.recoveryNeeded.push(ticker);
          const streak = (this.consecutiveConfirmed.get(ticker) ?? 0) + 1;
          this.consecutiveConfirmed.set(ticker, streak);
          if (streak >= this.escalationThreshold) outcome.escalate = true;

          outcome.rows.push(
            integrityRow({
              sessionId,
              marketTicker: ticker,
              type: 'rest_snapshot_mismatch',
              severity: 'error',
              details: {
                local_state_hash: result.localHash,
                rest_state_hash: result.restHash,
                local_seq: local.lastSeq?.toString() ?? null,
                states_considered: result.statesConsidered,
                consecutive_confirmed: streak,
                window_ms: t1 - t0,
              },
            }),
          );
        } else if (result.kind !== 'mismatch_transient') {
          this.consecutiveConfirmed.delete(ticker);
        }
      }
    }

    this.log(outcome);
    return outcome;
  }

  /**
   * Classifies one market.
   *
   * A market that mismatched on the previous pass is being re-checked, so a
   * second failure is confirmed. Anything else starts as transient.
   */
  private compare(local: MarketBook, remote: RestBook, t0: number, t1: number): MarketValidation {
    const restBook = restBookOf(local.marketTicker, remote);
    const restHash = restBook.getStateHash();
    const localHash = local.getStateHash();

    if (localHash === restHash) {
      this.pendingRecheck.delete(local.marketTicker);
      return {
        marketTicker: local.marketTicker,
        kind: 'match_current',
        localHash,
        restHash,
        matchedAtMs: null,
        matchedSeq: null,
        statesConsidered: 1,
      };
    }

    // The REST snapshot was built somewhere inside the request window; compare
    // against every state the book actually passed through there.
    const states = local.historicalStates(t0 - this.toleranceMs);
    const hit = states.find((s) => s.hash === restHash && s.atMs <= t1 + this.toleranceMs);

    if (hit) {
      this.pendingRecheck.delete(local.marketTicker);
      return {
        marketTicker: local.marketTicker,
        kind: 'match_recent',
        localHash,
        restHash,
        matchedAtMs: hit.atMs,
        matchedSeq: hit.seq,
        statesConsidered: states.length,
      };
    }

    const wasPending = this.pendingRecheck.has(local.marketTicker);
    if (wasPending) this.pendingRecheck.delete(local.marketTicker);
    else this.pendingRecheck.add(local.marketTicker);

    return {
      marketTicker: local.marketTicker,
      kind: wasPending ? 'mismatch_confirmed' : 'mismatch_transient',
      localHash,
      restHash,
      matchedAtMs: null,
      matchedSeq: null,
      statesConsidered: states.length,
    };
  }

  /** Markets awaiting a confirming re-check; the caller schedules it promptly. */
  get awaitingRecheck(): string[] {
    return [...this.pendingRecheck];
  }

  private tally(outcome: ValidationOutcome, r: MarketValidation): void {
    if (r.kind === 'match_current') outcome.matchedCurrent += 1;
    else if (r.kind === 'match_recent') outcome.matchedRecent += 1;
    else if (r.kind === 'mismatch_transient') outcome.transient += 1;
    else outcome.confirmed += 1;
  }

  private log(outcome: ValidationOutcome): void {
    if (outcome.checked === 0) return;

    if (outcome.confirmed > 0) {
      logger.error(
        {
          event: 'book_validation_confirmed_mismatch',
          checked: outcome.checked,
          confirmed: outcome.confirmed,
          escalate: outcome.escalate,
        },
        'local book disagreed with REST on an independent re-check',
      );
    } else if (outcome.transient > 0) {
      logger.warn(
        {
          event: 'book_validation_transient',
          checked: outcome.checked,
          transient: outcome.transient,
        },
        'REST disagreed with every recent local state; re-checking before acting',
      );
    } else {
      logger.debug(
        {
          event: 'book_validation_ok',
          checked: outcome.checked,
          matchedCurrent: outcome.matchedCurrent,
          matchedRecent: outcome.matchedRecent,
        },
        'all validated books agreed with REST',
      );
    }
  }

  reset(ticker: string): void {
    this.pendingRecheck.delete(ticker);
    this.consecutiveConfirmed.delete(ticker);
  }
}

function restBookOf(ticker: string, remote: RestBook): MarketBook {
  // Rebuilt through the same canonicalisation path as the live book, so the
  // hashes are comparable by construction.
  const book = new MarketBook(ticker);
  book.replaceWithSnapshot({ yesBids: remote.yes_dollars ?? [], noBids: remote.no_dollars ?? [] });
  return book;
}

function countLevels(remote: RestBook): number {
  return (remote.yes_dollars?.length ?? 0) + (remote.no_dollars?.length ?? 0);
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
        out[side].push({ price, local: lv?.toString() ?? null, rest: rv?.toString() ?? null });
        if (out[side].length >= maxEntries) break;
      }
    }
  }

  return out;
}
