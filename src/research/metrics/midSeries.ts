import { Decimal } from '@/src/book/decimal';

/**
 * The mid and microprice history of one market, recorded during a run and
 * consumed AFTER it.
 *
 * Markouts need the mid at a fill time plus 30 seconds. That value does not
 * exist yet when the fill happens, so it cannot be computed in the hot path
 * without reaching into the future -- which is exactly the lookahead this
 * platform is built to prevent. Recording the series and computing markouts in
 * a separate pass keeps the future strictly out of strategy state.
 *
 * Prices are held as integer MICRO-dollars. The book's canonical form is six
 * decimal places, so the integer is exact, comparisons are cheap, and a
 * million points per market cost a plain number array rather than a million
 * Decimal objects.
 */

const MICROS = 1_000_000;

export function toMicros(value: Decimal | null): number | null {
  return value === null ? null : Math.round(value.mul(MICROS).toNumber());
}

export function fromMicros(micros: number | null): Decimal | null {
  return micros === null ? null : new Decimal(micros).div(MICROS);
}

export class MidSeries {
  /** Strictly increasing. */
  private readonly times: number[] = [];
  private readonly mids: (number | null)[] = [];
  private readonly micros: (number | null)[] = [];

  private lastMid: number | null | undefined = undefined;
  private lastMicro: number | null | undefined = undefined;

  /**
   * Latest instant at which this market was OBSERVED, whether or not the mid
   * moved.
   *
   * Distinct from the last recorded point, and the distinction matters. The
   * series only stores changes, so a quiet market's last point can be minutes
   * old while we were watching the whole time. Bounding markouts by the last
   * CHANGE would silently drop the 30-second horizon for exactly the calm
   * markets a maker does best in -- a bias toward volatility that looks like a
   * finding.
   */
  private observedUntil: number | null = null;

  /** Notes that the market was being watched at `atMs`, mid unchanged. */
  observe(atMs: bigint): void {
    const t = Number(atMs);
    if (this.observedUntil === null || t > this.observedUntil) this.observedUntil = t;
  }

  /** Records a point, skipping it when nothing changed. */
  record(atMs: bigint, mid: Decimal | null, microprice: Decimal | null): void {
    this.observe(atMs);
    const m = toMicros(mid);
    const mp = toMicros(microprice);
    if (m === this.lastMid && mp === this.lastMicro) return;

    const t = Number(atMs);
    if (this.times.length > 0 && this.times[this.times.length - 1] === t) {
      // Several events share a millisecond; the last one wins, because that is
      // the state an observer at that millisecond would end up seeing.
      this.mids[this.mids.length - 1] = m;
      this.micros[this.micros.length - 1] = mp;
    } else {
      this.times.push(t);
      this.mids.push(m);
      this.micros.push(mp);
    }
    this.lastMid = m;
    this.lastMicro = mp;
  }

  get length(): number {
    return this.times.length;
  }

  get lastTimeMs(): number | null {
    return this.times.length === 0 ? null : this.times[this.times.length - 1]!;
  }

  /** Last instant this market was watched, mid change or not. */
  get observedUntilMs(): number | null {
    return this.observedUntil;
  }

  /**
   * Index of the last point at or before `atMs`, or -1.
   *
   * `<=`, never `<`: the value AT an instant is the state in force then, and a
   * strict bound would silently read the previous quote at every timestamp
   * that happens to coincide with an update.
   */
  private indexAt(atMs: number): number {
    let lo = 0;
    let hi = this.times.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! <= atMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /**
   * Mid in force at `atMs`.
   *
   * Null when the series has not started, when `atMs` is past the last instant
   * we were WATCHING, or when the value in force is itself unknown -- which is
   * what a capture gap records. Extrapolating a last-known price past the end
   * of coverage would turn a missing 30-second markout into a fabricated zero,
   * and a zero reads as "no adverse selection": the most flattering possible
   * error.
   */
  midAt(atMs: number): Decimal | null {
    if (this.observedUntil === null || atMs > this.observedUntil) return null;
    const i = this.indexAt(atMs);
    return i < 0 ? null : fromMicros(this.mids[i]!);
  }

  micropriceAt(atMs: number): Decimal | null {
    if (this.observedUntil === null || atMs > this.observedUntil) return null;
    const i = this.indexAt(atMs);
    return i < 0 ? null : fromMicros(this.micros[i]!);
  }
}

export class MidSeriesStore {
  private readonly series = new Map<string, MidSeries>();

  for(marketTicker: string): MidSeries {
    let s = this.series.get(marketTicker);
    if (!s) {
      s = new MidSeries();
      this.series.set(marketTicker, s);
    }
    return s;
  }

  get(marketTicker: string): MidSeries | undefined {
    return this.series.get(marketTicker);
  }

  get totalPoints(): number {
    let n = 0;
    for (const s of this.series.values()) n += s.length;
    return n;
  }
}
