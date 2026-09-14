import type { TimerEvent } from '@/src/research/events/researchEvent';

/**
 * Timers, expressed as simulated events.
 *
 * A strategy that wants to reprice in 250 ms cannot use setTimeout: the
 * callback would fire in wall time, unrelated to the data, and in a backtest
 * that finishes a trading day in nine seconds it would fire essentially at
 * random. Instead a timer becomes a scheduled entry in the event queue and the
 * engine interleaves it with market data by timestamp.
 *
 * Ties are broken by insertion order, so two timers scheduled for the same
 * instant always fire in the order they were requested. Determinism here is
 * not cosmetic: a maker that cancels then requotes behaves differently if the
 * two fire in the other order.
 */
export interface ScheduledTimer {
  id: number;
  dueMs: bigint;
  label: string;
  sequence: number;
  marketTicker?: string;
}

export class TimerScheduler {
  private queue: ScheduledTimer[] = [];
  private nextId = 1;
  private sequence = 0;
  private dirty = false;

  /** Schedules a timer `delayMs` after `nowMs`. Returns its id, for cancel. */
  scheduleAfter(nowMs: bigint, delayMs: bigint, label: string, marketTicker?: string): number {
    if (delayMs < 0n) {
      throw new Error(`cannot schedule a timer ${delayMs}ms in the past: that is lookahead`);
    }
    return this.scheduleAt(nowMs + delayMs, label, marketTicker);
  }

  scheduleAt(dueMs: bigint, label: string, marketTicker?: string): number {
    const timer: ScheduledTimer = {
      id: this.nextId++,
      dueMs,
      label,
      sequence: this.sequence++,
      marketTicker,
    };
    this.queue.push(timer);
    this.dirty = true;
    return timer.id;
  }

  cancel(id: number): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((t) => t.id !== id);
    return this.queue.length !== before;
  }

  cancelAll(): void {
    this.queue = [];
  }

  private sortIfNeeded(): void {
    if (!this.dirty) return;
    this.queue.sort((a, b) => (a.dueMs === b.dueMs ? a.sequence - b.sequence : a.dueMs < b.dueMs ? -1 : 1));
    this.dirty = false;
  }

  /** The next due time, or null when nothing is scheduled. */
  peekDueMs(): bigint | null {
    this.sortIfNeeded();
    return this.queue[0]?.dueMs ?? null;
  }

  /** Removes and returns every timer due at or before `ms`, in order. */
  drainDue(ms: bigint): ScheduledTimer[] {
    this.sortIfNeeded();
    const due: ScheduledTimer[] = [];
    while (this.queue.length > 0 && this.queue[0]!.dueMs <= ms) {
      due.push(this.queue.shift()!);
    }
    return due;
  }

  get size(): number {
    return this.queue.length;
  }
}

export function timerEvent(timer: ScheduledTimer, sessionId: string): TimerEvent {
  return {
    kind: 'timer',
    exchangeTimeMs: null,
    receiveTimeMs: timer.dueMs,
    sessionId,
    ingestOrdinal: null,
    streamId: null,
    seq: null,
    marketTicker: timer.marketTicker,
    timerId: timer.id,
    label: timer.label,
  };
}
