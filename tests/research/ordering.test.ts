import { describe, expect, it } from 'vitest';
import { compareOrderKeys, type OrderKey } from '@/src/research/events/researchEvent';

/**
 * The comparator is the whole ordering contract. Every one of these cases
 * corresponds to a bug this dataset has actually produced.
 */
const key = (over: Partial<OrderKey> = {}): OrderKey => ({
  sessionRank: 0,
  receiveTimeMs: 1_000n,
  ingestOrdinal: 1n,
  streamRank: 0,
  seq: 1n,
  kindRank: 2,
  tiebreak: 'a',
  ...over,
});

describe('research event ordering', () => {
  it('orders sessions by chronology, never by identifier', () => {
    // The later session has the alphabetically smaller tiebreak on purpose.
    const first = key({ sessionRank: 0, tiebreak: 'zzz' });
    const second = key({ sessionRank: 1, tiebreak: 'aaa' });
    expect(compareOrderKeys(first, second)).toBeLessThan(0);
  });

  it('orders numerically, not lexicographically', () => {
    // 100 must follow 99. A VARCHAR ordinal sorts them the other way, which is
    // exactly how the recorder once replayed deltas out of order.
    const ninetyNine = key({ ingestOrdinal: 99n });
    const hundred = key({ ingestOrdinal: 100n });
    expect(compareOrderKeys(ninetyNine, hundred)).toBeLessThan(0);
  });

  it('breaks a millisecond tie by the collector ordinal', () => {
    const a = key({ receiveTimeMs: 500n, ingestOrdinal: 7n });
    const b = key({ receiveTimeMs: 500n, ingestOrdinal: 8n });
    expect(compareOrderKeys(a, b)).toBeLessThan(0);
  });

  it('falls back to stream chronology when an ordinal is missing', () => {
    // A snapshot carries no ordinal. It must still sort against a delta in the
    // same millisecond by stream order, not arbitrarily.
    const snapshotLike = key({ receiveTimeMs: 500n, ingestOrdinal: null, streamRank: 0 });
    const laterStream = key({ receiveTimeMs: 500n, ingestOrdinal: 4n, streamRank: 1 });
    expect(compareOrderKeys(snapshotLike, laterStream)).toBeLessThan(0);
  });

  it('applies a delta before a snapshot that shares its position', () => {
    // A snapshot at sequence N already contains the delta at sequence N.
    // Snapshot-first would apply that delta twice on top of state that has it.
    const deltaKey = key({ kindRank: 2 });
    const snapshotKey = key({ kindRank: 4 });
    expect(compareOrderKeys(deltaKey, snapshotKey)).toBeLessThan(0);
  });

  it('uses exchange sequence within one stream', () => {
    const a = key({ receiveTimeMs: 900n, ingestOrdinal: null, streamRank: 3, seq: 10n });
    const b = key({ receiveTimeMs: 900n, ingestOrdinal: null, streamRank: 3, seq: 11n });
    expect(compareOrderKeys(a, b)).toBeLessThan(0);
  });

  it('is total: equal keys compare equal and the order is antisymmetric', () => {
    const a = key({ tiebreak: 'a' });
    const b = key({ tiebreak: 'b' });
    expect(compareOrderKeys(a, a)).toBe(0);
    expect(compareOrderKeys(a, b)).toBeLessThan(0);
    expect(compareOrderKeys(b, a)).toBeGreaterThan(0);
  });

  it('sorts a shuffled list into observation order', () => {
    const keys = [
      key({ sessionRank: 1, ingestOrdinal: 2n, tiebreak: 'd' }),
      key({ sessionRank: 0, receiveTimeMs: 2_000n, ingestOrdinal: 100n, tiebreak: 'c' }),
      key({ sessionRank: 0, receiveTimeMs: 1_000n, ingestOrdinal: 99n, tiebreak: 'b' }),
      key({ sessionRank: 1, ingestOrdinal: 1n, tiebreak: 'a' }),
    ];
    const sorted = [...keys].sort(compareOrderKeys).map((k) => k.tiebreak);
    expect(sorted).toEqual(['b', 'c', 'a', 'd']);
  });
});
