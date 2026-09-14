# Kalshi HFT research platform

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

## Execution modes

```
BACKTEST     recorded data, simulated execution
SHADOW       LIVE data, no real orders, hypothetical execution recorded
CALIBRATION  live data, REAL orders at tiny fixed size, placed to learn
             execution mechanics rather than to make money
LIVE         real strategy, real risk, a PnL objective
```

There is deliberately no "paper" mode. Paper implies simulated execution, and
CALIBRATION is the opposite: it places real orders precisely because simulated
execution is the quantity being estimated.

**Shadow cannot calibrate queue position.** If an order is never on the
exchange, the exchange cannot say where in the FIFO it would have been. Shadow
validates timing, signal behaviour and how sensitive hypothetical fills are to
the queue assumption; the assumption itself needs real resting orders.

```bash
npm run shadow -- --strategy join-bbo --series KXHIGHNY --minutes 30 --latency-ms 100
```

Writes `research/shadow/<run_id>/` with a manifest, every hypothetical order
(decision book, arrival book, displayed size at its level, both timestamps) and
one fills file per queue assumption. The live source opens a **read-only**
subscription: no session row, no raw frames, nothing to the recorded dataset.

---

## Counterfactual queue assumptions

Live data does not come twice, so several fill models have to run in one pass:

```bash
npm run research -- backtest --strategy join-bbo --from 2026-09-13 --to 2026-09-14 \
  --fill-model conservative_queue --counterfactual-fills touch,queue_decay
```

Each counterfactual gets its own exchange and portfolio, sees the same events
and the same intents, and **never calls the strategy back** — a strategy whose
inventory follows several execution realities at once does not have an
inventory. Orders are therefore identical by construction and any difference is
the queue model alone.

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

**Two columns, and the difference matters.** `markout` is measured from the
fill price, so it includes the half-spread a maker earns by construction — the
mid is above the bid, so buying at the bid has a positive markout before the
market does anything at all. `drift` is the same measurement from the *mid at
the fill*, with that half-spread removed, and it is the one that answers "were
we picked off". Adverse selection is a statement about `drift`; `markout` minus
`spread captured` should equal it.

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

## Settlement

A binary contract does not end at the last mid. It ends at exactly $0 or $1,
decided by an authority outside the order book.

```
OPEN                  still trading
CLOSED_UNDETERMINED   trading over, the exchange has not ruled
DETERMINED_YES        pays the notional
DETERMINED_NO         pays nothing
VOIDED                cancelled; the position returns at cost
```

`VOIDED` is a fifth state beyond the four the specification named. Kalshi
cancels markets, and folding that into either determination books a payout that
never happened.

Market definitions, determinations and fee treatment export as **dated
snapshots** (`npm run silver -- --market-state`), not partitioned by trading
day. A daily temperature market closes in the small hours and is determined
from the following morning's climate report, so the fact that settles Monday's
book does not exist until Tuesday; research reads the most recent snapshot.

**Nothing is inferred from weather data.** The exchange's own record is the only
authority — preliminary observations and the final climate report disagree
often enough that settling from the former would measure a different market.

Every run reports PnL decomposed, because the parts answer different questions:

```
trading (round trip)   was the market making any good?
settlement             did the inventory we were left holding happen to be right?
open, marked at mid    a mark, not a result
gross / fees / total economic
```

A maker that loses on spread and is rescued by a lucky determination has not
found an edge, and one net figure cannot say so.

The four ways a position can fail to settle are kept apart, because they are
not the same problem:

| resolution | meaning | fixable by |
|---|---|---|
| `OPEN_AT_RUN_END` | the window we chose ended while it was trading | extending the run |
| `AWAITING_DETERMINATION` | trading is over, the exchange has not ruled | waiting, then re-snapshotting |
| `noMarketState` | no record in the lake | `npm run silver -- --market-state` |
| `UNPRICEABLE` | no determination and no mark | nothing |

A determination is read only by post-run accounting, from a map no strategy
holds a reference to. Settlement runs after `onStop`.

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

A position with no mark — a one-sided book has no mid, and across two dozen
strikes at least one is one-sided most of the time — is **excluded** from the
PnL and counted separately as `unmarkedPositions`. Letting a single unpriceable
position null the total made the headline figure unavailable in almost every
run; pricing it at a guess would be worse.

**Phase 1 does not settle**, because the silver lake carries no lifecycle
events. Open positions are marked at the last mid and the summary says so
loudly. A large residual inventory means the net PnL is substantially a mark.

## Fees

Kalshi's fee is quadratic in price, `ceil_to_cents(rate × multiplier × C × P ×
(1−P))`, peaking at 50c and vanishing in the tails. A flat basis-point model
gets the sign of that effect wrong and would send a study looking for edge in
the wrong strikes.

The API supplies **`fee_type` and `fee_multiplier` per series**, and the
recorder captures both with the timestamp of the metadata that carried them.
Those are facts. It does **not** supply the coefficient, and Kalshi's own
documentation says some markets charge maker fees and some do not.

So the coefficient and the maker fee live in `config/feeSchedule.json`, where a
human asserts them with a source, a date and a `verified` flag:

```jsonc
{ "feeType": "quadratic", "baseRate": "0.07", "makerFeePerContract": "0",
  "source": "https://kalshi.com/docs/kalshi-fee-schedule.pdf",
  "verified": false, "verifiedBy": null, "verifiedAt": null }
```

**While `verified` is false — as it is today — a fee is UNKNOWN, not zero.** The
unknown propagates: `feeVerified: false` and net PnL withheld as N/A. An
unverified assumption quietly applied produces a number that looks like a result
and someone will quote it. A canary test asserts the shipped schedule is still
unverified, so flipping it is a deliberate act.

Entries are selected by the time of the fill, so a schedule change is a new
entry rather than an edit and re-running an old backtest keeps charging the old
rate.

**Market-maker programme rebates are separate and default to absent.** A rebate
is a property of the participant, not of the market; reporting ordinary-member
and market-maker economics as one figure overstates the second.

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
Measured on the 2026-09-13 slice (79 minutes, 24 markets, 94.5k deltas, 2.2k
trades, a quoting strategy at 100 ms latency):

```
~7,500 events/s   ~300 MB peak RSS   ~13 s wall
```

which projects a full day of the current universe to roughly three minutes.
Three things got it there and each is load-bearing at scale rather than on the
test slice:

- resting orders and pending cancels are indexed, instead of scanning every
  order ever submitted on each event and each trade
- the BBO is taken by scanning the ladder rather than sorting it, with an
  equivalence proof against `MarketBook.getYesBBO` in `bookView.test.ts`
- the mark grid prices only the markets the portfolio holds

Every run reports `events/s`, wall clock, peak RSS and mid-series size in its
summary. Checkpoint verification costs one ladder hash per checkpoint and can
be disabled with `--no-verify` once a day has been verified.

---

## Calibration

Real one-contract post-only probes, placed to learn how the queue behaves
rather than to make money.

```bash
npm run calibrate -- preflight                                  # verify, place nothing
npm run calibrate -- run --dry-run --minutes 10
npm run calibrate -- run --minutes 30 --i-understand-this-places-real-orders
npm run calibrate -- analyze
npm run silver -- --calibration                                 # export to the lake
```

**Why real orders.** Kalshi reports true queue position, but only for orders
actually resting on the exchange. No shadow run can obtain that number, so the
experiment buys it.

**Why it is not optimised for fills.** Side is a coin flip. Market selection
rotates across depth and flow strata. The price is fixed for the whole dwell
and never repriced. All three cost fill rate on purpose — a dataset gathered
only where we expected to fill teaches a model the conditions under which we
chose easy fills. Non-fills are retained as censored observations, and they are
most of the information.

The v0 envelope: 1 contract, 2 resting orders, 1 per market, 1 per series,
$5 worst-case exposure, 50 fills and 200 orders a day, mid within 0.15–0.85,
never within 30 minutes of close. Dwell is drawn from 10/30/60/120 s.

**Safety is layered.** Order creation is never retried — a create that times
out may be resting right now, so it throws and the caller reconciles by asking.
The probe row is written *before* the order is sent. The envelope is seeded
from the exchange at startup, not from process memory. Book invalid, private
feed down, persistence failing, an ambiguous order or any risk breach stops new
probes; a breach never crosses the spread to flatten.

### What `queue_position_fp` actually measures

The first run left 20 of 24 queue moves unexplained against a same-price
model. `npm run calibrate -- queue-audit` rebuilds the **full ladder** from the
collector's own recorded deltas over each probe's life — which is what a raw
archive is for; the better-price depth was never captured at poll time and did
not need to be — and classifies every reported move by what public event
explains it.

Over 44 probes and 4,202 transitions:

```
nonzero reported moves                31
  explained by public trades           1    3%
  explained by better levels           0    0%
  explained by same level              5   16%
  explained with lag adjustment       22   71%
  still unexplained                    3   10%

explained at ZERO lag                  6      <- the null model
median inferred queue lag            400 ms
p90 inferred queue lag               800 ms

corr(reported Q, better + same)    0.878
corr(reported Q, same level only)  0.940
```

**Unexplained fell from 83% to 10%, and the cause is timing, not better-priced
depth.** The endpoint is a lagged view: zero-lag explains 6 moves, best-lag
explains 28, and the inferred lags concentrate in 400–800 ms — matching the
independently measured 815 ms before a new order becomes visible at all. Two
measurements of different things agreeing is the reason to believe it.

Adding better-priced depth makes the correlation **worse** (0.878 vs 0.940).
The honest caveat: 28 of 31 moves happened while the probe was still at the
touch, where better depth is zero by construction, so this sample cannot
strongly test the better-price hypothesis — it can only say the hypothesis is
unnecessary to explain what was seen. The behind-the-BBO bucket is where 2 of
the 3 remaining unexplained moves live, and it has 3 observations.

So the same-level FIFO reading survives, and `conservative_queue`'s α = 0 is
supported: same-level cancellations happen constantly (0.5 contracts/step) and
almost never advance the queue.

### Execution results (53 probes)

Measured latency, which is what should eventually replace the 0/50/100/250 ms
sweep:

```
operation                    n    p50    p90    p99
submit                      53     40     82    641
cancel                      41     38    206    543
private ack after HTTP ack  53      2      7    365
queue visible after ack     52    815   1446   2184
```

That last row is the non-obvious one: the exchange does not report a new
order's queue position for about **0.8 seconds** after acknowledging it.

Fill models against the same real orders:

```
model                  n   TP   FP   FN   TN   fill-time err   queue bias
conservative_queue    53    6    0    5   42          122 ms        +1.3
queue_decay           53    6    0    5   42          122 ms        +1.3
touch                 53   11    3    0   39        8,898 ms       -46.2
```

`conservative_queue` produced **no false positives** and a 122 ms fill-time
error. `touch` caught every fill but invented three and was ten seconds out.
For a backtest the false positive is the expensive error: it inflates volume,
spread capture and PnL at once, silently.

One probe filled from **66.8 contracts back in the queue**, which no
conservative model would predict.

Fifty-three probes is a pilot, not a dataset. Every figure above is printed
with its sample size for that reason, and no α has been fitted: the progression
is queue definition, then timestamp semantics, then a constructed public-ahead
quantity, then the residual — and only then a model.

---

## What is not built yet

Blocked on more calibration data:

- resolving the unexplained queue moves, which must come before any fit
- fitting `α` in `Q(t+Δ) = Q(t) − V_executed − α·C(t)`, replacing the arbitrary
  `queue_decay` parameters
- `EmpiricalLatencyModel.fromCalibrationDataset(...)`, replacing the fixed
  latency sweep with the measured distributions
- re-running the benchmark matrix under the calibrated model

Not built and not blocked, just deliberately absent: an exchange-side order
group (the create endpoint 404s on this account, so the process-side limits are
the only guard), and probe repricing, which v0 omits so that queue mechanics
are not confounded with a quoting policy.

Still not built, deliberately: dashboard, distributed compute, parameter
optimizer, ML framework, ClickHouse, Kafka, Ray, Spark, Iceberg,
Avellaneda-Stoikov, weather model, automatic deployment.
