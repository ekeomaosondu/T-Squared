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
