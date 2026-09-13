#!/usr/bin/env tsx
import '@/src/config/bootstrap';
import { closeDb, db } from '@/src/persistence/db';
import { verifyReplay } from '@/src/replay/replay';

/**
 * Proves that recorded deltas reproduce recorded book state, for every market
 * in the capture window.
 *
 * This is the recorder's acceptance test: for each materialised snapshot, the
 * book is rebuilt from a seed snapshot plus the delta stream and the SHA-256
 * state hashes are compared. Kalshi is never contacted.
 *
 *   npm run verify-replay [-- --ticker KX... --limit 50]
 */
async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--ticker') ? argv[argv.indexOf('--ticker') + 1] : undefined;
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : 40;

  const sql = db();

  const [bounds] = (await sql`
    SELECT min(received_at_ms)::text AS from_ms, max(received_at_ms)::text AS to_ms
      FROM orderbook_snapshots
  `) as unknown as { from_ms: string | null; to_ms: string | null }[];

  if (!bounds?.from_ms || !bounds.to_ms) {
    console.error('no snapshots recorded; nothing to verify');
    await closeDb();
    return;
  }

  // Start one millisecond before the earliest snapshot so every market has a
  // seed at or before the window start.
  const fromMs = BigInt(bounds.from_ms) - 1n;
  const toMs = BigInt(bounds.to_ms);

  const tickers = only
    ? [only]
    : ((await sql`
        SELECT DISTINCT market_ticker FROM orderbook_deltas ORDER BY market_ticker
      `) as unknown as { market_ticker: string }[]).map((r) => r.market_ticker);

  console.log(
    `window ${new Date(Number(fromMs)).toISOString()} .. ${new Date(Number(toMs)).toISOString()}`,
  );
  console.log(`markets: ${tickers.length}\n`);

  let checked = 0;
  let matched = 0;
  const failures: string[] = [];

  for (const ticker of tickers) {
    const v = await verifyReplay(sql, ticker, fromMs, toMs, limit);
    checked += v.checked;
    matched += v.matched;

    const ok = v.checked > 0 && v.matched === v.checked;
    if (!ok && v.checked > 0) failures.push(ticker);

    console.log(
      `  ${ticker.padEnd(26)} ${String(v.matched).padStart(3)}/${String(v.checked).padEnd(3)} ` +
        `${v.checked === 0 ? 'no targets' : ok ? 'exact' : `MISMATCH (${v.mismatches.length})`}`,
    );
    if (v.mismatches.length > 0) {
      for (const m of v.mismatches.slice(0, 2)) {
        console.log(
          `      at ${new Date(Number(m.atMs)).toISOString()}  expected ${m.expected.slice(0, 12)}  actual ${m.actual.slice(0, 12)}`,
        );
      }
    }
  }

  console.log(
    `\n${matched}/${checked} recorded snapshots reproduced exactly from raw deltas` +
      (failures.length ? `\nmarkets with mismatches: ${failures.join(', ')}` : ''),
  );

  await closeDb();
  if (checked === 0 || matched !== checked) process.exit(2);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb().catch(() => {});
  process.exit(1);
});
