# ---------------------------------------------------------------------------
# Kalshi market-data recorder -- collector daemon
#
# The collector core has no Next.js or Vercel dependency, so this image runs
# the same code the laptop has been running, unchanged. Only the host differs.
#
# Runs as a long-lived process: a WebSocket recorder is exactly the workload
# serverless is wrong for.
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps

WORKDIR /app

# Native modules (@duckdb/node-api, used by the silver exporter) need a
# toolchain at install time but not at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false


FROM node:22-slim AS runtime

WORKDIR /app

# tini reaps zombies and forwards SIGTERM, which matters here: the collector
# flushes its write buffer on SIGTERM, and a swallowed signal loses events.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    COLLECTOR_MODE=daemon \
    HEALTH_PORT=8080 \
    LOG_PRETTY=false

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY config ./config

# Unprivileged: the recorder never needs root.
RUN useradd --system --uid 10001 --home-dir /app collector \
    && mkdir -p /app/.spool /app/.archive \
    && chown -R collector:collector /app
USER collector

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]

# `node --import tsx`, NOT `npx tsx`.
#
# npx spawns tsx as a CHILD process and does not forward SIGTERM to it, so a
# container stop killed npx while the collector never ran its shutdown handler
# -- losing whatever was still in the write buffer on every deploy. Running the
# loader in-process means the signal reaches our handler directly.
CMD ["node", "--import", "tsx", "scripts/collector.ts"]
