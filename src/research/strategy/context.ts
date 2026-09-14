import { Decimal } from '@/src/book/decimal';
import type { BookView } from '@/src/research/engine/marketState';
import type { ExecutionAdapter, ExecutionMode, WorkingOrder } from '@/src/research/execution/executionAdapter';
import type { OrderIntent } from '@/src/research/strategy/orderIntent';
import type { SimulationClock } from '@/src/research/engine/simulationClock';
import type { TimerScheduler } from '@/src/research/engine/scheduler';

/**
 * Everything a strategy is allowed to touch.
 *
 * Note what is absent: no data source, no simulated exchange, no fill model,
 * no results writer, no Date, no I/O. A strategy that cannot reach those
 * cannot accidentally depend on running in a backtest, and cannot look ahead
 * even if it tries.
 */

/** A market's current state, as of the last event the strategy has seen. */
export interface MarketState {
  readonly ticker: string;
  readonly book: BookView;
  /**
   * False when the book cannot be vouched for: before its first snapshot,
   * during a capture gap, or after an invariant violation. A strategy that
   * quotes off an invalid book is quoting off fiction.
   */
  readonly valid: boolean;
  readonly seriesTicker: string | null;
  readonly eventTicker: string | null;
}

export interface OrderGateway {
  submit(intent: OrderIntent): void;
  cancel(clientOrderId: string): void;
  replace(clientOrderId: string, newClientOrderId: string, changes: { price?: Decimal; quantity?: Decimal }): void;
  /** Orders still working, optionally for one market. */
  open(marketTicker?: string): readonly WorkingOrder[];
  find(clientOrderId: string): WorkingOrder | undefined;
}

export interface StrategyContext {
  /** The ONLY clock. See SimulationClock: never call Date.now(). */
  readonly clock: SimulationClock;
  readonly mode: ExecutionMode;
  readonly orders: OrderGateway;

  /** Markets in this run's universe. */
  markets(): readonly string[];
  state(marketTicker: string): MarketState | undefined;
  /** Signed YES position. Negative is short YES, i.e. long NO. */
  position(marketTicker: string): Decimal;

  /** Schedules a timer. Fires as a simulated event, not on wall time. */
  scheduleAfter(delayMs: bigint, label: string, marketTicker?: string): number;
  cancelTimer(timerId: number): boolean;

  /** Structured note attached to the run's log. Not a console. */
  log(event: string, fields?: Record<string, unknown>): void;
}

export interface ContextDeps {
  clock: SimulationClock;
  scheduler: TimerScheduler;
  adapter: ExecutionAdapter;
  marketState: (ticker: string) => MarketState | undefined;
  markets: () => readonly string[];
  position: (ticker: string) => Decimal;
  onLog: (event: string, fields: Record<string, unknown>) => void;
}

export function createContext(deps: ContextDeps): StrategyContext {
  const gateway: OrderGateway = {
    submit(intent) {
      deps.adapter.submit(intent, deps.clock.nowMs());
    },
    cancel(clientOrderId) {
      deps.adapter.submit({ type: 'cancel', clientOrderId }, deps.clock.nowMs());
    },
    replace(clientOrderId, newClientOrderId, changes) {
      deps.adapter.submit(
        {
          type: 'replace',
          clientOrderId,
          newClientOrderId,
          newPrice: changes.price,
          newQuantity: changes.quantity,
        },
        deps.clock.nowMs(),
      );
    },
    open(marketTicker) {
      return deps.adapter.openOrders(marketTicker);
    },
    find(clientOrderId) {
      return deps.adapter.findByClientId(clientOrderId);
    },
  };

  return {
    clock: deps.clock,
    mode: deps.adapter.mode,
    orders: gateway,
    markets: () => deps.markets(),
    state: (ticker) => deps.marketState(ticker),
    position: (ticker) => deps.position(ticker),
    scheduleAfter: (delayMs, label, marketTicker) =>
      deps.scheduler.scheduleAfter(deps.clock.nowMs(), delayMs, label, marketTicker),
    cancelTimer: (timerId) => deps.scheduler.cancel(timerId),
    log: (event, fields = {}) => deps.onLog(event, fields),
  };
}
