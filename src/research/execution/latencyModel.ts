import type { OrderIntent } from '@/src/research/strategy/orderIntent';
import type { ResearchEvent } from '@/src/research/events/researchEvent';
import type { WorkingOrder } from '@/src/research/execution/executionAdapter';

/**
 * Every backtest models latency explicitly.
 *
 * A market-making result with no latency assumption is not optimistic, it is
 * meaningless: the entire strategy is a claim about reacting to the book
 * faster than the book moves. Zero latency is available, but it has to be
 * chosen, and it is reported in the run manifest so no comparison silently
 * mixes assumptions.
 *
 * Four distinct delays, because they are physically different things:
 *
 *   marketData  exchange -> our process
 *   decision    our process thinking
 *   submit      our process -> exchange, for a new order
 *   cancel      our process -> exchange, for a cancel
 *
 * Cancel is separated from submit deliberately: the interval in which a cancel
 * is in flight but not yet effective is exactly when adverse selection happens,
 * and collapsing the two would hide it.
 */
export interface LatencyModel {
  readonly name: string;
  marketDataLatencyMs(event: ResearchEvent): number;
  decisionLatencyMs(): number;
  submitLatencyMs(intent: OrderIntent): number;
  cancelLatencyMs(order: WorkingOrder): number;
  /** Serialized into the run manifest. */
  describe(): Record<string, unknown>;
}

/**
 * No latency at all.
 *
 * Useful only as an upper bound on what a strategy could ever earn. Treat any
 * edge that survives ONLY here as an artifact.
 */
export class ZeroLatencyModel implements LatencyModel {
  readonly name = 'zero';
  marketDataLatencyMs(): number {
    return 0;
  }
  decisionLatencyMs(): number {
    return 0;
  }
  submitLatencyMs(): number {
    return 0;
  }
  cancelLatencyMs(): number {
    return 0;
  }
  describe(): Record<string, unknown> {
    return { model: 'zero' };
  }
}

export interface FixedLatencyParams {
  marketDataMs: number;
  decisionMs: number;
  submitMs: number;
  cancelMs: number;
}

export class FixedLatencyModel implements LatencyModel {
  readonly name = 'fixed';
  constructor(private readonly params: FixedLatencyParams) {}

  /** Convenience: one round-trip figure split across the four stages. */
  static uniform(ms: number): FixedLatencyModel {
    return new FixedLatencyModel({
      marketDataMs: ms,
      decisionMs: 0,
      submitMs: ms,
      cancelMs: ms,
    });
  }

  marketDataLatencyMs(): number {
    return this.params.marketDataMs;
  }
  decisionLatencyMs(): number {
    return this.params.decisionMs;
  }
  submitLatencyMs(): number {
    return this.params.submitMs;
  }
  cancelLatencyMs(): number {
    return this.params.cancelMs;
  }
  describe(): Record<string, unknown> {
    return { model: 'fixed', ...this.params };
  }
}
