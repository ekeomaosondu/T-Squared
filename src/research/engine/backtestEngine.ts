import type { Decimal } from '@/src/book/decimal';
import type {
  BookCheckpoint,
  HistoricalDataSource,
  HistoricalRequest,
  DatasetSlice,
} from '@/src/research/data/historicalDataSource';
import {
  isMarketEvent,
  type BookDeltaEvent,
  type BookSnapshotEvent,
  type CaptureGapEvent,
  type ResearchEvent,
  type TradeEvent,
} from '@/src/research/events/researchEvent';
import { MarketStateStore, type BookView } from '@/src/research/engine/marketState';
import { SimulationClock } from '@/src/research/engine/simulationClock';
import { TimerScheduler, timerEvent } from '@/src/research/engine/scheduler';
import { createContext, type MarketState, type StrategyContext } from '@/src/research/strategy/context';
import type { Strategy } from '@/src/research/strategy/strategy';
import {
  SimulatedExchange,
  SimulatedExecutionAdapter,
  type GapOrderPolicy,
  type SimulatedFill,
  type SimulatedOrder,
  type SimulatedOrderUpdate,
} from '@/src/research/execution/simulatedExchange';
import type { FillModel } from '@/src/research/execution/fills/fillModel';
import type { LatencyModel } from '@/src/research/execution/latencyModel';
import type { FeeModel } from '@/src/research/portfolio/fees';
import { Portfolio, type EquityRow } from '@/src/research/portfolio/portfolio';
import { MidSeriesStore } from '@/src/research/metrics/midSeries';
import type { HistoricalMarketState } from '@/src/research/data/marketDefinitions';
import { logger } from '@/src/logging/logger';

/**
 * The backtest engine.
 *
 * One loop, one clock, one ordering. Its entire job is to advance simulated
 * time through recorded events and to guarantee that nothing in the run ever
 * consults information from later than the instant being processed.
 *
 * ---------------------------------------------------------------------------
 * Where latency is charged
 * ---------------------------------------------------------------------------
 * The strategy is invoked at each event's TRUE timestamp, but the order it
 * emits is charged market-data latency on top of decision and submission
 * latency. So an order reacting to an event at time T can be effective no
 * earlier than T + marketData + decision + submit.
 *
 * That is the same arrival time a real system would achieve -- it would have
 * received the event at T + marketData and acted then -- while the information
 * the strategy used is what existed at T rather than at T + marketData. The
 * simulated strategy therefore acts on strictly LESS information than the real
 * one for the same arrival time. The error is real, it is bounded by the
 * market-data latency, and it points against the strategy, which is the only
 * direction a modelling error may point.
 *
 * The alternative -- maintaining a second, delayed copy of every book -- buys
 * exactness at roughly double the memory and time, and is a Phase 2 change if
 * a study ever turns out to be sensitive to it.
 */

/** What a backtest does when it reaches an interval nobody was recording. */
export type CaptureGapPolicy = 'abort' | 'skip_event' | 'skip_until_fresh_snapshot';

export interface BacktestOptions {
  source: HistoricalDataSource;
  request: HistoricalRequest;
  strategy: Strategy;
  fillModel: FillModel;
  feeModel: FeeModel;
  latency: LatencyModel;
  /** Default `skip_until_fresh_snapshot`. */
  gapPolicy?: CaptureGapPolicy;
  /** Default `cancel_all`. */
  gapOrderPolicy?: GapOrderPolicy;
  /** Grid on which inventory and drawdown are sampled. Default 1000 ms. */
  markIntervalMs?: number;
  /** Stop after this many events. For smoke tests only. */
  maxEvents?: number;
  /** Recorded in the manifest. Nothing in Phase 1 is stochastic. */
  randomSeed?: number;
  /**
   * Check the reconstructed book against the collector's own recorded hashes.
   *
   * On by default. It costs one ladder hash per checkpoint and it is the only
   * thing standing between "the backtest ran" and "the backtest ran on the
   * book that actually existed".
   */
  verifyCheckpoints?: boolean;
}

/**
 * What happened to every position the run was left holding.
 *
 * Reported rather than summed away, because the four non-settled outcomes are
 * not interchangeable: two are data gaps we could close, one is a fact we can
 * only wait for, and one says the position cannot be valued at all.
 */
export interface SettlementReport {
  settled: number;
  voided: number;
  openAtRunEnd: number;
  awaitingDetermination: number;
  unpriceable: number;
  /** Settled positions whose determination the exchange still calls provisional. */
  provisional: string[];
  /** Markets held at the end with no record in the lake at all. */
  noMarketState: string[];
  /** How each settled payout was established. */
  basisCounts: Record<string, number>;
}

/** An interval in which the run refused to trust the book. */
export interface InvalidInterval {
  marketTicker: string;
  fromMs: string;
  toMs: string | null;
  reason: string;
}

export interface BacktestRunResult {
  slice: DatasetSlice;
  orders: SimulatedOrder[];
  fills: SimulatedFill[];
  portfolio: Portfolio;
  midSeries: MidSeriesStore;
  invalidIntervals: InvalidInterval[];
  /** Market definitions and determinations used for settlement. */
  marketStates: Map<string, HistoricalMarketState>;
  /** How each held position finished, and why. */
  settlement: SettlementReport;
  /** Compact equity curve on the mark grid. */
  equityCurve: EquityRow[];
  counts: {
    events: number;
    snapshots: number;
    deltas: number;
    trades: number;
    timers: number;
    captureGaps: number;
    ordersSubmitted: number;
    ordersCancelled: number;
    ordersRejected: number;
  };
  bookStats: MarketStateStore['stats'];
  firstEventMs: bigint | null;
  lastEventMs: bigint | null;
  wallClockMs: number;
  peakRssBytes: number;
  /**
   * Replay equality against the collector's independently recorded book
   * hashes. `compared === matched` means the reconstruction is exact.
   */
  checkpointChecks: {
    compared: number;
    matched: number;
    skippedInvalidBook: number;
    mismatches: { marketTicker: string; atMs: string; expected: string; actual: string }[];
  };
}

export class BacktestEngine {
  private readonly clock = new SimulationClock();
  private readonly scheduler = new TimerScheduler();
  private readonly state = new MarketStateStore();
  private readonly portfolio = new Portfolio();
  private readonly midSeries = new MidSeriesStore();
  private readonly exchange: SimulatedExchange;
  private readonly adapter: SimulatedExecutionAdapter;
  private readonly ctx: StrategyContext;

  private readonly gapPolicy: CaptureGapPolicy;
  private readonly markIntervalMs: number;

  private readonly seriesOf = new Map<string, string | null>();
  private readonly eventOf = new Map<string, string | null>();
  private readonly gapOpen = new Map<string, InvalidInterval>();
  private readonly invalidIntervals: InvalidInterval[] = [];
  private readonly equityCurve: EquityRow[] = [];

  private universe: string[] = [];
  private nextMarkMs: bigint | null = null;
  private peakRss = 0;

  private readonly counts = {
    events: 0,
    snapshots: 0,
    deltas: 0,
    trades: 0,
    timers: 0,
    captureGaps: 0,
    ordersSubmitted: 0,
    ordersCancelled: 0,
    ordersRejected: 0,
  };
  private readonly checkpointChecks = {
    compared: 0,
    matched: 0,
    skippedInvalidBook: 0,
    mismatches: [] as { marketTicker: string; atMs: string; expected: string; actual: string }[],
  };
  private checkpoints: BookCheckpoint[] = [];
  private checkpointIdx = 0;
  private marketStates = new Map<string, HistoricalMarketState>();

  /**
   * Live view of the market states, handed to the exchange at construction.
   *
   * The exchange needs them for fees but the source is async, so it receives
   * this map and the run fills it in before the first event.
   */
  private readonly marketStateRef = new Map<string, HistoricalMarketState>();

  constructor(private readonly opts: BacktestOptions) {
    this.gapPolicy = opts.gapPolicy ?? 'skip_until_fresh_snapshot';
    this.markIntervalMs = opts.markIntervalMs ?? 1000;

    this.exchange = new SimulatedExchange({
      state: this.state,
      fillModel: opts.fillModel,
      feeModel: opts.feeModel,
      latency: opts.latency,
      gapOrderPolicy: opts.gapOrderPolicy,
      marketStates: this.marketStateRef,
    });
    this.adapter = new SimulatedExecutionAdapter(this.exchange);

    this.ctx = createContext({
      clock: this.clock,
      scheduler: this.scheduler,
      adapter: this.adapter,
      markets: () => this.universe,
      marketState: (ticker) => this.marketState(ticker),
      position: (ticker) => this.portfolio.positionQuantity(ticker),
      onLog: (event, fields) =>
        logger.debug({ event: `strategy_${event}`, at: this.clock.nowIso(), ...fields }, event),
    });
  }

  private marketState(ticker: string): MarketState | undefined {
    const book = this.state.view(ticker);
    if (!book) return undefined;
    return {
      ticker,
      book,
      valid: book.valid,
      seriesTicker: this.seriesOf.get(ticker) ?? null,
      eventTicker: this.eventOf.get(ticker) ?? null,
    };
  }

  async run(): Promise<BacktestRunResult> {
    const startedAt = Date.now();

    const slice = await this.opts.source.describe(this.opts.request);
    this.universe = [...slice.marketTickers];

    if (this.opts.verifyCheckpoints !== false) {
      this.checkpoints = await this.opts.source.checkpoints(this.opts.request);
    }

    // Loaded up front so the exchange can resolve fees per market, and held
    // for settlement after the run. Determination fields are not read during
    // the loop.
    this.marketStates = await this.opts.source.marketStates(this.opts.request);
    for (const [ticker, state] of this.marketStates) this.marketStateRef.set(ticker, state);

    this.opts.strategy.onStart(this.ctx);

    let firstEventMs: bigint | null = null;
    let lastEventMs: bigint | null = null;

    for await (const event of this.opts.source.stream(this.opts.request)) {
      const at = event.receiveTimeMs;
      if (firstEventMs === null) {
        firstEventMs = at;
        this.nextMarkMs = at;
      }
      lastEventMs = at;

      this.drainTimersBefore(at);

      // Checkpoints are compared at the END of their millisecond: every event
      // stamped with that millisecond has been applied, and none from the next
      // one has. That is the state the live sampler captured, because it ran
      // in the same process after the frame handler returned. Comparing before
      // the events sharing the checkpoint's millisecond leaves six of 14,832
      // hashes off by exactly the deltas in that millisecond.
      this.checkCheckpointsUpTo(at);

      this.clock.advanceTo(at);

      // Control messages split around the event by a STRICT comparison.
      //
      // Everything effective strictly BEFORE this instant is applied first: a
      // cancel that became effective a second ago must not still be resting
      // when a print arrives, and an order that arrived a second ago must be
      // in the book.
      //
      // Everything effective at EXACTLY this instant is applied after. Ties go
      // against the strategy in both directions: an order that arrives on the
      // timestamp of a favourable print misses it, and a cancel that becomes
      // effective on that timestamp does not save us from the fill.
      this.applyExchange(this.exchange.advanceTo(at - 1n));

      this.handle(event);

      this.applyExchange(this.exchange.advanceTo(at));

      this.maybeMark(at);

      this.counts.events += 1;
      if (this.opts.maxEvents && this.counts.events >= this.opts.maxEvents) break;
      if ((this.counts.events & 0xffff) === 0) this.samplePeakRss();
    }

    // Timers scheduled past the last event still fire, so a strategy's final
    // reprice is not silently dropped.
    if (lastEventMs !== null) this.drainTimersBefore(lastEventMs + 1n);

    if (lastEventMs !== null) {
      this.checkCheckpointsUpTo(lastEventMs + 1n);
      this.applyExchange({ updates: this.exchange.finalize(lastEventMs), fills: [] });
      this.mark(lastEventMs);
      for (const [ticker, interval] of this.gapOpen) {
        interval.toMs = lastEventMs.toString();
        this.gapOpen.delete(ticker);
      }
    }

    this.opts.strategy.onStop(this.ctx);

    // Settlement runs AFTER onStop, and reads a map the strategy never had a
    // reference to. A determination is a fact from after the run window, so
    // letting it reach a strategy callback -- even the last one -- would be
    // handing it the answer.
    const settlement = this.applySettlement(lastEventMs);

    this.samplePeakRss();

    return {
      slice,
      orders: this.exchange.allOrders(),
      fills: this.exchange.fills,
      portfolio: this.portfolio,
      midSeries: this.midSeries,
      invalidIntervals: this.invalidIntervals,
      marketStates: this.marketStates,
      settlement,
      equityCurve: this.equityCurve,
      counts: this.counts,
      bookStats: this.state.stats,
      firstEventMs,
      lastEventMs,
      wallClockMs: Date.now() - startedAt,
      peakRssBytes: this.peakRss,
      checkpointChecks: this.checkpointChecks,
    };
  }

  // -------------------------------------------------------------------------
  // Event dispatch
  // -------------------------------------------------------------------------

  private handle(event: ResearchEvent): void {
    if (isMarketEvent(event) && event.marketTicker) {
      if (!this.seriesOf.has(event.marketTicker)) {
        this.seriesOf.set(event.marketTicker, event.seriesTicker ?? null);
        this.eventOf.set(event.marketTicker, event.eventTicker ?? null);
      }
    }

    switch (event.kind) {
      case 'book_snapshot':
        return this.onSnapshot(event);
      case 'book_delta':
        return this.onDelta(event);
      case 'trade':
        return this.onTrade(event);
      case 'capture_gap':
        return this.onCaptureGap(event);
      case 'market_lifecycle':
      case 'timer':
        return;
    }
  }

  private onSnapshot(event: BookSnapshotEvent): void {
    this.state.applySnapshot(event);
    this.counts.snapshots += 1;

    const wasGapped = this.gapOpen.get(event.marketTicker);
    if (wasGapped) {
      wasGapped.toMs = event.receiveTimeMs.toString();
      this.gapOpen.delete(event.marketTicker);
      this.exchange.onCaptureResume(event.marketTicker);
      this.opts.strategy.onDataResume(event.marketTicker, this.ctx);
    }

    this.recordMid(event.marketTicker, event.receiveTimeMs);
    this.opts.strategy.onBookUpdate(event, this.ctx);
  }

  private onDelta(event: BookDeltaEvent): void {
    const outcome = this.state.applyDelta(event);
    this.counts.deltas += 1;
    if (!outcome.applied) return;

    // Queue estimates move on the recorder's own pre/post counts.
    this.exchange.onBookDelta(event);

    this.recordMid(event.marketTicker, event.receiveTimeMs);
    this.opts.strategy.onBookUpdate(event, this.ctx);
  }

  private onTrade(event: TradeEvent): void {
    this.counts.trades += 1;
    // A trade proves we were still watching, even though it does not move the
    // book. Without this the markout window would end at the last QUOTE change.
    this.midSeries.for(event.marketTicker).observe(event.receiveTimeMs);
    const fills = this.exchange.onTrade(event);
    this.applyExchange({ updates: [], fills });
    this.opts.strategy.onTrade(event, this.ctx);
  }

  private onCaptureGap(event: CaptureGapEvent): void {
    this.counts.captureGaps += 1;

    if (this.gapPolicy === 'abort') {
      throw new Error(
        `capture gap from ${new Date(Number(event.startedAtMs)).toISOString()} to ` +
          `${event.endedAtMs === null ? 'unknown' : new Date(Number(event.endedAtMs)).toISOString()}: ` +
          'nobody was recording, so the run cannot continue under policy "abort"',
      );
    }

    const invalidated = this.state.applyCaptureGap(event);
    for (const ticker of invalidated) {
      const interval: InvalidInterval = {
        marketTicker: ticker,
        fromMs: event.startedAtMs.toString(),
        toMs: null,
        reason: `capture_gap:${event.reason}`,
      };
      this.gapOpen.set(ticker, interval);
      this.invalidIntervals.push(interval);
      // A stale mid must not survive the gap: recording a null here is what
      // stops a markout from reading straight across an interval nobody saw.
      this.midSeries.for(ticker).record(event.startedAtMs, null, null);
    }

    if (this.gapPolicy === 'skip_until_fresh_snapshot') {
      this.applyExchange({
        updates: this.exchange.onCaptureGap(invalidated, event.receiveTimeMs),
        fills: [],
      });
    }

    this.opts.strategy.onDataGap(event, this.ctx);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /**
   * Compares the reconstructed book against every checkpoint whose millisecond
   * has fully elapsed, i.e. `cp.atMs < atMs`.
   *
   * A book that is not valid at the checkpoint instant is SKIPPED, not counted
   * as a mismatch: during a capture gap the recorder had state we deliberately
   * refuse to reconstruct, and calling that a failure would punish the replay
   * for being honest.
   */
  private checkCheckpointsUpTo(atMs: bigint): void {
    while (this.checkpointIdx < this.checkpoints.length) {
      const cp = this.checkpoints[this.checkpointIdx]!;
      if (cp.atMs >= atMs) break;
      this.checkpointIdx += 1;

      const view = this.state.view(cp.marketTicker);
      if (!view || !view.valid) {
        this.checkpointChecks.skippedInvalidBook += 1;
        continue;
      }

      this.checkpointChecks.compared += 1;
      const actual = view.stateHash();
      if (actual === cp.stateHash) {
        this.checkpointChecks.matched += 1;
      } else if (this.checkpointChecks.mismatches.length < 25) {
        this.checkpointChecks.mismatches.push({
          marketTicker: cp.marketTicker,
          atMs: cp.atMs.toString(),
          expected: cp.stateHash,
          actual,
        });
      }
    }
  }

  /**
   * Applies the exchange's determinations to whatever the run is still holding.
   *
   * Every position gets a resolution, and the four unsettled ones are kept
   * apart on purpose. "The run ended while the market was still trading" is a
   * window we chose and could extend; "the market closed and the exchange has
   * not ruled yet" is a fact we can only wait for; "no record in the lake"
   * is a pipeline gap; "no mark either" means the position cannot be valued at
   * all. Summing them into one residual would hide three fixable problems
   * behind one unfixable one.
   */
  private applySettlement(lastEventMs: bigint | null): SettlementReport {
    const report: SettlementReport = {
      settled: 0,
      voided: 0,
      openAtRunEnd: 0,
      awaitingDetermination: 0,
      unpriceable: 0,
      provisional: [],
      noMarketState: [],
      basisCounts: {},
    };

    for (const position of this.portfolio.allPositions()) {
      if (position.quantity.isZero()) continue;
      const ticker = position.marketTicker;
      const state = this.marketStates.get(ticker);

      if (!state) {
        report.noMarketState.push(ticker);
        this.portfolio.resolveAs(ticker, this.hasMark(ticker) ? 'OPEN_AT_RUN_END' : 'UNPRICEABLE');
        if (this.hasMark(ticker)) report.openAtRunEnd += 1;
        else report.unpriceable += 1;
        continue;
      }

      if (state.state === 'VOIDED') {
        this.portfolio.voidMarket(ticker);
        report.voided += 1;
        continue;
      }

      if (state.yesSettlementValue !== null) {
        this.portfolio.settle(ticker, state.yesSettlementValue);
        report.settled += 1;
        report.basisCounts[state.settlementBasis] =
          (report.basisCounts[state.settlementBasis] ?? 0) + 1;
        // A provisional determination can still be revised, so a result built
        // on one is provisional too and says so.
        if (state.isProvisional) report.provisional.push(ticker);
        continue;
      }

      const marked = this.hasMark(ticker);
      if (state.state === 'CLOSED_UNDETERMINED') {
        this.portfolio.resolveAs(ticker, marked ? 'AWAITING_DETERMINATION' : 'UNPRICEABLE');
        if (marked) report.awaitingDetermination += 1;
        else report.unpriceable += 1;
      } else {
        this.portfolio.resolveAs(ticker, marked ? 'OPEN_AT_RUN_END' : 'UNPRICEABLE');
        if (marked) report.openAtRunEnd += 1;
        else report.unpriceable += 1;
      }
    }

    // Re-mark after settlement so the final equity row reflects the payouts.
    if (lastEventMs !== null) this.mark(lastEventMs);
    return report;
  }

  private hasMark(marketTicker: string): boolean {
    const view = this.state.view(marketTicker);
    return view?.valid === true && view.bbo().mid !== null;
  }

  private drainTimersBefore(atMs: bigint): void {
    for (;;) {
      const due = this.scheduler.peekDueMs();
      if (due === null || due > atMs) break;
      for (const timer of this.scheduler.drainDue(due)) {
        this.clock.advanceTo(timer.dueMs);
        this.applyExchange(this.exchange.advanceTo(timer.dueMs));
        this.counts.timers += 1;
        this.opts.strategy.onTimer(timerEvent(timer, 'simulated'), this.ctx);
      }
    }
  }

  private applyExchange(result: { updates: SimulatedOrderUpdate[]; fills: SimulatedFill[] }): void {
    for (const fill of result.fills) {
      if (!fill.feeKnown) this.portfolio.noteUnknownFee();
      this.portfolio.applyFill(fill);
      this.opts.strategy.onFill(fill, this.ctx);
    }
    for (const update of result.updates) {
      if (update.status === 'pending') this.counts.ordersSubmitted += 1;
      if (update.status === 'cancelled') this.counts.ordersCancelled += 1;
      if (update.status === 'rejected') this.counts.ordersRejected += 1;
      this.opts.strategy.onOrderUpdate(update, this.ctx);
    }
  }

  private recordMid(marketTicker: string, atMs: bigint): void {
    const view: BookView | undefined = this.state.view(marketTicker);
    if (!view) return;
    if (!view.valid) {
      this.midSeries.for(marketTicker).record(atMs, null, null);
      return;
    }
    this.midSeries.for(marketTicker).record(atMs, view.bbo().mid, view.microprice());
  }

  private maybeMark(atMs: bigint): void {
    if (this.nextMarkMs === null) return;
    if (atMs < this.nextMarkMs) return;
    this.mark(atMs);
    const step = BigInt(this.markIntervalMs);
    // Catch up in whole steps so the grid stays aligned across a quiet period.
    this.nextMarkMs = this.nextMarkMs + ((atMs - this.nextMarkMs) / step + 1n) * step;
  }

  private mark(atMs: bigint): void {
    // Only markets the portfolio actually holds. The mark grid fires once a
    // second for the whole run, and pricing all two dozen markets each time --
    // when the strategy is flat in most of them -- is the second largest cost
    // in a full-day backtest after applying the deltas themselves.
    const marks = new Map<string, Decimal | null>();
    for (const position of this.portfolio.allPositions()) {
      const view = this.state.view(position.marketTicker);
      marks.set(position.marketTicker, view?.valid ? view.bbo().mid : null);
    }
    this.portfolio.mark(atMs, marks);
    this.equityCurve.push(this.portfolio.equityRow(atMs, marks));
  }

  private samplePeakRss(): void {
    const rss = process.memoryUsage().rss;
    if (rss > this.peakRss) this.peakRss = rss;
  }
}
