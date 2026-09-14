import { Decimal, ZERO } from '@/src/book/decimal';
import type { SimulatedFill } from '@/src/research/execution/simulatedExchange';
import type { FillMarkout } from '@/src/research/metrics/markouts';

/**
 * PnL attribution and conditional breakdowns.
 *
 * A single net figure hides everything worth knowing. The same strategy can be
 * profitable in wide spreads and ruinous in tight ones, fine on the front
 * contract and hopeless on the back, and a headline number averages the two
 * into an answer that is true of nothing.
 *
 * So results are cut by the dimensions a market maker can actually act on:
 * where it traded, when, and what the book looked like at the time.
 */

export interface BucketStats {
  bucket: string;
  fills: number;
  contracts: string;
  notional: string;
  fees: string;
  /** Mean half-spread captured, dollars per contract. */
  spreadCaptured: string | null;
  /** Mean markout at the summary horizon, dollars per contract. */
  markout: string | null;
  /** Share of fills with a negative markout at the summary horizon. */
  adverseRate: string | null;
}

export interface Breakdown {
  dimension: string;
  buckets: BucketStats[];
}

/** Horizon the per-bucket markout columns are reported at. */
export const BUCKET_MARKOUT_HORIZON_MS = 1_000;

interface Accumulator {
  fills: number;
  contracts: Decimal;
  notional: Decimal;
  fees: Decimal;
  spreadSum: Decimal;
  spreadObs: number;
  markoutSum: Decimal;
  markoutObs: number;
  adverse: number;
}

const emptyAcc = (): Accumulator => ({
  fills: 0,
  contracts: ZERO,
  notional: ZERO,
  fees: ZERO,
  spreadSum: ZERO,
  spreadObs: 0,
  markoutSum: ZERO,
  markoutObs: 0,
  adverse: 0,
});

/**
 * Buckets a value onto a fixed ladder, so runs are comparable.
 *
 * Quantile bucketing would make every run's buckets depend on that run's own
 * distribution, which is exactly what a comparison table must not do.
 */
function spreadBucket(spread: Decimal | null): string {
  if (spread === null) return 'unknown';
  const cents = spread.mul(100);
  if (cents.lte(1)) return '<=1c';
  if (cents.lte(2)) return '2c';
  if (cents.lte(3)) return '3c';
  if (cents.lte(5)) return '4-5c';
  if (cents.lte(10)) return '6-10c';
  return '>10c';
}

function depthBucket(depth: Decimal | null): string {
  if (depth === null) return 'unknown';
  if (depth.lte(50)) return '<=50';
  if (depth.lte(200)) return '51-200';
  if (depth.lte(1000)) return '201-1000';
  return '>1000';
}

function imbalanceBucket(imbalance: Decimal | null): string {
  if (imbalance === null) return 'unknown';
  const v = imbalance.toNumber();
  if (v <= -0.6) return '[-1.0,-0.6]';
  if (v <= -0.2) return '(-0.6,-0.2]';
  if (v < 0.2) return '(-0.2,0.2)';
  if (v < 0.6) return '[0.2,0.6)';
  return '[0.6,1.0]';
}

/**
 * Days from the fill to the market's own event date, parsed from the ticker.
 *
 * KXHIGHNY-26SEP13-B78.5 settles on the 13th. Kalshi does not publish the
 * settlement TIME in anything the silver lake carries, so this is a day-level
 * proxy rather than the time-to-settlement a term-structure study would want.
 * Labelled as a proxy so nobody mistakes it for one.
 */
export function daysToEventDate(marketTicker: string, atMs: bigint): string {
  const m = /-(\d{2})([A-Z]{3})(\d{2})-/.exec(marketTicker);
  if (!m) return 'unknown';
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[m[2]!];
  if (month === undefined) return 'unknown';
  const eventDay = Date.UTC(2000 + Number(m[1]), month, Number(m[3]));
  const fillDay = new Date(Number(atMs));
  const fillDayUtc = Date.UTC(fillDay.getUTCFullYear(), fillDay.getUTCMonth(), fillDay.getUTCDate());
  return `D+${Math.round((eventDay - fillDayUtc) / 86_400_000)}`;
}

export function computeBreakdowns(
  fills: readonly SimulatedFill[],
  markouts: readonly FillMarkout[],
  horizonMs: number = BUCKET_MARKOUT_HORIZON_MS,
): Breakdown[] {
  const markoutByFill = new Map(markouts.map((m) => [m.fillId, m]));
  const key = String(horizonMs);

  const dimensions: { dimension: string; of: (f: SimulatedFill) => string }[] = [
    { dimension: 'market', of: (f) => f.marketTicker },
    { dimension: 'event', of: (f) => f.marketTicker.split('-').slice(0, 2).join('-') },
    { dimension: 'series', of: (f) => f.marketTicker.split('-')[0] ?? 'unknown' },
    {
      dimension: 'hour_utc',
      of: (f) => `${String(new Date(Number(f.filledAtMs)).getUTCHours()).padStart(2, '0')}:00`,
    },
    { dimension: 'days_to_event_date', of: (f) => daysToEventDate(f.marketTicker, f.filledAtMs) },
    { dimension: 'spread', of: (f) => spreadBucket(f.spreadAtFill) },
    { dimension: 'depth_1', of: (f) => depthBucket(f.depth1AtFill) },
    { dimension: 'imbalance_1', of: (f) => imbalanceBucket(f.imbalance1AtFill) },
    { dimension: 'liquidity', of: (f) => f.liquidity },
    { dimension: 'fill_reason', of: (f) => f.reason },
  ];

  return dimensions.map(({ dimension, of }) => {
    const acc = new Map<string, Accumulator>();

    for (const fill of fills) {
      const bucket = of(fill);
      let a = acc.get(bucket);
      if (!a) {
        a = emptyAcc();
        acc.set(bucket, a);
      }
      a.fills += 1;
      a.contracts = a.contracts.plus(fill.quantity);
      a.notional = a.notional.plus(fill.quantity.mul(fill.yesPrice));
      a.fees = a.fees.plus(fill.fee);

      if (fill.liquidity === 'maker' && fill.midAtFill !== null) {
        const captured =
          fill.yesAction === 'buy'
            ? fill.midAtFill.minus(fill.yesPrice)
            : fill.yesPrice.minus(fill.midAtFill);
        a.spreadSum = a.spreadSum.plus(captured);
        a.spreadObs += 1;
      }

      const value = markoutByFill.get(fill.fillId)?.markouts[key];
      if (value !== null && value !== undefined) {
        const d = new Decimal(value);
        a.markoutSum = a.markoutSum.plus(d);
        a.markoutObs += 1;
        if (d.isNegative()) a.adverse += 1;
      }
    }

    const buckets: BucketStats[] = [...acc.entries()]
      .map(([bucket, a]) => ({
        bucket,
        fills: a.fills,
        contracts: a.contracts.toFixed(6),
        notional: a.notional.toFixed(6),
        fees: a.fees.toFixed(6),
        spreadCaptured: a.spreadObs === 0 ? null : a.spreadSum.div(a.spreadObs).toFixed(8),
        markout: a.markoutObs === 0 ? null : a.markoutSum.div(a.markoutObs).toFixed(8),
        adverseRate:
          a.markoutObs === 0 ? null : new Decimal(a.adverse).div(a.markoutObs).toFixed(6),
      }))
      .sort((x, y) => (x.bucket < y.bucket ? -1 : x.bucket > y.bucket ? 1 : 0));

    return { dimension, buckets };
  });
}
