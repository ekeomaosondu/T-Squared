import { createHash } from 'node:crypto';
import { canonicalPrice, canonicalSize, type DecimalInput } from '@/src/book/decimal';

/**
 * Deterministic book hashing.
 *
 * The hash preimage is:
 *   market_ticker \n yes: <levels> \n no: <levels>
 * where levels are canonical "price@size" pairs sorted price-DESCENDING
 * (best bid first) and joined by ",". Zero-size levels are excluded -- a level
 * that has been fully removed and a level that never existed are the same book.
 *
 * Sorting is on the numeric value of the canonical string, which at a fixed 6
 * decimal places is equivalent to lexicographic ordering; we sort numerically
 * anyway so the invariant does not depend on that coincidence.
 */

export type LevelPair = readonly [string, string];

export function canonicalLevels(levels: Iterable<readonly [DecimalInput, DecimalInput]>): LevelPair[] {
  const out: LevelPair[] = [];
  for (const [price, size] of levels) {
    const p = canonicalPrice(price);
    const s = canonicalSize(size);
    if (Number(s) === 0) continue;
    out.push([p, s]);
  }
  out.sort((a, b) => Number(b[0]) - Number(a[0]));
  return out;
}

export function serializeLevels(levels: readonly LevelPair[]): string {
  return levels.map(([p, s]) => `${p}@${s}`).join(',');
}

export function hashBookState(
  marketTicker: string,
  yesLevels: readonly LevelPair[],
  noLevels: readonly LevelPair[],
): string {
  const preimage =
    `${marketTicker}\n` + `yes:${serializeLevels(yesLevels)}\n` + `no:${serializeLevels(noLevels)}`;
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/**
 * Hash over a whole event ladder, so a synchronised cross-strike sample can be
 * compared or deduplicated as one unit. Markets are sorted by ticker.
 */
export function hashLadderState(entries: Iterable<readonly [string, string | null]>): string {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const preimage = sorted.map(([ticker, hash]) => `${ticker}=${hash ?? 'null'}`).join('\n');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Bytes(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}
