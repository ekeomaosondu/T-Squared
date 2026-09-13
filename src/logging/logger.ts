import pino from 'pino';
import { env } from '@/src/config/env';

/**
 * Structured logging only.
 *
 * Level policy (see README):
 *   DEBUG individual feed events
 *   INFO  connects / subscriptions / discovery / archive
 *   WARN  reconnects, recoverable validation mismatches
 *   ERROR DB failures, gap-recovery failures
 *
 * Individual deltas are never logged at INFO.
 */

const REDACT_PATHS = [
  'password',
  '*.password',
  'privateKey',
  '*.privateKey',
  'KALSHI_PRIVATE_KEY_PEM',
  '*.KALSHI_PRIVATE_KEY_PEM',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'BLOB_READ_WRITE_TOKEN',
  '*.BLOB_READ_WRITE_TOKEN',
  'INTERNAL_API_TOKEN',
  '*.INTERNAL_API_TOKEN',
  'CRON_SECRET',
  '*.CRON_SECRET',
  'headers["KALSHI-ACCESS-SIGNATURE"]',
  'headers["KALSHI-ACCESS-KEY"]',
  'headers.authorization',
];

function build(): pino.Logger {
  let level = 'info';
  let pretty = false;
  try {
    const e = env();
    level = e.LOG_LEVEL;
    pretty = e.LOG_PRETTY;
  } catch {
    // Logging must work even if the environment is invalid -- that failure
    // needs to be loggable.
  }

  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    // BigInt appears throughout (seq, epoch ms); pino's default serialiser
    // would throw on it.
    formatters: {
      log(obj) {
        return serializeBigInts(obj) as Record<string, unknown>;
      },
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  });
}

function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Error)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeBigInts(v)]),
    );
  }
  return value;
}

export const logger = build();

export type LogContext = {
  session_id?: string;
  stream_id?: string;
  market_ticker?: string;
  channel?: string;
  seq?: bigint | number;
  event?: string;
  [key: string]: unknown;
};

export function childLogger(ctx: LogContext): pino.Logger {
  return logger.child(serializeBigInts(ctx) as Record<string, unknown>);
}
