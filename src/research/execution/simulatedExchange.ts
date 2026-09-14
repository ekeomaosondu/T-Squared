import { Decimal, D, ONE, ZERO, canonicalPrice } from '@/src/book/decimal';
import type { BookDeltaEvent, TradeEvent } from '@/src/research/events/researchEvent';
import type { BookView, MarketStateStore } from '@/src/research/engine/marketState';
import type { FeeModel } from '@/src/research/portfolio/fees';
import type {
  ExecutionAdapter,
  ExecutionMode,
  Fill,
  Liquidity,
  OrderStatus,
  OrderUpdate,
  WorkingOrder,
} from '@/src/research/execution/executionAdapter';
import {
  newQueueState,
  type FillModel,
  type FillReason,
  type QueueState,
} from '@/src/research/execution/fills/fillModel';
import type { LatencyModel } from '@/src/research/execution/latencyModel';
import {
  yesAction as toYesAction,
  yesEquivalentPrice,
  type Action,
  type OrderIntent,
} from '@/src/research/strategy/orderIntent';

/**
 * A simulated Kalshi exchange.
 *
 * Its job is to be honestly pessimistic about the two things a historical
 * backtest cannot know: WHEN our messages arrive, and WHERE we sit in a queue
 * we cannot see. Everything else -- crossing, partial fills, cancel races -- is
 * mechanical.
 *
 * ---------------------------------------------------------------------------
 * The lookahead rule
 * ---------------------------------------------------------------------------
 * An order does nothing until `nowMs >= effectiveAtMs`. There is no path by
 * which an intent submitted in response to an event affects the same event,
 * and no path by which an order rests retroactively. That single rule is what
 * prevents the classic backtest fiction of a maker who always happens to be
 * quoting just before a favourable print.
 *
 * The engine calls `advanceTo` AFTER applying market data for an instant, not
 * before. So an order that becomes effective at exactly the timestamp of a
 * favourable trade misses it, and a cancel that becomes effective at the same
 * timestamp does not save us from the fill. Both errors point the same way --
 * against the strategy -- which is the only direction a modelling error is
 * allowed to point.
 */

/**
 * A simulated order: a WorkingOrder plus the simulator's own bookkeeping.
 *
 * The extra fields -- arrival time, cancel timing, queue estimate -- are what
 * make a backtest auditable. A strategy sees only the WorkingOrder half.
 */
export interface SimulatedOrder extends Omit<WorkingOrder, 'status'> {
  status: OrderStatus;
  filledQuantity: Decimal;

  /**
   * Submission counter, used as the final tiebreak wherever orders are
   * ordered.
   *
   * A NUMBER, not the string id. Sorting on "o10" versus "o2" is
   * lexicographic and puts the tenth order before the second -- the same class
   * of bug that once made this dataset's deltas replay out of order.
   */
  sequence: number;

  /** When the strategy emitted the intent. */
  submittedAtMs: bigint;
  /** When it reaches the exchange. Nothing happens before this. */
  effectiveAtMs: bigint;
  restedAtMs: bigint | null;

  cancelRequestedAtMs: bigint | null;
  cancelEffectiveAtMs: bigint | null;
  terminalAtMs: bigint | null;

  queue: QueueState | null;
  rejectReason: string | null;
}

/** A Fill plus everything only a simulator can know about why it happened. */
export interface SimulatedFill extends Fill {
  reason: FillReason;

  /** Queue estimates, so a fill can be re-examined under another model. */
  queueAheadAtEntry: Decimal | null;
  queueAheadBeforeFill: Decimal | null;

  fillModel: string;
  /** The book's state hash at the moment of the fill, when the book is valid. */
  bookStateHash: string | null;
  triggeringTradeId: string | null;
  tag?: string;

  /**
   * Book context captured AT the fill.
   *
   * Recorded here rather than reconstructed later because the book at a
   * specific past instant is not recoverable from the result files, and every
   * conditional breakdown the analysis asks for -- by spread, by depth, by
   * imbalance -- needs exactly this.
   */
  midAtFill: Decimal | null;
  spreadAtFill: Decimal | null;
  depth1AtFill: Decimal | null;
  imbalance1AtFill: Decimal | null;
}

export type SimulatedOrderUpdate = OrderUpdate;

/** What happens to resting orders when coverage is lost. */
export type GapOrderPolicy = 'cancel_all' | 'keep_resting' | 'freeze';

export interface SimulatedExchangeOptions {
  state: MarketStateStore;
  fillModel: FillModel;
  feeModel: FeeModel;
  latency: LatencyModel;
  /**
   * What to do with resting orders when a capture gap opens.
   *
   * Default `cancel_all`. During a gap the book can move anywhere, so a
   * resting order is exposed to state we never observed; leaving it there
   * generates fills the simulation has no evidence for. `freeze` suspends
   * matching without cancelling, for studying the cost of the choice.
   */
  gapOrderPolicy?: GapOrderPolicy;
}

const remainingOf = (o: SimulatedOrder) => o.quantity.minus(o.filledQuantity);

/** The book ladder a resting order actually sits on. */
function ladderOf(order: SimulatedOrder): { side: 'yes' | 'no'; price: string } {
  return order.yesAction === 'buy'
    ? { side: 'yes', price: canonicalPrice(order.yesPrice) }
    : { side: 'no', price: canonicalPrice(ONE.minus(order.yesPrice)) };
}

export class SimulatedExchange {
  private readonly state: MarketStateStore;
  private readonly fillModel: FillModel;
  private readonly feeModel: FeeModel;
  private readonly latency: LatencyModel;
  private readonly gapOrderPolicy: GapOrderPolicy;

  private readonly orders = new Map<string, SimulatedOrder>();
  /** clientOrderId -> orderId, for cancel and replace. */
  private readonly byClientId = new Map<string, string>();
  /** Orders awaiting their effective time, in submission order. */
  private pending: SimulatedOrder[] = [];
  /** Cancels awaiting their effective time, in request order. */
  private pendingCancels: SimulatedOrder[] = [];
  /** Resting orders indexed by the exact book level they sit on. */
  private readonly restingByLevel = new Map<string, Set<string>>();
  /**
   * Resting orders indexed by market.
   *
   * Both indexes exist for one reason: a run accumulates tens of thousands of
   * orders, and scanning all of them on every trade -- or every event -- is
   * quadratic in a dataset with a million of them. On a full trading day that
   * is the difference between minutes and hours.
   */
  private readonly restingByMarket = new Map<string, Set<string>>();
  /** Markets frozen by an open capture gap. */
  private readonly frozen = new Set<string>();

  private orderSeq = 0;
  private fillSeq = 0;

  readonly fills: SimulatedFill[] = [];

  constructor(opts: SimulatedExchangeOptions) {
    this.state = opts.state;
    this.fillModel = opts.fillModel;
    this.feeModel = opts.feeModel;
    this.latency = opts.latency;
    this.gapOrderPolicy = opts.gapOrderPolicy ?? 'cancel_all';
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  /**
   * Accepts an intent.
   *
   * `nowMs` is the simulated instant the STRATEGY acted. Decision and
   * submission latency are added here, so the order's effective time is fixed
   * at submission and cannot be revised by anything that happens next.
   */
  submit(intent: OrderIntent, nowMs: bigint): SimulatedOrderUpdate[] {
    switch (intent.type) {
      case 'limit':
      case 'market':
        return this.submitNew(intent, nowMs);
      case 'cancel':
        return this.requestCancel(intent.clientOrderId, nowMs);
      case 'replace': {
        const existing = this.findByClientId(intent.clientOrderId);
        if (!existing) {
          return [this.reject(intent.clientOrderId, 'unknown order', nowMs)];
        }
        const updates = this.requestCancel(intent.clientOrderId, nowMs);
        updates.push(
          ...this.submitNew(
            {
              type: 'limit',
              marketTicker: existing.marketTicker,
              side: existing.side,
              action: existing.action,
              price: intent.newPrice ?? existing.price,
              quantity: intent.newQuantity ?? remainingOf(existing),
              clientOrderId: intent.newClientOrderId,
              tag: existing.tag,
            },
            nowMs,
          ),
        );
        return updates;
      }
    }
  }

  private submitNew(
    intent: Extract<OrderIntent, { type: 'limit' | 'market' }>,
    nowMs: bigint,
  ): SimulatedOrderUpdate[] {
    if (this.byClientId.has(intent.clientOrderId)) {
      return [this.reject(intent.clientOrderId, 'duplicate clientOrderId', nowMs)];
    }
    if (intent.quantity.lte(0)) {
      return [this.reject(intent.clientOrderId, 'non-positive quantity', nowMs)];
    }

    const price = intent.type === 'limit' ? intent.price : intent.maxPrice;
    if (price.lt(0) || price.gt(1)) {
      return [this.reject(intent.clientOrderId, `price ${price.toString()} outside [0, 1]`, nowMs)];
    }

    const yesPrice = yesEquivalentPrice(intent.side, intent.action, price);
    const sequence = ++this.orderSeq;
    const order: SimulatedOrder = {
      orderId: `o${sequence}`,
      sequence,
      clientOrderId: intent.clientOrderId,
      marketTicker: intent.marketTicker,
      side: intent.side,
      action: intent.action,
      price,
      yesPrice,
      yesAction: toYesAction(intent.side, intent.action),
      quantity: intent.quantity,
      filledQuantity: ZERO,
      status: 'pending',
      timeInForce: intent.type === 'market' ? 'ioc' : (intent.timeInForce ?? 'gtc'),
      tag: intent.tag,
      submittedAtMs: nowMs,
      effectiveAtMs:
        nowMs +
        BigInt(Math.round(this.latency.decisionLatencyMs())) +
        BigInt(Math.round(this.latency.submitLatencyMs(intent))),
      restedAtMs: null,
      cancelRequestedAtMs: null,
      cancelEffectiveAtMs: null,
      terminalAtMs: null,
      queue: null,
      rejectReason: null,
    };

    this.orders.set(order.orderId, order);
    this.byClientId.set(order.clientOrderId, order.orderId);
    this.pending.push(order);

    return [this.update(order, 'accepted', nowMs)];
  }

  private requestCancel(clientOrderId: string, nowMs: bigint): SimulatedOrderUpdate[] {
    const order = this.findByClientId(clientOrderId);
    if (!order) return [this.reject(clientOrderId, 'unknown order', nowMs)];
    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      return [];
    }
    if (order.cancelRequestedAtMs !== null) return [];

    order.cancelRequestedAtMs = nowMs;
    // Cancel latency is separate from submit latency, and the window it opens
    // is exactly where adverse selection lives: the order can still fill while
    // the cancel is in flight, and it frequently does, because the reason we
    // are cancelling is the reason someone wants to trade with us.
    order.cancelEffectiveAtMs =
      nowMs +
      BigInt(Math.round(this.latency.decisionLatencyMs())) +
      BigInt(Math.round(this.latency.cancelLatencyMs(order)));
    this.pendingCancels.push(order);

    return [this.update(order, 'cancel_requested', nowMs)];
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------

  /**
   * Advances the exchange to `nowMs`: activates arrived orders and applies
   * cancels that have become effective.
   *
   * Cancels are applied BEFORE activations so that an order cancelled before
   * it ever arrived never rests. Activations then run in submission order.
   */
  advanceTo(nowMs: bigint): { updates: SimulatedOrderUpdate[]; fills: SimulatedFill[] } {
    const updates: SimulatedOrderUpdate[] = [];
    const fills: SimulatedFill[] = [];

    if (this.pendingCancels.length > 0) {
      const stillPendingCancel: SimulatedOrder[] = [];
      for (const order of this.pendingCancels) {
        if (order.cancelEffectiveAtMs !== null && order.cancelEffectiveAtMs > nowMs) {
          stillPendingCancel.push(order);
          continue;
        }
        if (
          order.status === 'filled' ||
          order.status === 'cancelled' ||
          order.status === 'rejected'
        ) {
          continue;
        }
        this.retire(order, 'cancelled', 'cancel effective', nowMs);
        updates.push(this.update(order, 'cancelled', nowMs));
      }
      this.pendingCancels = stillPendingCancel;
    }

    if (this.pending.length === 0) return { updates, fills };

    const stillPending: SimulatedOrder[] = [];
    for (const order of this.pending) {
      if (order.status !== 'pending') continue;
      if (order.effectiveAtMs > nowMs) {
        stillPending.push(order);
        continue;
      }
      const arrival = this.activate(order, nowMs);
      updates.push(...arrival.updates);
      fills.push(...arrival.fills);
    }
    this.pending = stillPending;

    return { updates, fills };
  }

  /** An order has reached the exchange: cross what it can, rest the remainder. */
  private activate(
    order: SimulatedOrder,
    nowMs: bigint,
  ): { updates: SimulatedOrderUpdate[]; fills: SimulatedFill[] } {
    const updates: SimulatedOrderUpdate[] = [];
    const fills: SimulatedFill[] = [];

    const view = this.state.view(order.marketTicker);
    if (!view || !view.valid) {
      // Arriving into a book we cannot vouch for. Rejecting is the honest
      // outcome: we have no evidence about what it would have matched against.
      this.retire(order, 'rejected', 'book not valid on arrival', nowMs);
      order.rejectReason = 'book_invalid';
      updates.push(this.update(order, 'rejected', nowMs));
      return { updates, fills };
    }

    fills.push(...this.cross(order, view, nowMs));

    const remaining = remainingOf(order);
    if (remaining.lte(0)) {
      this.retire(order, 'filled', 'fully filled on arrival', nowMs);
      updates.push(this.update(order, 'filled', nowMs));
      return { updates, fills };
    }

    if (order.timeInForce === 'ioc') {
      this.retire(order, 'cancelled', 'ioc remainder cancelled', nowMs);
      updates.push(this.update(order, 'cancelled', nowMs));
      return { updates, fills };
    }

    this.rest(order, view, nowMs);
    updates.push(this.update(order, 'resting', nowMs));
    return { updates, fills };
  }

  // -------------------------------------------------------------------------
  // Taker execution
  // -------------------------------------------------------------------------

  /**
   * Consumes displayed liquidity level by level.
   *
   * There is no assumption of infinite size at the touch. A 500-contract
   * market order into a book showing 40 at the best price fills 40 there and
   * walks, which on a thin prediction market is the difference between a
   * strategy that works and one that does not.
   */
  private cross(order: SimulatedOrder, view: BookView, nowMs: bigint): SimulatedFill[] {
    const fills: SimulatedFill[] = [];
    const levels = order.yesAction === 'buy' ? view.yesAskLevels() : view.yesBidLevels();

    for (const [priceStr, sizeStr] of levels) {
      const remaining = remainingOf(order);
      if (remaining.lte(0)) break;

      const levelPrice = D(priceStr);
      const acceptable =
        order.yesAction === 'buy' ? levelPrice.lte(order.yesPrice) : levelPrice.gte(order.yesPrice);
      if (!acceptable) break; // ladders are best-first, so nothing further qualifies

      const take = Decimal.min(remaining, D(sizeStr));
      if (take.lte(0)) continue;

      fills.push(this.recordFill(order, take, levelPrice, 'taker', 'cross', nowMs, view, null));
    }

    return fills;
  }

  // -------------------------------------------------------------------------
  // Passive execution
  // -------------------------------------------------------------------------

  private rest(order: SimulatedOrder, view: BookView, nowMs: bigint): void {
    const ladder = ladderOf(order);
    const displayed =
      ladder.side === 'yes' ? view.yesBidSizeAt(order.yesPrice) : view.yesAskSizeAt(order.yesPrice);

    order.status = 'resting';
    order.restedAtMs = nowMs;
    order.queue = newQueueState(displayed, this.fillModel.initialQueueAhead(displayed), nowMs);

    const key = this.levelKey(order.marketTicker, ladder.side, ladder.price);
    let set = this.restingByLevel.get(key);
    if (!set) {
      set = new Set();
      this.restingByLevel.set(key, set);
    }
    set.add(order.orderId);

    let byMarket = this.restingByMarket.get(order.marketTicker);
    if (!byMarket) {
      byMarket = new Set();
      this.restingByMarket.set(order.marketTicker, byMarket);
    }
    byMarket.add(order.orderId);
  }

  private levelKey(marketTicker: string, side: 'yes' | 'no', price: string): string {
    return `${marketTicker}|${side}|${price}`;
  }

  /**
   * A displayed level changed. Update every resting order sitting on it.
   *
   * Called with the recorder's own pre/post counts rather than a recomputed
   * difference, so the queue sees exactly the size change the exchange
   * published.
   */
  onBookDelta(event: BookDeltaEvent): void {
    if (!event.applied) return;
    if (event.preCount === null || event.postCount === null) return;

    const key = this.levelKey(event.marketTicker, event.side, canonicalPrice(event.price));
    const ids = this.restingByLevel.get(key);
    if (!ids || ids.size === 0) return;

    const pre = D(event.preCount);
    const post = D(event.postCount);
    for (const id of ids) {
      const order = this.orders.get(id);
      if (!order?.queue) continue;
      this.fillModel.onDisplayedSizeChange(order.queue, pre, post, event.receiveTimeMs);
    }
  }

  /**
   * A trade printed. Fill any resting order it would have reached.
   *
   * Eligibility is decided by which side of the book the AGGRESSOR consumed.
   * A taker buying YES removes YES asks, so it can only fill our resting YES
   * sells; a taker selling YES removes YES bids and can only fill our buys.
   * Getting this backwards produces a backtest in which the maker is filled by
   * every print and looks spectacular.
   */
  onTrade(event: TradeEvent): SimulatedFill[] {
    const fills: SimulatedFill[] = [];
    if (event.takerOutcomeSide === null) return fills; // never guessed
    if (this.frozen.has(event.marketTicker)) return fills;

    const view = this.state.view(event.marketTicker);
    if (!view || !view.valid) return fills;

    const tradeYesPrice = D(event.yesPrice);
    const tradeQty = D(event.count);
    if (tradeQty.lte(0)) return fills;

    // Taker bought YES -> our SELLS are eligible. Taker bought NO (sold YES)
    // -> our BUYS are eligible.
    const eligibleAction: Action = event.takerOutcomeSide === 'yes' ? 'sell' : 'buy';

    // Remaining print size, shared across our orders at successive prices.
    let available = tradeQty;

    const restingHere = this.restingByMarket.get(event.marketTicker);
    if (!restingHere || restingHere.size === 0) return fills;

    const candidates = [...restingHere]
      .map((id) => this.orders.get(id)!)
      .filter((o) => o !== undefined && o.status === 'resting' && o.yesAction === eligibleAction)
      .filter((o) =>
        eligibleAction === 'buy' ? o.yesPrice.gte(tradeYesPrice) : o.yesPrice.lte(tradeYesPrice),
      )
      // Best price first: a more aggressive resting order is reached first.
      // Best price first, then price-time priority among equals.
      .sort((a, b) =>
        eligibleAction === 'buy'
          ? b.yesPrice.comparedTo(a.yesPrice) || a.sequence - b.sequence
          : a.yesPrice.comparedTo(b.yesPrice) || a.sequence - b.sequence,
      );

    for (const order of candidates) {
      if (available.lte(0)) break;
      const queue = order.queue;
      if (!queue) continue;

      const remaining = remainingOf(order);
      if (remaining.lte(0)) continue;

      const through = !order.yesPrice.equals(tradeYesPrice);
      const queueAheadBefore = queue.queueAhead;
      const outcome = this.fillModel.onTrade(
        queue,
        available,
        remaining,
        through,
        event.receiveTimeMs,
      );
      if (outcome.filled.lte(0)) continue;

      // A resting order executes at ITS OWN price, not the print's. Filling a
      // 0.42 bid at a 0.40 print would credit the strategy with two cents it
      // never earned.
      const fill = this.recordFill(
        order,
        outcome.filled,
        order.yesPrice,
        'maker',
        outcome.reason,
        event.receiveTimeMs,
        view,
        event.tradeId,
        queueAheadBefore,
      );
      fills.push(fill);
      available = available.minus(outcome.filled);

      if (remainingOf(order).lte(0)) {
        this.retire(order, 'filled', 'fully filled', event.receiveTimeMs);
      }
    }

    return fills;
  }

  // -------------------------------------------------------------------------
  // Capture gaps
  // -------------------------------------------------------------------------

  /** Coverage lost. Apply the configured policy to every resting order. */
  onCaptureGap(marketTickers: readonly string[], nowMs: bigint): SimulatedOrderUpdate[] {
    const updates: SimulatedOrderUpdate[] = [];
    const affected = new Set(marketTickers);

    for (const ticker of affected) this.frozen.add(ticker);

    if (this.gapOrderPolicy === 'keep_resting') return updates;

    for (const order of this.orders.values()) {
      if (!affected.has(order.marketTicker)) continue;
      if (order.status !== 'resting' && order.status !== 'pending') continue;

      if (this.gapOrderPolicy === 'cancel_all') {
        this.retire(order, 'cancelled', 'capture gap', nowMs);
        updates.push(this.update(order, 'cancelled', nowMs));
      }
      // 'freeze' leaves the order resting but `frozen` suppresses matching.
    }
    return updates;
  }

  /** Coverage restored for a market, by a fresh exchange snapshot. */
  onCaptureResume(marketTicker: string): void {
    this.frozen.delete(marketTicker);
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  private recordFill(
    order: SimulatedOrder,
    quantity: Decimal,
    yesPrice: Decimal,
    liquidity: Liquidity,
    reason: FillReason,
    atMs: bigint,
    view: BookView,
    tradeId: string | null,
    queueAheadBeforeFill: Decimal | null = null,
  ): SimulatedFill {
    order.filledQuantity = order.filledQuantity.plus(quantity);

    const fee = this.feeModel.fee({
      marketTicker: order.marketTicker,
      quantity,
      yesPrice,
      liquidity,
    });

    // Reported in the order's own side terms as well as YES terms, so a NO
    // strategy reads its own prices back rather than their complements.
    const sidePrice = order.side === 'yes' ? yesPrice : ONE.minus(yesPrice);

    const bbo = view.valid ? view.bbo() : null;
    const depth = view.valid ? view.depth(1) : null;

    const fill: SimulatedFill = {
      fillId: `f${++this.fillSeq}`,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      marketTicker: order.marketTicker,
      side: order.side,
      action: order.action,
      yesAction: order.yesAction,
      price: sidePrice,
      yesPrice,
      quantity,
      liquidity,
      reason,
      fee,
      submittedAtMs: order.submittedAtMs,
      arrivedAtMs: order.effectiveAtMs,
      filledAtMs: atMs,
      queueAheadAtEntry: order.queue?.queueAheadAtEntry ?? null,
      queueAheadBeforeFill,
      fillModel: this.fillModel.name,
      bookStateHash: view.valid ? view.stateHash() : null,
      triggeringTradeId: tradeId,
      tag: order.tag,
      midAtFill: bbo?.mid ?? null,
      spreadAtFill: bbo?.spread ?? null,
      depth1AtFill: depth === null ? null : depth.bid.plus(depth.ask),
      imbalance1AtFill: view.valid ? view.imbalance(1) : null,
    };

    this.fills.push(fill);
    return fill;
  }

  private retire(
    order: SimulatedOrder,
    status: Exclude<OrderStatus, 'pending' | 'resting'>,
    _reason: string,
    atMs: bigint,
  ): void {
    order.status = status;
    order.terminalAtMs = atMs;
    order.queue = null;

    const ladder = ladderOf(order);
    this.restingByLevel
      .get(this.levelKey(order.marketTicker, ladder.side, ladder.price))
      ?.delete(order.orderId);
    this.restingByMarket.get(order.marketTicker)?.delete(order.orderId);
  }

  private reject(clientOrderId: string, reason: string, atMs: bigint): SimulatedOrderUpdate {
    return {
      orderId: '',
      clientOrderId,
      marketTicker: '',
      status: 'rejected',
      reason,
      atMs,
      remainingQuantity: ZERO,
    };
  }

  private update(order: SimulatedOrder, reason: string, atMs: bigint): SimulatedOrderUpdate {
    return {
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      marketTicker: order.marketTicker,
      status: order.status,
      reason,
      atMs,
      remainingQuantity: remainingOf(order),
    };
  }

  findByClientId(clientOrderId: string): SimulatedOrder | undefined {
    const id = this.byClientId.get(clientOrderId);
    return id === undefined ? undefined : this.orders.get(id);
  }

  allOrders(): SimulatedOrder[] {
    return [...this.orders.values()].sort((a, b) => a.sequence - b.sequence);
  }

  openOrders(marketTicker?: string): SimulatedOrder[] {
    const out: SimulatedOrder[] = [];

    const markets =
      marketTicker === undefined ? [...this.restingByMarket.keys()] : [marketTicker];
    for (const market of markets) {
      for (const id of this.restingByMarket.get(market) ?? []) {
        const order = this.orders.get(id);
        if (order?.status === 'resting') out.push(order);
      }
    }
    for (const order of this.pending) {
      if (order.status !== 'pending') continue;
      if (marketTicker !== undefined && order.marketTicker !== marketTicker) continue;
      out.push(order);
    }

    // Stable, so a strategy iterating its own book sees a fixed order.
    return out.sort((a, b) => a.sequence - b.sequence);
  }

  /** Ends the run: everything still live is cancelled at `atMs`. */
  finalize(atMs: bigint): SimulatedOrderUpdate[] {
    const updates: SimulatedOrderUpdate[] = [];
    for (const order of this.openOrders()) {
      this.retire(order, 'cancelled', 'end of run', atMs);
      updates.push(this.update(order, 'cancelled', atMs));
    }
    this.pending = [];
    this.pendingCancels = [];
    return updates;
  }
}

/**
 * The backtest execution adapter.
 *
 * A deliberately thin wrapper: it exists so that strategy code depends on
 * `ExecutionAdapter` and never on `SimulatedExchange`. When the paper and live
 * adapters arrive they implement the same three methods against Kalshi's REST
 * and WebSocket APIs, and every strategy works unchanged.
 */
export class SimulatedExecutionAdapter implements ExecutionAdapter {
  readonly mode: ExecutionMode = 'backtest';
  readonly name = 'simulated';

  constructor(private readonly exchange: SimulatedExchange) {}

  describe(): Record<string, unknown> {
    return { adapter: 'simulated', mode: this.mode };
  }

  submit(intent: OrderIntent, nowMs: bigint): OrderUpdate[] {
    return this.exchange.submit(intent, nowMs);
  }

  openOrders(marketTicker?: string): WorkingOrder[] {
    return this.exchange.openOrders(marketTicker);
  }

  findByClientId(clientOrderId: string): WorkingOrder | undefined {
    return this.exchange.findByClientId(clientOrderId);
  }
}
