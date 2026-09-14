import { Decimal, type DecimalInput } from '@/src/book/decimal';

/**
 * What a strategy emits.
 *
 * An intent is a REQUEST, not an order. It has no exchange identity, no
 * timestamp of arrival and no state: the execution adapter decides what
 * becomes of it, which is what lets identical strategy code run against a
 * simulator, a paper account and the live exchange.
 *
 * Every price and quantity is a Decimal. Prediction-market edges are measured
 * in tenths of a cent, so a float would put the noise floor above the signal.
 */

export type Side = 'yes' | 'no';
export type Action = 'buy' | 'sell';
export type TimeInForce = 'gtc' | 'ioc';

export interface LimitOrderIntent {
  type: 'limit';
  marketTicker: string;
  side: Side;
  action: Action;
  price: Decimal;
  quantity: Decimal;
  clientOrderId: string;
  timeInForce?: TimeInForce;
  /** Opaque strategy annotation, carried onto orders and fills. */
  tag?: string;
}

export interface MarketOrderIntent {
  type: 'market';
  marketTicker: string;
  side: Side;
  action: Action;
  quantity: Decimal;
  clientOrderId: string;
  /**
   * Worst acceptable average price. Required: the book is thin and a market
   * order without a limit is an instruction to pay any price, which no
   * research result should ever be based on.
   */
  maxPrice: Decimal;
  tag?: string;
}

export interface CancelIntent {
  type: 'cancel';
  clientOrderId: string;
}

export interface ReplaceIntent {
  type: 'replace';
  clientOrderId: string;
  newPrice?: Decimal;
  newQuantity?: Decimal;
  /** Identity of the replacement. A replace is a cancel plus a new order. */
  newClientOrderId: string;
}

export type OrderIntent = LimitOrderIntent | MarketOrderIntent | CancelIntent | ReplaceIntent;

export function limit(
  args: Omit<LimitOrderIntent, 'type' | 'price' | 'quantity'> & {
    price: DecimalInput;
    quantity: DecimalInput;
  },
): LimitOrderIntent {
  return {
    ...args,
    type: 'limit',
    price: new Decimal(args.price),
    quantity: new Decimal(args.quantity),
  };
}

export function cancel(clientOrderId: string): CancelIntent {
  return { type: 'cancel', clientOrderId };
}

/**
 * The YES-side price a (side, action) pair rests at.
 *
 * Kalshi's book is YES bids and NO bids; a NO bid at q is a YES ask at 1 - q.
 * Everything downstream -- fills, PnL, markouts -- is expressed in YES terms so
 * that a single signed position describes the whole book, so intents are
 * normalized here once rather than at each use.
 */
export function yesEquivalentPrice(side: Side, action: Action, price: Decimal): Decimal {
  // buy NO at p  ==  sell YES at 1 - p
  // sell NO at p ==  buy YES at 1 - p
  return side === 'yes' ? price : new Decimal(1).minus(price);
}

/** Whether the intent increases or decreases a signed YES position. */
export function yesAction(side: Side, action: Action): Action {
  if (side === 'yes') return action;
  return action === 'buy' ? 'sell' : 'buy';
}
