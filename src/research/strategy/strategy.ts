import type {
  BookDeltaEvent,
  BookSnapshotEvent,
  CaptureGapEvent,
  TimerEvent,
  TradeEvent,
} from '@/src/research/events/researchEvent';
import type { Fill, OrderUpdate } from '@/src/research/execution/executionAdapter';
import type { StrategyContext } from '@/src/research/strategy/context';

/**
 * What a strategy is.
 *
 * Every callback is synchronous and returns nothing. Orders leave through
 * `ctx.orders`, never as a return value, because a strategy must be able to
 * act from any callback -- including a fill -- and threading return values
 * through would make the order of effects depend on which callback fired.
 *
 * Synchronous is also a constraint, not an oversight: an async callback could
 * await something and resume after later events had been processed, which is
 * lookahead with extra steps.
 */
export interface Strategy {
  readonly name: string;
  readonly version: string;
  /** Serialized into the run manifest; a run is only reproducible with it. */
  parameters(): Record<string, unknown>;

  onStart(ctx: StrategyContext): void;

  onBookUpdate(event: BookSnapshotEvent | BookDeltaEvent, ctx: StrategyContext): void;

  onTrade(event: TradeEvent, ctx: StrategyContext): void;

  onFill(fill: Fill, ctx: StrategyContext): void;

  onOrderUpdate(update: OrderUpdate, ctx: StrategyContext): void;

  onTimer(event: TimerEvent, ctx: StrategyContext): void;

  /**
   * Coverage was lost. Every affected book is already invalid.
   *
   * The default policy cancels resting orders and stops quoting until a fresh
   * exchange snapshot arrives. A strategy may do less, but it may not pretend
   * the book stood still.
   */
  onDataGap(event: CaptureGapEvent, ctx: StrategyContext): void;

  /** Coverage restored for a market by a fresh exchange snapshot. */
  onDataResume(marketTicker: string, ctx: StrategyContext): void;

  onStop(ctx: StrategyContext): void;
}

/** No-op implementations, so a strategy overrides only what it uses. */
export abstract class BaseStrategy implements Strategy {
  abstract readonly name: string;
  readonly version: string = '1';
  parameters(): Record<string, unknown> {
    return {};
  }
  onStart(_ctx: StrategyContext): void {}
  onBookUpdate(_event: BookSnapshotEvent | BookDeltaEvent, _ctx: StrategyContext): void {}
  onTrade(_event: TradeEvent, _ctx: StrategyContext): void {}
  onFill(_fill: Fill, _ctx: StrategyContext): void {}
  onOrderUpdate(_update: OrderUpdate, _ctx: StrategyContext): void {}
  onTimer(_event: TimerEvent, _ctx: StrategyContext): void {}
  onDataGap(_event: CaptureGapEvent, _ctx: StrategyContext): void {}
  onDataResume(_marketTicker: string, _ctx: StrategyContext): void {}
  onStop(_ctx: StrategyContext): void {}
}
