import { logger } from '@/src/logging/logger';

/**
 * Per-stream recovery state machine.
 *
 *     HEALTHY
 *        |  sequence discontinuity
 *        v
 *     DEGRADED
 *        |  one recovery request issued
 *        v
 *     RECOVERING
 *        |  a valid replacement snapshot for every affected market
 *        v
 *     HEALTHY
 *
 * While DEGRADED or RECOVERING:
 *
 *     raw frames captured        YES
 *     raw frames persisted       YES
 *     canonical delta apply      NO
 *     new recovery requests      NO
 *     derived feature samples    NO (book is invalid)
 *
 * The "no new recovery" rule is the important one. Each requested snapshot
 * advances the subscription's own sequence, so a stream that requests recovery
 * on every subsequent frame drives itself: one real discontinuity produced
 * 2,552 snapshots against a single delta in seven seconds. Recovery is
 * therefore an EPISODE with an explicit lifetime, not a flag that gets re-set.
 *
 * Transitions live here, apart from the socket and the database, so they can be
 * exercised directly.
 */

export type StreamState = 'healthy' | 'degraded' | 'recovering' | 'closed';

export type TransitionReason =
  | 'sequence_gap'
  | 'recovery_requested'
  | 'snapshot_received'
  | 'recovery_complete'
  | 'recovery_timeout'
  | 'recovery_unavailable'
  | 'stream_closed';

export interface RecoveryEpisode {
  streamId: string;
  state: StreamState;
  /** sequence_gaps.id once the row has been written. */
  gapId: string | null;
  /** Markets still awaiting a replacement snapshot. */
  outstanding: Set<string>;
  affected: string[];
  openedAtMs: number;
  requestedAtMs: number | null;
  expectedSeq: bigint | null;
  receivedSeq: bigint | null;
  snapshotsReceived: number;
  /** Messages seen while the episode was open and therefore not applied. */
  messagesWithheld: number;
}

export interface Transition {
  streamId: string;
  from: StreamState;
  to: StreamState;
  reason: TransitionReason;
}

export interface OpenGapResult {
  /** False when an episode was already open, i.e. this is not a new gap. */
  opened: boolean;
  episode: RecoveryEpisode;
}

export interface MachineOptions {
  /** An episode producing no snapshots within this window has failed. */
  timeoutMs?: number;
  onTransition?: (t: Transition) => void;
}

export class StreamRecoveryMachine {
  private readonly states = new Map<string, StreamState>();
  private readonly episodes = new Map<string, RecoveryEpisode>();
  private readonly timeoutMs: number;
  private readonly onTransition: (t: Transition) => void;

  constructor(opts: MachineOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.onTransition = opts.onTransition ?? (() => {});
  }

  register(streamId: string): void {
    if (!this.states.has(streamId)) this.states.set(streamId, 'healthy');
  }

  stateOf(streamId: string): StreamState {
    return this.states.get(streamId) ?? 'healthy';
  }

  episodeOf(streamId: string): RecoveryEpisode | undefined {
    return this.episodes.get(streamId);
  }

  openEpisodes(): RecoveryEpisode[] {
    return [...this.episodes.values()];
  }

  private setState(streamId: string, to: StreamState, reason: TransitionReason): void {
    const from = this.stateOf(streamId);
    if (from === to) return;
    this.states.set(streamId, to);

    const episode = this.episodes.get(streamId);
    if (episode) episode.state = to;

    this.onTransition({ streamId, from, to, reason });
    logger.debug(
      { event: 'stream_state_transition', stream_id: streamId, from, to, reason },
      `stream ${from} -> ${to}`,
    );
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  /** Deltas may only be folded into canonical state on a healthy stream. */
  canApplyDeltas(streamId: string): boolean {
    return this.stateOf(streamId) === 'healthy';
  }

  /**
   * A recovery request is allowed only from DEGRADED. Once RECOVERING, no
   * incoming frame may trigger another until the episode resolves or times out.
   */
  canRequestRecovery(streamId: string): boolean {
    return this.stateOf(streamId) === 'degraded';
  }

  /** Derived samples are never written from a stream we cannot vouch for. */
  canSample(streamId: string): boolean {
    return this.stateOf(streamId) === 'healthy';
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * HEALTHY -> DEGRADED on a sequence discontinuity.
   *
   * If an episode is already open this is a no-op returning `opened: false`;
   * the caller must not record a second gap or request more snapshots.
   */
  openGap(
    streamId: string,
    input: {
      affected: string[];
      expectedSeq: bigint | null;
      receivedSeq: bigint | null;
      nowMs: number;
    },
  ): OpenGapResult {
    const existing = this.episodes.get(streamId);
    if (existing) {
      existing.messagesWithheld += 1;
      return { opened: false, episode: existing };
    }

    const episode: RecoveryEpisode = {
      streamId,
      state: 'degraded',
      gapId: null,
      outstanding: new Set(input.affected),
      affected: [...input.affected],
      openedAtMs: input.nowMs,
      requestedAtMs: null,
      expectedSeq: input.expectedSeq,
      receivedSeq: input.receivedSeq,
      snapshotsReceived: 0,
      messagesWithheld: 0,
    };
    this.episodes.set(streamId, episode);
    this.setState(streamId, 'degraded', 'sequence_gap');

    return { opened: true, episode };
  }

  /** DEGRADED -> RECOVERING once snapshots have actually been requested. */
  markRecoveryRequested(streamId: string, nowMs: number): RecoveryEpisode | null {
    const episode = this.episodes.get(streamId);
    if (!episode || this.stateOf(streamId) !== 'degraded') return null;

    episode.requestedAtMs = nowMs;
    this.setState(streamId, 'recovering', 'recovery_requested');
    return episode;
  }

  /**
   * No subscription was available to request snapshots from. The stream stays
   * DEGRADED and the episode is closed so a later gap can reopen it.
   */
  markRecoveryUnavailable(streamId: string): RecoveryEpisode | null {
    const episode = this.episodes.get(streamId);
    if (!episode) return null;
    this.episodes.delete(streamId);
    this.setState(streamId, 'degraded', 'recovery_unavailable');
    return episode;
  }

  /**
   * Records a replacement snapshot.
   *
   * The episode closes only when EVERY affected market has been rebuilt:
   * leaving it open until then stops deltas for not-yet-recovered markets
   * being applied to stale books.
   */
  recordSnapshot(
    streamId: string,
    marketTicker: string,
    nowMs: number,
  ): { relevant: boolean; completed: boolean; episode: RecoveryEpisode | null } {
    const episode = this.episodes.get(streamId);
    if (!episode || !episode.outstanding.has(marketTicker)) {
      return { relevant: false, completed: false, episode: episode ?? null };
    }

    episode.outstanding.delete(marketTicker);
    episode.snapshotsReceived += 1;

    if (episode.outstanding.size > 0) {
      return { relevant: true, completed: false, episode };
    }

    this.episodes.delete(streamId);
    this.setState(streamId, 'healthy', 'recovery_complete');
    void nowMs;
    return { relevant: true, completed: true, episode };
  }

  /** Counts a message withheld from canonical state while an episode is open. */
  withhold(streamId: string): void {
    const episode = this.episodes.get(streamId);
    if (episode) episode.messagesWithheld += 1;
  }

  /**
   * Fails episodes whose snapshots never arrived. Without this a stuck episode
   * leaves the stream degraded forever with no record of why.
   */
  reapTimeouts(nowMs: number): RecoveryEpisode[] {
    const timedOut: RecoveryEpisode[] = [];

    for (const [streamId, episode] of [...this.episodes]) {
      const since = episode.requestedAtMs ?? episode.openedAtMs;
      if (nowMs - since < this.timeoutMs) continue;

      this.episodes.delete(streamId);
      // Stays DEGRADED, not healthy: we still cannot vouch for these books.
      this.setState(streamId, 'degraded', 'recovery_timeout');
      timedOut.push(episode);
    }

    return timedOut;
  }

  /**
   * Closes a stream, returning any episode that was still open.
   *
   * The RETURN matters. Dropping the episode silently left its sequence_gaps
   * row at 'recovering' forever, and the health check counted it as
   * unrecovered for all time -- an alarm that is always on. The caller marks
   * the row superseded instead: the missed messages are gone, the book will be
   * rebuilt on the next stream, and nothing further can be done.
   */
  close(streamId: string): RecoveryEpisode | null {
    const episode = this.episodes.get(streamId) ?? null;
    this.episodes.delete(streamId);
    this.setState(streamId, 'closed', 'stream_closed');
    this.states.delete(streamId);
    return episode;
  }

  reset(): void {
    this.states.clear();
    this.episodes.clear();
  }
}
