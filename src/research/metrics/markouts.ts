import { Decimal } from '@/src/book/decimal';
import type { SimulatedFill } from '@/src/research/execution/simulatedExchange';
import type { MidSeries, MidSeriesStore } from '@/src/research/metrics/midSeries';

/**
 * Post-fill markouts.
 *
 * For a passive fill, the honest question is not "did the position make money
 * eventually" but "where was the market a moment after we traded". If the mid
 * moves against us within a hundred milliseconds of every fill, we are being
 * picked off, and no amount of favourable settlement luck changes that.
 *
 * Markouts are the most trustworthy number this platform produces at Phase 1,
 * more so than PnL, because they depend only on:
 *
 *   - the fill time and price, which the simulator chose
 *   - the recorded mid afterwards, which is data
 *
 * and NOT on the queue model, the fee schedule or the settlement outcome. Two
 * fill models will disagree about how many fills happened; they will not
 * disagree about what the market did after one.
 *
 * Computed entirely after the run, from a recorded series. Nothing here is
 * reachable from strategy state -- that is the whole reason it lives in a
 * separate pass.
 */

export const MARKOUT_HORIZONS_MS = [50, 100, 250, 500, 1_000, 5_000, 30_000] as const;
export type MarkoutHorizonMs = (typeof MARKOUT_HORIZONS_MS)[number];

export type MarkoutReference = 'mid' | 'microprice';

export interface FillMarkout {
  fillId: string;
  orderId: string;
  marketTicker: string;
  filledAtMs: string;
  liquidity: string;
  reason: string;
  /** 'buy' or 'sell' in YES terms. */
  yesAction: string;
  yesPrice: string;
  quantity: string;
  referencePrice: string | null;
  reference: MarkoutReference;
  /** Per-horizon, sign-normalized so POSITIVE is always favourable. */
  markouts: Record<string, string | null>;
  /** Per-horizon markout in dollars, i.e. markout * quantity. */
  markoutDollars: Record<string, string | null>;
}

function referenceAt(series: MidSeries, atMs: number, reference: MarkoutReference): Decimal | null {
  return reference === 'mid' ? series.midAt(atMs) : series.micropriceAt(atMs);
}

/**
 * Markout of one fill at one horizon.
 *
 * Sign convention: POSITIVE is favourable to us, always.
 *
 *   bought YES at p, mid later m  ->  m - p
 *   sold   YES at p, mid later m  ->  p - m
 *
 * so a maker whose fills are systematically followed by the mid running away
 * from them shows negative markouts regardless of which side it was on. That
 * uniformity is the point: adverse selection is a single number, not one
 * number per direction that has to be mentally sign-flipped.
 */
export function markoutOf(
  yesAction: 'buy' | 'sell',
  fillPrice: Decimal,
  futureReference: Decimal | null,
): Decimal | null {
  if (futureReference === null) return null;
  return yesAction === 'buy' ? futureReference.minus(fillPrice) : fillPrice.minus(futureReference);
}

export function computeMarkouts(
  fills: readonly SimulatedFill[],
  series: MidSeriesStore,
  reference: MarkoutReference = 'mid',
  horizons: readonly number[] = MARKOUT_HORIZONS_MS,
): FillMarkout[] {
  const out: FillMarkout[] = [];

  for (const fill of fills) {
    const s = series.get(fill.marketTicker);
    const filledAt = Number(fill.filledAtMs);

    const markouts: Record<string, string | null> = {};
    const markoutDollars: Record<string, string | null> = {};

    const ref = s ? referenceAt(s, filledAt, reference) : null;

    for (const h of horizons) {
      const future = s ? referenceAt(s, filledAt + h, reference) : null;
      const m = markoutOf(fill.yesAction, fill.yesPrice, future);
      const key = String(h);
      markouts[key] = m === null ? null : m.toFixed(6);
      markoutDollars[key] = m === null ? null : m.mul(fill.quantity).toFixed(6);
    }

    out.push({
      fillId: fill.fillId,
      orderId: fill.orderId,
      marketTicker: fill.marketTicker,
      filledAtMs: fill.filledAtMs.toString(),
      liquidity: fill.liquidity,
      reason: fill.reason,
      yesAction: fill.yesAction,
      yesPrice: fill.yesPrice.toFixed(6),
      quantity: fill.quantity.toFixed(6),
      referencePrice: ref === null ? null : ref.toFixed(6),
      reference,
      markouts,
      markoutDollars,
    });
  }

  return out;
}

export interface MarkoutSummary {
  horizonMs: number;
  /** Fills for which the horizon lay inside the recorded data. */
  observations: number;
  /** Fills dropped because the series ended first. Never counted as zero. */
  unobserved: number;
  meanMarkout: string | null;
  medianMarkout: string | null;
  totalMarkoutDollars: string | null;
  /** Share of observations with a strictly negative markout. */
  adverseRate: string | null;
}

export function summarizeMarkouts(
  markouts: readonly FillMarkout[],
  horizons: readonly number[] = MARKOUT_HORIZONS_MS,
): MarkoutSummary[] {
  return horizons.map((h) => {
    const key = String(h);
    const values: Decimal[] = [];
    let dollars = new Decimal(0);
    let unobserved = 0;
    let adverse = 0;

    for (const m of markouts) {
      const v = m.markouts[key];
      if (v === null || v === undefined) {
        // The horizon ran past the end of the data. Excluded, never imputed:
        // a missing 30-second markout counted as zero would read as "no
        // adverse selection", the most flattering possible error.
        unobserved += 1;
        continue;
      }
      const d = new Decimal(v);
      values.push(d);
      if (d.isNegative()) adverse += 1;
      dollars = dollars.plus(new Decimal(m.markoutDollars[key]!));
    }

    if (values.length === 0) {
      return {
        horizonMs: h,
        observations: 0,
        unobserved,
        meanMarkout: null,
        medianMarkout: null,
        totalMarkoutDollars: null,
        adverseRate: null,
      };
    }

    const sum = values.reduce((a, b) => a.plus(b), new Decimal(0));
    const sorted = [...values].sort((a, b) => a.comparedTo(b));
    const mid = sorted.length >> 1;
    const median =
      sorted.length % 2 === 1 ? sorted[mid]! : sorted[mid - 1]!.plus(sorted[mid]!).div(2);

    return {
      horizonMs: h,
      observations: values.length,
      unobserved,
      meanMarkout: sum.div(values.length).toFixed(8),
      medianMarkout: median.toFixed(8),
      totalMarkoutDollars: dollars.toFixed(6),
      adverseRate: new Decimal(adverse).div(values.length).toFixed(6),
    };
  });
}
