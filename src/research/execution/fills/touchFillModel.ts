import { Decimal, ZERO } from '@/src/book/decimal';
import { QueueFillModel } from '@/src/research/execution/fills/fillModel';

/**
 * Optimistic baseline: a resting order fills as soon as ANY trade prints at
 * its price, as though it were always at the front of the queue.
 *
 * This is deliberately wrong in a known direction. Its value is as a ceiling:
 * a strategy that cannot make money under `touch` cannot make money at all, so
 * it is the cheapest way to reject an idea. The gap between `touch` and
 * `conservative_queue` is itself the interesting number -- it measures how much
 * of a strategy's apparent edge depends purely on queue position.
 */
export class TouchFillModel extends QueueFillModel {
  readonly name = 'touch';

  constructor() {
    super(ZERO, new Decimal(1));
  }

  describe(): Record<string, unknown> {
    return {
      model: 'touch',
      queueAheadFraction: '0',
      cancelCreditRatio: '1',
      calibration: {
        // Measured against real probes and found badly wrong, which is exactly
        // what a ceiling is for.
        queueAheadAtEntry: 'refuted',
        evidence:
          'understates the exchange-reported queue at entry by ~46 contracts on average; ' +
          '3 false-positive fills in 53 probes and an 8.9s fill-time error',
      },
    };
  }
}
