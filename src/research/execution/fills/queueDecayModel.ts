import { Decimal, D, ONE, ZERO, type DecimalInput } from '@/src/book/decimal';
import { QueueFillModel, type QueueState, type TradeFillResult } from '@/src/research/execution/fills/fillModel';

/**
 * Parametric queue model sitting between `touch` and `conservative_queue`.
 *
 * Reality is neither extreme. Some of the volume ahead of a resting order does
 * cancel rather than trade, and some of the size at a level was posted after
 * us. This model exposes those beliefs as PARAMETERS instead of burying them:
 *
 *   queueAheadFraction  how much of the displayed size is really ahead of us
 *   cancelCreditRatio   how much of an unexplained withdrawal was ahead of us
 *   decayPerSecond      passive attrition of the queue while we wait
 *
 * The defaults are a midpoint, not a measurement, and they are wrong. They are
 * placeholders for values that must come from real Kalshi fills and observed
 * queue positions once the paper adapter is running -- which is precisely why
 * the parameters are surfaced in the run manifest rather than hardcoded here.
 *
 * Until that calibration exists, use this model to test the SENSITIVITY of a
 * conclusion to queue assumptions, never to produce a PnL figure to believe.
 */
export interface QueueDecayParams {
  queueAheadFraction: DecimalInput;
  cancelCreditRatio: DecimalInput;
  /** Fraction of remaining queue-ahead assumed to evaporate per second. */
  decayPerSecond: DecimalInput;
}

export const QUEUE_DECAY_DEFAULTS: QueueDecayParams = {
  queueAheadFraction: '1',
  cancelCreditRatio: '0.5',
  decayPerSecond: '0',
};

export class QueueDecayModel extends QueueFillModel {
  readonly name = 'queue_decay';

  private readonly decayPerSecond: Decimal;
  private readonly params: QueueDecayParams;

  constructor(params: Partial<QueueDecayParams> = {}) {
    const merged = { ...QUEUE_DECAY_DEFAULTS, ...params };
    super(D(merged.queueAheadFraction), D(merged.cancelCreditRatio));
    this.decayPerSecond = D(merged.decayPerSecond);
    this.params = merged;

    if (this.decayPerSecond.lt(0) || this.decayPerSecond.gt(1)) {
      throw new Error(`decayPerSecond must lie in [0, 1], got ${this.decayPerSecond.toString()}`);
    }
  }

  describe(): Record<string, unknown> {
    return {
      model: 'queue_decay',
      queueAheadFraction: D(this.params.queueAheadFraction).toString(),
      cancelCreditRatio: D(this.params.cancelCreditRatio).toString(),
      decayPerSecond: this.decayPerSecond.toString(),
      calibrated: false,
      calibrationNote:
        'the queue-ahead ANCHOR is now measured (see conservative_queue), but these ' +
        'decay parameters are not: every step-wise model of queue advance scored a ' +
        '2-6% hit rate on calibration v0, so nothing was fitted',
    };
  }

  /**
   * Time-based attrition, applied at the moment a fill is being considered
   * rather than on a timer.
   *
   * Applying it lazily keeps the model deterministic and free of wall-clock
   * dependence: the decay depends only on elapsed SIMULATED time between the
   * order resting and the print, so a rerun produces the identical queue.
   */
  onTrade(
    state: QueueState,
    tradeQty: Decimal,
    remaining: Decimal,
    through: boolean,
    atMs: bigint,
  ): TradeFillResult {
    if (!this.decayPerSecond.isZero() && state.queueAhead.gt(0)) {
      const elapsedSec = new Decimal((atMs - state.restedAtMs).toString()).div(1000);
      if (elapsedSec.gt(0)) {
        const survival = ONE.minus(this.decayPerSecond).pow(elapsedSec.toNumber());
        state.queueAhead = Decimal.max(ZERO, state.queueAheadAtEntry.mul(survival)).lt(state.queueAhead)
          ? Decimal.max(ZERO, state.queueAheadAtEntry.mul(survival))
          : state.queueAhead;
      }
    }
    return super.onTrade(state, tradeQty, remaining, through, atMs);
  }
}
