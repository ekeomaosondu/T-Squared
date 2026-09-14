import { ONE, ZERO } from '@/src/book/decimal';
import { QueueFillModel } from '@/src/research/execution/fills/fillModel';

/**
 * Conservative queue model.
 *
 * On joining a level, assume EVERY contract already displayed there is ahead
 * of us, and advance only as that volume actually trades.
 *
 * ---------------------------------------------------------------------------
 * This is no longer an assumption
 * ---------------------------------------------------------------------------
 * Calibration v0 placed 91 real one-contract probes and compared the
 * exchange's own `queue_position_fp` against the same-price displayed depth
 * computed from the public feed at the instant of entry:
 *
 *     67 probes with both readings
 *     62 exact matches (93%), to a hundredth of a contract
 *     27 of 28 exact among probes resting BEHIND the touch
 *     median gap 0.00
 *
 * The five misses are consistent with the endpoint's measured 400-800 ms lag
 * catching a level that changed between placement and the first reading.
 *
 * So `queueAheadAtEntry = displayed size at that level` is not a conservative
 * guess. It is what the exchange reports, exactly.
 *
 * The competing hypothesis -- that queue position counts everything ahead
 * under price priority, including better-priced depth -- was tested where it
 * could actually differ, on 4,367 observations resting one and two ticks
 * behind the touch. It was 13x worse on level error and overstated the queue
 * by 120 contracts. Better-priced depth is not part of the definition, so a
 * beta term for it is excluded by measurement rather than by preference.
 *
 * ---------------------------------------------------------------------------
 * What is still NOT established
 * ---------------------------------------------------------------------------
 * The cancellation credit, alpha = 0, is UNCONTRADICTED but not identified.
 * Same-price cancellations were observed constantly -- around half a contract
 * per 500 ms sample -- while the reported queue almost never moved, which is
 * what alpha = 0 predicts. But every step-wise model of how the queue advances
 * failed outright on this data: executions alone, plus alpha, and plus beta all
 * scored hit rates of 2-6% against a one-contract tolerance. Nothing was fitted
 * on that basis, and nothing should be until the residual is understood.
 *
 * So: the anchoring is measured, the decay rule is merely not refuted, and the
 * gap between those two claims is deliberate.
 */
export class ConservativeQueueModel extends QueueFillModel {
  readonly name = 'conservative_queue';

  constructor() {
    super(ONE, ZERO);
  }

  describe(): Record<string, unknown> {
    return {
      model: 'conservative_queue',
      queueAheadFraction: '1',
      cancelCreditRatio: '0',
      calibration: {
        // The anchoring is measured. The decay rule is not.
        queueAheadAtEntry: 'validated',
        evidence:
          '62 of 67 real probes matched the exchange queue exactly at entry (93%), ' +
          '27 of 28 behind the touch, median gap 0.00 contracts',
        betterPriceDepth:
          'excluded by measurement: 13x worse level error over 4,367 behind-touch observations',
        cancelCreditRatio: 'uncontradicted but not identified; no step-wise model fit',
        dataset: 'silver/execution_calibration/, calibration v0',
      },
    };
  }
}
