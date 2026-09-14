/**
 * The one clock a backtest is allowed to read.
 *
 * It advances ONLY from research events. Nothing in strategy, execution or
 * portfolio code may call Date.now(), setTimeout or setInterval: wall time is
 * not a property of the data, so a run that consults it is not reproducible
 * and, worse, silently changes behaviour when the machine is busy.
 *
 * Time never moves backwards. An attempt to rewind is a bug in the event
 * ordering, and failing loudly here is how it gets found rather than quietly
 * producing a strategy that saw the future.
 */
export class SimulationClock {
  private current: bigint;
  private started: bigint | null = null;

  constructor(startMs: bigint = 0n) {
    this.current = startMs;
  }

  nowMs(): bigint {
    return this.current;
  }

  startMs(): bigint | null {
    return this.started;
  }

  advanceTo(ms: bigint): void {
    if (this.started === null) this.started = ms;
    if (ms < this.current) {
      throw new Error(
        `simulation clock moved backwards: ${this.current} -> ${ms}. The event stream is ` +
          'out of order, and any result produced past this point would contain lookahead.',
      );
    }
    this.current = ms;
  }

  /** ISO form, for logs and result files. */
  nowIso(): string {
    return new Date(Number(this.current)).toISOString();
  }
}
