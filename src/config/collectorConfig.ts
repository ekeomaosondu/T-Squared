import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Typed collector configuration.
 *
 * Adding or removing series must never require a code change -- selectors are
 * data. Ticker PREFIXES are permitted here purely as a discovery filter; once
 * a market is discovered, the official series_ticker / event_ticker returned
 * by the API are what get persisted and used for grouping.
 */

export const MarketStatusSchema = z.enum([
  'initialized',
  'active',
  'inactive',
  'closed',
  'determined',
  'finalized',
]);
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

export const MarketSelectorSchema = z
  .object({
    id: z.string().min(1),

    seriesPrefixes: z.array(z.string().min(1)).optional(),
    seriesAllowlist: z.array(z.string().min(1)).optional(),
    seriesDenylist: z.array(z.string().min(1)).optional(),

    /**
     * Kalshi series categories, passed to the API as a server-side filter.
     *
     * Strongly recommended alongside seriesPrefixes: "KXHIGH"/"KXLOW" also
     * match KXHIGHINFLATION, KXLOWESTRATE, KXHIGHMOVDJT and others that are
     * not temperature markets at all. Constraining the category keeps prefix
     * discovery honest AND shrinks the series listing from ~17 MB to ~300 KB.
     */
    categories: z.array(z.string().min(1)).optional(),

    marketAllowlist: z.array(z.string().min(1)).optional(),
    marketDenylist: z.array(z.string().min(1)).optional(),

    statuses: z.array(MarketStatusSchema).optional(),

    /** Begin capturing this long before open_time, when discoverable. */
    subscribeBeforeOpenSeconds: z.number().int().nonnegative().optional(),
    /** Keep capturing this long after close_time, to catch settlement flow. */
    retainAfterCloseSeconds: z.number().int().nonnegative().optional(),
  })
  .refine(
    (s) =>
      (s.seriesPrefixes?.length ?? 0) > 0 ||
      (s.seriesAllowlist?.length ?? 0) > 0 ||
      (s.marketAllowlist?.length ?? 0) > 0,
    {
      message:
        'A selector must constrain the universe with at least one of ' +
        'seriesPrefixes, seriesAllowlist or marketAllowlist.',
    },
  );

export type MarketSelector = z.infer<typeof MarketSelectorSchema>;

const intervalList = z.array(z.number().int().positive()).default([]);

/**
 * Broad scope the recorder OBSERVES but does not capture.
 *
 * Discovery and capture are deliberately separate concepts. The KXHIGH and
 * KXLOW prefixes are not synonymous with "daily high/low temperature" -- on the
 * live exchange they match 112 series including KXHIGHINFLATION and
 * KXLOWESTRATE, and even filtered to Climate and Weather they still match 104.
 *
 * Recording 104 series for three weeks yields a much larger database, more
 * subscription complexity, more opportunities for gaps, and a great many
 * contracts nobody analyses. Four to twenty series, complete and
 * well-monitored, is the better dataset.
 *
 * So this block exists only to keep visibility into what is available: series
 * metadata is persisted so the operator can see candidates and expand
 * captureScope deliberately. Nothing here is ever subscribed to.
 */
export const DiscoveryScopeSchema = z.object({
  seriesPrefixes: z.array(z.string().min(1)).optional(),
  categories: z.array(z.string().min(1)).optional(),
  seriesDenylist: z.array(z.string().min(1)).optional(),
  /** Persist series metadata for everything in scope. Cheap: one cached call. */
  persistMetadata: z.boolean().default(true),
});
export type DiscoveryScope = z.infer<typeof DiscoveryScopeSchema>;

export const CollectorConfigSchema = z.object({
  /** Observed for metadata only; never subscribed. */
  discoveryScope: DiscoveryScopeSchema.optional(),

  /** The capture universe. Markets here are subscribed and recorded. */
  selectors: z.array(MarketSelectorSchema).min(1),

  /**
   * Refuse to start if the capture universe resolves to more series than this.
   * A guard against a config edit silently turning a focused recorder into an
   * exchange-wide one. Raise it deliberately.
   */
  maxCaptureSeries: z.number().int().positive().default(25),

  capture: z
    .object({
      orderbookDeltas: z.boolean().default(true),
      trades: z.boolean().default(true),
      tickerUpdates: z.boolean().default(true),
      lifecycleEvents: z.boolean().default(true),
      // Private channels stay off unless explicitly enabled; the market-data
      // recorder never depends on them.
      privateOrders: z.boolean().default(false),
      privateFills: z.boolean().default(false),
    })
    .prefault({}),

  sampling: z
    .object({
      bboIntervalsMs: intervalList,
      fullBookIntervalsMs: intervalList,
      eventLadderIntervalsMs: intervalList,
    })
    .prefault({}),

  validation: z
    .object({
      restOrderbookIntervalMs: z.number().int().positive().default(60_000),
      maxMarketsPerValidationBatch: z.number().int().positive().default(100),
      /**
       * How far either side of the REST request window a local book state may
       * lie and still count as agreement. Absorbs clock skew and REST-side
       * staleness; without it, any actively traded market looks like a
       * mismatch.
       */
      matchToleranceMs: z.number().int().nonnegative().default(2_000),
    })
    .prefault({}),

  retention: z
    .object({
      rawPostgresHours: z.number().int().positive().default(48),
      normalizedDays: z.number().int().positive().nullable().default(null),
    })
    .prefault({}),
});

export type CollectorConfig = z.infer<typeof CollectorConfigSchema>;

export const DEFAULT_COLLECTOR_CONFIG: CollectorConfig = CollectorConfigSchema.parse({
  // Broad visibility, narrow capture.
  discoveryScope: {
    seriesPrefixes: ['KXHIGH', 'KXLOW'],
    categories: ['Climate and Weather'],
    persistMetadata: true,
  },
  selectors: [
    {
      id: 'daily-temperature',
      // Explicit by default. Expanding the universe is a config change, not a
      // side effect of a prefix matching more than intended.
      seriesAllowlist: ['KXHIGHNY', 'KXLOWNY', 'KXHIGHLAX', 'KXLOWLAX'],
      statuses: ['initialized', 'active', 'inactive', 'closed', 'determined'],
      subscribeBeforeOpenSeconds: 21_600,
      retainAfterCloseSeconds: 7_200,
    },
  ],
  capture: {},
  sampling: {
    bboIntervalsMs: [1000, 5000, 60_000],
    fullBookIntervalsMs: [5000, 60_000],
    eventLadderIntervalsMs: [1000, 5000, 60_000],
  },
  validation: {},
  retention: {},
});

export function parseCollectorConfig(input: unknown): CollectorConfig {
  const result = CollectorConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid collector config: ${issues}`);
  }
  return result.data;
}

/**
 * Loads config from disk, falling back to the built-in default if the file is
 * absent. A malformed file is a hard error -- silently recording the wrong
 * universe for weeks is worse than failing to start.
 */
export async function loadCollectorConfig(filePath: string): Promise<CollectorConfig> {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_COLLECTOR_CONFIG;
    throw err;
  }

  return parseCollectorConfig(stripJsonComments(JSON.parse(text)));
}

/** Drops `$comment` keys so example files can stay self-documenting. */
function stripJsonComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripJsonComments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('$'))
        .map(([k, v]) => [k, stripJsonComments(v)]),
    );
  }
  return value;
}

/**
 * Stable hash of the effective config, recorded on every collector session.
 * Lets replay code detect that capture parameters changed mid-dataset.
 */
export function configHash(config: CollectorConfig): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** All distinct sampling intervals the collector must schedule. */
export function allSamplingIntervals(config: CollectorConfig): number[] {
  return [
    ...new Set([
      ...config.sampling.bboIntervalsMs,
      ...config.sampling.fullBookIntervalsMs,
      ...config.sampling.eventLadderIntervalsMs,
    ]),
  ].sort((a, b) => a - b);
}
