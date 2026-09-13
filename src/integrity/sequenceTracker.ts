import { isSequencedChannel } from '@/src/kalshi/schemas';

/**
 * Per-stream sequence validation.
 *
 * Kalshi assigns `seq` per subscription, so continuity is only ever asserted
 * within one (session, stream). Nothing here attempts to stitch sequences
 * across connections -- that is explicitly not a thing that can be done
 * correctly, and pretending otherwise would silently corrupt the dataset.
 *
 * The tracker classifies but never repairs. Deciding what to do about a gap
 * (invalidate books, request snapshots) belongs to the collector.
 */

export type SequenceVerdict =
  /** seq === expected. The only case where deltas may be applied. */
  | 'ok'
  /** First sequenced message on this stream; establishes the baseline. */
  | 'first'
  /** seq === last. A transport-level repeat; must not be applied twice. */
  | 'duplicate'
  /** seq < last. Arrived after a later message. */
  | 'out_of_order'
  /** seq > expected. Messages were missed. */
  | 'gap'
  /** Channel carries no seq (e.g. ticker); continuity is not assertable. */
  | 'unsequenced'
  /**
   * A gap was already reported and recovery is still outstanding. Continuity
   * cannot be re-evaluated against a stale baseline, so messages are counted
   * and withheld from the book but NOT reported as further gaps.
   */
  | 'degraded';

export interface SequenceResult {
  verdict: SequenceVerdict;
  expectedSeq: bigint | null;
  receivedSeq: bigint | null;
  /** How many messages were missed; only set for 'gap'. */
  missingCount: bigint | null;
}

export interface StreamSequenceState {
  streamId: string;
  channel: string;
  firstSeq: bigint | null;
  lastSeq: bigint | null;
  gapCount: number;
  duplicateCount: number;
  outOfOrderCount: number;
  messageCount: number;
  /** Set after a gap; cleared once a recovery snapshot has been applied. */
  degraded: boolean;
  /** Messages seen while degraded, recorded against the gap on recovery. */
  skippedWhileDegraded: number;
}

export class SequenceTracker {
  private readonly streams = new Map<string, StreamSequenceState>();

  register(streamId: string, channel: string): StreamSequenceState {
    const existing = this.streams.get(streamId);
    if (existing) return existing;

    const state: StreamSequenceState = {
      streamId,
      channel,
      firstSeq: null,
      lastSeq: null,
      gapCount: 0,
      duplicateCount: 0,
      outOfOrderCount: 0,
      messageCount: 0,
      degraded: false,
      skippedWhileDegraded: 0,
    };
    this.streams.set(streamId, state);
    return state;
  }

  get(streamId: string): StreamSequenceState | undefined {
    return this.streams.get(streamId);
  }

  all(): StreamSequenceState[] {
    return [...this.streams.values()];
  }

  /**
   * Classifies a message's sequence number and advances stream state.
   *
   * Only `ok` and `first` advance `lastSeq`. A gap does NOT advance it: the
   * stream stays anchored to the last known-good sequence until a recovery
   * snapshot re-baselines it, so a second gap is still reported against a
   * meaningful expectation.
   */
  observe(streamId: string, channel: string, seq: number | bigint | null | undefined): SequenceResult {
    const state = this.register(streamId, channel);

    if (!isSequencedChannel(channel) || seq === null || seq === undefined) {
      state.messageCount += 1;
      return { verdict: 'unsequenced', expectedSeq: null, receivedSeq: null, missingCount: null };
    }

    const received = BigInt(seq);
    state.messageCount += 1;

    // Once a gap is open, the baseline is stale by definition: we do not know
    // how many messages we missed, so every subsequent seq would compare
    // unequal and report another "gap". Reporting thousands of gaps for one
    // discontinuity buries the real event and, when each one triggers a
    // recovery request, feeds back into a snapshot storm. One episode, one gap.
    if (state.degraded) {
      state.skippedWhileDegraded += 1;
      return {
        verdict: 'degraded',
        expectedSeq: state.lastSeq === null ? null : state.lastSeq + 1n,
        receivedSeq: received,
        missingCount: null,
      };
    }

    if (state.lastSeq === null) {
      state.firstSeq = received;
      state.lastSeq = received;
      return { verdict: 'first', expectedSeq: null, receivedSeq: received, missingCount: null };
    }

    const expected = state.lastSeq + 1n;

    if (received === expected) {
      state.lastSeq = received;
      return { verdict: 'ok', expectedSeq: expected, receivedSeq: received, missingCount: null };
    }

    if (received === state.lastSeq) {
      state.duplicateCount += 1;
      return { verdict: 'duplicate', expectedSeq: expected, receivedSeq: received, missingCount: null };
    }

    if (received < state.lastSeq) {
      state.outOfOrderCount += 1;
      return { verdict: 'out_of_order', expectedSeq: expected, receivedSeq: received, missingCount: null };
    }

    state.gapCount += 1;
    state.degraded = true;
    return {
      verdict: 'gap',
      expectedSeq: expected,
      receivedSeq: received,
      missingCount: received - expected,
    };
  }

  /**
   * Re-baselines a stream after a recovery snapshot. This is the ONLY way a
   * degraded stream returns to healthy.
   */
  resetAfterRecovery(streamId: string, seq: number | bigint | null): number {
    const state = this.streams.get(streamId);
    if (!state) return 0;
    const skipped = state.skippedWhileDegraded;
    state.lastSeq = seq === null ? null : BigInt(seq);
    if (state.firstSeq === null) state.firstSeq = state.lastSeq;
    state.degraded = false;
    state.skippedWhileDegraded = 0;
    return skipped;
  }

  /** Drops a stream, e.g. when its subscription or connection ends. */
  remove(streamId: string): void {
    this.streams.delete(streamId);
  }

  clear(): void {
    this.streams.clear();
  }
}
