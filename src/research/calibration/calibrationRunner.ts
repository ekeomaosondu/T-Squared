import { randomUUID } from 'node:crypto';
import { Decimal, D, ONE, ZERO, canonicalPrice } from '@/src/book/decimal';
import type { Sql } from '@/src/persistence/db';
import { gitCommitSha } from '@/src/config/env';
import { KalshiApiError } from '@/src/kalshi/restClient';
import {
  AmbiguousOrderError,
  type KalshiTradingClient,
  type KalshiOrder,
} from '@/src/kalshi/tradingClient';
import type { LiveKalshiDataSource } from '@/src/research/data/liveKalshiSource';
import type { HistoricalMarketState } from '@/src/research/data/marketDefinitions';
import { MarketStateStore } from '@/src/research/engine/marketState';
import { SimulatedExchange, type SimulatedFill } from '@/src/research/execution/simulatedExchange';
import { ZeroLatencyModel } from '@/src/research/execution/latencyModel';
import { ZeroFeeModel } from '@/src/research/portfolio/fees';
import type { FillModel } from '@/src/research/execution/fills/fillModel';
import { KalshiPrivateFeed } from '@/src/research/calibration/privateFeed';
import { CalibrationStore } from '@/src/research/calibration/store';
import {
  LevelActivityTracker,
  RecentActivity,
} from '@/src/research/calibration/levelActivity';
import { ticksFromTouch } from '@/src/book/ladder';
import {
  assessEligibility,
  chooseDwellMs,
  chooseSide,
  selectNext,
  stratumId,
  type Candidate,
} from '@/src/research/calibration/marketSelector';
import {
  isKilled,
  mayPlaceProbe,
  premiumForProbe,
  type AccountState,
  type CalibrationEnvelope,
} from '@/src/research/calibration/riskEnvelope';
import { logger } from '@/src/logging/logger';

/**
 * CALIBRATION mode: real one-contract post-only probes, placed to learn how
 * the queue behaves rather than to make money.
 *
 * ---------------------------------------------------------------------------
 * Why this places real orders at all
 * ---------------------------------------------------------------------------
 * Every fill model in this repository is a guess about where an order sits in
 * a queue that market-by-price data cannot show. Kalshi will report the true
 * queue position -- but only for orders that are actually on the exchange. A
 * shadow run, however carefully instrumented, can never obtain that number.
 * So the experiment buys it, one contract at a time.
 *
 * ---------------------------------------------------------------------------
 * Why it must not be optimised for fills
 * ---------------------------------------------------------------------------
 * Side is a coin flip. Market selection rotates across depth and flow strata.
 * The price is fixed for the whole dwell and never repriced. All three rules
 * cost fill rate on purpose: a dataset gathered only where we expected to fill
 * teaches a model the conditions under which we chose easy fills, and that
 * model would then be confidently wrong everywhere else.
 *
 * Non-fills are kept. A probe that entered behind 400 contracts, watched the
 * queue fall to 220 over two minutes and never filled is a censored
 * observation, and censored observations are most of the information.
 */

export interface CalibrationConfig {
  envelope: CalibrationEnvelope;
  seriesTickers: string[];
  /** Wall-clock duration. Zero runs until interrupted. */
  runForMs: number;
  queuePollIntervalMs: number;
  /** Randomised pause between probes, so cadence is not confounded with depth. */
  cooldownMinMs: number;
  cooldownMaxMs: number;
  /** Exchange-side expiry, longer than the dwell, as a last-resort backstop. */
  expirationSlackMs: number;
  /** Placed orders are suppressed. Everything else runs. */
  dryRun: boolean;
  /**
   * Break stratum ties toward markets whose touch moves often.
   *
   * For the diagnostic run that has to produce observations where our probe
   * ends up BEHIND a newly improved price -- the regime the first audit had
   * almost no data for, and the one where better-priced depth could matter.
   */
  preferChurn?: boolean;
  fillModels: FillModel[];
  random?: () => number;
}

export const CALIBRATION_DEFAULTS = {
  queuePollIntervalMs: 500,
  cooldownMinMs: 5_000,
  cooldownMaxMs: 20_000,
  expirationSlackMs: 60_000,
};

type ProbeState =
  | 'submitting'
  | 'resting'
  | 'cancelling'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'ambiguous';

interface ActiveProbe {
  probeId: string;
  clientOrderId: string;
  orderId: string | null;
  marketTicker: string;
  seriesTicker: string;
  side: 'bid' | 'ask';
  yesPrice: Decimal;
  priceCents: number;
  quantity: number;
  plannedDwellMs: number;
  restingSinceMs: number | null;
  levelKey: string;
  state: ProbeState;
  queueSeqNo: number;
  lastQueuePosition: number | null;
  recordedInitialQueue: boolean;
  premium: Decimal;
  stratum: string;
  /** Each model's belief about the queue ahead, captured while it rested. */
  modelledQueueAtEntry: Map<string, Decimal>;
}

/** Why the runner stopped placing orders. */
export type StopReason =
  | 'book_invalid'
  | 'recovery_underway'
  | 'private_feed_down'
  | 'persistence_unavailable'
  | 'risk_limit'
  | 'ambiguous_order_state'
  | 'duration_elapsed'
  | 'interrupted';

export class CalibrationRunner {
  private readonly store: CalibrationStore;
  private readonly state = new MarketStateStore();
  private readonly activity = new RecentActivity();
  private readonly levels = new LevelActivityTracker();
  private readonly random: () => number;

  private readonly counterfactuals: { model: FillModel; exchange: SimulatedExchange }[] = [];
  private readonly cfFillsByClientId = new Map<string, Map<string, SimulatedFill>>();

  private readonly active = new Map<string, ActiveProbe>();
  private readonly byOrderId = new Map<string, ActiveProbe>();
  private readonly sampledByStratum = new Map<string, number>();

  private marketStates = new Map<string, HistoricalMarketState>();
  private readonly positions = new Map<string, Decimal>();
  private readonly premiums = new Map<string, Decimal>();

  private runId = randomUUID();
  private orderGroupId: string | null = null;
  private clockMs = 0;
  private nextProbeAtMs = 0;
  private fillsToday = 0;
  private ordersToday = 0;
  private halted: StopReason | null = null;
  private haltDetail = '';
  private queueTimer: NodeJS.Timeout | null = null;
  private privateFeedDownAt: number | null = null;

  constructor(
    private readonly deps: {
      sql: Sql;
      source: LiveKalshiDataSource;
      trading: KalshiTradingClient;
      privateFeed: KalshiPrivateFeed;
      datasetId: string;
      kalshiEnv: string;
    },
    private readonly config: CalibrationConfig,
  ) {
    this.store = new CalibrationStore(deps.sql);
    this.random = config.random ?? Math.random;

    for (const model of config.fillModels) {
      this.counterfactuals.push({
        model,
        exchange: new SimulatedExchange({
          state: this.state,
          fillModel: model,
          feeModel: new ZeroFeeModel(),
          // The real order's arrival is MEASURED. A latency model here would
          // add a second, invented delay on top of it.
          latency: new ZeroLatencyModel(),
          gapOrderPolicy: 'cancel_all',
        }),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async run(): Promise<{ runId: string; stopReason: StopReason; detail: string }> {
    const request = {
      datasetId: this.deps.datasetId,
      startTime: new Date(0),
      endTime: new Date(Date.now() + (this.config.runForMs || 86_400_000) + 3_600_000),
      seriesTickers: this.config.seriesTickers,
      includeTrades: true,
    };

    const slice = await this.deps.source.describe(request);
    this.marketStates = await this.deps.source.marketStates(request);

    if (!this.config.dryRun) {
      // An exchange-side runaway guard. Every limit in this process depends on
      // this process being correct; this one holds even if it is not.
      try {
        const group = await this.deps.trading.createOrderGroup(
          this.config.envelope.orderGroup15sLimit,
        );
        this.orderGroupId = group.value;
      } catch (err) {
        // The exchange-side runaway guard is a nice-to-have, not a
        // prerequisite. Losing it means the process-side limits are the only
        // thing standing between a bug and a runaway, so it is logged loudly
        // rather than swallowed -- but at one contract, two resting orders and
        // a five-dollar cap the blast radius is bounded either way.
        logger.warn(
          { event: 'order_group_unavailable', err: String(err) },
          'no exchange-side order group; process-side limits are the only guard',
        );
        await this.store
          .event({
            runId: this.runId,
            kind: 'warning',
            reason: 'order group unavailable; running on process-side limits alone',
            detail: { error: String(err).slice(0, 200) },
          })
          .catch(() => {});
      }
    }

    await this.store.startRun({
      runId: this.runId,
      datasetId: this.deps.datasetId,
      kalshiEnv: this.deps.kalshiEnv,
      gitCommitSha: gitCommitSha(),
      envelope: this.config.envelope,
      orderGroupId: this.orderGroupId,
    });

    // Seed from the EXCHANGE, not from what this process remembers. Process
    // accounting drifts; a crash and restart would otherwise begin believing
    // the account is flat when it is not.
    await this.syncAccountFromExchange('startup');

    this.wirePrivateFeed();
    await this.deps.privateFeed.start();

    this.queueTimer = setInterval(() => {
      void this.pollQueuePositions();
    }, this.config.queuePollIntervalMs);

    const deadline = this.config.runForMs > 0 ? Date.now() + this.config.runForMs : null;

    logger.info(
      {
        event: 'calibration_start',
        run_id: this.runId,
        markets: slice.marketTickers.length,
        dry_run: this.config.dryRun,
        envelope: this.config.envelope,
      },
      `calibration ${this.config.dryRun ? '(DRY RUN)' : 'LIVE'}: ${slice.marketTickers.length} market(s)`,
    );

    try {
      for await (const event of this.deps.source.stream(request)) {
        const at = event.receiveTimeMs;
        if (at > BigInt(this.clockMs)) this.clockMs = Number(at);

        this.applyEvent(event);

        if (deadline !== null && Date.now() >= deadline) {
          this.halt('duration_elapsed', 'planned duration reached');
          break;
        }
        if (this.halted && this.active.size === 0) break;
        if (!this.halted) await this.maybeLaunchProbe();
      }
    } finally {
      await this.shutdown();
    }

    const reason = this.halted ?? 'duration_elapsed';
    await this.store.endRun(this.runId, reason, this.haltDetail || null);
    return { runId: this.runId, stopReason: reason, detail: this.haltDetail };
  }

  private halt(reason: StopReason, detail: string): void {
    if (this.halted) return;
    this.halted = reason;
    this.haltDetail = detail;
    logger.error({ event: 'calibration_halt', reason, detail }, `calibration halted: ${detail}`);
    void this.store
      .event({ runId: this.runId, kind: 'killed', reason, detail: { detail } })
      .catch(() => {});
    void this.cancelEverything(`halted: ${reason}`);
  }

  private async shutdown(): Promise<void> {
    if (this.queueTimer) clearInterval(this.queueTimer);
    this.queueTimer = null;
    await this.cancelEverything('run ending');
    await this.deps.privateFeed.stop().catch(() => {});
  }

  /**
   * Cancels every probe still believed live.
   *
   * Never assumes success. A cancel whose outcome is unknown leaves the probe
   * marked ambiguous, which is a state the operator has to resolve rather than
   * one the process can quietly clear.
   */
  private async cancelEverything(why: string): Promise<void> {
    for (const probe of [...this.active.values()]) {
      if (probe.state === 'filled' || probe.state === 'cancelled') continue;
      await this.cancelProbe(probe, why).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  private applyEvent(event: import('@/src/research/events/researchEvent').ResearchEvent): void {
    switch (event.kind) {
      case 'book_snapshot':
        this.state.applySnapshot(event);
        break;
      case 'book_delta': {
        const applied = this.state.applyDelta(event);
        if (applied.applied) {
          this.activity.recordDelta(event.marketTicker, Number(event.receiveTimeMs));
          const view = this.state.view(event.marketTicker);
          if (view?.valid) {
            const b = view.bbo();
            this.activity.recordBbo(
              event.marketTicker,
              Number(event.receiveTimeMs),
              b.bid?.toFixed(6) ?? null,
              b.ask?.toFixed(6) ?? null,
            );
          }
          this.levels.onDelta(event);
          for (const c of this.counterfactuals) c.exchange.onBookDelta(event);
        }
        break;
      }
      case 'trade':
        this.activity.recordTrade(event.marketTicker, Number(event.receiveTimeMs));
        this.levels.onTrade(event);
        for (const c of this.counterfactuals) {
          for (const fill of c.exchange.onTrade(event)) this.recordCounterfactualFill(c.model.name, fill);
        }
        break;
      case 'capture_gap':
        this.state.applyCaptureGap(event);
        // Coverage loss means we can no longer vouch for the book any probe is
        // resting against.
        this.halt('book_invalid', `capture gap: ${event.reason}`);
        break;
      default:
        break;
    }

    const now = BigInt(this.clockMs);
    for (const c of this.counterfactuals) {
      const { fills } = c.exchange.advanceTo(now);
      for (const fill of fills) this.recordCounterfactualFill(c.model.name, fill);
    }
  }

  private recordCounterfactualFill(model: string, fill: SimulatedFill): void {
    let byModel = this.cfFillsByClientId.get(fill.clientOrderId);
    if (!byModel) {
      byModel = new Map();
      this.cfFillsByClientId.set(fill.clientOrderId, byModel);
    }
    if (!byModel.has(model)) byModel.set(model, fill);
  }

  // -------------------------------------------------------------------------
  // Safety gates
  // -------------------------------------------------------------------------

  /**
   * Replaces process-side position beliefs with the exchange's.
   *
   * Called at startup and again before the run considers itself safe. The
   * exchange is the only authority on what we own; every limit in this file is
   * worthless if it is computed against a stale local tally.
   */
  private async syncAccountFromExchange(why: string): Promise<void> {
    if (this.config.dryRun) return;
    try {
      const positions = await this.deps.trading.getPositions();
      this.positions.clear();
      this.premiums.clear();
      for (const p of positions.value) {
        if (p.position === 0) continue;
        this.positions.set(p.marketTicker, D(p.position));
        // Without an entry price the exposure of a pre-existing position is
        // unknown, so it is charged at the worst case a binary contract can
        // reach: one dollar per contract. Over-stating it can only make the
        // envelope stricter.
        this.premiums.set(p.marketTicker, D(Math.abs(p.position)));
      }

      const resting = await this.deps.trading.listOrders({ status: 'resting' });
      if (resting.value.length > 0) {
        // Orders we did not place, or ours from a previous run. Either way the
        // envelope's assumptions do not hold and a human should look.
        await this.store
          .event({
            runId: this.runId,
            kind: 'warning',
            reason: 'account already has resting orders',
            detail: { count: resting.value.length, when: why },
          })
          .catch(() => {});
        this.halt(
          'risk_limit',
          `${resting.value.length} resting order(s) already on the account; refusing to add more`,
        );
      }
    } catch (err) {
      this.halt('persistence_unavailable', `could not read account state from the exchange: ${err}`);
    }
  }

  private accountState(): AccountState {
    const restingByMarket = new Map<string, number>();
    const probesInFlight = new Map<string, number>();
    const seriesInFlight = new Map<string, number>();
    for (const probe of this.active.values()) {
      if (probe.state === 'filled' || probe.state === 'cancelled') continue;
      restingByMarket.set(probe.marketTicker, (restingByMarket.get(probe.marketTicker) ?? 0) + 1);
      probesInFlight.set(probe.marketTicker, (probesInFlight.get(probe.marketTicker) ?? 0) + 1);
      seriesInFlight.set(probe.seriesTicker, (seriesInFlight.get(probe.seriesTicker) ?? 0) + 1);
    }
    return {
      restingByMarket,
      positionByMarket: this.positions,
      premiumAtRiskByMarket: this.premiums,
      probesInFlight,
      seriesInFlight,
      fillsToday: this.fillsToday,
      ordersToday: this.ordersToday,
    };
  }

  /** Every reason the runner may not place an order right now. */
  private blockingCondition(): { reason: StopReason; detail: string } | null {
    if (!this.deps.privateFeed.isUp) {
      return { reason: 'private_feed_down', detail: 'private order and fill feed is not connected' };
    }
    if (this.privateFeedDownAt !== null) {
      return { reason: 'private_feed_down', detail: 'private feed dropped during this run' };
    }
    for (const probe of this.active.values()) {
      if (probe.state === 'ambiguous') {
        return {
          reason: 'ambiguous_order_state',
          detail: `${probe.clientOrderId} has an unknown state; it may still be live`,
        };
      }
    }
    const kill = isKilled(this.config.envelope, this.accountState());
    if (kill.killed) return { reason: 'risk_limit', detail: kill.detail ?? 'risk limit breached' };
    return null;
  }

  // -------------------------------------------------------------------------
  // Probe launch
  // -------------------------------------------------------------------------

  private async maybeLaunchProbe(): Promise<void> {
    const now = Date.now();
    if (now < this.nextProbeAtMs) return;

    const blocking = this.blockingCondition();
    if (blocking) {
      // A transient block waits; a terminal one kills. Only the operator's
      // limits and an ambiguous order are terminal.
      if (blocking.reason === 'risk_limit' || blocking.reason === 'ambiguous_order_state') {
        this.halt(blocking.reason, blocking.detail);
      }
      this.nextProbeAtMs = now + 2_000;
      return;
    }

    const candidates = this.eligibleCandidates(now);
    if (candidates.length === 0) {
      this.nextProbeAtMs = now + 2_000;
      return;
    }

    const chosen = selectNext(candidates, this.sampledByStratum, this.random, {
      preferChurn: this.config.preferChurn,
    });
    if (!chosen) {
      this.nextProbeAtMs = now + 2_000;
      return;
    }

    const side = chooseSide(this.random);
    const book = this.state.view(chosen.marketTicker);
    const bbo = book?.bbo();
    if (!book?.valid || !bbo?.bid || !bbo.ask) {
      this.nextProbeAtMs = now + 1_000;
      return;
    }

    // Join the existing touch. Never penny: a one-tick improvement would put
    // us at the front of an empty queue, which is the one position that
    // teaches nothing about queueing.
    const yesPrice = side === 'bid' ? bbo.bid : bbo.ask;
    const premium = premiumForProbe(yesPrice, side, this.config.envelope.orderSize);

    const decision = mayPlaceProbe(
      this.config.envelope,
      this.accountState(),
      chosen.marketTicker,
      chosen.seriesTicker,
      premium,
    );
    if (!decision.allowed) {
      await this.store
        .event({
          runId: this.runId,
          kind: 'blocked',
          reason: decision.reason ?? 'unknown',
          marketTicker: chosen.marketTicker,
          detail: { detail: decision.detail },
        })
        .catch(() => {});
      this.nextProbeAtMs = now + 2_000;
      return;
    }

    await this.launchProbe(chosen, side, yesPrice, premium, book);
  }

  private eligibleCandidates(nowMs: number): Candidate[] {
    const out: Candidate[] = [];
    for (const view of this.state.views()) {
      const ticker = view.marketTicker;
      const marketState = this.marketStates.get(ticker);
      const series = marketState?.seriesTicker ?? ticker.split('-')[0] ?? 'unknown';

      const eligibility = assessEligibility(
        {
          marketTicker: ticker,
          seriesTicker: series,
          book: view,
          state: marketState,
          recentTrades: this.activity.tradesIn(ticker, nowMs),
          recentDeltas: this.activity.deltasIn(ticker, nowMs),
          nowMs,
        },
        this.config.envelope,
      );
      if (!eligibility.eligible || !eligibility.stratum || !eligibility.mid) continue;

      out.push({
        marketTicker: ticker,
        seriesTicker: series,
        stratum: eligibility.stratum,
        mid: eligibility.mid,
        touchDepth: eligibility.touchDepth ?? ZERO,
        bboChanges: this.activity.bboChangesIn(ticker, nowMs),
      });
    }
    return out;
  }

  private async launchProbe(
    candidate: Candidate,
    side: 'bid' | 'ask',
    yesPrice: Decimal,
    premium: Decimal,
    book: import('@/src/research/engine/marketState').BookView,
  ): Promise<void> {
    const probeId = randomUUID();
    const clientOrderId = `cal-${probeId.slice(0, 18)}`;
    const dwellMs = chooseDwellMs(this.random);
    const bbo = book.bbo();

    // A NO buy at 1-p is what a Kalshi offer physically is, so the probe is
    // the same object a live maker would send.
    const orderSide: 'yes' | 'no' = side === 'bid' ? 'yes' : 'no';
    const sidePrice = side === 'bid' ? yesPrice : ONE.minus(yesPrice);
    const priceCents = Number(sidePrice.mul(100).toFixed(0));
    if (priceCents < 1 || priceCents > 99) return;

    const aheadAtEntry = book.depthAhead(side, yesPrice);
    const displayed = aheadAtEntry.sameLevel;

    const decisionTsMs = Date.now();
    const expirationTs = Math.floor((decisionTsMs + dwellMs + this.config.expirationSlackMs) / 1000);

    // Written BEFORE the order is sent. If the create then times out there is
    // already a durable record naming the client order id we may have live.
    await this.store.insertProbe({
      probeId,
      runId: this.runId,
      marketTicker: candidate.marketTicker,
      seriesTicker: candidate.seriesTicker,
      eventTicker: this.marketStates.get(candidate.marketTicker)?.eventTicker ?? null,
      depthStratum: candidate.stratum.depth,
      flowStratum: candidate.stratum.flow,
      probeSide: side,
      plannedDwellMs: dwellMs,
      decisionTsMs,
      bookHashAtDecision: book.stateHash(),
      bookSeqAtDecision: null,
      decisionBid: bbo.bid,
      decisionAsk: bbo.ask,
      decisionBidSize: bbo.bidSize,
      decisionAskSize: bbo.askSize,
      decisionMid: bbo.mid,
      decisionImbalance1: book.imbalance(1),
      decisionImbalance3: book.imbalance(3),
      displayedSizeAtEntry: displayed,
      betterDepthAtEntry: aheadAtEntry.better,
      clientOrderId,
      orderSide,
      orderAction: 'buy',
      priceCents,
      yesPrice,
      quantity: this.config.envelope.orderSize,
      expirationTs,
    });

    const probe: ActiveProbe = {
      probeId,
      clientOrderId,
      orderId: null,
      marketTicker: candidate.marketTicker,
      seriesTicker: candidate.seriesTicker,
      side,
      yesPrice,
      priceCents,
      quantity: this.config.envelope.orderSize,
      plannedDwellMs: dwellMs,
      restingSinceMs: null,
      levelKey: this.levels.watch(candidate.marketTicker, side, yesPrice),
      state: 'submitting',
      queueSeqNo: 0,
      lastQueuePosition: null,
      recordedInitialQueue: false,
      premium,
      stratum: stratumId(candidate.stratum),
      modelledQueueAtEntry: new Map(),
    };
    this.active.set(clientOrderId, probe);
    this.ordersToday += 1;
    this.sampledByStratum.set(probe.stratum, (this.sampledByStratum.get(probe.stratum) ?? 0) + 1);
    await this.store.bumpRunCounters(this.runId, { attempted: 1 }).catch(() => {});

    if (this.config.dryRun) {
      await this.store.recordSubmission(probeId, {
        orderId: null,
        httpSendTsMs: decisionTsMs,
        httpAckTsMs: decisionTsMs,
        httpStatus: null,
        terminalState: 'aborted',
        rejectReason: 'dry run: no order was sent',
      });
      this.active.delete(clientOrderId);
      this.levels.unwatch(probe.levelKey);
      this.scheduleCooldown();
      return;
    }

    try {
      const created = await this.deps.trading.createOrder({
        clientOrderId,
        marketTicker: candidate.marketTicker,
        // The V2 API takes the YES-ladder side directly, so the probe's own
        // side maps straight through with no yes/no encoding to invert.
        side,
        price: yesPrice,
        count: this.config.envelope.orderSize,
        postOnly: true,
        cancelOrderOnPause: true,
        expirationTime: expirationTs,
        ...(this.orderGroupId ? { orderGroupId: this.orderGroupId } : {}),
      });

      probe.orderId = created.value.order_id;
      probe.state = 'resting';
      probe.restingSinceMs = created.timing.ackTs;
      this.byOrderId.set(created.value.order_id, probe);
      this.premiums.set(
        candidate.marketTicker,
        (this.premiums.get(candidate.marketTicker) ?? ZERO).plus(premium),
      );

      await this.store.recordSubmission(probeId, {
        orderId: created.value.order_id,
        httpSendTsMs: created.timing.sendTs,
        httpAckTsMs: created.timing.ackTs,
        httpStatus: created.timing.httpStatus,
        terminalState: 'resting',
        rejectReason: null,
      });
      await this.store.bumpRunCounters(this.runId, { placed: 1 }).catch(() => {});

      this.submitCounterfactuals(probe);
      // Read the modelled queue NOW, while the counterfactual orders are still
      // resting. After they are retired the queue state is gone, which is why
      // the first live run recorded a null modelled queue for every probe that
      // did not fill -- the comparison we actually care about.
      for (const c of this.counterfactuals) {
        const cfOrder = c.exchange.findByClientId(probe.clientOrderId);
        if (cfOrder?.queue) {
          probe.modelledQueueAtEntry.set(c.model.name, cfOrder.queue.queueAheadAtEntry);
        }
      }
      void this.pollQueuePositions();
      this.scheduleDwellTimeout(probe);
    } catch (err) {
      await this.handleSubmitFailure(probe, err);
    }
    this.scheduleCooldown();
  }

  /**
   * A create that did not clearly succeed.
   *
   * A post-only rejection is a normal, informative outcome: the touch moved
   * between our decision and the order's arrival, which is a latency
   * observation in its own right. An UNKNOWN outcome is different -- the order
   * may be live -- and halts the run until an operator resolves it.
   */
  private async handleSubmitFailure(probe: ActiveProbe, err: unknown): Promise<void> {
    this.levels.unwatch(probe.levelKey);

    if (err instanceof AmbiguousOrderError) {
      probe.state = 'ambiguous';
      // No timings. A rejected or ambiguous create has no round trip to
      // measure, and writing Date.now() twice would seed the latency dataset
      // with zeroes that drag the median to nothing.
      await this.store.recordSubmission(probe.probeId, {
        orderId: null,
        httpSendTsMs: null,
        httpAckTsMs: null,
        httpStatus: null,
        terminalState: 'ambiguous',
        rejectReason: err.message,
      });
      await this.reconcileAmbiguous(probe);
      return;
    }

    const detail = err instanceof KalshiApiError ? `${err.status}: ${err.message}` : String(err);
    probe.state = 'rejected';
    this.active.delete(probe.clientOrderId);
    await this.store.recordSubmission(probe.probeId, {
      orderId: null,
      httpSendTsMs: null,
      httpAckTsMs: null,
      httpStatus: err instanceof KalshiApiError ? err.status : null,
      terminalState: 'rejected',
      rejectReason: detail,
    });
    await this.store
      .event({
        runId: this.runId,
        kind: 'warning',
        reason: 'order_rejected',
        marketTicker: probe.marketTicker,
        detail: { detail },
      })
      .catch(() => {});
  }

  /**
   * Resolves an unknown order outcome by ASKING, never by assuming.
   *
   * The rule is that the order may still be live. If the exchange confirms it
   * exists we adopt it and cancel; if it does not appear we still halt, because
   * "I could not find it" and "it does not exist" are not the same statement.
   */
  private async reconcileAmbiguous(probe: ActiveProbe): Promise<void> {
    try {
      const orders = await this.deps.trading.listOrders({ ticker: probe.marketTicker });
      const found = orders.value.find(
        (o: KalshiOrder) => o.client_order_id === probe.clientOrderId,
      );
      if (found) {
        probe.orderId = found.order_id;
        probe.state = 'cancelling';
        this.byOrderId.set(found.order_id, probe);
        await this.store
          .event({
            runId: this.runId,
            kind: 'reconciled',
            reason: 'ambiguous create was live; cancelling',
            marketTicker: probe.marketTicker,
            detail: { order_id: found.order_id },
          })
          .catch(() => {});
        await this.cancelProbe(probe, 'reconciled after an ambiguous create');
        this.halt('ambiguous_order_state', `recovered ${probe.clientOrderId}; stopping for review`);
        return;
      }
      await this.store
        .event({
          runId: this.runId,
          kind: 'ambiguous',
          reason: 'create outcome unknown and no matching order found',
          marketTicker: probe.marketTicker,
          detail: { client_order_id: probe.clientOrderId },
        })
        .catch(() => {});
    } catch (err) {
      await this.store
        .event({
          runId: this.runId,
          kind: 'ambiguous',
          reason: 'could not reconcile an ambiguous create',
          marketTicker: probe.marketTicker,
          detail: { error: String(err) },
        })
        .catch(() => {});
    }
    this.halt(
      'ambiguous_order_state',
      `${probe.clientOrderId} may be live and could not be confirmed`,
    );
  }

  private scheduleCooldown(): void {
    const { cooldownMinMs, cooldownMaxMs } = this.config;
    const span = Math.max(0, cooldownMaxMs - cooldownMinMs);
    this.nextProbeAtMs = Date.now() + cooldownMinMs + Math.floor(this.random() * span);
  }

  private scheduleDwellTimeout(probe: ActiveProbe): void {
    setTimeout(() => {
      if (probe.state !== 'resting') return;
      void this.cancelProbe(probe, 'dwell elapsed');
    }, probe.plannedDwellMs).unref();
  }

  // -------------------------------------------------------------------------
  // Counterfactuals
  // -------------------------------------------------------------------------

  /**
   * Puts the SAME order into every simulated exchange.
   *
   * Submitted at the book's current event time rather than at the REST ack:
   * the simulated exchanges advance on market data, and handing them a clock
   * reading from a different source would let their time run backwards.
   */
  private submitCounterfactuals(probe: ActiveProbe): void {
    const at = BigInt(this.clockMs);
    for (const c of this.counterfactuals) {
      c.exchange.submit(
        {
          type: 'limit',
          marketTicker: probe.marketTicker,
          side: probe.side === 'bid' ? 'yes' : 'no',
          action: 'buy',
          price: probe.side === 'bid' ? probe.yesPrice : ONE.minus(probe.yesPrice),
          quantity: D(probe.quantity),
          clientOrderId: probe.clientOrderId,
          tag: probe.probeId,
        },
        at,
      );
      c.exchange.advanceTo(at);
    }
  }

  private cancelCounterfactuals(probe: ActiveProbe): void {
    const at = BigInt(this.clockMs);
    for (const c of this.counterfactuals) {
      c.exchange.submit({ type: 'cancel', clientOrderId: probe.clientOrderId }, at);
      c.exchange.advanceTo(at);
    }
  }

  private async persistCounterfactuals(probe: ActiveProbe): Promise<void> {
    const byModel = this.cfFillsByClientId.get(probe.clientOrderId);
    for (const c of this.counterfactuals) {
      const fill = byModel?.get(c.model.name);
      const order = c.exchange.findByClientId(probe.clientOrderId);
      await this.store
        .insertCounterfactual({
          probeId: probe.probeId,
          fillModel: c.model.name,
          parameters: c.model.describe(),
          wouldFill: fill !== undefined,
          fillTimeMs:
            fill && probe.restingSinceMs !== null
              ? Number(fill.filledAtMs) - Number(fill.arrivedAtMs)
              : null,
          fillReason: fill?.reason ?? null,
          queueAtEntry:
            fill?.queueAheadAtEntry ??
            order?.queue?.queueAheadAtEntry ??
            probe.modelledQueueAtEntry.get(c.model.name) ??
            null,
          queueBeforeFill: fill?.queueAheadBeforeFill ?? null,
        })
        .catch(() => {});
    }
    this.cfFillsByClientId.delete(probe.clientOrderId);
  }

  // -------------------------------------------------------------------------
  // Queue sampling
  // -------------------------------------------------------------------------

  /**
   * Samples the true queue position of every resting probe in ONE request.
   *
   * One request means one instant. Polling probes individually would spread
   * the observations across separate round trips, and a queue position is only
   * comparable to the book state it was measured against.
   */
  private async pollQueuePositions(): Promise<void> {
    if (this.config.dryRun) return;
    const resting = [...this.active.values()].filter((p) => p.state === 'resting' && p.orderId);
    if (resting.length === 0) return;

    const markets = [...new Set(resting.map((p) => p.marketTicker))];
    let result;
    try {
      result = await this.deps.trading.getQueuePositions(markets);
    } catch (err) {
      logger.warn({ event: 'queue_poll_failed', err: String(err) }, 'queue position poll failed');
      return;
    }

    const byOrder = new Map(result.value.map((r) => [r.orderId, r.queuePosition]));

    for (const probe of resting) {
      const queuePosition = byOrder.get(probe.orderId!) ?? null;
      const book = this.state.view(probe.marketTicker);
      const bbo = book?.valid ? book.bbo() : null;
      // The FULL ahead-of-us quantity, not just our own level. Kalshi counts
      // everything that must match before we can fill, and a probe that does
      // not reprice accumulates better-priced depth in front of it whenever
      // the market improves past it.
      const ahead = book?.valid ? book.depthAhead(probe.side, probe.yesPrice) : null;
      const displayed = ahead?.sameLevel ?? null;
      const ticks = book?.valid
        ? ticksFromTouch(probe.side, probe.yesPrice, bbo?.bid ?? null, bbo?.ask ?? null)
        : null;
      const activity = this.levels.snapshot(probe.levelKey);

      probe.queueSeqNo += 1;

      // The FIRST reading that actually has a number, not the first poll.
      //
      // A new order does not appear in the queue-position endpoint
      // immediately: measured at roughly five seconds on this account. Taking
      // the first poll would have recorded null as the entry queue for every
      // probe, which is what the first live run did. The delay is itself worth
      // knowing, so the observation's own timestamps are stored with it.
      if (queuePosition !== null && !probe.recordedInitialQueue) {
        probe.recordedInitialQueue = true;
        await this.store
          .recordInitialQueue(probe.probeId, {
            queuePosition,
            sendTsMs: result.timing.sendTs,
            recvTsMs: result.timing.ackTs,
          })
          .catch(() => {});
      }
      if (queuePosition !== null) probe.lastQueuePosition = queuePosition;

      await this.store
        .insertQueueObservation({
          probeId: probe.probeId,
          seqNo: probe.queueSeqNo,
          pollSendTsMs: result.timing.sendTs,
          pollReceiveTsMs: result.timing.ackTs,
          timeSinceEntryMs:
            probe.restingSinceMs === null ? 0 : result.timing.sendTs - probe.restingSinceMs,
          queuePosition,
          displayedLevelSize: displayed,
          bestBid: bbo?.bid ?? null,
          bestAsk: bbo?.ask ?? null,
          bestBidSize: bbo?.bidSize ?? null,
          bestAskSize: bbo?.askSize ?? null,
          imbalance1: book?.valid ? book.imbalance(1) : null,
          imbalance3: book?.valid ? book.imbalance(3) : null,
          cumExecuted: activity.executed,
          cumRemoved: activity.removed,
          cumAdded: activity.added,
          cumTrades: activity.trades,
          betterDepth: ahead?.better ?? null,
          betterLevels: ahead?.betterLevels ?? null,
          totalPublicAhead: ahead === null ? null : ahead.better.plus(ahead.sameLevel),
          ticksFromTouch: ticks,
        })
        .catch((err) => {
          // Persistence is a stop condition: a probe whose observations are not
          // being written is real exposure buying nothing.
          this.halt('persistence_unavailable', `could not write a queue observation: ${err}`);
        });
    }
  }

  // -------------------------------------------------------------------------
  // Private feed
  // -------------------------------------------------------------------------

  private wirePrivateFeed(): void {
    this.deps.privateFeed.on('down', ({ reason }) => {
      this.privateFeedDownAt = Date.now();
      this.halt('private_feed_down', reason);
    });

    this.deps.privateFeed.on('order', (update) => {
      const probe =
        (update.clientOrderId ? this.active.get(update.clientOrderId) : undefined) ??
        (update.orderId ? this.byOrderId.get(update.orderId) : undefined);
      if (!probe) return;
      void this.store.recordPrivateAck(probe.probeId, update.receivedAtMs).catch(() => {});
    });

    this.deps.privateFeed.on('fill', (fill) => {
      const probe =
        (fill.clientOrderId ? this.active.get(fill.clientOrderId) : undefined) ??
        (fill.orderId ? this.byOrderId.get(fill.orderId) : undefined);
      if (!probe) return;
      void this.onFilled(probe, fill);
    });
  }

  private async onFilled(
    probe: ActiveProbe,
    fill: import('@/src/research/calibration/privateFeed').PrivateFill,
  ): Promise<void> {
    probe.state = 'filled';
    this.fillsToday += 1;

    const filledQty = D(fill.count ?? probe.quantity);
    const signed = probe.side === 'bid' ? filledQty : filledQty.neg();
    this.positions.set(
      probe.marketTicker,
      (this.positions.get(probe.marketTicker) ?? ZERO).plus(signed),
    );

    await this.store
      .recordFill(probe.probeId, {
        exchangeTsMs: fill.exchangeTsMs,
        receiveTsMs: fill.receivedAtMs,
        price: fill.yesPrice ?? canonicalPrice(probe.yesPrice),
        quantity: filledQty.toFixed(6),
        feeDollars: fill.feeDollars,
        queueBefore: probe.lastQueuePosition,
      })
      .catch(() => {});
    await this.store
      .bumpRunCounters(this.runId, { filled: 1, contracts: filledQty.toNumber() })
      .catch(() => {});

    this.cancelCounterfactuals(probe);
    await this.persistCounterfactuals(probe);
    this.levels.unwatch(probe.levelKey);
    this.active.delete(probe.clientOrderId);
    if (probe.orderId) this.byOrderId.delete(probe.orderId);
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  private async cancelProbe(probe: ActiveProbe, why: string): Promise<void> {
    if (probe.state !== 'resting' && probe.state !== 'cancelling') return;
    if (!probe.orderId) return;

    probe.state = 'cancelling';
    const decisionTsMs = Date.now();

    try {
      const cancelled = await this.deps.trading.cancelOrder(
        probe.orderId,
        probe.clientOrderId,
        probe.marketTicker,
      );
      await this.store.recordCancel(probe.probeId, {
        decisionTsMs,
        sendTsMs: cancelled.timing.sendTs,
        ackTsMs: cancelled.timing.ackTs,
      });
      probe.state = 'cancelled';
      // Censored, not failed. A probe that rested and never filled bounds the
      // fill time from below, and those are most of the information here.
      await this.store.finishProbe(probe.probeId, {
        terminalState: 'cancelled',
        censored: true,
        notes: why,
      });
    } catch (err) {
      if (err instanceof AmbiguousOrderError) {
        probe.state = 'ambiguous';
        await this.store.recordCancel(probe.probeId, { decisionTsMs, sendTsMs: null, ackTsMs: null });
        await this.store.finishProbe(probe.probeId, {
          terminalState: 'ambiguous',
          censored: true,
          notes: `cancel outcome unknown: ${err.message}`,
        });
        this.halt('ambiguous_order_state', `cancel of ${probe.clientOrderId} had an unknown outcome`);
        return;
      }
      // The exchange answered: most often "already gone", which is fine.
      await this.store.recordCancel(probe.probeId, { decisionTsMs, sendTsMs: null, ackTsMs: null });
      await this.store.finishProbe(probe.probeId, {
        terminalState: 'cancelled',
        censored: true,
        notes: `${why}; cancel returned ${String(err)}`,
      });
      probe.state = 'cancelled';
    }

    this.cancelCounterfactuals(probe);
    await this.persistCounterfactuals(probe);
    this.premiums.delete(probe.marketTicker);
    this.levels.unwatch(probe.levelKey);
    this.active.delete(probe.clientOrderId);
    if (probe.orderId) this.byOrderId.delete(probe.orderId);
  }
}
