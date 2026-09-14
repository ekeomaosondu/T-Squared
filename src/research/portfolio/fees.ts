import { type Decimal, D, ONE, ZERO, type DecimalInput } from '@/src/book/decimal';

/**
 * Trading fees.
 *
 * Kalshi's general trading fee is quadratic in price rather than linear in
 * notional:
 *
 *     fee = ceil_to_cents( rate * contracts * price * (1 - price) )
 *
 * That shape matters for a market maker. The fee peaks at 50c and falls to
 * almost nothing in the tails, so the same half-cent spread is profitable on a
 * 5c contract and a loss on a 50c one. A flat basis-point model -- the obvious
 * thing to reach for from equities -- gets the sign of that effect wrong and
 * would send a study looking for edge in exactly the wrong strikes.
 *
 * IMPORTANT: the rate and the maker fee below are DEFAULTS, not measurements.
 * Kalshi publishes per-series fee schedules and changes them; the maker fee in
 * particular is zero on some series and not others. Both are surfaced in the
 * run manifest so a result always names the fee assumption it was produced
 * under, and both must be checked against the current schedule for KXHIGH and
 * KXLOW before any absolute PnL figure is quoted.
 */

export type Liquidity = 'maker' | 'taker';

export interface FeeContext {
  marketTicker: string;
  quantity: Decimal;
  /** Execution price in YES terms, 0..1. */
  yesPrice: Decimal;
  liquidity: Liquidity;
}

export interface FeeModel {
  readonly name: string;
  fee(ctx: FeeContext): Decimal;
  describe(): Record<string, unknown>;
}

export interface KalshiFeeParams {
  /** Coefficient in `rate * C * P * (1 - P)`. */
  takerRate: DecimalInput;
  /** Flat per-contract maker fee, in dollars. Zero on many series. */
  makerFeePerContract: DecimalInput;
  /** Kalshi rounds a fee UP to the next cent. */
  roundUpToCents: boolean;
}

export const KALSHI_FEE_DEFAULTS: KalshiFeeParams = {
  takerRate: '0.07',
  makerFeePerContract: '0',
  roundUpToCents: true,
};

export class KalshiFeeModel implements FeeModel {
  readonly name = 'kalshi';
  private readonly params: KalshiFeeParams;

  constructor(params: Partial<KalshiFeeParams> = {}) {
    // Explicit `undefined` must not overwrite a default: a caller that passes
    // through an absent CLI flag would otherwise silently disable the fee.
    const provided = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined),
    ) as Partial<KalshiFeeParams>;
    this.params = { ...KALSHI_FEE_DEFAULTS, ...provided };
  }

  fee(ctx: FeeContext): Decimal {
    const raw =
      ctx.liquidity === 'taker'
        ? D(this.params.takerRate).mul(ctx.quantity).mul(ctx.yesPrice).mul(ONE.minus(ctx.yesPrice))
        : D(this.params.makerFeePerContract).mul(ctx.quantity);

    if (raw.lte(0)) return ZERO;
    if (!this.params.roundUpToCents) return raw;
    return raw.mul(100).ceil().div(100);
  }

  describe(): Record<string, unknown> {
    return {
      model: 'kalshi',
      takerRate: D(this.params.takerRate).toString(),
      makerFeePerContract: D(this.params.makerFeePerContract).toString(),
      roundUpToCents: this.params.roundUpToCents,
      verified: false,
    };
  }
}

/** Fee-free, for isolating the effect of fees on a conclusion. */
export class ZeroFeeModel implements FeeModel {
  readonly name = 'zero';
  fee(): Decimal {
    return ZERO;
  }
  describe(): Record<string, unknown> {
    return { model: 'zero' };
  }
}
