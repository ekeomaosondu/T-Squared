# Kalshi Market-Data Recorder

A persistent market-data collection service for Kalshi, built to accumulate
weeks of high-fidelity order-book and trade data for systematic market-making
research — with a primary focus on the daily **KXHIGH / KXLOW** temperature
markets.

The guiding rule is that **the raw event log is sacred**. Every order-book
delta and every public trade the exchange sends is stored verbatim. Nothing is
downsampled, interpolated, smoothed, deduplicated or repaired on the way in.
Sampling horizons apply only to *derived* tables, all of which can be
recomputed from raw history.

---

## Status

Implemented and verified against live production data: market discovery,
WebSocket ingestion, order-book reconstruction, sequence-gap detection and
recovery, normalized persistence, periodic sampling, synchronized event-ladder
sampling, REST validation, integrity and health tables, offline replay, and
immutable raw archival with verified retention.

Hardened under a 45-minute fault-injected soak on the live four-city universe —
6 abrupt socket terminations, 4 genuinely dropped frames, 2 database stalls and
a collector restart mid-event — after which all 8 checks passed:

```
113,652 frames captured, 0 ingest_ordinal holes
4 sequence gaps, all recorded and all recovered
83,748/83,748 applied deltas exact, 0 negative levels
32 streams, all closed cleanly, no duplicate subscriptions
14,136/14,136 snapshots reproduced exactly across 24 markets
RSS 113MB -> 97MB; peak write buffer 1,841 rows
```

Not yet built: Vercel rolling sessions / lease handoff, the export CLI, the
monitoring dashboard, and the optional private order/fill and weather feeds.
See [Roadmap](#roadmap).

> **Retention is disabled by default.** `RAW_DB_RETENTION_ENABLED=false` until
> you have confirmed archives are being written and verified. Nothing is ever
> dropped before its archive is checksum- and row-count-verified.

---

## What is being collected

| Stream | Channel | Stored as |
|---|---|---|
| Order-book snapshots | `orderbook_delta` | `orderbook_snapshots` (`ws_initial`) |
| Order-book deltas | `orderbook_delta` | `orderbook_deltas`, one row per delta |
| Public trades | `trade` | `public_trades`, keyed by exchange `trade_id` |
| Ticker / BBO | `ticker` | `ticker_updates` |
| Market lifecycle | `market_lifecycle_v2` | `market_lifecycle_events` |
| Everything, verbatim | all | `raw_ingest_events` |

Plus derived tables: `book_samples` (BBO + depth + imbalance at configured
horizons), `event_ladder_samples` (synchronized cross-strike snapshots),
periodic `local_materialized` book snapshots, `book_validations`,
`sequence_gaps`, `integrity_events`, and `ingest_health_minutes`.

### Why raw deltas matter

A BBO time series answers "what was the spread?". It cannot answer "how much
size was pulled from the second level 300 ms before that trade?", "where was
our order in the queue?", or "what did the whole strike ladder look like at
14:03:12.418?". Those questions need the event stream, not a summary of it.

Storing raw also means a parser bug is recoverable. `raw_ingest_events.payload`
holds the exact message, so a future `parse_version` can re-derive fields this
version never normalized — without re-collecting anything.

---

## Architecture

```
                              KALSHI
                                |
              +-----------------+-----------------+
              |                 |                 |
        orderbook WS         trade WS         ticker WS
              |                 |                 |
              +-----------------+-----------------+
                                |
                      KalshiWebSocketClient
                   (timestamps at socket receipt)
                                |
                          Collector
                   1. capture raw  ---------------+
                   2. classify sequence           |
                   3. reconstruct book            |
                   4. normalize                   |
                                |                 |
              +-----------------+                 |
              |                                   |
        BookManager                         BatchWriter
     (in-memory books)                 (batched, transactional)
              |                                   |
              +-----------------+-----------------+
                                |
                            POSTGRES
                                |
              +-----------------+-----------------+
              |                 |                 |
        derived samples    integrity/health    raw archive
        BBO / ladders /    gaps / validations   (JSONL.GZ)
        features
```

Six subsystems, each independently testable:

| Subsystem | Location |
|---|---|
| Market discovery | `src/collector/universeManager.ts` |
| WebSocket ingestion | `src/kalshi/`, `src/collector/collector.ts` |
| Book reconstruction | `src/book/` |
| Normalized persistence | `src/persistence/` |
| Snapshot / feature generation | `src/sampling/` |
| Integrity monitoring | `src/integrity/` |

The collector core has **no Next.js or Vercel imports**. `npm run collector`
runs it as a plain long-lived Node process, and moving ingestion to Fly.io,
Railway, Render, AWS or a bare VM is a deployment decision, not a rewrite.

---

## How book reconstruction works

Kalshi expresses the book as **YES bids** and **NO bids**. Both are stored
exactly as received. The conventional YES-side view is *derived*:

```
best_yes_bid = max(YES bid prices)
best_yes_ask = 1 - max(NO bid prices)
```

The YES ask size is the size resting on that NO bid level. The original
representation is never discarded — `orderbook_snapshots` stores `yes_bids` and
`no_bids` verbatim, and the derived columns sit alongside them.

Deltas apply as `post_count = pre_count + delta_count`:

| Result | Action |
|---|---|
| `post > 0` | level remains |
| `post = 0` | level removed |
| `post < 0` | **invariant violation** |

A negative post-count persists the raw event, writes the delta with
`applied = false` and an `apply_error`, marks the book invalid, records an
integrity event, and requests a fresh snapshot. Quantities are **never** clamped
to zero, and a book only becomes valid again by being replaced from an exchange
snapshot — there is no incremental repair path.

### Price and quantity conventions

The current Kalshi API quotes **dollars as decimal strings**
(`yes_bid_dollars: "0.0200"`), not integer cents, and quantities as
**fractional fixed-point strings** (`count_fp: "41.39"`). Both stay strings all
the way into `decimal.js` and then into `NUMERIC` columns. JavaScript floating
point is never used for exchange state, and in-memory price keys are canonical
fixed-point strings so `0.1 + 0.2` cannot create a phantom level.

---

## How sequence recovery works

`seq` is scoped to a **subscription**, not to the exchange. Continuity is
therefore only ever asserted within one `(session_id, stream_id)`. Separate
connections are never stitched into one sequence.

On `actual_seq != previous_seq + 1`:

1. persist the raw event
2. insert a `sequence_gaps` record
3. mark the subscription stream `degraded`
4. invalidate every book on that subscription
5. stop applying deltas to canonical state
6. keep persisting all raw messages
7. request `get_snapshot` for the affected markets (once)
8. rebuild each book from the recovery snapshot
9. insert snapshots with `source = ws_recovery`
10. restore the stream to `healthy`

Nothing is interpolated and missing updates are never guessed at.

This is an explicit state machine (`src/integrity/recoveryStateMachine.ts`):

```
HEALTHY --sequence discontinuity--> DEGRADED --one recovery request--> RECOVERING
       <--a valid replacement snapshot for every affected market--
```

While `DEGRADED` or `RECOVERING`:

| | |
|---|---|
| raw frames captured | yes |
| raw frames persisted | yes |
| canonical delta apply | **no** |
| new recovery requests | **no** |
| derived feature samples | **no** |

**One episode per discontinuity.** While a gap is open the baseline is stale by
definition, so the tracker reports `degraded` rather than re-reporting. This is
not cosmetic: without it, a single discontinuity produced thousands of gap rows
and — because each one requested recovery snapshots, which themselves advance
the subscription's `seq` — fed back into a snapshot storm (2,552 snapshots
against 1 delta in seven seconds, observed against live data).

A timed-out episode leaves the stream `DEGRADED`, not healthy: we still cannot
vouch for those books.

---

## Database

Schema lives in `db/migrations/`, applied in order by `npm run migrate`, which
records each file's checksum and refuses to run if an applied migration has
changed.

### `raw_ingest_events` — the authoritative log

Range-partitioned by day in UTC. Retention **drops whole partitions** after
their archive is verified, rather than issuing a bulk `DELETE` that would leave
autovacuum scanning every index while ingestion competes for the same I/O.

Notable decisions:

- **`PRIMARY KEY (id, received_at)`.** Postgres requires the partition key in
  any unique constraint. `id` is still globally increasing via the shared
  identity sequence; the database simply does not enforce uniqueness on it
  alone. That is accepted and deliberate.
- **Three indexes, not six.** Every index turns one heap append into extra
  random index maintenance on the hot path, and this table is not meant to serve
  ordinary strategy queries. No BRIN either — daily partition pruning already
  does that job, since each live partition spans one day.
- **`payload_hash BYTEA`** (32 raw bytes, not 64 hex chars), deliberately
  **not** indexed and **not** unique. Duplicate frames are kept: the question
  this table answers is *what did our socket actually receive*. Deduplication
  belongs downstream (`public_trades.trade_id`, and `(session, stream, seq)`).
- **No `DEFAULT` partition.** If partition maintenance fails, inserts must fail
  loudly rather than pooling into a catch-all that later blocks `ATTACH` of the
  correct range.

Partition maintenance runs at startup and hourly under advisory lock
`81726391`, creating `RAW_PARTITION_AHEAD_DAYS` ahead. Runway is a first-class
health metric:

| `partitions_ahead` | State |
|---|---|
| ≥ 3 | healthy |
| 2 | warning |
| 1 | critical |
| 0 | at risk |
| −1 | today's partition missing — writes are failing |

### Ordering authority

```
exchange seq   >   ingest_ordinal   >   id
```

- **`seq`** is the exchange's own sequence, scoped to a subscription. It is the
  ordering key for order-book replay, always as
  `(session, stream chronology, seq)`.
- **`ingest_ordinal`** is an in-process counter assigned synchronously at socket
  receipt, before any asynchronous work. It records the order this process
  *observed* frames, is monotonic within a session, and is meaningless across
  sessions. For the unsequenced `ticker` channel it is the only principled
  ordering available. Because every frame is captured, including control
  frames, its contiguity also answers "did a frame go missing between receipt
  and durability?".
- **`id`** is provenance identity, assigned at flush time. It is **not** event
  ordering and must never be used as such.

`seq` restarts on every reconnect, so a session that reconnected holds several
streams with overlapping `seq` ranges. Ordering by `stream_id` — a random UUID —
interleaves them arbitrarily. That is invisible with a single stream and
catastrophic after a reconnect, which is why streams are ordered by when they
began.

### SQL ordering rules

PostgreSQL resolves a bare name in `ORDER BY` / `GROUP BY` / `DISTINCT ON` to an
**output column alias** in preference to an input column. So:

```sql
SELECT d.seq::text AS seq FROM orderbook_deltas d ORDER BY seq;  -- sorts TEXT
```

yields `100, 101, 1111, 13, 130`. Two rules apply project-wide, enforced by
`tests/sqlConventions.test.ts`, which scans the source:

1. Never cast a numeric or temporal **ordering key** to its display form inside
   the query that orders by it. No cast is needed anyway — the driver returns
   `int8` and `numeric` as strings already.
2. Every `ORDER BY` / `GROUP BY` / `DISTINCT ON` referring to a source column is
   table-qualified: `ORDER BY d.seq`, never `ORDER BY seq`.

### Provenance, not foreign keys

Normalized tables carry `raw_event_id` plus `raw_event_received_at`. These are
**pointers, not foreign keys**: raw rows are intentionally dropped after the
retention window while normalized rows may live for months. `raw_event_id`
means "this came from raw capture event N" — which after archival lives in
object storage — not "Postgres guarantees that row still exists".
`raw_event_received_at` lets a provenance lookup prune straight to the owning
partition.

### Table data dictionary

| Table | Purpose |
|---|---|
| `series`, `events`, `markets` | Latest metadata, with the verbatim API object in `raw` |
| `market_metadata_versions` | Append-only audit of **structural** changes (rules, strikes, close time, status) |
| `tracked_markets` | Exactly when the recorder intended to capture each market; prior windows are never overwritten |
| `collector_sessions` | One row per process/run — a capture **epoch** |
| `subscription_streams` | One row per `(connection, channel)`; `sid` is scoped here |
| `raw_ingest_events` | Every message, verbatim, partitioned by day |
| `orderbook_snapshots` | `ws_initial`, `ws_recovery`, `local_materialized`, `rest_validation`, `session_handoff` |
| `orderbook_deltas` | One row per delta, applied or not, with pre/post counts |
| `public_trades` | Keyed by exchange `trade_id`; all three taker fields preserved |
| `ticker_updates` | Exchange BBO, volume, open interest — an independent check on our book |
| `market_lifecycle_events` | created / activated / determined / settled / … |
| `sequence_gaps` | One row per discontinuity, with recovery status |
| `integrity_events` | Everything anomalous, never deleted |
| `book_validations` | Every REST cross-check, matched or not |
| `ingest_health_minutes` | Per-session/minute counts, latencies, partition runway |
| `book_samples` | BBO, depth 1/3/5/10, imbalance, microprice per horizon |
| `event_ladder_sample_groups` / `event_ladder_samples` | Synchronized cross-strike ladders |
| `raw_archives`, `raw_partition_archive_state` | Archive manifests and the per-partition ledger |

`market_metadata_versions` hashes an **allowlist of structural fields only**. A
market object also carries live quote and volume fields that change on every
trade; hashing those would mint a new "metadata version" on every discovery poll
and bury the handful of real changes.

---

## KXHIGH / KXLOW specifics

Each daily event is a set of mutually exclusive temperature buckets forming a
ladder. Markets are grouped by the **official `event_ticker`** returned by the
API — ticker strings are never parsed to infer structure. Prefixes are used
only as a discovery filter.

`event_ladder_samples` captures the whole ladder at one logical instant: books
are cloned synchronously before any feature computation, so strikes are
genuinely simultaneous rather than independently timed reads presented as one
moment. Probabilities are **not** normalized to sum to one — what the market
showed is what is stored, including when it is internally inconsistent.

A real capture, one synchronized instant:

```
KXHIGHNY-26SEP13   18:38:10   yes_bid  yes_ask   mid
  ≤78°                          0.6300   0.6900   0.6600
  78–79°                        0.2200   0.2900   0.2550
  80–81°                        0.0600   0.1000   0.0800
  82–83°                        (none)   0.0100   (null)
  84–85°                        (none)   0.0100   (null)
  ≥85°                          (none)   0.0100   (null)
```

Missing BBOs stay null; they are never imputed.

Strike grids change daily (observed: 78–85 one day, 74–81 the next), the bucket
count is never assumed, and no city list is hardcoded.

### Discovery scope vs capture scope

`KXHIGH`/`KXLOW` is **not** synonymous with daily temperature. Those prefixes
match 112 series on the live exchange, including `KXHIGHINFLATION`,
`KXLOWESTRATE` and `KXHIGHMOVDJT`; filtered to Climate and Weather they still
match **104**.

Three weeks of 104 series means a much larger database, more subscription
complexity, more opportunity for gaps, and a great many contracts nobody
analyses. Four to twenty series, complete and well-monitored, is the better
dataset. So the two concepts are separate:

| | |
|---|---|
| **`discoveryScope`** | Observed but **never subscribed**. Series metadata is persisted so you can see what is available and expand deliberately. |
| **`selectors`** | The capture universe. Explicit allowlist by default. |

`maxCaptureSeries` (default 25) refuses to start when a selector resolves wider
than expected — a prefix selector can silently widen when the exchange lists new
series, and that should be a startup failure naming the count and the fix, not a
recorder that quietly begins capturing a whole category.
`config/collector.wide-example.json` shows the opt-in for the full scope.

---

## Configuration

Selectors are data; adding or removing series never requires a code change.
Copy `config/collector.example.json` to `config/collector.json`.

```json
{
  "selectors": [{
    "id": "daily-temperature",
    "seriesPrefixes": ["KXHIGH", "KXLOW"],
    "categories": ["Climate and Weather"],
    "statuses": ["initialized", "active", "inactive", "closed", "determined"],
    "subscribeBeforeOpenSeconds": 21600,
    "retainAfterCloseSeconds": 7200
  }],
  "sampling": {
    "bboIntervalsMs": [1000, 5000, 60000],
    "fullBookIntervalsMs": [5000, 60000],
    "eventLadderIntervalsMs": [1000, 5000, 60000]
  }
}
```

To pin an explicit set instead:

```json
{ "seriesAllowlist": ["KXHIGHNY", "KXLOWNY", "KXHIGHLAX", "KXLOWLAX"] }
```

All durations are environment variables — see `.env.example`.

### Credentials

The WebSocket requires authentication (RSA-PSS over
`<timestamp><METHOD><path>`, MGF1-SHA256, 32-byte salt). Vercel environment
variables are single-line, so the PEM may be supplied as base64 of the whole
file (recommended), with literal `\n` escapes, or as a real multi-line key:

```bash
cat kalshi-key.pem | base64 | pbcopy   # paste into KALSHI_PRIVATE_KEY_PEM
```

No credential is ever logged. `redactedEnv()` is the only loggable view of the
environment, and pino redacts key paths as a second line of defence.

---

## Running locally

```bash
npm install
cp .env.example .env.local          # add KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY_PEM
npm run db:up                       # Postgres 17 in Docker, port 54329
npm run migrate                     # schema + partitions
npm run collector                   # daemon mode
```

Useful during development:

```bash
npm test                            # unit + ingestion tests
npm run typecheck
npm run db:psql                     # psql into the local database
npm run db:reset                    # drop, recreate, migrate
COLLECTOR_CONFIG_PATH=config/collector.smoke.json npm run collector   # 2 series
```

---

## Replaying data

> If the recorder cannot later replay a book, it is not complete.

```bash
npm run replay -- --ticker KXHIGHNY-26SEP14-B74.5 \
                  --from 2026-09-13T18:51:00Z \
                  --to   2026-09-13T18:54:00Z \
                  --sample-ms 1000 --format csv
```

Replay seeds from the nearest usable snapshot, applies deltas in
`(session_id, stream_id, seq)` order, treats a session boundary as a hard reset,
and does not apply deltas recorded as `applied = false` — replaying those would
invent a book the recorder never believed in. Kalshi is never contacted.

The summary states whether the window came from an uninterrupted stream or was
stitched after a recovery:

```json
{ "epochs": [...], "sequenceGapsInWindow": 0, "uninterrupted": true }
```

To prove reconstruction end to end:

```bash
npm run verify-replay
```

This rebuilds every market's book from a seed snapshot plus the delta stream and
compares SHA-256 state hashes against snapshots the recorder wrote
independently. Against 150 seconds of live KXHIGHNY production data:

```
372/372 recorded snapshots reproduced exactly from raw deltas
```

---

## Data quality

- `ingest_health_minutes` — per-minute message counts, DB flush latency,
  exchange-to-receive latency percentiles, reconnects, partition runway.
- `book_validations` — every REST cross-check, classified by *timing* rather
  than bare equality (see below).
- `integrity_events` — sequence gaps, negative quantities, crossed books,
  ticker/book disagreement, schema drift, DB failures, buffer overflow.

### REST validation semantics

A REST snapshot is built at an unobservable instant between our request and our
receipt of the response:

```
t0            request sent
t0 + 10ms     local delta applied
t0 + 20ms     REST server builds its snapshot   <-- the state we receive
t0 + 30ms     local delta applied
t1 = t0+60ms  response arrives
```

Comparing that against the book *now* reports a mismatch on any actively traded
market. A non-matching hash is therefore checked against every state the book
actually passed through in `[t0 - tolerance, t1 + tolerance]`, reconstructed by
rewinding a bounded journal of applied deltas. Four outcomes:

| `match_kind` | Meaning | Action |
|---|---|---|
| `match_current` | agrees with the book as it stands | none |
| `match_recent` | agrees with a state the book genuinely held | none |
| `mismatch_transient` | no match, first observation | re-check in 1.5s |
| `mismatch_confirmed` | no match on an independent re-check | request WS recovery snapshot |

Only `mismatch_confirmed` is actionable, and only repeated confirmations
reconnect. The live book is never replaced from REST. Without this, an earlier
"98.3% match rate" looked like 1.7% corrupt books when it was almost entirely
timing — and acting on it would have let the validator destabilise a healthy
recorder.

Recent states are reconstructed by rewinding, not by hashing the book on every
mutation, which would serialise and SHA-256 the whole ladder thousands of times
a second. The journal costs one small object per delta and is cleared by a
snapshot, since a snapshot is a hard reset that earlier deltas no longer
describe.

Exchange-to-receive latency is computed only from messages carrying a usable
exchange timestamp and is **not** treated as true network latency — Kalshi's
timestamps are coarse in places.

Suspicious states are recorded, never deleted. A transiently crossed book is
real data.

---

## Logging

Structured JSON only, with `session_id`, `stream_id`, `market_ticker`,
`channel`, `seq` and `event` as context.

| Level | Used for |
|---|---|
| `debug` | individual feed events |
| `info` | connects, subscriptions, discovery, archive |
| `warn` | reconnects, recoverable validation mismatches |
| `error` | DB failures, gap-recovery failures |

Individual deltas are never logged at `info`.

---

## Raw archiving and retention

```bash
npm run archive             # seal, archive and verify completed partitions
npm run archive -- --status # report only
```

The lifecycle is one-way and every step is recorded, because the last step
destroys data:

```
partition completes
  -> SEAL      row count fixed; no further inserts can land in this range
  -> ARCHIVE   deterministic NDJSON, gzipped, one part per channel and hour
  -> VERIFY    every object re-read; SHA-256 and row count must match
  -> retention floor elapses
  -> DETACH    concurrently, so ingestion is not blocked
  -> DROP
```

Nothing is detached or dropped unless **every part verified** and the archived
row count equals the count sealed when the partition closed. Verification
re-reads from storage rather than trusting the upload call, because "the bytes
are retrievable and correct" is exactly the property the subsequent `DROP`
depends on.

Archive boundaries follow partition boundaries, so the partition dropped and the
objects written are provably the same rows:

```
kalshi/raw/channel=orderbook_delta/date=2026-09-13/hour=17/
    part-<session>-<first_id>-<last_id>.jsonl.gz
```

Storage is an interface. Vercel Blob is the default; a local backend exists for
development. Selecting the local backend in `vercel_rolling` mode is a hard
error — a function filesystem is not durable, so a local archive would vanish
and retention could then drop partitions that were never really archived.

`RAW_DB_RETENTION_HOURS` is a **floor** on the age of a completed partition, not
an exact TTL: with daily partitions the effective retention is between that and
24 hours more.

---

## Going live

The launch gate is one sentence: **one real partition archives, verifies,
restores and replays exactly. Then enable retention.**

```bash
# 1. Start with retention disabled. Nothing can be deleted.
RAW_DB_RETENTION_ENABLED=false npm run collector

# 2. Let the first UTC daily partition close naturally. Do not manufacture it.

# 3. Run the real archival flow: seal -> archive -> verify rows -> verify sha256
npm run archive
npm run archive -- --status

# 4. Restore that partition into a scratch database and reconstruct from it.
#    This is the acceptance criterion, not step 3.
npm run restore -- --partition raw_ingest_events_YYYY_MM_DD

# 5. Only after step 4 passes, enable retention.
#    The first deletion is then a partition already proven restorable.
RAW_DB_RETENTION_ENABLED=true
```

Archive verification proves `bytes written == bytes read`. Step 4 proves what
actually matters:

```
archived bytes -> restore -> parse -> normalize -> replay -> exact book state
```

`npm run restore` replays every archived frame through the **real collector**
into a scratch database and compares the result against the snapshots the live
recorder wrote at the time. It exits non-zero unless every one reconstructs
exactly.

### Ongoing

```bash
npm run integrity          # daily: health, gaps, ordinal holes, archive
                           # status, validation counts, coverage, sampled replay
npm run integrity:full     # weekly: replay every market in the window
```

Both exit non-zero on `CRITICAL` or any replay mismatch, so cron only speaks up
when it matters.

### Monitoring

`GET /api/health` returns a single level, with HTTP status mirroring it:

| Level | HTTP | Meaning |
|---|---|---|
| `HEALTHY` | 200 | nothing to do |
| `DEGRADED` | 200 | needs attention; history still being captured correctly |
| `CRITICAL` | 503 | dataset is being damaged or is not being collected |

`CRITICAL` is raised by: stale or absent collector heartbeat, an
`ingest_ordinal` hole (a frame observed but never persisted), an unrecovered
sequence gap, partition runway under two days, or failing database writes. An
overdue archive is `DEGRADED` while retention is disabled and `CRITICAL` once it
is enabled, because unarchived data is then one job away from deletion.

`GET /api/collector/status` gives the detail behind it, including series
coverage.

### Series coverage

A configured series that has never listed a market looks identical to one the
recorder is silently failing on, so the two are tracked apart:

```
KXHIGHNY   exercised               markets=12
KXHIGHLAX  exercised               markets=12
KXLOWNY    awaiting_first_market   markets=0
KXLOWLAX   awaiting_first_market   markets=0
```

The low-temperature series are seasonal and currently list nothing. When they
first appear, treat it as a small production test: confirm discovery,
subscription, initial snapshots, synchronized ladder samples, REST validation
and replay. The first listing is logged as `series_first_subscribed`.

---

## Soak testing

A clean run proves normal operation. This deliberately makes operation abnormal:

```bash
npm run soak -- --minutes 45     # inject faults against live data
npm run soak:verify              # check the recorded dataset
```

Injected faults: abrupt socket terminations, genuinely dropped frames (filtered
at the transport, so gap detection is exercised for real rather than synthesised
downstream), a database stall long enough to trigger write backpressure, and a
collector restart mid-event producing a second capture epoch.

`soak:verify` asserts:

- every observed frame is durable (`ingest_ordinal` contiguous, no holes)
- every sequence gap is recorded *and* recovered
- no delta was applied to a book lacking a fresh snapshot
- no duplicate subscriptions
- `post = pre + delta` for every applied delta, zero negatives
- no materialised snapshot written for an invalid book
- every session closed with an explicit reason
- **replay equality**: every recorded snapshot reproduced exactly from raw deltas

This is the gate for trusting the recorder unattended.

Replay equality is a **mandatory invariant** for any change touching ingestion,
persistence, sequence handling or SQL ordering. Every serious defect found in
this project was caught by it and by nothing else:

| Defect | Symptom without replay equality |
|---|---|
| Raw log reordered by async DB work in the frame handler | none — ingestion looked healthy |
| Deltas ordered by `seq::text` → 100, 101, 1111, 13, 130 | none — all rows present |
| Streams interleaved by random UUID after a reconnect | none — only wrong after a reconnect |
| Deltas in the seed snapshot's own millisecond dropped | none — rare and silent |

CI (`.github/workflows/ci.yml`) therefore runs `tests/replayEquality.test.ts`
against a real Postgres on every push: it drives the real collector, batch
writer and database with a synthetic feed covering a random walk, a sequence gap
with recovery, and a reconnect where `seq` restarts. `tests/sqlConventions.test.ts`
backs it up by scanning the source for unqualified ordering keys and
self-shadowing cast aliases.

---

## Deploying to Vercel

> The rolling-session supervisor and lease handoff are not yet implemented.
> Until they are, run the collector as a daemon (Fly.io, Railway, Render, a VM,
> or locally) pointed at the same Neon database. Nothing in the collector core
> is Vercel-specific, so this is a supported deployment, not a workaround.

Planned model, for reference: Vercel Cron hits `/api/collector/run` every
minute; the route inspects a Postgres lease and exits immediately if a healthy
collector exists. Sessions roll over before the platform's duration limit —
soft handoff at ~24 minutes, forced shutdown at ~28. At each ownership boundary
the incoming session writes `source = session_handoff` snapshots for every
tracked book, because sequence continuity across connections cannot be
fabricated and each session is a separately auditable epoch.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| P0 | Auth, discovery, WS, raw recorder, parsers, book, trades | done |
| P1 | Sequence validation, recovery, normalized tables, ticker, lifecycle, dynamic subscriptions | done |
| P2 | Periodic book sampling, ladder sampling, REST validation, health metrics | done |
| P4 | Raw archival with verified retention | done |
| P4 | Export CLI | not started |
| P3 | Vercel rolling workers, session leases, handoff | deferred, see below |
| P5 | Private order/fill streams, weather reference feeds | scaffolded (schema + interface only) |

Replay (nominally P4) was built early because it is the acceptance test for
everything below it.

**P4 was deliberately done before P3.** Daemon mode already works, so the safest
deployment for a multi-week collection is a persistent process rather than
voluntarily introducing a connection transition roughly twice an hour. Every
handoff is another opportunity for subscription overlap, snapshot races, gaps,
duplicate raw frames and lease-ownership mistakes. Archival, by contrast, is
what makes retention safe at all — and until it existed, nothing could be
allowed to delete anything.

Recommended topology for the collection period:

```
Vercel            dashboard / control API
Persistent worker Kalshi collector (daemon mode)
Neon              database
Blob / S3         archives
```

P3 remains worth building if Vercel-only operation is a hard requirement.

---

## Notes on the live API

Verified against production on 2026-09-13; recorded here because several
details are not obvious from the docs.

- Prices are **dollars as decimal strings**, not integer cents. Quantities are
  **fractional** fixed-point strings.
- `GET /markets/orderbooks` needs **repeated** `tickers` params. A comma-joined
  value is read as a single ticker and silently returns one empty book. The
  server-side maximum is **100** per call.
- The `status` **query** vocabulary (`open|unopened|closed|settled`, one at a
  time) differs from the `status` **field** on a market object
  (`initialized|active|inactive|closed|determined|finalized`).
- `min_close_ts` prunes settled history server-side. For KXHIGHNY this is the
  difference between 840 rows per discovery cycle and 12.
- `GET /series` returns ~17 MB / 14,017 series. The `category` filter cuts that
  to ~316 KB.
- The `ticker` channel carries **no `seq`**, so gap detection must never be
  applied to it.
- `market_lifecycle_v2` is a **global** channel: despite subscribing with
  `market_tickers`, it delivers lifecycle events for the entire exchange.
- A snapshot **omits** a side's key entirely when that side is empty, rather
  than sending an empty array.
