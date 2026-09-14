import { z } from 'zod';

/**
 * Environment parsing.
 *
 * Every duration in the system is configurable here; nothing is hardcoded in
 * the hot path. Credentials are parsed but never logged -- `redactedEnv()` is
 * the only representation that may be emitted.
 */

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : v.toLowerCase() === 'true' || v === '1'));

const int = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().int().finite());

const EnvSchema = z.object({
  KALSHI_ENV: z.enum(['production', 'demo']).default('production'),
  KALSHI_API_KEY_ID: z.string().optional().default(''),
  KALSHI_PRIVATE_KEY_PEM: z.string().optional().default(''),

  DATABASE_URL: z.string().optional().default(''),
  BLOB_READ_WRITE_TOKEN: z.string().optional().default(''),

  COLLECTOR_ENABLED: bool(true),
  COLLECTOR_MODE: z.enum(['vercel_rolling', 'daemon']).default('daemon'),

  COLLECTOR_SOFT_RUNTIME_SECONDS: int(1440),
  COLLECTOR_HARD_RUNTIME_SECONDS: int(1680),
  /**
   * Permit a second collector to start while another is heartbeating.
   *
   * Off by default. Two collectors double-subscribe the same markets and
   * produce two sequence epochs for them, which look individually valid and
   * cannot afterwards be reconciled.
   */
  ALLOW_MULTIPLE_COLLECTORS: bool(false),

  COLLECTOR_HEARTBEAT_INTERVAL_MS: int(5000),
  COLLECTOR_HEARTBEAT_STALE_MS: int(20000),

  MARKET_DISCOVERY_INTERVAL_MS: int(60_000),
  METADATA_REFRESH_INTERVAL_MS: int(300_000),

  REST_BOOK_VALIDATION_INTERVAL_MS: int(60_000),

  RAW_DB_RETENTION_HOURS: int(48),
  /**
   * Master switch for DESTRUCTIVE partition removal.
   *
   * Defaults to false and must stay false until archival exists and has
   * verified a partition's row count and SHA-256. Until then there is nowhere
   * for dropped raw data to go, so retention would simply destroy it.
   */
  RAW_DB_RETENTION_ENABLED: bool(false),
  RAW_ARCHIVE_ENABLED: bool(true),

  /**
   * Destructive expiry of NORMALIZED rows (deltas, trades, ticker, snapshots)
   * from Postgres after their silver Parquet is verified.
   *
   * Also false by default. Once on, Neon holds only enough recent normalized
   * data for debugging and live operation; the multi-week research dataset
   * lives in R2, typed and directly queryable, and is rebuildable from bronze.
   */
  NORMALIZED_RETENTION_ENABLED: bool(false),
  /** Days of normalized data to keep hot in Postgres. */
  NORMALIZED_RETENTION_DAYS: int(3),
  RAW_PARTITION_AHEAD_DAYS: int(7),
  RAW_PARTITION_MAINTENANCE_INTERVAL_MS: int(3_600_000),
  /** How often the archive worker seals, uploads and verifies partitions. */
  ARCHIVE_INTERVAL_MS: int(3_600_000),

  DB_BATCH_MAX_ROWS: int(500),
  DB_BATCH_MAX_WAIT_MS: int(250),
  DB_BUFFER_MAX_ROWS: int(200_000),

  /** Health endpoint port for the daemon. 0 disables it. */
  HEALTH_PORT: int(8080),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: bool(false),

  INTERNAL_API_TOKEN: z.string().optional().default(''),
  CRON_SECRET: z.string().optional().default(''),

  COLLECTOR_CONFIG_PATH: z.string().optional().default('config/collector.json'),

  /**
   * Identity stamped on every collector session, archive manifest, integrity
   * report, export and materialized dataset, so every artifact is visibly
   * associated with the same production dataset.
   */
  DATASET_ID: z.string().optional().default('kalshi-dev'),
  DEPLOYMENT_ENV: z.enum(['production', 'staging', 'development']).default('development'),

  /** Where immutable archives go. r2 and s3 share the S3-compatible client. */
  ARCHIVE_STORAGE: z.enum(['r2', 's3', 'vercel_blob', 'local']).default('local'),

  /** S3-compatible archive credentials (Cloudflare R2 or AWS S3). */
  ARCHIVE_BUCKET: z.string().optional().default(''),
  ARCHIVE_ENDPOINT: z.string().optional().default(''),
  ARCHIVE_ACCESS_KEY_ID: z.string().optional().default(''),
  ARCHIVE_SECRET_ACCESS_KEY: z.string().optional().default(''),
  ARCHIVE_REGION: z.string().optional().default('auto'),

  /**
   * Direct (non-pooled) Postgres URL.
   *
   * Neon's pooler uses transaction pooling, which is right for serverless and
   * the dashboard but wrong for migrations, session-level maintenance and
   * DETACH PARTITION CONCURRENTLY. Admin paths use this; the app uses the
   * pooled DATABASE_URL.
   */
  DIRECT_DATABASE_URL: z.string().optional().default(''),

  /**
   * The commit this build was made from, baked in at image build time.
   *
   * The container has no .git directory -- it is excluded from the build
   * context -- so the working-tree fallback below returns null inside Docker.
   * That silently dropped code provenance on exactly the sessions that matter
   * most: the production ones. Passed as a build argument by `npm run
   * deploy:fly`.
   */
  GIT_COMMIT_SHA: z.string().optional().default(''),

  // Supplied automatically by Vercel; used for session attribution only.
  VERCEL_DEPLOYMENT_ID: z.string().optional().default(''),
  VERCEL_GIT_COMMIT_SHA: z.string().optional().default(''),
  VERCEL_REGION: z.string().optional().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const env = parsed.data;

  if (env.COLLECTOR_SOFT_RUNTIME_SECONDS >= env.COLLECTOR_HARD_RUNTIME_SECONDS) {
    throw new Error(
      'COLLECTOR_SOFT_RUNTIME_SECONDS must be strictly less than ' +
        'COLLECTOR_HARD_RUNTIME_SECONDS: the soft limit requests a handoff, the ' +
        'hard limit forces shutdown.',
    );
  }

  return env;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test seam: force re-read of process.env. */
export function resetEnvCache(): void {
  cached = null;
}

/** The ONLY shape of the environment that may be logged. */
export function redactedEnv(e: Env = env()) {
  return {
    datasetId: e.DATASET_ID,
    deploymentEnv: e.DEPLOYMENT_ENV,
    archiveStorage: e.ARCHIVE_STORAGE,
    kalshiEnv: e.KALSHI_ENV,
    kalshiApiKeyId: e.KALSHI_API_KEY_ID ? `${e.KALSHI_API_KEY_ID.slice(0, 4)}…` : '(unset)',
    kalshiPrivateKey: e.KALSHI_PRIVATE_KEY_PEM ? '(set)' : '(unset)',
    gitCommitSha: gitCommitSha(e) ?? '(unknown)',
    databaseUrl: e.DATABASE_URL ? redactDatabaseUrl(e.DATABASE_URL) : '(unset)',
    directDatabaseUrl: e.DIRECT_DATABASE_URL ? redactDatabaseUrl(e.DIRECT_DATABASE_URL) : '(unset)',
    blobToken: e.BLOB_READ_WRITE_TOKEN ? '(set)' : '(unset)',
    collectorMode: e.COLLECTOR_MODE,
    collectorEnabled: e.COLLECTOR_ENABLED,
    logLevel: e.LOG_LEVEL,
  };
}

/** Strips credentials from a Postgres URL, keeping host/db for diagnostics. */
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.password = '';
    u.username = u.username ? '***' : '';
    return u.toString().replace(':@', '@');
  } catch {
    return '(unparseable)';
  }
}

export const KALSHI_ENDPOINTS = {
  production: {
    rest: 'https://api.elections.kalshi.com',
    ws: 'wss://api.elections.kalshi.com/trade-api/ws/v2',
  },
  demo: {
    rest: 'https://demo-api.kalshi.co',
    ws: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
  },
} as const;

export function kalshiEndpoints(e: Env = env()) {
  return KALSHI_ENDPOINTS[e.KALSHI_ENV];
}

/**
 * The commit this process is running.
 *
 * Resolution order, most to least authoritative:
 *
 *   GIT_COMMIT_SHA         baked into the container image at build time
 *   VERCEL_GIT_COMMIT_SHA  supplied by Vercel
 *   git rev-parse HEAD     the working tree, for local runs
 *
 * Recorded on every collector session so a window of the dataset can be tied
 * to the exact code that produced it -- which matters when a parsing or
 * reconstruction change lands mid-collection.
 *
 * A dirty working tree is marked, because "the deployed SHA" is then a claim
 * that is not quite true.
 */
export function gitCommitSha(e: Env = env()): string | null {
  if (e.GIT_COMMIT_SHA) return e.GIT_COMMIT_SHA;
  if (e.VERCEL_GIT_COMMIT_SHA) return e.VERCEL_GIT_COMMIT_SHA;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const run = (args: string[]) =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    const sha = run(['rev-parse', 'HEAD']);
    const dirty = run(['status', '--porcelain']).length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

/**
 * Connection string for administrative work: migrations, partition
 * maintenance, DETACH PARTITION CONCURRENTLY and archive maintenance.
 *
 * Neon's pooler is a transaction pooler, so session-level behaviour and some
 * DDL do not survive it. Falls back to DATABASE_URL when no direct URL is
 * configured, which is correct for a plain single-endpoint Postgres.
 */
export function adminDatabaseUrl(e: Env = env()): string {
  return e.DIRECT_DATABASE_URL || e.DATABASE_URL;
}
