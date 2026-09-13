import { MarketBook } from '@/src/book/book';
import { computeFeatures } from '@/src/book/features';
import type { Sql } from '@/src/persistence/db';
import { findSeedSnapshot, type SnapshotRow } from '@/src/persistence/repositories/snapshots';
import { logger } from '@/src/logging/logger';

/**
 * Offline book reconstruction from recorded data.
 *
 * This is the acceptance test for the whole recorder: if a book cannot be
 * rebuilt here, without contacting Kalshi, then the dataset is not complete.
 *
 * Reconstruction rules:
 *
 *   - Start from the nearest usable snapshot at or before the requested time.
 *   - Apply deltas in (session_id, stream_id, seq) order.
 *   - A session boundary is a HARD reset: `seq` is scoped to a subscription,
 *     so continuing across epochs would be fabricating continuity. Replay
 *     re-seeds from a snapshot in the new epoch instead.
 *   - Deltas recorded with applied = false are NOT applied; they were not part
 *     of canonical state when recorded and replaying them would invent a book
 *     the recorder never believed in.
 *   - Recorded sequence gaps are surfaced, not smoothed over.
 */

export interface ReplayOptions {
  marketTicker: string;
  fromMs: bigint;
  toMs: bigint;
  /** Emit a reconstructed snapshot every N ms instead of per event. */
  sampleMs?: number;
  /**
   * Stop after this sequence number on `toSeqStream`.
   *
   * Wall-clock bounds are ambiguous when several events share a millisecond;
   * a sequence bound is exact, which is what verification needs.
   */
  toSeq?: bigint;
  toSeqStream?: string | null;
  /**
   * Called after every state change, with the position just reached.
   *
   * Lets a caller check many points in ONE forward pass instead of replaying
   * from the window start for each one, which is O(n^2) and unusable on a
   * multi-week dataset.
   */
  onPosition?: (position: { streamId: string | null; seq: bigint | null; book: MarketBook }) => void;
  /** Stop at the first integrity problem rather than continuing. */
  strict?: boolean;
}

export interface ReplayEpoch {
  sessionId: string;
  streamId: string | null;
  startedAtMs: bigint;
  seedSnapshotId: string | null;
  seedSource: string | null;
  deltasApplied: number;
  deltasSkipped: number;
  gaps: number;
}

export interface ReplayFrame {
  atMs: bigint;
  at: string;
  sessionId: string;
  streamId: string | null;
  seq: string | null;
  stateHash: string;
  valid: boolean;
  yesBid: string | null;
  yesAsk: string | null;
  bidSize: string | null;
  askSize: string | null;
  spread: string | null;
  mid: string | null;
  microprice: string | null;
  yesLevels: number;
  noLevels: number;
}

export interface ReplayResult {
  marketTicker: string;
  fromMs: bigint;
  toMs: bigint;
  frames: ReplayFrame[];
  epochs: ReplayEpoch[];
  finalBook: MarketBook | null;
  totalDeltas: number;
  appliedDeltas: number;
  skippedDeltas: number;
  /** Recorded sequence gaps overlapping the window. */
  gapsInWindow: {
    detected_at: Date;
    session_id: string;
    stream_id: string;
    expected_seq: string | null;
    received_seq: string | null;
    status: string;
  }[];
  warnings: string[];
}

interface DeltaRow {
  id: string;
  session_id: string;
  stream_id: string;
  seq: string;
  side: 'yes' | 'no';
  price: string;
  delta_count: string;
  applied: boolean;
  apply_error: string | null;
  received_at_ms: string;
  exchange_ts_ms: string | null;
}

function bookFromSnapshot(marketTicker: string, snap: SnapshotRow): MarketBook {
  const book = new MarketBook(marketTicker);
  book.replaceWithSnapshot(
    { yesBids: snap.yes_bids ?? [], noBids: snap.no_bids ?? [] },
    {
      seq: snap.seq === null ? null : BigInt(snap.seq),
      atMs: Number(snap.received_at_ms),
      sessionId: snap.session_id ?? undefined,
      streamId: snap.stream_id ?? undefined,
    },
  );
  return book;
}

function frameOf(book: MarketBook, atMs: bigint, sessionId: string, streamId: string | null): ReplayFrame {
  const f = computeFeatures(book);
  return {
    atMs,
    at: new Date(Number(atMs)).toISOString(),
    sessionId,
    streamId,
    seq: book.lastSeq?.toString() ?? null,
    stateHash: f.stateHash,
    valid: book.valid,
    yesBid: f.yesBid?.toFixed(6) ?? null,
    yesAsk: f.yesAsk?.toFixed(6) ?? null,
    bidSize: f.bidSize?.toFixed(6) ?? null,
    askSize: f.askSize?.toFixed(6) ?? null,
    spread: f.spread?.toFixed(6) ?? null,
    mid: f.mid?.toFixed(6) ?? null,
    microprice: f.microprice?.toFixed(6) ?? null,
    yesLevels: book.levelCount.yes,
    noLevels: book.levelCount.no,
  };
}

export async function replay(sql: Sql, opts: ReplayOptions): Promise<ReplayResult> {
  const { marketTicker, fromMs, toMs } = opts;

  const result: ReplayResult = {
    marketTicker,
    fromMs,
    toMs,
    frames: [],
    epochs: [],
    finalBook: null,
    totalDeltas: 0,
    appliedDeltas: 0,
    skippedDeltas: 0,
    gapsInWindow: [],
    warnings: [],
  };

  // Recorded gaps first, so the caller knows up front whether this window was
  // captured from an uninterrupted stream or stitched after a recovery.
  result.gapsInWindow = await sql`
    SELECT g.detected_at,
           g.session_id,
           g.stream_id,
           g.expected_seq,
           g.received_seq,
           g.status
      FROM sequence_gaps g
     WHERE g.detected_at BETWEEN to_timestamp(${Number(fromMs) / 1000}) AND to_timestamp(${Number(toMs) / 1000})
       AND g.affected_markets @> ${JSON.stringify([marketTicker])}::jsonb
     ORDER BY g.detected_at
  `;

  let seed = await findSeedSnapshot(sql, marketTicker, fromMs);

  // If the window starts before this market has any recorded state, fall back
  // to its first snapshot inside the window and say so, rather than returning
  // nothing. Different markets in one event are first snapshotted milliseconds
  // apart, so a window pinned to the earliest snapshot across an event would
  // otherwise fail for every market except the first.
  if (!seed) {
    const later = await sql<SnapshotRow[]>`
      SELECT s.snapshot_id, s.market_ticker, s.source, s.session_id, s.stream_id,
             s.sid, s.seq, s.received_at, s.received_at_ms, s.yes_bids, s.no_bids,
             s.state_hash
        FROM orderbook_snapshots s
       WHERE s.market_ticker = ${marketTicker}
         AND s.received_at_ms > ${fromMs.toString()}
         AND s.received_at_ms <= ${toMs.toString()}
         AND s.source IN ('ws_initial', 'ws_recovery', 'session_handoff', 'local_materialized')
       ORDER BY s.received_at_ms
       LIMIT 1
    `;
    seed = later[0] ?? null;
    if (seed) {
      result.warnings.push(
        `no snapshot at or before ${new Date(Number(fromMs)).toISOString()}; ` +
          `replay starts at ${new Date(Number(seed.received_at_ms)).toISOString()} instead`,
      );
    }
  }

  if (!seed) {
    result.warnings.push(
      `no snapshot for ${marketTicker} in or before the requested window; cannot seed replay`,
    );
    return result;
  }

  let book = bookFromSnapshot(marketTicker, seed);
  let currentSession = seed.session_id ?? '';
  let currentStream = seed.stream_id;

  let epoch: ReplayEpoch = {
    sessionId: currentSession,
    streamId: currentStream,
    startedAtMs: BigInt(seed.received_at_ms),
    seedSnapshotId: seed.snapshot_id,
    seedSource: seed.source,
    deltasApplied: 0,
    deltasSkipped: 0,
    gaps: 0,
  };
  result.epochs.push(epoch);

  // Snapshots inside the window mark new epochs and recovery points.
  const laterSnapshots = await sql<SnapshotRow[]>`
    SELECT s.snapshot_id, s.market_ticker, s.source, s.session_id, s.stream_id,
           s.sid, s.seq, s.received_at, s.received_at_ms, s.yes_bids, s.no_bids,
           s.state_hash
      FROM orderbook_snapshots s
     WHERE s.market_ticker = ${marketTicker}
       AND s.received_at_ms > ${seed.received_at_ms}
       AND s.received_at_ms <= ${toMs.toString()}
       AND s.source IN ('ws_initial', 'ws_recovery', 'session_handoff')
     ORDER BY s.received_at_ms
  `;

  // Ordering is (stream chronology, exchange seq).
  //
  // `seq` is scoped to a subscription and RESTARTS on every reconnect, so a
  // session that reconnected contains several streams with overlapping seq
  // ranges. stream_id is a random UUID, so ordering by it interleaves those
  // streams arbitrarily -- invisible with a single stream, catastrophic after
  // a reconnect. Streams are therefore ordered by when they began, and seq
  // orders within a stream.
  //
  // The stream's own started_at is authoritative; the per-market first
  // observation is a fallback for a delta whose stream row is unavailable.
  //
  // No display casts: the driver already returns int8 and numeric as strings,
  // so a cast would only risk an output alias shadowing the source column.
  const deltas = await sql<DeltaRow[]>`
    WITH stream_first AS (
      SELECT d2.stream_id, min(d2.received_at_ms) AS first_ms
        FROM orderbook_deltas d2
       WHERE d2.market_ticker = ${marketTicker}
         AND d2.received_at_ms >= ${seed.received_at_ms}
         AND d2.received_at_ms <= ${toMs.toString()}
       GROUP BY d2.stream_id
    )
    SELECT d.id,
           d.session_id,
           d.stream_id,
           d.seq,
           d.side,
           d.price,
           d.delta_count,
           d.applied,
           d.apply_error,
           d.received_at_ms,
           d.exchange_ts_ms
      FROM orderbook_deltas d
      JOIN stream_first sf ON sf.stream_id = d.stream_id
      LEFT JOIN subscription_streams st ON st.stream_id = d.stream_id
     WHERE d.market_ticker = ${marketTicker}
       AND d.received_at_ms >= ${seed.received_at_ms}
       AND d.received_at_ms <= ${toMs.toString()}
     ORDER BY COALESCE(
                EXTRACT(EPOCH FROM st.started_at) * 1000,
                sf.first_ms
              ),
              d.stream_id,
              d.seq
  `;

  // The delta window is now inclusive of the seed's millisecond, because at
  // realistic message rates several events share one millisecond and a strict
  // `>` silently dropped those that followed the snapshot within it. Position
  // relative to the seed is therefore decided by (stream order, seq) rather
  // than by the timestamp alone.
  const streamOrder = new Map<string, number>();
  for (const d of deltas) {
    if (!streamOrder.has(d.stream_id)) streamOrder.set(d.stream_id, streamOrder.size);
  }
  const seedSeq = seed.seq === null ? null : BigInt(seed.seq);
  const seedStreamIndex =
    seed.stream_id !== null && streamOrder.has(seed.stream_id)
      ? streamOrder.get(seed.stream_id)!
      : null;

  /**
   * Should this snapshot be applied before this delta?
   *
   * Timestamps alone are not enough: a recovery snapshot and the deltas that
   * follow it routinely share a millisecond at realistic message rates, and
   * applying the snapshot first would discard the very deltas it precedes.
   * Within a millisecond, the exchange's own sequence decides.
   */
  const snapshotPrecedes = (snap: SnapshotRow, delta: DeltaRow): boolean => {
    const sMs = BigInt(snap.received_at_ms);
    const dMs = BigInt(delta.received_at_ms);
    if (sMs !== dMs) return sMs <= dMs;

    if (snap.stream_id !== null && snap.stream_id === delta.stream_id && snap.seq !== null) {
      return BigInt(snap.seq) <= BigInt(delta.seq);
    }

    const si = snap.stream_id === null ? undefined : streamOrder.get(snap.stream_id);
    const di = streamOrder.get(delta.stream_id);
    if (si !== undefined && di !== undefined) return si <= di;
    return true;
  };

  let snapIdx = 0;
  let stoppedAtBound = false;
  let reachedTargetStream = opts.toSeqStream == null;
  let nextSampleMs = opts.sampleMs ? (fromMs / BigInt(opts.sampleMs)) * BigInt(opts.sampleMs) : null;

  const emit = (atMs: bigint) => {
    if (atMs < fromMs) return;
    if (opts.sampleMs && nextSampleMs !== null) {
      while (atMs >= nextSampleMs) {
        result.frames.push(frameOf(book, nextSampleMs, currentSession, currentStream));
        nextSampleMs += BigInt(opts.sampleMs);
      }
      return;
    }
    result.frames.push(frameOf(book, atMs, currentSession, currentStream));
  };

  emit(BigInt(seed.received_at_ms));
  opts.onPosition?.({ streamId: currentStream, seq: book.lastSeq, book });

  for (const delta of deltas) {
    const atMs = BigInt(delta.received_at_ms);

    // Skip anything at or before the seed's own position.
    if (seedStreamIndex !== null) {
      const idx = streamOrder.get(delta.stream_id)!;
      if (idx < seedStreamIndex) continue;
      if (idx === seedStreamIndex && seedSeq !== null && BigInt(delta.seq) <= seedSeq) continue;
    } else if (atMs === BigInt(seed.received_at_ms) && seedSeq !== null && BigInt(delta.seq) <= seedSeq) {
      // Seed's stream is unknown; fall back to comparing sequence directly.
      continue;
    }

    // Stop at the target position.
    //
    // `seq` restarts on every reconnect, so a later stream's deltas carry LOW
    // sequence numbers. Comparing seq alone lets them stream past the bound
    // unnoticed; the stream identity has to end the replay too.
    if (opts.toSeq !== undefined) {
      const onTargetStream = opts.toSeqStream == null || delta.stream_id === opts.toSeqStream;
      if (onTargetStream && BigInt(delta.seq) > opts.toSeq) {
        stoppedAtBound = true;
        break;
      }
      if (!onTargetStream && reachedTargetStream) {
        // We have moved past the target's stream entirely.
        stoppedAtBound = true;
        break;
      }
      if (onTargetStream) reachedTargetStream = true;
    }

    // Re-seed from any snapshot that precedes this delta.
    while (snapIdx < laterSnapshots.length && snapshotPrecedes(laterSnapshots[snapIdx]!, delta)) {
      const snap = laterSnapshots[snapIdx]!;
      snapIdx += 1;

      // A reconnect opens a NEW stream whose seq restarts, so a stream change
      // is an epoch boundary just as a session change is.
      const newEpoch = snap.session_id !== currentSession || snap.stream_id !== currentStream;
      book = bookFromSnapshot(marketTicker, snap);
      currentSession = snap.session_id ?? currentSession;
      currentStream = snap.stream_id;

      if (newEpoch || snap.source === 'session_handoff') {
        // A new session or stream is a new sequence space; never carry state
        // across one.
        epoch = {
          sessionId: currentSession,
          streamId: currentStream,
          startedAtMs: BigInt(snap.received_at_ms),
          seedSnapshotId: snap.snapshot_id,
          seedSource: snap.source,
          deltasApplied: 0,
          deltasSkipped: 0,
          gaps: 0,
        };
        result.epochs.push(epoch);
      }
      if (snap.source === 'ws_recovery') epoch.gaps += 1;

      emit(BigInt(snap.received_at_ms));
      opts.onPosition?.({ streamId: currentStream, seq: book.lastSeq, book });
    }

    result.totalDeltas += 1;

    // A delta the recorder could not apply is not applied here either.
    if (!delta.applied) {
      result.skippedDeltas += 1;
      epoch.deltasSkipped += 1;
      if (opts.strict) {
        result.warnings.push(
          `delta ${delta.id} (seq ${delta.seq}) was not applied when recorded: ${delta.apply_error ?? 'unknown'}`,
        );
      }
      continue;
    }

    const outcome = book.applyDelta({
      side: delta.side,
      price: delta.price,
      delta: delta.delta_count,
      seq: BigInt(delta.seq),
      atMs: Number(atMs),
    });

    if (!outcome.applied) {
      result.warnings.push(
        `replay diverged at delta ${delta.id} (seq ${delta.seq}): ${outcome.error ?? 'unknown'}`,
      );
      epoch.deltasSkipped += 1;
      if (opts.strict) break;
      continue;
    }

    result.appliedDeltas += 1;
    epoch.deltasApplied += 1;
    emit(atMs);
    opts.onPosition?.({ streamId: delta.stream_id, seq: BigInt(delta.seq), book });
  }

  // A snapshot can land after the final delta -- most often a reconnect's
  // ws_initial with no further trading before the window closes. The re-seed
  // loop only runs while processing deltas, so drain the remainder here.
  if (!stoppedAtBound) {
    while (snapIdx < laterSnapshots.length) {
      const snap = laterSnapshots[snapIdx]!;
      if (BigInt(snap.received_at_ms) > toMs) break;
      snapIdx += 1;

      const newEpoch = snap.session_id !== currentSession || snap.stream_id !== currentStream;
      book = bookFromSnapshot(marketTicker, snap);
      currentSession = snap.session_id ?? currentSession;
      currentStream = snap.stream_id;

      if (newEpoch || snap.source === 'session_handoff') {
        epoch = {
          sessionId: currentSession,
          streamId: currentStream,
          startedAtMs: BigInt(snap.received_at_ms),
          seedSnapshotId: snap.snapshot_id,
          seedSource: snap.source,
          deltasApplied: 0,
          deltasSkipped: 0,
          gaps: 0,
        };
        result.epochs.push(epoch);
      }
      emit(BigInt(snap.received_at_ms));
      opts.onPosition?.({ streamId: currentStream, seq: book.lastSeq, book });
    }
  }

  // Flush any remaining sample buckets up to the requested end.
  if (opts.sampleMs && nextSampleMs !== null) {
    while (nextSampleMs <= toMs) {
      result.frames.push(frameOf(book, nextSampleMs, currentSession, currentStream));
      nextSampleMs += BigInt(opts.sampleMs);
    }
  }

  result.finalBook = book;

  logger.debug(
    {
      event: 'replay_complete',
      market_ticker: marketTicker,
      frames: result.frames.length,
      epochs: result.epochs.length,
      applied: result.appliedDeltas,
      skipped: result.skippedDeltas,
    },
    'replay complete',
  );

  return result;
}

/**
 * Verifies replay against snapshots the recorder wrote independently.
 *
 * For each materialised snapshot in the window, the book is reconstructed from
 * raw history up to that instant and the state hashes are compared. This is the
 * end-to-end proof that recorded deltas reproduce recorded state.
 */
interface VerifyTarget {
  received_at_ms: string;
  state_hash: string;
  seq: string | null;
  stream_id: string | null;
}

export interface VerifyResult {
  marketTicker: string;
  checked: number;
  matched: number;
  mismatches: { atMs: string; expected: string; actual: string }[];
}

/**
 * Verifies replay against snapshots the recorder wrote independently.
 *
 * ONE forward pass: every materialised snapshot in the window is indexed by the
 * (stream, seq) position it was taken at, and each is checked as the replay
 * reaches that position. The previous implementation replayed from the window
 * start for every target, which is quadratic and took longer than the capture
 * itself on 45 minutes of data.
 */
export async function verifyReplay(
  sql: Sql,
  marketTicker: string,
  fromMs: bigint,
  toMs: bigint,
  limit = 25,
): Promise<VerifyResult> {
  const targets = await sql<VerifyTarget[]>`
    SELECT s.received_at_ms, s.state_hash, s.seq, s.stream_id
      FROM orderbook_snapshots s
     WHERE s.market_ticker = ${marketTicker}
       AND s.source = 'local_materialized'
       AND s.received_at_ms >= ${fromMs.toString()}
       AND s.received_at_ms <= ${toMs.toString()}
       AND s.seq IS NOT NULL
     ORDER BY s.received_at_ms
     LIMIT ${limit}
  `;

  const out: VerifyResult = { marketTicker, checked: 0, matched: 0, mismatches: [] };
  if (targets.length === 0) return out;

  // Several samples can share a position when nothing traded between them.
  const byPosition = new Map<string, VerifyTarget[]>();
  for (const t of targets) {
    const key = `${t.stream_id ?? ''}:${t.seq}`;
    const list: VerifyTarget[] = byPosition.get(key) ?? [];
    list.push(t);
    byPosition.set(key, list);
  }

  const seen = new Set<string>();

  await replay(sql, {
    marketTicker,
    fromMs,
    toMs,
    onPosition: ({ streamId, seq, book }) => {
      if (seq === null) return;
      const key = `${streamId ?? ''}:${seq}`;
      const hits = byPosition.get(key);
      if (!hits || seen.has(key)) return;
      seen.add(key);

      const actual = book.getStateHash();
      for (const t of hits) {
        out.checked += 1;
        if (actual === t.state_hash) out.matched += 1;
        else out.mismatches.push({ atMs: t.received_at_ms, expected: t.state_hash, actual });
      }
    },
  });

  // A target whose position the replay never reached is itself a failure: the
  // recorder asserted a state the delta stream cannot account for.
  for (const [key, hits] of byPosition) {
    if (seen.has(key)) continue;
    for (const t of hits) {
      out.checked += 1;
      out.mismatches.push({
        atMs: t.received_at_ms,
        expected: t.state_hash,
        actual: '(position never reached during replay)',
      });
    }
  }

  return out;
}
