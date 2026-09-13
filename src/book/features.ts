import type { MarketBook } from '@/src/book/book';
import { Decimal, PRICE_DP, SIZE_DP, toNumeric } from '@/src/book/decimal';

/**
 * Derived features computed from a reconstructed book.
 *
 * Every field is nullable and nothing is imputed. A missing BBO stays missing,
 * and a zero denominator yields null rather than a placeholder value, so that
 * downstream research can distinguish "no market" from "balanced market".
 */

export const DEPTH_LEVELS = [1, 3, 5, 10] as const;
export type DepthLevel = (typeof DEPTH_LEVELS)[number];

export interface BookFeatures {
  yesBid: Decimal | null;
  yesAsk: Decimal | null;
  bidSize: Decimal | null;
  askSize: Decimal | null;
  spread: Decimal | null;
  mid: Decimal | null;
  microprice: Decimal | null;
  depth: Record<DepthLevel, { bid: Decimal; ask: Decimal }>;
  imbalance: Record<DepthLevel, Decimal | null>;
  stateHash: string;
  valid: boolean;
  lastSeq: bigint | null;
}

export function computeFeatures(book: MarketBook): BookFeatures {
  const bbo = book.getYesBBO();

  const depth = {} as Record<DepthLevel, { bid: Decimal; ask: Decimal }>;
  const imbalance = {} as Record<DepthLevel, Decimal | null>;
  for (const k of DEPTH_LEVELS) {
    depth[k] = book.getDepth(k);
    imbalance[k] = book.getImbalance(k);
  }

  return {
    yesBid: bbo.bid,
    yesAsk: bbo.ask,
    bidSize: bbo.bidSize,
    askSize: bbo.askSize,
    spread: bbo.spread,
    mid: bbo.mid,
    microprice: book.getMicroprice(),
    depth,
    imbalance,
    stateHash: book.getStateHash(),
    valid: book.valid,
    lastSeq: book.lastSeq,
  };
}

/** Maps features onto the book_samples column set. */
export function featuresToSampleColumns(f: BookFeatures): Record<string, unknown> {
  return {
    yes_bid: toNumeric(f.yesBid, PRICE_DP),
    yes_ask: toNumeric(f.yesAsk, PRICE_DP),
    bid_size: toNumeric(f.bidSize, SIZE_DP),
    ask_size: toNumeric(f.askSize, SIZE_DP),
    spread: toNumeric(f.spread, PRICE_DP),
    mid: toNumeric(f.mid, PRICE_DP),
    microprice: toNumeric(f.microprice, PRICE_DP),

    bid_depth_1: toNumeric(f.depth[1].bid, SIZE_DP),
    ask_depth_1: toNumeric(f.depth[1].ask, SIZE_DP),
    bid_depth_3: toNumeric(f.depth[3].bid, SIZE_DP),
    ask_depth_3: toNumeric(f.depth[3].ask, SIZE_DP),
    bid_depth_5: toNumeric(f.depth[5].bid, SIZE_DP),
    ask_depth_5: toNumeric(f.depth[5].ask, SIZE_DP),
    bid_depth_10: toNumeric(f.depth[10].bid, SIZE_DP),
    ask_depth_10: toNumeric(f.depth[10].ask, SIZE_DP),

    imbalance_1: toNumeric(f.imbalance[1], 8),
    imbalance_3: toNumeric(f.imbalance[3], 8),
    imbalance_5: toNumeric(f.imbalance[5], 8),
    imbalance_10: toNumeric(f.imbalance[10], 8),

    book_state_hash: f.stateHash,
    book_valid: f.valid,
    source_seq: f.lastSeq?.toString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Consistency assertions (spec section 43)
// ---------------------------------------------------------------------------

export type ConsistencyIssue =
  | { kind: 'price_out_of_range'; side: 'yes' | 'no'; price: string }
  | { kind: 'negative_size'; side: 'yes' | 'no'; price: string; size: string }
  | { kind: 'crossed_book'; bid: string; ask: string };

/**
 * Checks invariants that should hold for a well-formed book.
 *
 * A crossed book is reported, NOT corrected: the exchange can genuinely cross
 * transiently and that is real data worth keeping.
 */
export function checkConsistency(book: MarketBook): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  for (const [side, levels] of [
    ['yes', book.yesBids] as const,
    ['no', book.noBids] as const,
  ]) {
    for (const [price, size] of levels) {
      const p = new Decimal(price);
      if (p.lt(0) || p.gt(1)) issues.push({ kind: 'price_out_of_range', side, price });
      if (size.isNegative()) issues.push({ kind: 'negative_size', side, price, size: size.toString() });
    }
  }

  const { bid, ask } = book.getYesBBO();
  if (bid && ask && bid.gt(ask)) {
    issues.push({ kind: 'crossed_book', bid: bid.toString(), ask: ask.toString() });
  }

  return issues;
}
