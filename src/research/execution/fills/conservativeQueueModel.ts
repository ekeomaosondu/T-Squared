import { ONE, ZERO } from '@/src/book/decimal';
import { QueueFillModel } from '@/src/research/execution/fills/fillModel';

/**
 * Conservative queue model.
 *
 * On joining a level, assume EVERY contract already displayed there is ahead
 * of us -- which is true, since a new order goes to the back of a price-time
 * queue. The order then fills only after that volume has actually traded.
 *
 * Crucially, a level shrinking earns NO credit. A displayed size falling from
 * 400 to 250 says somebody withdrew 150 contracts; it does not say whether
 * they were ahead of us or behind us, and market-by-price data cannot tell us.
 * Crediting cancellations automatically is the single most common way a
 * prediction-market backtest manufactures fills that would never have
 * happened, because a maker's quotes sit at exactly the levels other makers
 * are constantly repricing.
 *
 * The result is pessimistic in thin books and roughly right in active ones.
 * Read it as a floor, and read the spread between it and `touch` as the size
 * of the uncertainty.
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
      note: 'cancellations earn no queue credit; only executed volume advances the queue',
    };
  }
}
