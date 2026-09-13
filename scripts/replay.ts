#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { writeFile } from 'node:fs/promises';
import { closeDb, db } from '@/src/persistence/db';
import { replay, verifyReplay } from '@/src/replay/replay';
import { logger } from '@/src/logging/logger';

/**
 * Replay CLI.
 *
 *   npm run replay -- --ticker KXHIGHNY-26SEP14-B74.5 --from <iso> --to <iso>
 *                     [--sample-ms 1000] [--format json|csv|ndjson]
 *                     [--out file] [--verify] [--strict]
 *
 * Reconstructs the book purely from recorded data. Kalshi is never contacted.
 */

interface Args {
  ticker?: string;
  from?: string;
  to?: string;
  sampleMs?: number;
  format: 'json' | 'csv' | 'ndjson';
  out?: string;
  verify: boolean;
  strict: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { format: 'json', verify: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--ticker': args.ticker = next(); break;
      case '--from': args.from = next(); break;
      case '--to': args.to = next(); break;
      case '--sample-ms': args.sampleMs = Number(next()); break;
      case '--format': args.format = next() as Args['format']; break;
      case '--out': args.out = next(); break;
      case '--verify': args.verify = true; break;
      case '--strict': args.strict = true; break;
      case '--help':
        console.log(HELP);
        process.exit(0);
    }
  }
  return args;
}

const HELP = `
Replay a recorded Kalshi order book.

  --ticker <market>     market ticker (required)
  --from <iso|epochMs>  window start (default: 1 hour ago)
  --to <iso|epochMs>    window end   (default: now)
  --sample-ms <n>       emit a reconstructed snapshot every n ms
  --format json|csv|ndjson
  --out <path>          write to a file instead of stdout
  --verify              also verify replay against recorded snapshots
  --strict              stop at the first integrity problem
`;

function toMs(value: string | undefined, fallback: number): bigint {
  if (!value) return BigInt(fallback);
  if (/^\d+$/.test(value)) return BigInt(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`unparseable timestamp: ${value}`);
  return BigInt(parsed);
}

const CSV_COLUMNS = [
  'at', 'atMs', 'sessionId', 'streamId', 'seq', 'yesBid', 'yesAsk', 'bidSize',
  'askSize', 'spread', 'mid', 'microprice', 'yesLevels', 'noLevels', 'valid', 'stateHash',
] as const;

function toCsv(frames: Record<string, unknown>[]): string {
  const head = CSV_COLUMNS.join(',');
  const rows = frames.map((f) =>
    CSV_COLUMNS.map((c) => {
      const v = f[c];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','),
  );
  return [head, ...rows].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ticker) {
    console.error('--ticker is required.\n' + HELP);
    process.exit(1);
  }

  const now = Date.now();
  const fromMs = toMs(args.from, now - 3_600_000);
  const toMsVal = toMs(args.to, now);

  const sql = db();

  const result = await replay(sql, {
    marketTicker: args.ticker,
    fromMs,
    toMs: toMsVal,
    sampleMs: args.sampleMs,
    strict: args.strict,
  });

  // Integrity context belongs with the data, not hidden behind a flag: the
  // caller must be able to tell whether this window came from an uninterrupted
  // stream or was stitched after a recovery.
  const summary = {
    marketTicker: result.marketTicker,
    from: new Date(Number(fromMs)).toISOString(),
    to: new Date(Number(toMsVal)).toISOString(),
    frames: result.frames.length,
    epochs: result.epochs.map((e) => ({
      sessionId: e.sessionId,
      startedAt: new Date(Number(e.startedAtMs)).toISOString(),
      seedSource: e.seedSource,
      deltasApplied: e.deltasApplied,
      deltasSkipped: e.deltasSkipped,
      recoverySnapshots: e.gaps,
    })),
    totalDeltas: result.totalDeltas,
    appliedDeltas: result.appliedDeltas,
    skippedDeltas: result.skippedDeltas,
    sequenceGapsInWindow: result.gapsInWindow.length,
    // Intervals when nobody was listening at all.
    captureGaps: result.captureGaps.map((g) => ({
      from: g.started_at.toISOString(),
      to: g.ended_at?.toISOString() ?? null,
      reason: g.reason,
      durationMs: g.duration_ms_text === null ? null : Number(g.duration_ms_text),
    })),
    uninterrupted:
      result.gapsInWindow.length === 0 &&
      result.captureGaps.length === 0 &&
      result.epochs.length === 1,
    warnings: result.warnings,
    finalStateHash: result.finalBook?.getStateHash() ?? null,
  };

  let output: string;
  if (args.format === 'csv') output = toCsv(result.frames as unknown as Record<string, unknown>[]);
  else if (args.format === 'ndjson') output = result.frames.map((f) => JSON.stringify(f)).join('\n');
  else output = JSON.stringify({ summary, frames: result.frames }, null, 2);

  if (args.out) {
    await writeFile(args.out, output, 'utf8');
    console.error(JSON.stringify(summary, null, 2));
    console.error(`\nwrote ${result.frames.length} frames to ${args.out}`);
  } else {
    if (args.format !== 'json') console.error(JSON.stringify(summary, null, 2));
    console.log(output);
  }

  if (args.verify) {
    const v = await verifyReplay(sql, args.ticker, fromMs, toMsVal);
    console.error(
      `\nverification: ${v.matched}/${v.checked} recorded snapshots reproduced exactly` +
        (v.mismatches.length ? `\nmismatches: ${JSON.stringify(v.mismatches.slice(0, 5), null, 2)}` : ''),
    );
    if (v.checked > 0 && v.matched !== v.checked) process.exitCode = 2;
  }

  await closeDb();
}

main().catch(async (err) => {
  logger.error({ event: 'replay_failed', err: String(err) }, 'replay failed');
  await closeDb().catch(() => {});
  process.exit(1);
});
