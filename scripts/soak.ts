#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { loadCollectorConfig } from '@/src/config/collectorConfig';
import { env } from '@/src/config/env';
import { SessionRunner } from '@/src/collector/session';
import { closeDb, db } from '@/src/persistence/db';
import { migrate } from '@/src/persistence/migrate';
import { logger } from '@/src/logging/logger';

/**
 * Fault-injected soak test.
 *
 * A clean run proves normal operation. This deliberately makes operation
 * abnormal and then checks that the recorded dataset still reconstructs
 * exactly, which is the only property that actually matters.
 *
 *   npm run soak -- --minutes 45
 *
 * Injected faults:
 *   - abrupt socket termination (several times)
 *   - a genuinely dropped frame, creating a real sequence discontinuity
 *   - a database stall long enough to exercise batching backpressure
 *   - a collector restart mid-event, creating a second capture epoch
 *
 * Memory is sampled throughout. Afterwards, run `npm run soak:verify`.
 */

interface Args {
  minutes: number;
  configPath: string;
  restartAtFraction: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    minutes: Number(get('--minutes') ?? 30),
    configPath: get('--config') ?? env().COLLECTOR_CONFIG_PATH,
    restartAtFraction: Number(get('--restart-at') ?? 0.5),
  };
}

interface FaultLog {
  at: string;
  kind: string;
  detail: string;
}

const faults: FaultLog[] = [];
const memory: { at: number; rssMb: number; heapMb: number; books: number; buffered: number }[] = [];

function record(kind: string, detail: string): void {
  faults.push({ at: new Date().toISOString(), kind, detail });
  logger.warn({ event: 'fault_injected', kind, detail }, `FAULT INJECTED: ${kind}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runSession(
  sql: ReturnType<typeof db>,
  configPath: string,
  durationMs: number,
  label: string,
): Promise<string> {
  const config = await loadCollectorConfig(configPath);
  const runner = new SessionRunner({ sql, env: env(), config, mode: 'daemon' });

  await runner.start();
  logger.info(
    { event: 'soak_session_started', session_id: runner.sessionId, label, durationMs },
    `soak session ${label} started`,
  );

  const startedAt = Date.now();
  const endsAt = startedAt + durationMs;

  // ---- fault schedule ----------------------------------------------------
  // Spread across the window so each fault lands in a different market regime.
  const at = (fraction: number) => startedAt + durationMs * fraction;

  const schedule: { when: number; run: () => void }[] = [
    {
      when: at(0.12),
      run: () => {
        record('socket_terminate', 'abrupt transport failure #1');
        runner.ws.forceDisconnect('soak #1');
      },
    },
    {
      when: at(0.25),
      run: () => {
        // Drop exactly one sequenced orderbook frame. This is the only honest
        // way to test gap detection: a gap synthesised downstream would bypass
        // the code under test.
        let dropped = false;
        runner.ws.setFrameFilter((env2) => {
          if (dropped) return true;
          if (env2?.type === 'orderbook_delta' && typeof env2.seq === 'number') {
            dropped = true;
            record('dropped_frame', `discarded orderbook_delta seq=${env2.seq}`);
            runner.ws.setFrameFilter(null);
            return false;
          }
          return true;
        });
      },
    },
    {
      when: at(0.4),
      run: () => {
        record('db_stall', 'stalling database writes for 12s');
        void stallDatabase(runner, 12_000);
      },
    },
    {
      when: at(0.55),
      run: () => {
        record('socket_terminate', 'abrupt transport failure #2');
        runner.ws.forceDisconnect('soak #2');
      },
    },
    {
      when: at(0.72),
      run: () => {
        let dropped = false;
        runner.ws.setFrameFilter((env2) => {
          if (dropped) return true;
          if (env2?.type === 'orderbook_delta' && typeof env2.seq === 'number') {
            dropped = true;
            record('dropped_frame', `discarded orderbook_delta seq=${env2.seq}`);
            runner.ws.setFrameFilter(null);
            return false;
          }
          return true;
        });
      },
    },
    {
      when: at(0.88),
      run: () => {
        record('socket_terminate', 'abrupt transport failure #3');
        runner.ws.forceDisconnect('soak #3');
      },
    },
  ];

  let next = 0;
  while (Date.now() < endsAt) {
    await sleep(1000);

    while (next < schedule.length && Date.now() >= schedule[next]!.when) {
      try {
        schedule[next]!.run();
      } catch (err) {
        logger.error({ event: 'fault_failed', err: String(err) }, 'fault injection failed');
      }
      next += 1;
    }

    const mem = process.memoryUsage();
    const status = runner.snapshotStatus();
    memory.push({
      at: Date.now(),
      rssMb: Math.round(mem.rss / 1e6),
      heapMb: Math.round(mem.heapUsed / 1e6),
      books: status.books.total,
      buffered: status.bufferedRows,
    });
  }

  await runner.stop(`soak_${label}_complete`);
  return runner.sessionId;
}

/**
 * Holds the write buffer closed for a while by blocking the pool.
 *
 * Uses pg_sleep inside a transaction that takes an exclusive lock on the raw
 * table, so real inserts queue behind it and the writer has to buffer.
 */
async function stallDatabase(runner: SessionRunner, ms: number): Promise<void> {
  const sql = db();
  try {
    await sql.begin(async (tx) => {
      await tx`LOCK TABLE raw_ingest_events IN EXCLUSIVE MODE`;
      await tx`SELECT pg_sleep(${ms / 1000})`;
    });
    record('db_stall_released', `lock held ${ms}ms; buffered=${runner.writer.bufferedRows}`);
  } catch (err) {
    logger.error({ event: 'db_stall_failed', err: String(err) }, 'database stall failed');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const totalMs = args.minutes * 60_000;

  logger.info(
    { event: 'soak_start', minutes: args.minutes, config: args.configPath },
    `soak test starting: ${args.minutes} minutes`,
  );

  const sql = db();
  await migrate(sql);

  // Two sessions, so the dataset contains a real epoch boundary and replay has
  // to reset from a snapshot rather than carrying sequence across.
  const firstMs = Math.floor(totalMs * args.restartAtFraction);
  const secondMs = totalMs - firstMs;

  const sessionA = await runSession(sql, args.configPath, firstMs, 'A');

  record('collector_restart', 'stopping session A and starting session B mid-event');
  await sleep(2_000);

  const sessionB = await runSession(sql, args.configPath, secondMs, 'B');

  const rss = memory.map((m) => m.rssMb);
  const summary = {
    minutes: args.minutes,
    sessions: [sessionA, sessionB],
    faults,
    memory: {
      samples: memory.length,
      rssStartMb: rss[0] ?? null,
      rssEndMb: rss.at(-1) ?? null,
      rssMaxMb: rss.length ? Math.max(...rss) : null,
      rssGrowthMb: rss.length ? (rss.at(-1) ?? 0) - (rss[0] ?? 0) : null,
      maxBufferedRows: Math.max(0, ...memory.map((m) => m.buffered)),
      maxBooks: Math.max(0, ...memory.map((m) => m.books)),
    },
  };

  logger.info({ event: 'soak_complete', ...summary }, 'soak test complete');
  console.log('\n' + JSON.stringify(summary, null, 2));
  console.log('\nNow run:  npm run soak:verify -- --sessions ' + [sessionA, sessionB].join(','));

  await closeDb();
}

main().catch(async (err) => {
  logger.fatal({ event: 'soak_failed', err: String(err), stack: (err as Error)?.stack }, 'soak failed');
  await closeDb().catch(() => {});
  process.exit(1);
});
