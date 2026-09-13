import { describe, expect, it } from 'vitest';
import { buildExportQuery, rowToJsonLine, toCsvValue, EXPORT_TABLES } from '@/src/persistence/export';

describe('export query building', () => {
  it('rejects an unknown table and names the alternatives', () => {
    expect(() => buildExportQuery({ table: 'nope' })).toThrow(/unknown table "nope"/);
    expect(() => buildExportQuery({ table: 'nope' })).toThrow(/orderbook_deltas/);
  });

  it('orders deltas by stream chronology then exchange sequence', () => {
    // Never by id, and never by stream_id alone -- seq restarts per stream.
    const { sql } = buildExportQuery({ table: 'orderbook_deltas' });
    expect(sql).toContain('ORDER BY t.received_at, t.session_id, t.stream_id, t.seq');
  });

  it('table-qualifies every ordering key', () => {
    for (const [name, spec] of Object.entries(EXPORT_TABLES)) {
      for (const term of spec.orderBy.split(',')) {
        expect(term.trim(), `${name} orderBy must be qualified`).toMatch(/^[a-z]+\.\w+/);
      }
    }
  });

  it('filters by time as bound parameters', () => {
    const { sql, params } = buildExportQuery({
      table: 'public_trades',
      fromMs: 1_789_325_000_000,
      toMs: 1_789_326_000_000,
    });
    expect(sql).toContain('t.received_at >= to_timestamp($1)');
    expect(sql).toContain('t.received_at <= to_timestamp($2)');
    expect(params).toEqual([1_789_325_000, 1_789_326_000]);
  });

  it('joins to markets for series and event filters', () => {
    // Grouping uses the official relationship, never a ticker prefix.
    const { sql, params } = buildExportQuery({
      table: 'orderbook_deltas',
      seriesTickers: ['KXHIGHNY', 'KXLOWNY'],
    });
    expect(sql).toContain('LEFT JOIN markets m ON m.market_ticker = t.market_ticker');
    expect(sql).toContain('m.series_ticker = ANY($1::text[])');
    expect(params[0]).toEqual(['KXHIGHNY', 'KXLOWNY']);
  });

  it('resolves ladder samples through their group', () => {
    const { sql } = buildExportQuery({ table: 'event_ladder_samples', eventTickers: ['KXHIGHNY-26SEP14'] });
    expect(sql).toContain('JOIN event_ladder_sample_groups g');
    expect(sql).toContain('g.event_ticker = ANY($1::text[])');
  });

  it('refuses filters a table cannot support', () => {
    expect(() => buildExportQuery({ table: 'ingest_health_minutes', tickers: ['X'] })).toThrow(
      /not market-scoped/,
    );
    expect(() => buildExportQuery({ table: 'sequence_gaps', seriesTickers: ['X'] })).toThrow(
      /cannot be filtered by series/,
    );
  });

  it('never interpolates user values into the SQL text', () => {
    const evil = "KX'; DROP TABLE markets; --";
    const { sql, params } = buildExportQuery({ table: 'public_trades', tickers: [evil] });
    expect(sql).not.toContain('DROP TABLE');
    expect(params[0]).toEqual([evil]);
  });
});

describe('export value formatting', () => {
  it('escapes CSV values losslessly', () => {
    expect(toCsvValue(null)).toBe('');
    expect(toCsvValue('plain')).toBe('plain');
    expect(toCsvValue('has,comma')).toBe('"has,comma"');
    expect(toCsvValue('has"quote')).toBe('"has""quote"');
    expect(toCsvValue(new Date('2026-09-13T18:00:00Z'))).toBe('2026-09-13T18:00:00.000Z');
    expect(toCsvValue({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('renders bytea as hex rather than losing it', () => {
    // payload_hash is BYTEA; JSON.stringify of a Buffer would be unusable.
    expect(toCsvValue(Buffer.from([0xde, 0xad]))).toBe('dead');
    expect(JSON.parse(rowToJsonLine({ h: Buffer.from([0xbe, 0xef]) })).h).toBe('beef');
  });

  it('renders decimal strings verbatim, never as floats', () => {
    // NUMERIC arrives as a string and must stay exact.
    const line = JSON.parse(rowToJsonLine({ price: '0.420000', count: '41.39' }));
    expect(line.price).toBe('0.420000');
    expect(line.count).toBe('41.39');
  });
});
