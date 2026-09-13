# CI

`ci.yml` runs typecheck, lint, the full test suite and the Next.js build against
a real PostgreSQL 17 service.

## Why a database in CI

Three of the defects found in this project were invisible to unit tests and to
the running application, and were caught only by **replay equality** — the
property that a book reconstructed from the recorded delta stream matches,
byte for byte, the snapshot the recorder wrote independently:

| Defect | Symptom without replay equality |
|---|---|
| Raw log reordered by async DB work in the frame handler | none; ingestion looked healthy |
| Deltas ordered by `seq::text`, i.e. 100, 101, 1111, 13, 130 | none; rows all present |
| Streams interleaved by random UUID after a reconnect | none; only wrong after a reconnect |

`tests/replayEquality.test.ts` therefore drives the real `Collector`,
`BatchWriter` and database with a synthetic feed covering a long random walk, a
sequence gap with recovery, and a reconnect where `seq` restarts.

**Treat it as mandatory for any change touching ingestion, persistence,
sequence handling, or SQL ordering.** `tests/sqlConventions.test.ts` backs it up
by scanning the source for unqualified ordering keys and self-shadowing cast
aliases.
