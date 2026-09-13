import { createHash } from 'node:crypto';
import { Decimal } from '@/src/book/decimal';
import { canonicalJson } from '@/src/config/collectorConfig';

/**
 * Wire-value -> column-value conversions.
 *
 * Kept separate from both the Kalshi schemas and the repositories so that
 * exchange parsing and storage stay decoupled.
 */

/** RFC3339 string -> Date. Empty strings and unparseable values become null. */
export function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    // Kalshi lifecycle timestamps are seconds; ticker/trade are milliseconds.
    // Anything below this threshold cannot be a sane millisecond timestamp.
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Unix epoch milliseconds from a Kalshi seconds-or-millis field. */
export function toEpochMs(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(value < 1e11 ? Math.round(value * 1000) : Math.round(value));
}

/**
 * Decimal string for a NUMERIC column. Values arrive from Kalshi as strings and
 * stay strings -- they are never routed through a JS number.
 */
export function toNumericString(
  value: string | number | Decimal | null | undefined,
  dp?: number,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Decimal ? value : new Decimal(value);
  if (!d.isFinite()) return null;
  return dp === undefined ? d.toString() : d.toFixed(dp, Decimal.ROUND_HALF_EVEN);
}

export function toBigIntString(value: bigint | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return BigInt(value).toString();
}

/** Empty string -> null, so "no result yet" is not stored as a value. */
export function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * Stable hash of a metadata object, used to detect real changes. Computed over
 * canonical JSON so key ordering cannot produce a spurious new version.
 */
export function versionHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Fields that define a market's STRUCTURAL identity.
 *
 * market_metadata_versions exists to make rule, strike, close-time and status
 * changes auditable. A market object also carries live quote and volume fields
 * (yes_bid_dollars, volume_fp, open_interest_fp, ...) which change on every
 * trade -- hashing those would mint a new "metadata version" on every discovery
 * poll and bury the handful of real changes under thousands of rows.
 *
 * This is an ALLOWLIST rather than a denylist of volatile fields: if Kalshi
 * adds another quote field later, a denylist would silently start generating
 * spurious versions again. The cost is that a genuinely new structural field
 * needs adding here, which is the safer direction to fail in.
 *
 * The full observed object is still stored in the row's `raw` column.
 */
export const MARKET_STRUCTURAL_FIELDS = [
  'ticker',
  'event_ticker',
  'market_type',
  'title',
  'subtitle',
  'yes_sub_title',
  'no_sub_title',
  'status',
  'strike_type',
  'floor_strike',
  'cap_strike',
  'functional_strike',
  'custom_strike',
  'price_level_structure',
  'price_ranges',
  'created_time',
  'open_time',
  'close_time',
  'expected_expiration_time',
  'latest_expiration_time',
  'expiration_time',
  'occurrence_datetime',
  'settlement_timer_seconds',
  'can_close_early',
  'early_close_condition',
  'rules_primary',
  'rules_secondary',
  'result',
  'expiration_value',
  'settlement_value_dollars',
  'notional_value_dollars',
  'response_price_units',
] as const;

/** Structural-only hash used as the market_metadata_versions identity. */
export function marketVersionHash(market: Record<string, unknown>): string {
  const structural: Record<string, unknown> = {};
  for (const field of MARKET_STRUCTURAL_FIELDS) {
    if (field in market) structural[field] = market[field];
  }
  return versionHash(structural);
}
