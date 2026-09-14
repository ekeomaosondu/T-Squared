# Deploying the collector daemon

The collector core has no Next.js or Vercel dependency, so the container runs
the same code that has been running locally — only the host changes.

## Prerequisite: the database must be reachable from the host

While `DATABASE_URL` points at `localhost`, the daemon cannot move: a remote
container cannot reach Postgres on a laptop. Provision Neon first, then deploy.

## Fly.io

Fly suits this workload: a single always-on machine, no request-driven scaling,
and a WebSocket that must stay connected.

```bash
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy --copy-config --name kalshi-market-recorder

# Secrets. Never put these in fly.toml -- it is committed.
fly secrets set \
  KALSHI_API_KEY_ID="..." \
  KALSHI_PRIVATE_KEY_PEM="$(base64 < kalshi-key.pem)" \
  DATABASE_URL="postgres://...-pooler.../neondb?sslmode=require" \
  DIRECT_DATABASE_URL="postgres://.../neondb?sslmode=require" \
  ARCHIVE_BUCKET="kalshi" \
  ARCHIVE_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
  ARCHIVE_ACCESS_KEY_ID="..." \
  ARCHIVE_SECRET_ACCESS_KEY="..." \
  DATASET_ID="kalshi-prod-2026-09"

fly deploy
fly logs
curl https://kalshi-market-recorder.fly.dev/health
```

### Exactly one machine, always

```bash
fly scale count 1
fly status
```

Two collectors would double-subscribe the same markets and produce two sequence
epochs for them. `fly.toml` sets `auto_stop_machines = false` and
`min_machines_running = 1`: suspending the machine stops the WebSocket and loses
market data, which is the one thing this system exists to prevent.

## Any Docker host

```bash
docker build -t kalshi-recorder .
docker run -d --name kalshi-recorder --restart unless-stopped \
  -p 8080:8080 --env-file .env.production kalshi-recorder
```

## Health

| Endpoint | Meaning |
|---|---|
| `GET /live` | process liveness only; never touches the database, so a database outage does not cause the orchestrator to kill a collector that is correctly buffering |
| `GET /health` | full dataset health; **503** on `CRITICAL` |

Orchestrators should probe `/live`. Alerting should watch `/health`.

## Signals

The image runs `node --import tsx`, **not** `npx tsx`. `npx` spawns the script
as a child process and does not forward `SIGTERM`, so a container stop killed
`npx` while the collector never ran its shutdown handler — losing whatever was
still in the write buffer on every deploy. `tini` is PID 1 and forwards signals;
the collector flushes its buffer and closes the session with an explicit
`end_reason`.

Verify after any change to the entrypoint:

```bash
docker stop -t 30 <container>
# then confirm the session closed cleanly:
#   SELECT end_reason FROM collector_sessions ORDER BY started_at DESC LIMIT 1;
# NULL means the signal was swallowed and buffered events were lost.
```

## Deploy strategy

`fly.toml` uses `strategy = "immediate"`: the old machine stops before the new
one starts, so two collectors never hold subscriptions for the same markets at
once. A brief gap in collection is the correct trade — a gap is visible in
`sequence_gaps` and in session boundaries, whereas overlapping collectors
produce two epochs that look valid individually and cannot be reconciled.

## Deploying with the commit baked in

Always `npm run deploy:fly`, never a bare `fly deploy`.

`.dockerignore` excludes `.git`, so the working-tree fallback in
`gitCommitSha()` returns null inside the container and every session records
`git_commit_sha = NULL`. That loses the link between a window of the dataset
and the code that produced it, on exactly the sessions where it matters most.
`deploy:fly` passes the SHA as a build argument and marks a dirty tree; the
deploy gate asserts the recorded value so it cannot regress silently.

## Enabling retention

Retention is DESTRUCTIVE and both switches are off. Turn them on only after a
**full day** has passed the archive/restore gate — not a partial partition. A
full day is the first time the gate runs at production scale, with multiple
part files and a session spanning midnight.

```bash
# 1. Wait for the partition to close at 00:00 UTC. Do not manufacture it.
#    The daemon's archive worker seals and uploads within the hour; confirm:
curl -s https://kalshi-market-recorder.fly.dev/health | grep archive_currency

# 2. The gate. Reads the archived bytes back out of R2, verifies every
#    checksum, replays the frames through the REAL collector, and compares the
#    reconstructed books against the independently recorded snapshot hashes.
#    This, not the upload, is the acceptance criterion.
npm run restore -- --partition raw_ingest_events_YYYY_MM_DD

# 3. Only if that prints PASS:
fly secrets set RAW_DB_RETENTION_ENABLED=true NORMALIZED_RETENTION_ENABLED=true
npm run deploy:fly
```

Normalized retention is separately gated in code: it deletes a day only once
every silver export for that day is verified, and does nothing at all when no
exports are recorded. So enabling it before running `npm run silver` is inert
rather than dangerous.

## Rotating the R2 credentials

The archive credentials are long-lived and only rotate on purpose. Rotate them
when they may have been exposed — pasted into a chat, a ticket or a log — or
when the daemon moves host.

Only step 1 is manual; everything else verifies itself.

```bash
# 1. Cloudflare dashboard -> R2 -> Manage API tokens -> Create.
#    Scope: Object Read & Write on the archive bucket only.
#    Put the new values straight into .env.local. Nowhere else.

# 2. Prove they work: probe write/read/delete, plus a real archive read
#    checked against its recorded SHA-256. A write-only token passes a naive
#    check and then silently breaks every restore, so read scope is tested
#    against something the OLD token wrote.
npm run rotate:r2

# 3. Stage them on Fly and deploy.
npm run rotate:r2 -- --apply
npm run deploy:fly

# 4. Confirm the collector came back on the new credentials.
fly status
curl -s https://kalshi-market-recorder.fly.dev/health | head -40

# 5. Delete the OLD token in the Cloudflare dashboard.

# 6. Confirm nothing depended on it.
npm run rotate:r2
npm run restore -- --partition <most recent archived partition>
```

Step 6 matters more than it looks. The restore gate reads real archive bytes
back out of R2 and replays them, so it is the only check that proves the new
token can still reach everything the old one wrote.
