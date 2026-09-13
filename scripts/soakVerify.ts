#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { closeDb, db } from '@/src/persistence/db';
import { verifyReplay } from '@/src/replay/replay';

/**
 * Checks the soak test's success criteria against the recorded dataset.
 *
 * Every check is phrased so that a PASS is a positive statement about the data,
 * not an absence of log lines.
 */

interface Check {
  name: string;
  detail: string;
  pass: boolean;
}

const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Verification is a single forward pass per market, so checking every
  // recorded snapshot is cheap; the previous quadratic implementation took
  // longer than the capture itself.
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg === -1 ? 100_000 : Number(argv[limitArg + 1]);

  const sql = db();

  // ---- all expected raw frames durable ----------------------------------
  const ordinalHoles = (await sql`
    WITH o AS (
      SELECT r.session_id, r.ingest_ordinal,
             lag(r.ingest_ordinal) OVER (PARTITION BY r.session_id ORDER BY r.ingest_ordinal) AS prev
        FROM raw_ingest_events r
       WHERE r.ingest_ordinal IS NOT NULL
    )
    SELECT o.session_id, count(*) FILTER (WHERE o.ingest_ordinal <> o.prev + 1) AS holes,
           count(*) AS transitions, min(o.ingest_ordinal) AS first_ordinal
      FROM o WHERE o.prev IS NOT NULL
     GROUP BY o.session_id
  `) as unknown as { session_id: string; holes: string; transitions: string; first_ordinal: string }[];

  const totalHoles = ordinalHoles.reduce((n, r) => n + Number(r.holes), 0);
  const totalFrames = ordinalHoles.reduce((n, r) => n + Number(r.transitions) + 1, 0);
  check(
    'all observed frames durable',
    totalHoles === 0 && ordinalHoles.every((r) => Number(r.first_ordinal) <= 2),
    `${totalFrames} frames across ${ordinalHoles.length} session(s), ${totalHoles} ordinal hole(s)`,
  );

  // ---- every forced gap is recorded --------------------------------------
  const gaps = (await sql`
    SELECT g.status, count(*) AS n FROM sequence_gaps g GROUP BY g.status
  `) as unknown as { status: string; n: string }[];
  const gapTotal = gaps.reduce((n, g) => n + Number(g.n), 0);
  const recovered = Number(gaps.find((g) => g.status === 'recovered')?.n ?? 0);

  const gapIntegrity = (await sql`
    SELECT count(*) AS n FROM integrity_events e WHERE e.type = 'sequence_gap'
  `) as unknown as { n: string }[];

  check(
    'every sequence gap recorded and recovered',
    gapTotal > 0 && gapTotal === recovered && Number(gapIntegrity[0]!.n) === gapTotal,
    `${gapTotal} gap(s): ${gaps.map((g) => `${g.status}=${g.n}`).join(', ')}; ` +
      `${gapIntegrity[0]!.n} matching integrity_events`,
  );

  // ---- reconnects start from fresh snapshot state ------------------------
  // Every stream that carried an applied delta must have had a snapshot first.
  const streamsWithoutSeed = (await sql`
    SELECT d.stream_id, min(d.seq) AS first_applied_seq
      FROM orderbook_deltas d
     WHERE d.applied
       AND NOT EXISTS (
         SELECT 1 FROM orderbook_snapshots s
          WHERE s.stream_id = d.stream_id
            AND s.market_ticker = d.market_ticker
            AND s.source IN ('ws_initial', 'ws_recovery')
            AND s.received_at_ms <= d.received_at_ms
       )
     GROUP BY d.stream_id
  `) as unknown as { stream_id: string; first_applied_seq: string }[];

  check(
    'every applied delta was preceded by a snapshot on its stream',
    streamsWithoutSeed.length === 0,
    streamsWithoutSeed.length === 0
      ? 'no delta was applied to a book that lacked a fresh snapshot'
      : `${streamsWithoutSeed.length} stream(s) applied deltas with no seed snapshot`,
  );

  const streams = (await sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE s.status = 'closed') AS closed
      FROM subscription_streams s
  `) as unknown as { total: string; closed: string }[];

  // ---- no duplicate subscriptions ----------------------------------------
  // Two OPEN streams on the same channel within one session would mean the same
  // markets were subscribed twice, producing two sequence spaces.
  const dupes = (await sql`
    SELECT s.session_id, s.channel, count(*) AS open_streams
      FROM subscription_streams s
     WHERE s.ended_at IS NULL
     GROUP BY s.session_id, s.channel
    HAVING count(*) > 1
  `) as unknown as { session_id: string; channel: string; open_streams: string }[];

  check(
    'no duplicate subscriptions',
    dupes.length === 0,
    dupes.length === 0
      ? `${streams[0]!.total} stream(s) total, ${streams[0]!.closed} closed cleanly`
      : `${dupes.length} channel(s) had overlapping open subscriptions`,
  );

  // ---- zero negative book levels -----------------------------------------
  const negatives = (await sql`
    SELECT count(*) AS n FROM orderbook_deltas d WHERE d.applied AND d.post_count < 0
  `) as unknown as { n: string }[];
  const arithmetic = (await sql`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE d.post_count = d.pre_count + d.delta_count) AS ok
      FROM orderbook_deltas d WHERE d.applied
  `) as unknown as { total: string; ok: string }[];

  check(
    'no negative levels, and post = pre + delta throughout',
    Number(negatives[0]!.n) === 0 && arithmetic[0]!.total === arithmetic[0]!.ok,
    `${arithmetic[0]!.ok}/${arithmetic[0]!.total} applied deltas exact, ${negatives[0]!.n} negative`,
  );

  // ---- no derived samples asserting a book we could not vouch for --------
  // A materialised snapshot asserts a state; it must never be written for an
  // invalid book. BBO samples MAY be written with book_valid = false, since the
  // absence of trustworthy state is itself information.
  const badSnapshots = (await sql`
    SELECT count(*) AS n
      FROM orderbook_snapshots s
     WHERE s.source = 'local_materialized'
       AND s.state_hash IS NULL
  `) as unknown as { n: string }[];

  const invalidSamples = (await sql`
    SELECT count(*) FILTER (WHERE NOT b.book_valid) AS invalid,
           count(*) AS total
      FROM book_samples b
  `) as unknown as { invalid: string; total: string }[];

  check(
    'no materialised snapshot written for an invalid book',
    Number(badSnapshots[0]!.n) === 0,
    `${invalidSamples[0]!.invalid} of ${invalidSamples[0]!.total} BBO samples flagged book_valid=false ` +
      `(expected during recovery); ${badSnapshots[0]!.n} bad materialised snapshots`,
  );

  // ---- session boundaries are explicit -----------------------------------
  const sessions = (await sql`
    SELECT c.session_id, c.end_reason, c.reconnect_count, c.sequence_gaps,
           c.messages_received
      FROM collector_sessions c
     ORDER BY c.started_at
  `) as unknown as {
    session_id: string;
    end_reason: string | null;
    reconnect_count: number;
    sequence_gaps: number;
    messages_received: string;
  }[];

  check(
    'every session closed with an explicit reason',
    sessions.length > 1 && sessions.every((s) => s.end_reason !== null),
    sessions.map((s) => `${s.session_id.slice(0, 8)}(${s.end_reason}, reconnects=${s.reconnect_count})`).join(', '),
  );

  // ---- replay equality ---------------------------------------------------
  const bounds = (await sql`
    SELECT min(s.received_at_ms) AS from_ms, max(s.received_at_ms) AS to_ms
      FROM orderbook_snapshots s
  `) as unknown as { from_ms: string | null; to_ms: string | null }[];

  let replayLine = 'no snapshots to verify';
  let replayPass = false;

  if (bounds[0]?.from_ms && bounds[0].to_ms) {
    const tickers = ((await sql`
      SELECT DISTINCT d.market_ticker FROM orderbook_deltas d ORDER BY d.market_ticker
    `) as unknown as { market_ticker: string }[]).map((r) => r.market_ticker);

    let checked = 0;
    let matched = 0;
    const failures: string[] = [];

    for (const ticker of tickers) {
      const v = await verifyReplay(sql, ticker, BigInt(bounds[0].from_ms) - 1n, BigInt(bounds[0].to_ms), limit);
      checked += v.checked;
      matched += v.matched;
      if (v.checked > 0 && v.matched !== v.checked) failures.push(`${ticker}(${v.matched}/${v.checked})`);
    }

    replayPass = checked > 0 && matched === checked;
    replayLine =
      `${matched}/${checked} recorded snapshots reproduced exactly across ${tickers.length} market(s)` +
      (failures.length ? `; failures: ${failures.join(', ')}` : '');
  }

  check('replay equality across fault injection', replayPass, replayLine);

  // ---- report ------------------------------------------------------------
  console.log('\n=== soak verification ===\n');
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`        ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);

  await closeDb();
  if (failed.length > 0) process.exit(2);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
