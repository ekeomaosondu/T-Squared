import type { Sql } from '@/src/persistence/db';
import {
  emptyToNull,
  marketVersionHash,
  toDate,
  toNumericString,
} from '@/src/persistence/convert';
import type { KalshiEvent, KalshiMarket, KalshiSeries } from '@/src/kalshi/schemas';
import { logger } from '@/src/logging/logger';

/**
 * Reference-data persistence.
 *
 * The `raw` column always receives the verbatim API object. Normalised columns
 * exist for querying; they are never the only copy of anything.
 */

export async function upsertSeries(sql: Sql, series: KalshiSeries, now = new Date()): Promise<void> {
  await sql`
    INSERT INTO series (
      series_ticker, title, category, frequency, tags, settlement_sources,
      contract_url, contract_terms_url, fee_type, fee_multiplier,
      product_metadata, last_updated_ts, last_refreshed_at, raw
    ) VALUES (
      ${series.ticker},
      ${series.title ?? null},
      ${series.category ?? null},
      ${series.frequency ?? null},
      ${sql.json((series.tags ?? null) as never)},
      ${sql.json((series.settlement_sources ?? null) as never)},
      ${series.contract_url ?? null},
      ${series.contract_terms_url ?? null},
      ${series.fee_type ?? null},
      ${toNumericString(series.fee_multiplier)},
      ${sql.json((series.product_metadata ?? null) as never)},
      ${toDate(series.last_updated_ts)},
      ${now},
      ${sql.json(series as never)}
    )
    ON CONFLICT (series_ticker) DO UPDATE SET
      title              = EXCLUDED.title,
      category           = EXCLUDED.category,
      frequency          = EXCLUDED.frequency,
      tags               = EXCLUDED.tags,
      settlement_sources = EXCLUDED.settlement_sources,
      contract_url       = EXCLUDED.contract_url,
      contract_terms_url = EXCLUDED.contract_terms_url,
      fee_type           = EXCLUDED.fee_type,
      fee_multiplier     = EXCLUDED.fee_multiplier,
      product_metadata   = EXCLUDED.product_metadata,
      last_updated_ts    = EXCLUDED.last_updated_ts,
      last_refreshed_at  = EXCLUDED.last_refreshed_at,
      raw                = EXCLUDED.raw
  `;
}

export async function upsertEvent(sql: Sql, event: KalshiEvent, now = new Date()): Promise<void> {
  await sql`
    INSERT INTO events (
      event_ticker, series_ticker, title, sub_title, category,
      mutually_exclusive, available_on_brokers, settlement_sources,
      collateral_return_type, strike_date, strike_period, product_metadata,
      last_updated_ts, last_refreshed_at, raw
    ) VALUES (
      ${event.event_ticker},
      ${event.series_ticker ?? null},
      ${event.title ?? null},
      ${event.sub_title ?? null},
      ${event.category ?? null},
      ${event.mutually_exclusive ?? null},
      ${event.available_on_brokers ?? null},
      ${sql.json((event.settlement_sources ?? null) as never)},
      ${emptyToNull(event.collateral_return_type)},
      ${toDate(event.strike_date)},
      ${emptyToNull(event.strike_period)},
      ${sql.json((event.product_metadata ?? null) as never)},
      ${toDate(event.last_updated_ts)},
      ${now},
      ${sql.json(event as never)}
    )
    ON CONFLICT (event_ticker) DO UPDATE SET
      series_ticker          = EXCLUDED.series_ticker,
      title                  = EXCLUDED.title,
      sub_title              = EXCLUDED.sub_title,
      category               = EXCLUDED.category,
      mutually_exclusive     = EXCLUDED.mutually_exclusive,
      available_on_brokers   = EXCLUDED.available_on_brokers,
      settlement_sources     = EXCLUDED.settlement_sources,
      collateral_return_type = EXCLUDED.collateral_return_type,
      strike_date            = EXCLUDED.strike_date,
      strike_period          = EXCLUDED.strike_period,
      product_metadata       = EXCLUDED.product_metadata,
      last_updated_ts        = EXCLUDED.last_updated_ts,
      last_refreshed_at      = EXCLUDED.last_refreshed_at,
      raw                    = EXCLUDED.raw
  `;
}

/**
 * Upserts the current market row AND appends a metadata version if anything
 * changed. The version row is what makes rule/close-time/status changes
 * auditable weeks later.
 */
export async function upsertMarket(
  sql: Sql,
  market: KalshiMarket,
  seriesTicker: string | null,
  now = new Date(),
): Promise<{ metadataChanged: boolean }> {
  // Structural fields only: quotes and volume change constantly and are not
  // metadata changes.
  const hash = marketVersionHash(market as Record<string, unknown>);

  const inserted = await sql<{ market_ticker: string }[]>`
    INSERT INTO market_metadata_versions (
      market_ticker, observed_at, version_hash, status, close_time, result, raw
    ) VALUES (
      ${market.ticker}, ${now}, ${hash}, ${market.status ?? null},
      ${toDate(market.close_time)}, ${emptyToNull(market.result)},
      ${sql.json(market as never)}
    )
    ON CONFLICT (market_ticker, version_hash) DO NOTHING
    RETURNING market_ticker
  `;

  await sql`
    INSERT INTO markets (
      market_ticker, market_id, event_ticker, series_ticker, market_type,
      title, subtitle, yes_sub_title, no_sub_title, status,
      strike_type, floor_strike, cap_strike, functional_strike, custom_strike,
      price_level_structure, price_ranges,
      created_time, updated_time, open_time, close_time,
      expected_expiration_time, latest_expiration_time, expiration_time,
      occurrence_datetime, notional_value,
      settlement_timer_seconds, can_close_early, early_close_condition,
      rules_primary, rules_secondary,
      result, expiration_value, settlement_value, settlement_ts,
      is_provisional, last_refreshed_at, raw
    ) VALUES (
      ${market.ticker},
      ${(market as { market_id?: string }).market_id ?? null},
      ${market.event_ticker ?? null},
      ${seriesTicker},
      ${market.market_type ?? null},
      ${market.title ?? null},
      ${market.subtitle ?? null},
      ${market.yes_sub_title ?? null},
      ${market.no_sub_title ?? null},
      ${market.status ?? null},
      ${emptyToNull(market.strike_type)},
      ${toNumericString(market.floor_strike)},
      ${toNumericString(market.cap_strike)},
      ${emptyToNull(market.functional_strike)},
      ${sql.json((market.custom_strike ?? null) as never)},
      ${emptyToNull(market.price_level_structure)},
      ${sql.json((market.price_ranges ?? null) as never)},
      ${toDate(market.created_time)},
      ${toDate(market.updated_time)},
      ${toDate(market.open_time)},
      ${toDate(market.close_time)},
      ${toDate(market.expected_expiration_time)},
      ${toDate(market.latest_expiration_time)},
      ${toDate(market.expiration_time)},
      ${toDate(market.occurrence_datetime)},
      ${toNumericString(market.notional_value_dollars)},
      ${market.settlement_timer_seconds ?? null},
      ${market.can_close_early ?? null},
      ${emptyToNull(market.early_close_condition)},
      ${market.rules_primary ?? null},
      ${market.rules_secondary ?? null},
      ${emptyToNull(market.result)},
      ${emptyToNull(market.expiration_value)},
      ${toNumericString(market.settlement_value_dollars)},
      ${null},
      ${null},
      ${now},
      ${sql.json(market as never)}
    )
    ON CONFLICT (market_ticker) DO UPDATE SET
      market_id                = COALESCE(EXCLUDED.market_id, markets.market_id),
      event_ticker             = EXCLUDED.event_ticker,
      series_ticker            = COALESCE(EXCLUDED.series_ticker, markets.series_ticker),
      market_type              = EXCLUDED.market_type,
      title                    = EXCLUDED.title,
      subtitle                 = EXCLUDED.subtitle,
      yes_sub_title            = EXCLUDED.yes_sub_title,
      no_sub_title             = EXCLUDED.no_sub_title,
      status                   = EXCLUDED.status,
      strike_type              = EXCLUDED.strike_type,
      floor_strike             = EXCLUDED.floor_strike,
      cap_strike               = EXCLUDED.cap_strike,
      functional_strike        = EXCLUDED.functional_strike,
      custom_strike            = EXCLUDED.custom_strike,
      price_level_structure    = EXCLUDED.price_level_structure,
      price_ranges             = EXCLUDED.price_ranges,
      created_time             = EXCLUDED.created_time,
      updated_time             = EXCLUDED.updated_time,
      open_time                = EXCLUDED.open_time,
      close_time               = EXCLUDED.close_time,
      expected_expiration_time = EXCLUDED.expected_expiration_time,
      latest_expiration_time   = EXCLUDED.latest_expiration_time,
      expiration_time          = EXCLUDED.expiration_time,
      occurrence_datetime      = EXCLUDED.occurrence_datetime,
      notional_value           = EXCLUDED.notional_value,
      settlement_timer_seconds = EXCLUDED.settlement_timer_seconds,
      can_close_early          = EXCLUDED.can_close_early,
      early_close_condition    = EXCLUDED.early_close_condition,
      rules_primary            = EXCLUDED.rules_primary,
      rules_secondary          = EXCLUDED.rules_secondary,
      result                   = EXCLUDED.result,
      expiration_value         = EXCLUDED.expiration_value,
      settlement_value         = EXCLUDED.settlement_value,
      last_refreshed_at        = EXCLUDED.last_refreshed_at,
      raw                      = EXCLUDED.raw
  `;

  return { metadataChanged: inserted.length > 0 };
}

// ---------------------------------------------------------------------------
// Tracking windows
// ---------------------------------------------------------------------------

/**
 * Opens a tracking window. Prior windows are never mutated: a market that is
 * tracked, dropped and tracked again produces three rows.
 */
export async function openTrackingWindow(
  sql: Sql,
  marketTicker: string,
  selectorId: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  await sql`
    INSERT INTO tracked_markets (
      market_ticker, selector_id, tracking_started_at, reason_started
    ) VALUES (${marketTicker}, ${selectorId}, ${now}, ${reason})
    ON CONFLICT (market_ticker, selector_id) WHERE tracking_ended_at IS NULL
    DO NOTHING
  `;
}

export async function closeTrackingWindow(
  sql: Sql,
  marketTicker: string,
  selectorId: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  await sql`
    UPDATE tracked_markets
       SET tracking_ended_at = ${now}, reason_ended = ${reason}
     WHERE market_ticker = ${marketTicker}
       AND selector_id   = ${selectorId}
       AND tracking_ended_at IS NULL
  `;
}

export async function listOpenTrackingWindows(
  sql: Sql,
): Promise<{ market_ticker: string; selector_id: string; tracking_started_at: Date }[]> {
  return sql`
    SELECT market_ticker, selector_id, tracking_started_at
      FROM tracked_markets
     WHERE tracking_ended_at IS NULL
     ORDER BY tracking_started_at
  `;
}

/** One market's strike definition within an event ladder. */
export interface LadderMarketRow {
  event_ticker: string;
  market_ticker: string;
  floor_strike: string | null;
  cap_strike: string | null;
  strike_type: string | null;
  functional_strike: string | null;
}

/**
 * Markets grouped by their OFFICIAL event_ticker, for synchronised ladder
 * sampling. Grouping comes from the API relationship, never from parsing the
 * ticker string.
 */
export async function loadEventLadders(
  sql: Sql,
  eventTickers: string[],
): Promise<Map<string, LadderMarketRow[]>> {
  if (eventTickers.length === 0) return new Map();

  const rows = await sql<LadderMarketRow[]>`
    SELECT event_ticker, market_ticker, floor_strike, cap_strike, strike_type, functional_strike
      FROM markets
     WHERE event_ticker = ANY(${eventTickers}::text[])
     ORDER BY event_ticker, floor_strike NULLS FIRST, market_ticker
  `;

  const out = new Map<string, LadderMarketRow[]>();
  for (const row of rows) {
    const list = out.get(row.event_ticker) ?? [];
    list.push(row);
    out.set(row.event_ticker, list);
  }
  return out;
}

export async function refreshMarketsFromApi(
  sql: Sql,
  markets: KalshiMarket[],
  seriesByEvent: Map<string, string>,
  now = new Date(),
): Promise<number> {
  let changed = 0;
  for (const market of markets) {
    const series = market.event_ticker ? (seriesByEvent.get(market.event_ticker) ?? null) : null;
    const { metadataChanged } = await upsertMarket(sql, market, series, now);
    if (metadataChanged) changed += 1;
  }
  if (changed > 0) {
    logger.info({ event: 'market_metadata_changed', count: changed }, 'market metadata versions recorded');
  }
  return changed;
}
