import type { FillModel } from '@/src/research/execution/fills/fillModel';
import { TouchFillModel } from '@/src/research/execution/fills/touchFillModel';
import { ConservativeQueueModel } from '@/src/research/execution/fills/conservativeQueueModel';
import { QueueDecayModel, type QueueDecayParams } from '@/src/research/execution/fills/queueDecayModel';
import {
  FixedLatencyModel,
  ZeroLatencyModel,
  type LatencyModel,
} from '@/src/research/execution/latencyModel';
import { KalshiHistoricalFeeModel, ZeroFeeModel, type FeeModel } from '@/src/research/portfolio/fees';
import { loadFeeSchedule, type FeeScheduleFile } from '@/src/research/portfolio/feeSchedule';
import type { Strategy } from '@/src/research/strategy/strategy';
import { JoinBboStrategy } from '@/src/research/strategies/joinBbo';
import { ImbalanceMakerStrategy } from '@/src/research/strategies/imbalanceMaker';
import { InventorySkewMakerStrategy } from '@/src/research/strategies/inventorySkewMaker';

/**
 * Names to implementations.
 *
 * One place where a CLI flag or a YAML key becomes an object. Without it every
 * entry point grows its own switch, they drift, and two commands end up
 * disagreeing about what `conservative_queue` means -- at which point the
 * comparison table is comparing labels rather than models.
 */

export const STRATEGY_NAMES = ['join-bbo', 'imbalance-maker', 'inventory-skew-maker'] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export const FILL_MODEL_NAMES = ['touch', 'conservative_queue', 'queue_decay'] as const;
export type FillModelName = (typeof FILL_MODEL_NAMES)[number];

export function makeStrategy(name: string, params: Record<string, unknown> = {}): Strategy {
  switch (name) {
    case 'join-bbo':
      return new JoinBboStrategy(params);
    case 'imbalance-maker':
      return new ImbalanceMakerStrategy(params);
    case 'inventory-skew-maker':
      return new InventorySkewMakerStrategy(params);
    default:
      throw new Error(`unknown strategy "${name}". Known: ${STRATEGY_NAMES.join(', ')}`);
  }
}

export function makeFillModel(name: string, params: Record<string, unknown> = {}): FillModel {
  switch (name) {
    case 'touch':
      return new TouchFillModel();
    case 'conservative_queue':
      return new ConservativeQueueModel();
    case 'queue_decay':
      return new QueueDecayModel(params as Partial<QueueDecayParams>);
    default:
      throw new Error(`unknown fill model "${name}". Known: ${FILL_MODEL_NAMES.join(', ')}`);
  }
}

/**
 * A latency model from a single millisecond figure.
 *
 * Zero is a distinct MODEL rather than a fixed model set to zero, so that a
 * run with no latency assumption is visibly labelled as such in its manifest
 * rather than looking like a parameter choice.
 */
export function makeLatencyModel(ms: number): LatencyModel {
  if (ms === 0) return new ZeroLatencyModel();
  return FixedLatencyModel.uniform(ms);
}

/**
 * Fee models by name.
 *
 * `kalshi_historical` needs the asserted schedule, so it is async: the
 * alternative is a lazily-loaded module singleton, which would make a run's
 * fee treatment depend on whatever the file said the first time any code path
 * happened to touch it.
 */
export async function makeFeeModel(
  name: string,
  opts: { schedulePath?: string; schedule?: FeeScheduleFile } = {},
): Promise<FeeModel> {
  switch (name) {
    case 'kalshi_historical':
    case 'kalshi':
      return new KalshiHistoricalFeeModel(
        opts.schedule ?? (await loadFeeSchedule(opts.schedulePath)),
      );
    case 'zero':
      return new ZeroFeeModel();
    default:
      throw new Error(`unknown fee model "${name}". Known: kalshi_historical, zero`);
  }
}
