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

/** Strips line comments so prose about the rule is not flagged as a violation. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
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
            .replace(/\)+$/, '')
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
