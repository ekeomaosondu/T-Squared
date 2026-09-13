import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';

/**
 * Guards the SQL ordering rules documented in src/persistence/db.ts.
 *
 * PostgreSQL resolves a bare ORDER BY / GROUP BY / DISTINCT ON name to an
 * OUTPUT ALIAS in preference to an input column, so `SELECT seq::text AS seq
 * ... ORDER BY seq` sorts lexicographically. That produced an order-book replay
 * that applied deltas out of order while looking perfectly healthy.
 */

const ROOTS = ['src', 'scripts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => sourceFiles(path.join(process.cwd(), r)));

/**
 * Strips comments and single/double-quoted string literals.
 *
 * All SQL in this codebase lives in template literals, so prose in an ordinary
 * string -- an error message mentioning "ORDER BY", for instance -- is not SQL
 * and must not be flagged.
 */
function stripComments(text: string): string {
  const withoutComments = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');

  return withoutComments.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
}

describe('SQL ordering conventions', () => {
  it('never orders, groups or distincts on an unqualified bare column', () => {
    const violations: string[] = [];

    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const re = /\b(ORDER\s+BY|GROUP\s+BY|DISTINCT\s+ON\s*\()\s+?([^\n;`]+)/gi;

      for (const m of text.matchAll(re)) {
        // Stop the clause at whatever keyword follows it on the same line.
        const clause = m[2]!.split(/\b(LIMIT|OFFSET|FETCH|FOR|RETURNING|HAVING|WINDOW)\b/i)[0]!;
        for (const rawTerm of clause.split(',')) {
          const term = rawTerm
            .replace(/\b(ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST)\b/gi, '')
            // Cut at the close paren that ends an enclosing OVER (...) window
            // clause, so `ORDER BY r.seq) AS prev` is read as `r.seq`.
            .replace(/\)[\s\S]*$/, '')
            .trim();
          if (!term) continue;
          // Interpolations, literals, positional refs and function calls are fine.
          if (/^\$\{|^\d+$|^'/.test(term)) continue;
          if (/[(]/.test(term)) continue;
          // A qualified reference (alias.column) is what we require.
          if (/^[A-Za-z_][\w$]*\.[A-Za-z_]\w*$/.test(term)) continue;

          violations.push(`${path.relative(process.cwd(), file)}: "${m[1]} ${term}"`);
        }
      }
    }

    expect(violations, `unqualified ordering keys:\n${violations.join('\n')}`).toEqual([]);
  });

  it('never aliases a cast back onto the source column name', () => {
    const violations: string[] = [];
    // e.g. `seq::text AS seq` -- the alias shadows the column it came from.
    const re = /\b(\w+)\s*::\s*\w+\s+AS\s+(\w+)/gi;

    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(re)) {
        if (m[1]!.toLowerCase() === m[2]!.toLowerCase()) {
          violations.push(`${path.relative(process.cwd(), file)}: "${m[0]}"`);
        }
      }
    }

    expect(violations, `self-shadowing cast aliases:\n${violations.join('\n')}`).toEqual([]);
  });
});

describe('sequence ordering regression', () => {
  // The exact fixture from the review. Lexicographically these sort
  // 100, 101, 1111, 13, 130, 2, 20, 200 -- which is how the replay bug applied
  // deltas. Numerically they must sort as below.
  const SEQS = [13, 100, 101, 1111, 130, 2, 20, 200];
  const EXPECTED = [2, 13, 20, 100, 101, 130, 200, 1111];

  it('sorts sequence numbers numerically, not lexicographically', () => {
    const bigints = SEQS.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(bigints.map(Number)).toEqual(EXPECTED);
  });

  it('demonstrates the lexicographic ordering this guards against', () => {
    const asText = SEQS.map(String).sort();
    expect(asText).toEqual(['100', '101', '1111', '13', '130', '2', '20', '200']);
    expect(asText.map(Number)).not.toEqual(EXPECTED);
  });

  it('applies deltas in numeric sequence order when replaying', async () => {
    const { MarketBook } = await import('@/src/book/book');

    // One delta per sequence number, each adding its own index worth of size.
    const deltas = SEQS.map((seq, i) => ({ seq: BigInt(seq), delta: String(i + 1) }));

    const ordered = [...deltas].sort((a, b) => (a.seq < b.seq ? -1 : 1));
    const book = new MarketBook('T');
    book.replaceWithSnapshot({ yesBids: [], noBids: [] });

    const applied: string[] = [];
    for (const d of ordered) {
      book.applyDelta({ side: 'yes', price: '0.5', delta: d.delta, seq: d.seq });
      applied.push(d.seq.toString());
    }

    expect(applied).toEqual(EXPECTED.map(String));
    // lastSeq must end on the numerically largest, not the lexicographic one.
    expect(book.lastSeq).toBe(1111n);
    expect(book.yesBids.get('0.500000')!.eq(new Decimal(36))).toBe(true);
  });
});

describe('batch insert ordering', () => {
  it('inserts parent tables before their children', async () => {
    const { orderedTables } = await import('@/src/persistence/batchWriter');

    // Children can otherwise reach the database first, since tables are
    // inserted group-by-group. Found by soak testing across a restart.
    const byTable = new Map<string, unknown>([
      ['event_ladder_samples', []],
      ['orderbook_deltas', []],
      ['event_ladder_sample_groups', []],
    ]);

    const order = orderedTables(byTable as never);
    expect(order.indexOf('event_ladder_sample_groups')).toBeLessThan(
      order.indexOf('event_ladder_samples'),
    );
    expect(order).toContain('orderbook_deltas');
  });
});

describe('ladder sample group identity', () => {
  it('is deterministic, so re-sampling a bucket is idempotent', async () => {
    const { ladderGroupId } = await import('@/src/sampling/ladderSampler');

    const a = ladderGroupId('KXHIGHNY-26SEP14', 1000, 1_789_325_000_000);
    const b = ladderGroupId('KXHIGHNY-26SEP14', 1000, 1_789_325_000_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('differs across event, interval and bucket', async () => {
    const { ladderGroupId } = await import('@/src/sampling/ladderSampler');
    const base = ladderGroupId('KXHIGHNY-26SEP14', 1000, 1_789_325_000_000);

    expect(ladderGroupId('KXHIGHNY-26SEP15', 1000, 1_789_325_000_000)).not.toBe(base);
    expect(ladderGroupId('KXHIGHNY-26SEP14', 5000, 1_789_325_000_000)).not.toBe(base);
    expect(ladderGroupId('KXHIGHNY-26SEP14', 1000, 1_789_325_001_000)).not.toBe(base);
  });
});

describe('silver Parquet column typing', () => {
  it('declares numeric types rather than letting JSON infer VARCHAR', async () => {
    const { typedProjection, SILVER_COLUMN_TYPES } = await import('@/src/persistence/silver');

    // postgres.js returns BIGINT and NUMERIC as strings to preserve exactness,
    // so a naive JSON round-trip lands them in Parquet as VARCHAR -- and
    // min/max on a VARCHAR ordinal sorts lexicographically, putting 100 before
    // 99. Same hazard as the replay ordering bug, in the research files.
    const projection = typedProjection(['ingest_ordinal', 'seq', 'price', 'market_ticker']);

    expect(projection).toContain('CAST("ingest_ordinal" AS BIGINT)');
    expect(projection).toContain('CAST("seq" AS BIGINT)');
    expect(projection).toContain('CAST("price" AS DECIMAL(12,6))');
    // Genuinely textual columns pass through untouched.
    expect(projection).toContain('"market_ticker"');
    expect(projection).not.toContain('CAST("market_ticker"');

    // Prices and sizes must be DECIMAL, never DOUBLE: exchange values stay
    // exact all the way into research.
    for (const col of ['price', 'delta_count', 'yes_price', 'mid', 'spread']) {
      expect(SILVER_COLUMN_TYPES[col], `${col} must be exact`).toMatch(/^DECIMAL/);
    }
  });

  it('types every ordering key used by the silver layer', async () => {
    const { SILVER_COLUMN_TYPES, SILVER_TABLES } = await import('@/src/persistence/silver');

    // Anything a research query is likely to ORDER BY must be numeric.
    for (const spec of SILVER_TABLES) {
      for (const term of spec.orderBy.split(',')) {
        const col = term.trim().split('.')[1];
        if (!col || col === 'id' || col === 'trade_id' || col === 'snapshot_id') continue;
        if (col === 'session_id') continue; // a UUID; lexicographic is fine
        expect(SILVER_COLUMN_TYPES[col], `${spec.table}.${col} is an ordering key`).toBeDefined();
      }
    }
  });
});
