import { Decimal, ONE, ZERO } from '@/src/book/decimal';

/**
 * Position accounting for BINARY prediction-market contracts.
 *
 * Everything is expressed as a single SIGNED position in YES contracts, which
 * is possible because Kalshi's two instruments are exact complements: buying
 * one NO at q is economically identical to selling one YES at 1 - q. Carrying
 * separate YES and NO inventories would double the state and then require
 * netting logic that has to agree with itself.
 *
 * The equity assumptions from equities do NOT transfer:
 *
 *   - a contract settles at exactly $0 or $1, so terminal value is discrete
 *     and there is no such thing as a price outside [0, 1]
 *   - a short is fully collateralised at $1 per contract, so a negative
 *     position consumes capital rather than releasing it
 *   - `cash` below is a mark-to-settlement balance, NOT a Kalshi account
 *     balance: it credits a short with the sale proceeds instead of debiting
 *     the collateral. Both conventions give identical PnL over a round trip,
 *     but only `collateralRequired` describes capital actually tied up.
 */

export interface PositionState {
  marketTicker: string;
  /** Signed YES contracts. Negative is short YES, i.e. long NO. */
  quantity: Decimal;
  /** Average price of the CURRENTLY OPEN position, in YES terms. */
  averageEntryPrice: Decimal;
  realizedPnl: Decimal;
  feesPaid: Decimal;
  boughtQuantity: Decimal;
  soldQuantity: Decimal;
  /** Sum of |quantity| * price over all fills. */
  notional: Decimal;
  fillCount: number;
  settled: boolean;
  /** Payout per YES contract actually applied, in dollars. */
  settlementPayout: Decimal | null;
  /** How the position finished. See PositionResolution. */
  resolution: PositionResolution;
}

/**
 * How a position finished, and WHY that is the answer.
 *
 * Four of these look alike in a PnL total and mean entirely different things:
 *
 *   SETTLED                the exchange determined the market; this is a fact
 *   VOIDED                 the market was cancelled; the position closed at cost
 *   OPEN_AT_RUN_END        the market was still trading when our window ended,
 *                          so the value is a mark and would change if the run
 *                          were extended
 *   AWAITING_DETERMINATION trading is over and the exchange has not yet ruled;
 *                          extending the run would NOT help, only waiting will
 *   UNPRICEABLE            no determination and no mark; excluded from PnL
 *
 * Collapsing "we stopped early" into "we cannot price it" would hide a
 * fixable data gap behind an unfixable one.
 */
export type PositionResolution =
  | 'FLAT'
  | 'SETTLED'
  | 'VOIDED'
  | 'OPEN_AT_RUN_END'
  | 'AWAITING_DETERMINATION'
  | 'UNPRICEABLE';

export function newPosition(marketTicker: string): PositionState {
  return {
    marketTicker,
    quantity: ZERO,
    averageEntryPrice: ZERO,
    realizedPnl: ZERO,
    feesPaid: ZERO,
    boughtQuantity: ZERO,
    soldQuantity: ZERO,
    notional: ZERO,
    fillCount: 0,
    settled: false,
    settlementPayout: null,
    resolution: 'FLAT',
  };
}

export interface FillApplication {
  /** Change in cash, fee already deducted. */
  cashDelta: Decimal;
  /** Realized PnL crystallised by the closing portion of this fill. */
  realizedDelta: Decimal;
  /** Contracts of the existing position that this fill closed. */
  closedQuantity: Decimal;
}

/**
 * Applies one fill to a position.
 *
 * @param signedQuantity positive to buy YES, negative to sell YES
 * @param price          execution price in YES terms
 */
export function applyFillToPosition(
  position: PositionState,
  signedQuantity: Decimal,
  price: Decimal,
  fee: Decimal,
): FillApplication {
  if (signedQuantity.isZero()) {
    return { cashDelta: fee.neg(), realizedDelta: ZERO, closedQuantity: ZERO };
  }

  const absQty = signedQuantity.abs();
  const before = position.quantity;

  let realizedDelta = ZERO;
  let closedQuantity = ZERO;

  const opposing = !before.isZero() && before.isNegative() !== signedQuantity.isNegative();

  if (opposing) {
    closedQuantity = Decimal.min(before.abs(), absQty);
    // Long closed by a sell earns (exit - entry); short closed by a buy earns
    // (entry - exit). One expression, signed by the direction of the position
    // being closed.
    const direction = before.isPositive() ? ONE : ONE.neg();
    realizedDelta = closedQuantity.mul(price.minus(position.averageEntryPrice)).mul(direction);

    const remaining = absQty.minus(closedQuantity);
    if (remaining.isZero()) {
      position.quantity = before.plus(signedQuantity);
      if (position.quantity.isZero()) position.averageEntryPrice = ZERO;
    } else {
      // The fill closed the old position and opened a new one the other way.
      position.quantity = signedQuantity.isPositive() ? remaining : remaining.neg();
      position.averageEntryPrice = price;
    }
  } else {
    const priorAbs = before.abs();
    const newAbs = priorAbs.plus(absQty);
    position.averageEntryPrice = priorAbs
      .mul(position.averageEntryPrice)
      .plus(absQty.mul(price))
      .div(newAbs);
    position.quantity = before.plus(signedQuantity);
  }

  position.realizedPnl = position.realizedPnl.plus(realizedDelta);
  position.feesPaid = position.feesPaid.plus(fee);
  position.notional = position.notional.plus(absQty.mul(price));
  position.fillCount += 1;
  if (signedQuantity.isPositive()) position.boughtQuantity = position.boughtQuantity.plus(absQty);
  else position.soldQuantity = position.soldQuantity.plus(absQty);

  // Buying costs cash; selling raises it. The fee always costs cash.
  const cashDelta = signedQuantity.mul(price).neg().minus(fee);

  return { cashDelta, realizedDelta, closedQuantity };
}

/**
 * Settles a position at the payout the exchange determined.
 *
 * Explicit and terminal. A YES contract pays exactly its notional if the event
 * occurred and exactly nothing otherwise, so the entire remaining position
 * converts to cash and the unrealized PnL becomes realized. There is no
 * closing price and no final mark -- treating settlement as "mark at the last
 * mid" carries the market's uncertainty into a number that has none.
 *
 * @param yesPayout payout per YES contract, normalised to 0..1. Taken from
 *                  the exchange's `settlement_value` where available rather
 *                  than inferred, and NEVER from a weather observation: the
 *                  preliminary reading and the final climate report disagree
 *                  often enough that settling from the former would be
 *                  measuring a different market.
 */
export function settlePosition(position: PositionState, yesPayout: Decimal): FillApplication {
  if (position.settled) {
    throw new Error(`${position.marketTicker} is already settled`);
  }
  const qty = position.quantity;

  const realizedDelta = qty.mul(yesPayout.minus(position.averageEntryPrice));
  const cashDelta = qty.mul(yesPayout);

  position.settled = true;
  position.settlementPayout = yesPayout;
  position.resolution = 'SETTLED';
  position.quantity = ZERO;
  position.averageEntryPrice = ZERO;

  return { cashDelta, realizedDelta, closedQuantity: qty.abs() };
}

/**
 * Closes a position in a VOIDED market.
 *
 * Kalshi cancels markets. A void returns the position at cost, so the
 * economic result is exactly zero rather than a payout of either side. Booking
 * it as a determination in either direction invents a dollar per contract.
 */
export function voidPosition(position: PositionState): FillApplication {
  if (position.settled) {
    throw new Error(`${position.marketTicker} is already settled`);
  }
  const qty = position.quantity;
  const cashDelta = qty.mul(position.averageEntryPrice);

  position.settled = true;
  position.settlementPayout = null;
  position.resolution = 'VOIDED';
  position.quantity = ZERO;
  position.averageEntryPrice = ZERO;

  return { cashDelta, realizedDelta: ZERO, closedQuantity: qty.abs() };
}

/** Unrealized PnL of an open position at a mark. Null when there is no mark. */
export function unrealizedPnl(position: PositionState, mark: Decimal | null): Decimal | null {
  if (position.quantity.isZero()) return ZERO;
  if (mark === null) return null;
  return position.quantity.mul(mark.minus(position.averageEntryPrice));
}

/**
 * Capital Kalshi would actually tie up for this position.
 *
 * A long costs its purchase price per contract; a short is collateralised at
 * $1 minus the sale price, because the worst case is the contract settling at
 * $1. Reported separately from cash so that a strategy which looks flat on PnL
 * but consumes a lot of collateral is visible as such.
 */
export function collateralRequired(position: PositionState): Decimal {
  const qty = position.quantity;
  if (qty.isZero()) return ZERO;
  return qty.isPositive()
    ? qty.mul(position.averageEntryPrice)
    : qty.abs().mul(ONE.minus(position.averageEntryPrice));
}
