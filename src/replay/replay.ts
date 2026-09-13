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
    SELECT detected_at,
           session_id,
           stream_id,
           expected_seq::text AS expected_seq,
           received_seq::text AS received_seq,
           status
      FROM sequence_gaps
     WHERE detected_at BETWEEN to_timestamp(${Number(fromMs) / 1000}) AND to_timestamp(${Number(toMs) / 1000})
       AND affected_markets @> ${JSON.stringify([marketTicker])}::jsonb
     ORDER BY sequence_gaps.detected_at
  `;

  let seed = await findSeedSnapshot(sql, marketTicker, fromMs);

  // If the window starts before this market has any recorded state, fall back
  // to its first snapshot inside the window and say so, rather than returning
  // nothing. Different markets in one event are first snapshotted milliseconds
  // apart, so a window pinned to the earliest snapshot across an event would
  // otherwise fail for every market except the first.
  if (!seed) {
    const later = await sql<SnapshotRow[]>`
      SELECT snapshot_id, market_ticker, source, session_id, stream_id, sid, seq,
             received_at, received_at_ms, yes_bids, no_bids, state_hash
        FROM orderbook_snapshots
       WHERE market_ticker = ${marketTicker}
         AND received_at_ms > ${fromMs.toString()}
         AND received_at_ms <= ${toMs.toString()}
         AND source IN ('ws_initial', 'ws_recovery', 'session_handoff', 'local_materialized')
       ORDER BY received_at_ms
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
    SELECT snapshot_id, market_ticker, source, session_id, stream_id, sid, seq,
           received_at, received_at_ms, yes_bids, no_bids, state_hash
      FROM orderbook_snapshots
     WHERE market_ticker = ${marketTicker}
       AND received_at_ms > ${seed.received_at_ms}
       AND received_at_ms <= ${toMs.toString()}
       AND source IN ('ws_initial', 'ws_recovery', 'session_handoff')
     ORDER BY received_at_ms
  `;

  // NOTE: the ORDER BY must reference the underlying BIGINT columns, not the
  // ::text output aliases. `seq::text` takes the default alias `seq`, and
  // Postgres resolves a bare ORDER BY name to the OUTPUT column first -- which
  // sorts sequence numbers lexicographically (100, 101, 1111, 13, 130) and
  // applies deltas in the wrong order. Hence the explicit table qualification.
  const deltas = await sql<DeltaRow[]>`
    SELECT id::text            AS id,
           session_id,
           stream_id,
           seq::text           AS seq,
           side,
           price::text         AS price,
           delta_count::text   AS delta_count,
           applied,
           apply_error,
           received_at_ms::text AS received_at_ms,
           exchange_ts_ms::text AS exchange_ts_ms
      FROM orderbook_deltas
     WHERE market_ticker = ${marketTicker}
       AND received_at_ms > ${seed.received_at_ms}
       AND received_at_ms <= ${toMs.toString()}
     ORDER BY orderbook_deltas.session_id,
              orderbook_deltas.stream_id,
              orderbook_deltas.seq
  `;

  let snapIdx = 0;
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

  for (const delta of deltas) {
    const atMs = BigInt(delta.received_at_ms);

    if (
      opts.toSeq !== undefined &&
      BigInt(delta.seq) > opts.toSeq &&
      (opts.toSeqStream == null || delta.stream_id === opts.toSeqStream)
    ) {
      break;
    }

    // Re-seed from any snapshot that precedes this delta.
    while (snapIdx < laterSnapshots.length && BigInt(laterSnapshots[snapIdx]!.received_at_ms) <= atMs) {
      const snap = laterSnapshots[snapIdx]!;
      snapIdx += 1;

      const newEpoch = snap.session_id !== currentSession;
      book = bookFromSnapshot(marketTicker, snap);
      currentSession = snap.session_id ?? currentSession;
      currentStream = snap.stream_id;

      if (newEpoch || snap.source === 'session_handoff') {
        // A new session is a new sequence space; never carry state across.
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
export interface VerifyResult {
  marketTicker: string;
  checked: number;
  matched: number;
  mismatches: { atMs: string; expected: string; actual: string }[];
}

export async function verifyReplay(
  sql: Sql,
  marketTicker: string,
  fromMs: bigint,
  toMs: bigint,
  limit = 25,
): Promise<VerifyResult> {
  const targets = await sql<
    { received_at_ms: string; state_hash: string; seq: string | null; stream_id: string | null }[]
  >`
    SELECT received_at_ms::text, state_hash, seq::text, stream_id
      FROM orderbook_snapshots
     WHERE market_ticker = ${marketTicker}
       AND source = 'local_materialized'
       AND received_at_ms >= ${fromMs.toString()}
       AND received_at_ms <= ${toMs.toString()}
       AND seq IS NOT NULL
     ORDER BY orderbook_snapshots.received_at_ms
     LIMIT ${limit}
  `;

  const out: VerifyResult = { marketTicker, checked: 0, matched: 0, mismatches: [] };

  for (const target of targets) {
    const atMs = BigInt(target.received_at_ms);

    // Seed from the START of the window, not from just before the target, so
    // every delta in between has to do real work. Materialised snapshots are
    // not used as re-seed points during replay, so they cannot short-circuit
    // the comparison. The bound is the snapshot's sequence number, which is
    // exact where a millisecond timestamp is not.
    const r = await replay(sql, {
      marketTicker,
      fromMs,
      toMs: atMs + 60_000n,
      toSeq: target.seq === null ? undefined : BigInt(target.seq),
      toSeqStream: target.stream_id,
    });
    if (!r.finalBook) continue;

    out.checked += 1;
    const actual = r.finalBook.getStateHash();
    if (actual === target.state_hash) out.matched += 1;
    else out.mismatches.push({ atMs: target.received_at_ms, expected: target.state_hash, actual });
  }

  return out;
}
