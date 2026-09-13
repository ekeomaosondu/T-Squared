import Decimal from 'decimal.js';

/**
 * Exact decimal arithmetic for all exchange state.
 *
 * JavaScript floating point is NEVER used for prices or quantities. Every
 * price and size that enters the system becomes a Decimal immediately and
 * leaves it as a canonical fixed-point string, which is also what Postgres
 * NUMERIC receives and what the state hash is computed over.
 */

// 34 significant digits is far beyond anything Kalshi quotes; the point is
// that intermediate arithmetic (microprice, imbalance) never silently loses
// precision. ROUND_HALF_EVEN only ever applies to derived features -- raw
// exchange values are exact at these scales.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -19, toExpPos: 34 });

export { Decimal };

/** Decimal places used for canonical price strings and NUMERIC(12,6). */
export const PRICE_DP = 6;
/** Decimal places used for canonical size strings and NUMERIC(24,6). */
export const SIZE_DP = 6;

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

export type DecimalInput = Decimal | string | number;

export function D(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

/**
 * Canonical price string, e.g. "0.420000". This exact form is used as the
 * in-memory book key, in the canonical JSON, and in the hash preimage, so it
 * must be stable across processes and versions.
 */
export function canonicalPrice(value: DecimalInput): string {
  return D(value).toFixed(PRICE_DP, Decimal.ROUND_HALF_EVEN);
}

export function canonicalSize(value: DecimalInput): string {
  return D(value).toFixed(SIZE_DP, Decimal.ROUND_HALF_EVEN);
}

/**
 * Kalshi quotes integer cents (1..99). Converting via Decimal keeps 37c as
 * exactly 0.37, which `37 / 100` in binary floating point does not.
 */
export function centsToPrice(cents: DecimalInput): Decimal {
  return D(cents).div(100);
}

export function priceToCents(price: DecimalInput): Decimal {
  return D(price).mul(100);
}

/** YES ask implied by a NO bid: an ask at 1 - q. */
export function yesAskFromNoBid(noBidPrice: DecimalInput): Decimal {
  return ONE.minus(D(noBidPrice));
}

/** Inverse of {@link yesAskFromNoBid}. */
export function noBidFromYesAsk(yesAskPrice: DecimalInput): Decimal {
  return ONE.minus(D(yesAskPrice));
}

export class DecimalRangeError extends Error {
  constructor(
    message: string,
    readonly value: string,
  ) {
    super(message);
    this.name = 'DecimalRangeError';
  }
}

/**
 * Contract prices are probabilities and must lie in [0, 1]. A violation is an
 * integrity event, not something to clamp away.
 */
export function assertPriceInRange(value: Decimal, context: string): void {
  if (!value.isFinite() || value.lt(0) || value.gt(1)) {
    throw new DecimalRangeError(
      `${context}: price ${value.toString()} is outside [0, 1]`,
      value.toString(),
    );
  }
}

export function assertNonNegativeSize(value: Decimal, context: string): void {
  if (!value.isFinite() || value.lt(0)) {
    throw new DecimalRangeError(
      `${context}: size ${value.toString()} is negative`,
      value.toString(),
    );
  }
}

/** Parses a NUMERIC returned by postgres.js (always a string) back to Decimal. */
export function fromNumeric(value: string | null | undefined): Decimal | null {
  return value === null || value === undefined ? null : new Decimal(value);
}

/** Formats a Decimal for a NUMERIC column, preserving null. */
export function toNumeric(value: Decimal | null | undefined, dp = PRICE_DP): string | null {
  return value === null || value === undefined ? null : value.toFixed(dp, Decimal.ROUND_HALF_EVEN);
}
