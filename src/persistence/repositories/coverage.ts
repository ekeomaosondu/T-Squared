import type { Sql } from '@/src/persistence/db';
import { logger } from '@/src/logging/logger';

/**
 * Series coverage.
 *
 * Distinguishes "this series is configured but the exchange has not listed a
 * market yet" from "this series is configured and the recorder is silently
 * failing on it". Without it those look identical.
 */

export type CoverageStatus = 'configured' | 'awaiting_first_market' | 'exercised';

export interface CoverageRow {
  series_ticker: string;
  status: CoverageStatus;
  first_seen_at: Date | null;
  first_subscribed_at: Date | null;
  first_snapshot_at: Date | null;
  first_delta_at: Date | null;
  first_ladder_at: Date | null;
  markets_seen: number;
  last_market_ticker: string | null;
}

/** Registers every configured series, without disturbing existing progress. */
export async function registerConfiguredSeries(sql: Sql, seriesTickers: string[]): Promise<void> {
  if (seriesTickers.length === 0) return;
  await sql`
    INSERT INTO series_coverage (series_ticker, status)
    SELECT s, 'configured' FROM unnest(${seriesTickers}::text[]) AS s
    ON CONFLICT (series_ticker) DO NOTHING
  `;
}

/**
 * Records that a series exists but currently lists no eligible market. This is
 * a normal state -- KXLOW series are seasonal -- not a fault.
 */
export async function markAwaitingFirstMarket(sql: Sql, seriesTickers: string[]): Promise<void> {
  if (seriesTickers.length === 0) return;
  await sql`
    UPDATE series_coverage c
       SET status = 'awaiting_first_market',
           first_seen_at = COALESCE(c.first_seen_at, now()),
           updated_at = now()
     WHERE c.series_ticker = ANY(${seriesTickers}::text[])
       AND c.status = 'configured'
  `;
}

/** Records that markets for a series were discovered and subscribed. */
export async function markSubscribed(
  sql: Sql,
  seriesTicker: string,
  marketTicker: string,
  marketCount: number,
): Promise<void> {
  const rows = await sql<{ was_first: boolean }[]>`
    INSERT INTO series_coverage (
      series_ticker, status, first_seen_at, first_subscribed_at, markets_seen, last_market_ticker
    ) VALUES (
      ${seriesTicker}, 'exercised', now(), now(), ${marketCount}, ${marketTicker}
    )
    ON CONFLICT (series_ticker) DO UPDATE SET
      status              = 'exercised',
      first_seen_at       = COALESCE(series_coverage.first_seen_at, now()),
      first_subscribed_at = COALESCE(series_coverage.first_subscribed_at, now()),
      markets_seen        = GREATEST(series_coverage.markets_seen, EXCLUDED.markets_seen),
      last_market_ticker  = EXCLUDED.last_market_ticker,
      updated_at          = now()
    RETURNING (series_coverage.first_subscribed_at IS NULL) AS was_first
  `;

  if (rows[0]?.was_first) {
    // First listing of a configured series is worth noticing: it is the first
    // time discovery, subscription, snapshots, ladder sampling, validation and
    // replay are exercised for that series.
    logger.info(
      { event: 'series_first_subscribed', series_ticker: seriesTicker, marketCount, market_ticker: marketTicker },
      `series ${seriesTicker} listed its first tracked market`,
    );
  }
}

/** Stamps the first time a given milestone was reached for a series. */
export async function markMilestone(
  sql: Sql,
  seriesTicker: string,
  milestone: 'snapshot' | 'delta' | 'ladder',
): Promise<void> {
  const column =
    milestone === 'snapshot' ? 'first_snapshot_at' : milestone === 'delta' ? 'first_delta_at' : 'first_ladder_at';

  await sql.unsafe(
    `UPDATE series_coverage
        SET ${column} = now(), updated_at = now()
      WHERE series_ticker = $1 AND ${column} IS NULL`,
    [seriesTicker],
  );
}

export async function listCoverage(sql: Sql): Promise<CoverageRow[]> {
  return sql<CoverageRow[]>`
    SELECT c.series_ticker, c.status, c.first_seen_at, c.first_subscribed_at,
           c.first_snapshot_at, c.first_delta_at, c.first_ladder_at,
           c.markets_seen, c.last_market_ticker
      FROM series_coverage c
     ORDER BY c.status, c.series_ticker
  `;
}
