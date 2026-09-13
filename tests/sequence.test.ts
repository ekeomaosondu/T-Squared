import { beforeEach, describe, expect, it } from 'vitest';
import { SequenceTracker } from '@/src/integrity/sequenceTracker';

/**
 * Sequence continuity is only ever asserted WITHIN one (session, stream).
 * Kalshi scopes `seq` to a subscription, so any cross-connection continuity
 * would be fabricated.
 */
describe('SequenceTracker', () => {
  let tracker: SequenceTracker;
  const STREAM = 'stream-a';
  const CH = 'orderbook_delta';

  beforeEach(() => {
    tracker = new SequenceTracker();
  });

  it('treats the first sequenced message as a baseline, not a gap', () => {
    const r = tracker.observe(STREAM, CH, 100);
    expect(r.verdict).toBe('first');
    expect(tracker.get(STREAM)!.firstSeq).toBe(100n);
    expect(tracker.get(STREAM)!.lastSeq).toBe(100n);
  });

  it('accepts a continuous sequence', () => {
    tracker.observe(STREAM, CH, 100);
    for (let s = 101; s <= 110; s++) {
      expect(tracker.observe(STREAM, CH, s).verdict).toBe('ok');
    }
    const state = tracker.get(STREAM)!;
    expect(state.lastSeq).toBe(110n);
    expect(state.gapCount).toBe(0);
    expect(state.degraded).toBe(false);
  });

  it('flags a duplicate sequence without treating it as a gap', () => {
    tracker.observe(STREAM, CH, 100);
    tracker.observe(STREAM, CH, 101);
    const r = tracker.observe(STREAM, CH, 101);

    expect(r.verdict).toBe('duplicate');
    expect(tracker.get(STREAM)!.duplicateCount).toBe(1);
    expect(tracker.get(STREAM)!.gapCount).toBe(0);
    expect(tracker.get(STREAM)!.degraded).toBe(false);
    // A duplicate must not advance the stream.
    expect(tracker.get(STREAM)!.lastSeq).toBe(101n);
  });

  it('flags an out-of-order sequence', () => {
    tracker.observe(STREAM, CH, 100);
    tracker.observe(STREAM, CH, 101);
    const r = tracker.observe(STREAM, CH, 99);

    expect(r.verdict).toBe('out_of_order');
    expect(tracker.get(STREAM)!.outOfOrderCount).toBe(1);
    expect(tracker.get(STREAM)!.lastSeq).toBe(101n);
  });

  it('detects a missing sequence and reports how many were lost', () => {
    tracker.observe(STREAM, CH, 100);
    const r = tracker.observe(STREAM, CH, 105);

    expect(r.verdict).toBe('gap');
    expect(r.expectedSeq).toBe(101n);
    expect(r.receivedSeq).toBe(105n);
    expect(r.missingCount).toBe(4n);
    expect(tracker.get(STREAM)!.degraded).toBe(true);
  });

  it('does not advance past a gap, so the next message is still measured against the last good seq', () => {
    tracker.observe(STREAM, CH, 100);
    tracker.observe(STREAM, CH, 105); // gap
    const next = tracker.observe(STREAM, CH, 106);

    // Still anchored to 100: we have not accepted 105 as good state.
    expect(next.verdict).toBe('gap');
    expect(next.expectedSeq).toBe(101n);
    expect(tracker.get(STREAM)!.gapCount).toBe(2);
  });

  it('returns to healthy only after a recovery snapshot re-baselines the stream', () => {
    tracker.observe(STREAM, CH, 100);
    tracker.observe(STREAM, CH, 105);
    expect(tracker.get(STREAM)!.degraded).toBe(true);

    tracker.resetAfterRecovery(STREAM, 200);

    const state = tracker.get(STREAM)!;
    expect(state.degraded).toBe(false);
    expect(state.lastSeq).toBe(200n);
    expect(tracker.observe(STREAM, CH, 201).verdict).toBe('ok');
  });

  it('keeps streams independent, since sid/seq are per-subscription', () => {
    tracker.observe('stream-a', CH, 100);
    tracker.observe('stream-b', CH, 7000);

    expect(tracker.observe('stream-a', CH, 101).verdict).toBe('ok');
    expect(tracker.observe('stream-b', CH, 7001).verdict).toBe('ok');
    expect(tracker.get('stream-a')!.lastSeq).toBe(100n + 1n);
    expect(tracker.get('stream-b')!.lastSeq).toBe(7001n);
  });

  it('never applies gap detection to unsequenced channels', () => {
    // The ticker channel carries no seq; asserting continuity on it would
    // manufacture gaps that do not exist.
    const r1 = tracker.observe('ticker-stream', 'ticker', undefined);
    const r2 = tracker.observe('ticker-stream', 'ticker', 999);

    expect(r1.verdict).toBe('unsequenced');
    expect(r2.verdict).toBe('unsequenced');
    expect(tracker.get('ticker-stream')!.gapCount).toBe(0);
    expect(tracker.get('ticker-stream')!.messageCount).toBe(2);
  });

  it('handles sequence values beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    tracker.observe(STREAM, CH, big);
    const r = tracker.observe(STREAM, CH, big + 1n);
    expect(r.verdict).toBe('ok');
    expect(tracker.get(STREAM)!.lastSeq).toBe(big + 1n);
  });
});
