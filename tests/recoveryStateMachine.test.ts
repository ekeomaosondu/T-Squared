import { beforeEach, describe, expect, it } from 'vitest';
import { StreamRecoveryMachine, type Transition } from '@/src/integrity/recoveryStateMachine';

/**
 * The recovery storm this guards against: each requested snapshot advances the
 * subscription's own sequence, so a stream allowed to request recovery on every
 * frame drives itself. One real discontinuity produced 2,552 snapshots against
 * a single delta in seven seconds.
 */
describe('StreamRecoveryMachine', () => {
  const S = 'stream-a';
  let m: StreamRecoveryMachine;
  let transitions: Transition[];

  beforeEach(() => {
    transitions = [];
    m = new StreamRecoveryMachine({ timeoutMs: 30_000, onTransition: (t) => transitions.push(t) });
    m.register(S);
  });

  const openGap = (nowMs = 1000, affected = ['A', 'B']) =>
    m.openGap(S, { affected, expectedSeq: 10n, receivedSeq: 50n, nowMs });

  it('starts healthy and permits everything', () => {
    expect(m.stateOf(S)).toBe('healthy');
    expect(m.canApplyDeltas(S)).toBe(true);
    expect(m.canSample(S)).toBe(true);
    expect(m.canRequestRecovery(S)).toBe(false);
  });

  it('moves HEALTHY -> DEGRADED on a discontinuity', () => {
    const { opened } = openGap();
    expect(opened).toBe(true);
    expect(m.stateOf(S)).toBe('degraded');

    // Deltas stop being applied and samples stop being written immediately.
    expect(m.canApplyDeltas(S)).toBe(false);
    expect(m.canSample(S)).toBe(false);
    // Recovery is permitted exactly once, from DEGRADED.
    expect(m.canRequestRecovery(S)).toBe(true);
  });

  it('moves DEGRADED -> RECOVERING and then refuses further recovery', () => {
    openGap();
    m.markRecoveryRequested(S, 1010);

    expect(m.stateOf(S)).toBe('recovering');
    expect(m.canRequestRecovery(S)).toBe(false);
    expect(m.canApplyDeltas(S)).toBe(false);
  });

  it('treats a second discontinuity during an episode as not-new', () => {
    openGap();
    m.markRecoveryRequested(S, 1010);

    for (let i = 0; i < 500; i++) {
      const { opened } = m.openGap(S, { affected: ['A', 'B'], expectedSeq: 11n, receivedSeq: 99n, nowMs: 1020 + i });
      expect(opened).toBe(false);
    }

    // Still one episode, and no transition storm.
    expect(m.openEpisodes()).toHaveLength(1);
    expect(m.episodeOf(S)!.messagesWithheld).toBe(500);
    expect(transitions.map((t) => t.to)).toEqual(['degraded', 'recovering']);
  });

  it('returns to HEALTHY only when every affected market is re-snapshotted', () => {
    openGap(1000, ['A', 'B', 'C']);
    m.markRecoveryRequested(S, 1010);

    expect(m.recordSnapshot(S, 'A', 1100)).toMatchObject({ relevant: true, completed: false });
    expect(m.stateOf(S)).toBe('recovering');

    expect(m.recordSnapshot(S, 'B', 1110)).toMatchObject({ relevant: true, completed: false });
    expect(m.stateOf(S)).toBe('recovering');

    const final = m.recordSnapshot(S, 'C', 1120);
    expect(final).toMatchObject({ relevant: true, completed: true });
    expect(final.episode!.snapshotsReceived).toBe(3);

    expect(m.stateOf(S)).toBe('healthy');
    expect(m.canApplyDeltas(S)).toBe(true);
    expect(m.canSample(S)).toBe(true);
  });

  it('ignores snapshots for markets outside the episode', () => {
    openGap(1000, ['A']);
    m.markRecoveryRequested(S, 1010);

    const other = m.recordSnapshot(S, 'ZZZ', 1100);
    expect(other).toMatchObject({ relevant: false, completed: false });
    expect(m.stateOf(S)).toBe('recovering');
  });

  it('stays DEGRADED when no subscription can serve the recovery', () => {
    openGap();
    m.markRecoveryUnavailable(S);

    expect(m.stateOf(S)).toBe('degraded');
    expect(m.openEpisodes()).toHaveLength(0);
    // A later discontinuity can open a fresh episode and retry.
    expect(m.openGap(S, { affected: ['A'], expectedSeq: 1n, receivedSeq: 9n, nowMs: 5000 }).opened).toBe(true);
  });

  it('times out a stalled episode and leaves the stream degraded', () => {
    openGap(1000, ['A', 'B']);
    m.markRecoveryRequested(S, 1010);

    expect(m.reapTimeouts(20_000)).toHaveLength(0);

    const timedOut = m.reapTimeouts(1010 + 30_001);
    expect(timedOut).toHaveLength(1);
    expect([...timedOut[0]!.outstanding].sort()).toEqual(['A', 'B']);

    // Degraded, NOT healthy: we still cannot vouch for these books.
    expect(m.stateOf(S)).toBe('degraded');
    expect(m.canApplyDeltas(S)).toBe(false);
    // And a fresh episode may now be opened to retry.
    expect(m.canRequestRecovery(S)).toBe(true);
  });

  it('times out from the open time when recovery was never requested', () => {
    openGap(1000);
    expect(m.reapTimeouts(1000 + 30_001)).toHaveLength(1);
  });

  it('keeps streams independent', () => {
    m.register('stream-b');
    openGap();

    expect(m.stateOf(S)).toBe('degraded');
    expect(m.stateOf('stream-b')).toBe('healthy');
    expect(m.canApplyDeltas('stream-b')).toBe(true);
  });

  it('clears state when a stream closes', () => {
    openGap();
    m.close(S);
    expect(m.openEpisodes()).toHaveLength(0);
    // An unknown stream reads as healthy.
    expect(m.stateOf(S)).toBe('healthy');
  });

  it('records the full transition path for one gap-and-recovery cycle', () => {
    openGap(1000, ['A']);
    m.markRecoveryRequested(S, 1010);
    m.recordSnapshot(S, 'A', 1100);

    expect(transitions).toEqual([
      { streamId: S, from: 'healthy', to: 'degraded', reason: 'sequence_gap' },
      { streamId: S, from: 'degraded', to: 'recovering', reason: 'recovery_requested' },
      { streamId: S, from: 'recovering', to: 'healthy', reason: 'recovery_complete' },
    ]);
  });
});
