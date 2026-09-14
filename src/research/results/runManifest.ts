import { createHash } from 'node:crypto';

/**
 * The reproducibility record of a run.
 *
 * A backtest result without one of these is an anecdote. Everything that can
 * change the answer is named here: the exact bytes read, the exact code, the
 * exact parameters, the exact assumptions about latency, fills and fees.
 *
 * `runKey` is a hash over precisely those inputs and NOTHING else -- not the
 * clock, not the run id, not the output path. Two runs with the same runKey
 * must produce identical orders, fills, positions and PnL, and the
 * determinism test asserts exactly that.
 */
export interface RunManifest {
  runId: string;
  /** Deterministic fingerprint of the reproducibility inputs. */
  runKey: string;

  datasetId: string;
  datasetFingerprint: string;
  /** Object paths actually scanned, so the slice can be reconstructed. */
  datasetObjects: { path: string; rows: number; rowGroups: number }[];

  strategyName: string;
  strategyVersion: string;
  strategyParameters: unknown;

  gitCommitSha: string | null;

  startTime: string;
  endTime: string;

  seriesTickers: string[];
  eventTickers?: string[];
  marketTickers?: string[];

  fillModel: string;
  fillModelParameters: Record<string, unknown>;
  latencyModel: Record<string, unknown>;
  feeModel: Record<string, unknown>;

  captureGapPolicy: string;
  gapOrderPolicy: string;
  markIntervalMs: number;

  randomSeed: number;

  startedAt: string;
  /** Filled in when the run finishes. */
  finishedAt?: string;
  engineVersion: string;
}

/** Bumped whenever a change to the engine can alter results. */
export const ENGINE_VERSION = '1.0.0';

export interface RunKeyInputs {
  datasetId: string;
  datasetFingerprint: string;
  strategyName: string;
  strategyVersion: string;
  strategyParameters: unknown;
  gitCommitSha: string | null;
  startTime: string;
  endTime: string;
  seriesTickers: string[];
  eventTickers?: string[];
  marketTickers?: string[];
  fillModel: string;
  fillModelParameters: Record<string, unknown>;
  latencyModel: Record<string, unknown>;
  feeModel: Record<string, unknown>;
  captureGapPolicy: string;
  gapOrderPolicy: string;
  markIntervalMs: number;
  randomSeed: number;
  engineVersion: string;
}

/** Stable JSON: object keys sorted, so key order cannot change the hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeRunKey(inputs: RunKeyInputs): string {
  return createHash('sha256').update(canonicalJson(inputs), 'utf8').digest('hex');
}

/**
 * A run id that sorts chronologically and still names its inputs.
 *
 * `<runKey12>-<compact UTC timestamp>`: two runs of the same experiment share
 * a visible prefix, so a directory listing groups reruns of one configuration
 * together while keeping them distinct on disk.
 */
export function makeRunId(runKey: string, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  return `${runKey.slice(0, 12)}-${stamp}`;
}
