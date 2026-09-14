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
  /**
   * Half-spread captured at the fill: the reference price at the fill instant
   * minus the fill price, signed so positive is favourable.
   *
   * Horizon-independent, and by construction positive for a maker resting
   * inside the spread. Every realized-edge figure is this plus a drift.
   */
  spreadCapture: string | null;
  /**
   * Total markout from the FILL PRICE, sign-normalized so positive is
   * favourable. This is the whole edge: the half-spread captured plus whatever
   * the market did afterwards.
   */
  markouts: Record<string, string | null>;
  /** Per-horizon markout in dollars, i.e. markout * quantity. */
  markoutDollars: Record<string, string | null>;
  /**
   * Drift of the reference price from the fill instant, sign-normalized.
   *
   * The SAME measurement with the half-spread removed, and the one that
   * actually answers "were we picked off". A maker buying at the bid has a
   * markout of at least half the spread by construction -- the mid is above
   * the bid -- so a healthy-looking total markout can hide a market that ran
   * away from every fill. Adverse selection is a statement about this column.
   */
  midDrift: Record<string, string | null>;
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
    const midDrift: Record<string, string | null> = {};

    const ref = s ? referenceAt(s, filledAt, reference) : null;
    const spreadCapture = markoutOf(fill.yesAction, fill.yesPrice, ref);

    for (const h of horizons) {
      const future = s ? referenceAt(s, filledAt + h, reference) : null;
      const m = markoutOf(fill.yesAction, fill.yesPrice, future);
      const drift = ref === null ? null : markoutOf(fill.yesAction, ref, future);
      const key = String(h);
      markouts[key] = m === null ? null : m.toFixed(6);
      markoutDollars[key] = m === null ? null : m.mul(fill.quantity).toFixed(6);
      midDrift[key] = drift === null ? null : drift.toFixed(6);
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
      spreadCapture: spreadCapture === null ? null : spreadCapture.toFixed(6),
      markouts,
      markoutDollars,
      midDrift,
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
  /**
   * Mean half-spread captured, over the SAME fills the drift is measured on.
   *
   * Restricted to that subset deliberately, so the decomposition below is an
   * identity rather than an approximation:
   *
   *     realizedEdge = spreadCapture + midDrift
   */
  meanSpreadCapture: string | null;
  /** Mean reference-price drift, with the half-spread removed. */
  meanMidDrift: string | null;
  /**
   * What the fill was actually worth by this horizon.
   *
   * The number a market maker should be looking at: the spread earned at the
   * touch, less whatever the market took back. A healthy spread capture with a
   * strongly negative drift is a strategy that is being paid to be wrong.
   */
  realizedEdge: string | null;
  /**
   * Share of observations the market moved AGAINST, measured on the drift.
   *
   * Deliberately not on the total markout: that includes the half-spread a
   * maker earns by construction, so it reports a comfortable-looking rate even
   * when the mid runs away from every single fill.
   */
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
    let driftSum = new Decimal(0);
    let captureSum = new Decimal(0);
    let driftObs = 0;
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
      values.push(new Decimal(v));
      dollars = dollars.plus(new Decimal(m.markoutDollars[key]!));

      const drift = m.midDrift[key];
      if (drift !== null && drift !== undefined && m.spreadCapture !== null) {
        const d = new Decimal(drift);
        driftSum = driftSum.plus(d);
        captureSum = captureSum.plus(new Decimal(m.spreadCapture));
        driftObs += 1;
        if (d.isNegative()) adverse += 1;
      }
    }

    if (values.length === 0) {
      return {
        horizonMs: h,
        observations: 0,
        unobserved,
        meanMarkout: null,
        medianMarkout: null,
        totalMarkoutDollars: null,
        meanSpreadCapture: null,
        meanMidDrift: null,
        realizedEdge: null,
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
      meanSpreadCapture: driftObs === 0 ? null : captureSum.div(driftObs).toFixed(8),
      meanMidDrift: driftObs === 0 ? null : driftSum.div(driftObs).toFixed(8),
      realizedEdge: driftObs === 0 ? null : captureSum.plus(driftSum).div(driftObs).toFixed(8),
      adverseRate: driftObs === 0 ? null : new Decimal(adverse).div(driftObs).toFixed(6),
    };
  });
}
