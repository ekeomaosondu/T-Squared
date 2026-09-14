# Kalshi HFT research platform — Phase 1

A strategy lab that reads the same R2 lake the recorder writes, replays the
exact order book the collector saw, runs a strategy against it, simulates
orders and fills, and produces standardized, comparable results.

The point is not maximum sophistication. It is to make an HFT idea **cheap to
test, hard to accidentally look ahead, easy to compare against a baseline, and
easy to move toward live execution.**

```
R2 silver Parquet
      |
      v
DuckDBHistoricalDataSource      predicate pushdown on date/series/market/time
      |
      v
BacktestEngine ---------------> MarketStateStore  (MarketBook, unchanged)
      |                               |
      v                               v
  Strategy  <--------------------  MarketState
      |
      v
  OrderIntent[]
      |
      v
ExecutionAdapter -> SimulatedExchange -> fills
      |
      v
  Portfolio -> metrics -> research/backtests/<run_id>/
```

Phase 2 replaces one box:

```
Kalshi live feed -> same Strategy -> LiveExecutionAdapter
```

---

## The one rule

**Strategy code cannot tell whether it is running in BACKTEST, SHADOW, PAPER or
LIVE.** It consumes normalized events and emits order intents; an execution
adapter decides what happens to them.

This is enforced statically, not by convention.
`tests/research/modeAgnostic.test.ts` reads the source under
`src/research/strategy/` and `src/research/strategies/` and fails if it imports
the simulator, the engine or a data source, or if it branches on a mode
literal. A single stray import would compile, pass every behavioural test, and
quietly make that strategy impossible to promote — so it is checked the only way
it can be.

The same scan forbids `Date.now`, `setTimeout`, `setInterval`, `Math.random`
and `new Date()` anywhere in the simulated path.

---

## Commands

```bash
# What would this slice read? Resolves objects and fingerprint without reading.
npm run research -- describe --series KXHIGHNY --from 2026-09-13 --to 2026-09-14

# Replay the book and check it against the collector's own recorded hashes.
# Run this on a new day BEFORE trusting any result from it. Exit 1 on mismatch.
npm run research -- verify --series KXHIGHNY --from 2026-09-13 --to 2026-09-14

# One strategy.
npm run research -- backtest \
  --strategy join-bbo \
  --series KXHIGHNY \
  --from 2026-09-13 --to 2026-09-14 \
  --fill-model conservative_queue \
  --latency-ms 100

# The experiment matrix.
npm run research -- compare --config experiments/baseline.yaml
```

Useful flags: `--markets A,B`, `--events A,B`, `--strategy-params '{"size":"25"}'`,
`--latency-ms N`, `--fee-model zero`, `--max-events N`, `--no-write`, `--no-verify`.

---

## Replay equality is the gate

Every backtest reconstructs each book from snapshots and deltas and compares it
against the SHA-256 hashes the collector recorded independently while it was
live. Those hashes come from `local_materialized` snapshots, which are
deliberately excluded from the event stream — replaying them as events would
reseed the book from the very state being verified.

```
replay equality: 14832/14832 exact
```

If `compared` and `matched` differ, every other number in the run was computed
on a book that is not the one that existed, and the run should be discarded
rather than interpreted. The comparison table says so in place of the summary.

This is also why the research platform does not contain a second order-book
implementation. `MarketBook`, `canonicalPrice`, the delta arithmetic and the
state hashing are the recorder's, unchanged. `MarketStateStore` adds only the
policy a multi-market replay needs: a book belongs to one stream at a time, a
delta from an older stream is dropped, and a book is invalid until an exchange
snapshot seeds it.

---

## Ordering

Events come out in the collector's observation order:

1. session, by when the session began — **never by session UUID**
2. collector receive time
3. `ingest_ordinal`, the collector's own observation counter
4. stream, by when the stream began — **never by stream UUID**
5. exchange `seq`, within a stream
6. event kind: a delta precedes a snapshot at the same position
7. a stable identifier

`seq` restarts on every reconnect, so a session that reconnected holds several
streams with overlapping sequence ranges; ordering those by a random identifier
interleaves them arbitrarily. Sorting is on typed BIGINT columns, never their
string forms — a VARCHAR ordinal sorts 100 before 99.

A snapshot at sequence N already contains the delta at sequence N, so the delta
is applied first and the snapshot then overwrites with identical state.
Snapshot-first would apply that delta a second time on top of state that
already contains it.

---

## Time and latency

Two clocks, never interchangeable:

- `exchangeTimeMs` — stamped by Kalshi, **nullable**, never imputed
- `receiveTimeMs` — when the collector's socket handler saw the frame

The simulation clock advances on `receiveTimeMs`, because that is the only
instant at which the information could have reached a trader. Exchange time is
carried for latency studies and never used to order the stream.

Latency is modelled in four parts because they are physically different things:
market data, decision, submit, cancel. Cancel is separate from submit
deliberately — the interval in which a cancel is in flight but not yet effective
is exactly where adverse selection lives.

**The lookahead rule.** An order does nothing until `nowMs >= effectiveAtMs`.
Control messages are split around each event by a strict comparison: anything
effective *before* the instant is applied first, anything effective *exactly at*
it is applied after. So an order arriving on the timestamp of a favourable print
misses it, and a cancel becoming effective on that timestamp does not save us
from the fill. Both ties point against the strategy.

Market-data latency is charged to the order's effective time rather than by
maintaining a second delayed book. The arrival time matches what a real system
would achieve, while the information the strategy used is what existed at `T`
rather than at `T + latency` — strictly less. The error is bounded by the
market-data latency and points against the strategy.

---

## Capture gaps

An interval when no collector was listening. Distinct from a sequence gap:
there the exchange sent frames we missed; here nobody was watching at all.

Derived from the lake rather than read from Postgres — the operational database
keeps only a few days, and research must stay answerable from R2 alone. The
order-book channel is one subscription, a reconnect or restart opens a new
stream, and the interval between the last frame of one and the first of the next
is time nobody saw. The *reason* is consequently unknown; the *interval*, which
is what a backtest must respect, is exact.

Default policy `skip_until_fresh_snapshot`:

- every affected book becomes invalid immediately
- resting orders are cancelled (`gapOrderPolicy: cancel_all`)
- an order arriving into an invalid book is **rejected**
- the mid series records an explicit unknown, so a markout cannot read across
- trading resumes only when a fresh exchange snapshot arrives
- the interval is recorded in the run's output

Also available: `abort` and `skip_event`.

---

## Fill models

Kalshi publishes market-by-**price** data. We see the total size at each price,
never the individual orders or their queue order. So when a resting order fills
is genuinely unknown, and any single answer is a modelling choice.

| model | queue ahead at entry | credit for a level shrinking |
|---|---|---|
| `touch` | 0 | full |
| `conservative_queue` | the whole displayed level | **none** |
| `queue_decay` | parameter | parameter, plus optional time decay |

`conservative_queue` gives no credit for cancellations on purpose. A level
falling from 400 to 250 says somebody withdrew 150 contracts; it does not say
whether they were ahead of us. Crediting cancellations automatically is the
single most common way a prediction-market backtest manufactures fills that
would never have happened, because a maker's quotes sit at exactly the levels
other makers are constantly repricing.

A trade removes size from a level, so the delta that follows it is not evidence
of a cancellation. The models reconcile the two, or the queue drains at roughly
double the true rate.

Run every study under at least two. **The gap between `touch` and
`conservative_queue` is itself the interesting number** — it measures how much of
a strategy's apparent edge depends purely on queue position.

> Absolute simulated PnL is **not** ground truth until the queue model has been
> calibrated against real Kalshi fills and observed queue positions. Until then
> the trustworthy outputs are relative comparisons and post-fill markouts.

---

## Markouts

For every fill, the mid at +50 ms, 100 ms, 250 ms, 500 ms, 1 s, 5 s, 30 s,
sign-normalized so **positive is always favourable**:

```
bought YES at p, mid later m  ->  m - p
sold   YES at p, mid later m  ->  p - m
```

Computed entirely after the run, from a recorded mid series, so the future is
structurally unreachable from strategy state.

These are the most trustworthy numbers the platform produces at Phase 1,
because they depend only on the fill time and price the simulator chose and on
the recorded mid afterwards — not on the queue model, the fee schedule or the
settlement outcome. Two fill models disagree about how many fills happened;
they do not disagree about what the market did after one.

A horizon that runs past the end of coverage is reported as **unobserved**, never
as zero. A missing 30-second markout counted as zero reads as "no adverse
selection" — the most flattering possible error. The series also distinguishes
*being watched* from *the mid changing*, so a calm market keeps its 30-second
horizon instead of being silently dropped.

---

## Accounting

One signed position in YES contracts per market. Kalshi's two instruments are
exact complements — buying one NO at `q` is identical to selling one YES at
`1 - q` — so a single signed quantity describes the whole book.

Equity assumptions do not transfer:

- a contract settles at exactly $0 or $1; terminal value is discrete
- a short is fully collateralised at $1 per contract, so it **consumes** capital
- `cash` is a mark-to-settlement balance, not a Kalshi account balance;
  `collateralRequired` is what capital is actually tied up

Settlement is explicit and terminal, never "mark at the last mid".

**Phase 1 does not settle**, because the silver lake carries no lifecycle
events. Open positions are marked at the last mid and the summary says so
loudly. A large residual inventory means the net PnL is substantially a mark.

Fees follow Kalshi's quadratic form, `ceil_to_cents(rate × C × P × (1−P))`,
which peaks at 50c and vanishes in the tails. A flat basis-point model gets the
sign of that effect wrong and would send a study looking for edge in the wrong
strikes. **The rate and the maker fee are defaults, not measurements** — both are
recorded in every manifest and must be checked against the current per-series
schedule before any absolute PnL is quoted.

---

## Reproducibility

Every run writes `research/backtests/<run_id>/`:

```
manifest.json  summary.json
orders.parquet  fills.parquet  positions.parquet  pnl.parquet  markouts.parquet
```

Parquet is written with **explicit** column types — `BIGINT` for ordering keys,
`DECIMAL(24,6)` for money and size — for the same reason the silver lake does.
Inferred types silently make an ordering key a VARCHAR and a price a DOUBLE, and
neither failure announces itself.

`runKey` is a SHA-256 over exactly the reproducibility inputs: dataset
fingerprint, code SHA, strategy and its parameters, fill model, latency model,
fee model, gap policy, seed, engine version. The dataset fingerprint covers the
object paths, row counts and row-group counts actually scanned — "same dataset
id" is not enough, because a day can be re-exported.

Two runs with the same `runKey` produce byte-identical orders, fills, positions,
PnL and markouts. Asserted in `tests/research/determinism.test.ts`. Only the
`performance` block (wall clock, RSS) is excluded — it is supposed to vary.

Empty tables still produce a file. A missing `fills.parquet` is ambiguous — did
the strategy never trade, or did the run fail? — and ambiguity in a results
directory is how a broken run gets read as a negative finding.

---

## The benchmark strategies

Deliberately simple. They share all order management (`QuotingStrategy`) and
differ only in what prices they want to show, so a difference in the comparison
table cannot come from a difference in plumbing.

- **`join-bbo`** — bid at the best bid, offer at the best ask. The baseline.
  Expect it to be adversely selected; that is the finding, not a bug.
- **`imbalance-maker`** — quote the side top-k imbalance favours. The *direction*
  is a parameter (`quote_favoured` / `quote_against` / `skew`), because the
  opposite reading is equally defensible and the data should decide.
- **`inventory-skew-maker`** — join, then lean against inventory with a linear,
  deterministic skew. The control that makes a stochastic-control model worth
  measuring against later.

An offer is submitted as a **NO buy at `1 - price`**, which is what a Kalshi
offer physically is, so the simulated order is identical to the live one.

---

## Performance

One day of the current ~24-market universe should be practical interactively.
Measured on the 2026-09-13 slice (79 minutes, 12 markets, 54k deltas):

```
~2,000-3,000 events/s   ~175 MB peak RSS
```

Every run reports `events/s`, wall clock, peak RSS and mid-series size in its
summary. Checkpoint verification costs one ladder hash per checkpoint and can
be disabled with `--no-verify` once a day has been verified.

---

## Explicit non-goals for Phase 1

No dashboard, no distributed compute, no parameter optimizer, no ML framework,
no ClickHouse, no Kafka, no Ray, no Spark, no Iceberg, no calibrated queue
model, no Avellaneda-Stoikov, no weather model, no automatic deployment.

Establish that simple strategies produce sensible relative results first.
