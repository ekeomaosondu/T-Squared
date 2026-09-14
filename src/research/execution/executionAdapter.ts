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

/**
 * Where a strategy's intents actually go.
 *
 *   BACKTEST     recorded data, simulated execution
 *   SHADOW       LIVE data, no real orders, hypothetical execution recorded
 *   CALIBRATION  live data, REAL orders at tiny fixed size, placed to learn
 *                execution mechanics rather than to make money
 *   LIVE         real strategy, real risk, a PnL objective
 *
 * There is deliberately no "paper" mode. Paper suggests simulated execution,
 * and CALIBRATION is the opposite: it places real orders precisely because
 * simulated execution is the quantity being estimated. Shadow trading can
 * validate timing, signals and hypothetical fills, but it cannot calibrate
 * queue position -- if an order is never on the exchange, the exchange cannot
 * say where in the FIFO it would have been. Only real resting orders answer
 * that, which is why CALIBRATION exists and why it is named for its purpose.
 */
export type ExecutionMode = 'backtest' | 'shadow' | 'calibration' | 'live';

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
  /**
   * Whether the fee is KNOWN, as opposed to zero.
   *
   * A live venue always reports what it charged, so this is true there. A
   * simulator can only apply a fee it can justify, and false means the
   * schedule for this market could not be verified -- so `fee` is a
   * placeholder and any net figure derived from this fill must be reported as
   * unavailable rather than as a number.
   */
  readonly feeKnown: boolean;

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
