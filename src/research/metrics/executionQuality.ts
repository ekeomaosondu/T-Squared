import { Decimal, ZERO } from '@/src/book/decimal';
import type { SimulatedFill, SimulatedOrder } from '@/src/research/execution/simulatedExchange';
import { markoutOf } from '@/src/research/metrics/markouts';

/**
 * How well the strategy traded, independent of whether it made money.
 *
 * These are the numbers that survive being wrong about the fill model. Two
 * queue assumptions disagree about HOW MANY fills happened; they agree about
 * what each fill looked like. So when the absolute PnL of a Phase 1 backtest
 * cannot be trusted -- and it cannot, until the queue model is calibrated --
 * this is what a comparison should be read from.
 */

export interface ExecutionQuality {
  ordersSubmitted: number;
  ordersRested: number;
  ordersFilled: number;
  ordersPartiallyFilled: number;
  ordersCancelled: number;
  ordersRejected: number;

  fills: number;
  makerFills: number;
  takerFills: number;
  /** Share of submitted orders that received any fill. */
  fillRate: string;
  /** Cancels per fill. High means quoting a lot and trading little. */
  cancelToFillRatio: string | null;

  contractVolume: string;
  notional: string;
  fees: string;

  /**
   * Mean half-spread captured on MAKER fills, in dollars per contract.
   *
   * (mid at fill - buy price) for a buy, (sell price - mid at fill) for a
   * sell, so positive means the fill happened on the favourable side of the
   * mid. This is the gross edge before the market moves; the markouts say
   * whether it survives.
   */
  averageSpreadCaptured: string | null;
  spreadCapturedObservations: number;

  /** Total simulated milliseconds with an order resting. */
  timeRestingMs: string;
  /** Mean time from resting to terminal state, over orders that rested. */
  meanRestingMs: string | null;

  /** Fill reasons, so an implausible distribution is visible at a glance. */
  fillReasons: Record<string, number>;

  /**
   * Mean estimated queue-ahead when an order joined its level.
   *
   * Under `touch` this is zero by construction. Under
   * `conservative_queue` it is the whole displayed level, and a large value
   * with a high fill rate is a red flag that the fills are coming from
   * trade-throughs rather than from patient queueing.
   */
  meanQueueAheadAtEntry: string | null;
}

const div = (a: Decimal, b: number): string | null =>
  b === 0 ? null : a.div(b).toFixed(8);

export function computeExecutionQuality(
  orders: readonly SimulatedOrder[],
  fills: readonly SimulatedFill[],
): ExecutionQuality {
  let rested = 0;
  let cancelled = 0;
  let rejected = 0;
  let timeResting = ZERO;
  let restingSamples = 0;

  for (const order of orders) {
    if (order.status === 'cancelled') cancelled += 1;
    if (order.status === 'rejected') rejected += 1;
    if (order.restedAtMs === null) continue;
    rested += 1;
    const end = order.terminalAtMs ?? order.restedAtMs;
    if (end > order.restedAtMs) {
      timeResting = timeResting.plus(new Decimal((end - order.restedAtMs).toString()));
      restingSamples += 1;
    }
  }

  const filledIds = new Set(fills.map((f) => f.orderId));
  let fullyFilled = 0;
  for (const order of orders) {
    if (!filledIds.has(order.orderId)) continue;
    if (order.filledQuantity.gte(order.quantity)) fullyFilled += 1;
  }

  let contracts = ZERO;
  let notional = ZERO;
  let fees = ZERO;
  let maker = 0;
  let taker = 0;
  let spreadSum = ZERO;
  let spreadObs = 0;
  let queueSum = ZERO;
  let queueObs = 0;
  const reasons: Record<string, number> = {};

  for (const fill of fills) {
    contracts = contracts.plus(fill.quantity);
    notional = notional.plus(fill.quantity.mul(fill.yesPrice));
    fees = fees.plus(fill.fee);
    if (fill.liquidity === 'maker') maker += 1;
    else taker += 1;
    reasons[fill.reason] = (reasons[fill.reason] ?? 0) + 1;

    if (fill.liquidity === 'maker' && fill.midAtFill !== null) {
      const captured = markoutOf(fill.yesAction, fill.yesPrice, fill.midAtFill);
      if (captured !== null) {
        spreadSum = spreadSum.plus(captured);
        spreadObs += 1;
      }
    }
    if (fill.queueAheadAtEntry !== null) {
      queueSum = queueSum.plus(fill.queueAheadAtEntry);
      queueObs += 1;
    }
  }

  return {
    ordersSubmitted: orders.length,
    ordersRested: rested,
    ordersFilled: fullyFilled,
    ordersPartiallyFilled: filledIds.size - fullyFilled,
    ordersCancelled: cancelled,
    ordersRejected: rejected,

    fills: fills.length,
    makerFills: maker,
    takerFills: taker,
    fillRate: orders.length === 0 ? '0' : new Decimal(filledIds.size).div(orders.length).toFixed(6),
    cancelToFillRatio: fills.length === 0 ? null : new Decimal(cancelled).div(fills.length).toFixed(6),

    contractVolume: contracts.toFixed(6),
    notional: notional.toFixed(6),
    fees: fees.toFixed(6),

    averageSpreadCaptured: div(spreadSum, spreadObs),
    spreadCapturedObservations: spreadObs,

    timeRestingMs: timeResting.toFixed(0),
    meanRestingMs: div(timeResting, restingSamples),

    fillReasons: reasons,
    meanQueueAheadAtEntry: div(queueSum, queueObs),
  };
}
