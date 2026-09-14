import type { Decimal } from '@/src/book/decimal';
import type { Action, OrderIntent, Side, TimeInForce } from '@/src/research/strategy/orderIntent';

/**
 * The seam between a strategy and whatever is actually trading.
 *
 * This is the single most important interface in the platform. A strategy
 * emits intents and receives fills; it never learns whether those intents went
 * to a simulator, to a shadow log, to a paper account or to Kalshi. Promoting
 * a strategy from backtest to live is then a change of adapter and nothing
 * else -- no branch inside the strategy, no `if (mode === 'live')`, and so no
 * possibility that the version that was tested differs from the version that
 * trades.
 *
 * The types here are deliberately the LOWEST COMMON DENOMINATOR of what every
 * venue can report. Simulator-only knowledge -- queue estimates, fill reasons,
 * the fill model's name -- lives on the simulator's extensions of these types,
 * where the metrics pipeline can read it and a strategy cannot.
 */

export type ExecutionMode = 'backtest' | 'shadow' | 'paper' | 'live';

export type OrderStatus = 'pending' | 'resting' | 'filled' | 'cancelled' | 'rejected';

export type Liquidity = 'maker' | 'taker';

/** An order as the strategy may observe it. */
export interface WorkingOrder {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly marketTicker: string;
  readonly side: Side;
  readonly action: Action;
  /** Price in the order's own side terms. */
  readonly price: Decimal;
  /** The same price on the YES ladder. */
  readonly yesPrice: Decimal;
  readonly yesAction: Action;
  readonly quantity: Decimal;
  readonly filledQuantity: Decimal;
  readonly status: OrderStatus;
  readonly timeInForce: TimeInForce;
  readonly tag?: string;
}

export interface OrderUpdate {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly marketTicker: string;
  readonly status: OrderStatus;
  readonly reason: string;
  readonly atMs: bigint;
  readonly remainingQuantity: Decimal;
}

export interface Fill {
  readonly fillId: string;
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly marketTicker: string;

  readonly side: Side;
  readonly action: Action;
  readonly yesAction: Action;
  readonly price: Decimal;
  readonly yesPrice: Decimal;
  readonly quantity: Decimal;

  readonly liquidity: Liquidity;
  readonly fee: Decimal;

  readonly submittedAtMs: bigint;
  readonly arrivedAtMs: bigint;
  readonly filledAtMs: bigint;

  readonly tag?: string;
}

export interface ExecutionAdapter {
  readonly mode: ExecutionMode;
  readonly name: string;
  describe(): Record<string, unknown>;
  submit(intent: OrderIntent, nowMs: bigint): OrderUpdate[];
  openOrders(marketTicker?: string): WorkingOrder[];
  findByClientId(clientOrderId: string): WorkingOrder | undefined;
}
