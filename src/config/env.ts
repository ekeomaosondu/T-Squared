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
  RAW_PARTITION_AHEAD_DAYS: int(7),
  RAW_PARTITION_MAINTENANCE_INTERVAL_MS: int(3_600_000),
  /** How often the archive worker seals, uploads and verifies partitions. */
  ARCHIVE_INTERVAL_MS: int(3_600_000),

  DB_BATCH_MAX_ROWS: int(500),
  DB_BATCH_MAX_WAIT_MS: int(250),
  DB_BUFFER_MAX_ROWS: int(200_000),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: bool(false),

  INTERNAL_API_TOKEN: z.string().optional().default(''),
  CRON_SECRET: z.string().optional().default(''),

  COLLECTOR_CONFIG_PATH: z.string().optional().default('config/collector.json'),

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
    kalshiEnv: e.KALSHI_ENV,
    kalshiApiKeyId: e.KALSHI_API_KEY_ID ? `${e.KALSHI_API_KEY_ID.slice(0, 4)}…` : '(unset)',
    kalshiPrivateKey: e.KALSHI_PRIVATE_KEY_PEM ? '(set)' : '(unset)',
    databaseUrl: e.DATABASE_URL ? redactDatabaseUrl(e.DATABASE_URL) : '(unset)',
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
