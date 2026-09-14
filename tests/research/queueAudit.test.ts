import { describe, expect, it } from 'vitest';
import { classifyMove, EXPLAINED_TOLERANCE } from '@/src/research/calibration/queueAudit';

/**
 * The audit now carries a headline claim -- that most queue movement is a
 * timing artefact rather than same-price cancellation -- so the rule that
 * produces it is pinned here.
 *
 * The ordering is the substance. A lag alignment is the LAST resort because a
 * search over dozens of offsets will fit something in a busy book, and any
 * ordering that reached for it earlier would inflate the explained fraction.
 */

const base = {
  deltaQ: 0,
  deltaSame: 0,
  deltaBetter: 0,
  executedAhead: 0,
  bestLagResidual: 99,
};

describe('queue move classification', () => {
  it('credits a trade when executed volume matches the move', () => {
    expect(classifyMove({ ...base, deltaQ: 12, executedAhead: 12 })).toBe('TRADE_EXPLAINED');
  });

  it('prefers a trade over a coincidental same-level change', () => {
    // Both would "fit". A print is the least ambiguous evidence available, so
    // it wins.
    expect(
      classifyMove({ ...base, deltaQ: 12, executedAhead: 12, deltaSame: 12 }),
    ).toBe('TRADE_EXPLAINED');
  });

  it('credits better-priced depth only when it actually moved', () => {
    expect(classifyMove({ ...base, deltaQ: 30, deltaBetter: 30 })).toBe(
      'BETTER_LEVEL_EXPLAINED',
    );
    // Better depth held still: attributing the move to it would be free, and
    // at the touch -- where better depth is permanently zero -- would explain
    // every move for nothing.
    expect(classifyMove({ ...base, deltaQ: 30, deltaBetter: 0, deltaSame: 30 })).toBe(
      'SAME_LEVEL_EXPLAINED',
    );
  });

  it('falls back to same-level cancellation', () => {
    expect(classifyMove({ ...base, deltaQ: 8, deltaSame: 8 })).toBe('SAME_LEVEL_EXPLAINED');
  });

  it('reaches for a lag alignment only when nothing else fits', () => {
    expect(classifyMove({ ...base, deltaQ: 20, bestLagResidual: 0.2 })).toBe(
      'POSSIBLE_TIMING_ALIAS',
    );
    // A good lag fit does NOT outrank a direct explanation.
    expect(
      classifyMove({ ...base, deltaQ: 20, deltaSame: 20, bestLagResidual: 0 }),
    ).toBe('SAME_LEVEL_EXPLAINED');
  });

  it('leaves a move unexplained when no public cause fits', () => {
    expect(classifyMove({ ...base, deltaQ: 40, deltaSame: 1, bestLagResidual: 30 })).toBe(
      'STILL_UNEXPLAINED',
    );
  });

  it('treats a sub-tolerance change as no move at all', () => {
    const tiny = EXPLAINED_TOLERANCE / 2;
    expect(classifyMove({ ...base, deltaQ: tiny })).toBe('SAME_LEVEL_EXPLAINED');
    // Unless the book says something large happened and the queue did not move,
    // which is itself unexplained.
    expect(classifyMove({ ...base, deltaQ: tiny, deltaSame: 50 })).toBe('STILL_UNEXPLAINED');
  });

  it('handles a queue that moved BACKWARDS', () => {
    // Someone can be inserted ahead of us only by improving price, so a
    // negative advance should be attributable to better-priced depth arriving.
    expect(classifyMove({ ...base, deltaQ: -25, deltaBetter: -25 })).toBe(
      'BETTER_LEVEL_EXPLAINED',
    );
  });
});
