import { describe, expect, it } from 'vitest';
import {
  D,
  Decimal,
  assertNonNegativeSize,
  assertPriceInRange,
  canonicalPrice,
  canonicalSize,
  centsToPrice,
  fromNumeric,
  noBidFromYesAsk,
  toNumeric,
  yesAskFromNoBid,
} from '@/src/book/decimal';

/**
 * Exchange state must never touch JavaScript floating point. These tests pin
 * the cases where it would silently go wrong.
 */
describe('exact decimal arithmetic', () => {
  it('produces stable canonical strings', () => {
    expect(canonicalPrice('0.42')).toBe('0.420000');
    expect(canonicalPrice('0.4200')).toBe('0.420000');
    expect(canonicalPrice(0.42)).toBe('0.420000');
    expect(canonicalSize('150')).toBe('150.000000');
    expect(canonicalSize('41.39')).toBe('41.390000');
  });

  it('avoids binary floating-point error that JS numbers introduce', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(D('0.1').plus('0.2').toString()).toBe('0.3');
    expect(canonicalPrice(D('0.1').plus('0.2'))).toBe('0.300000');
  });

  it('converts cents exactly, where cents/100 in floating point would not', () => {
    // Kept for the legacy integer-cent form; the live API now sends dollars.
    expect(centsToPrice(37).toString()).toBe('0.37');
    expect(centsToPrice(99).toString()).toBe('0.99');
    for (let c = 1; c <= 99; c++) {
      expect(canonicalPrice(centsToPrice(c))).toBe((c / 100).toFixed(6));
    }
  });

  it('accumulates fractional quantities without drift', () => {
    // A hundred 0.01 increments must be exactly 1, not 1.0000000000000007.
    let naive = 0;
    let exact = new Decimal(0);
    for (let i = 0; i < 100; i++) {
      naive += 0.01;
      exact = exact.plus('0.01');
    }
    expect(naive).not.toBe(1);
    expect(exact.toString()).toBe('1');
  });

  it('inverts YES ask and NO bid exactly across the whole grid', () => {
    for (let c = 1; c <= 99; c++) {
      const noBid = centsToPrice(c);
      const yesAsk = yesAskFromNoBid(noBid);
      expect(canonicalPrice(noBidFromYesAsk(yesAsk))).toBe(canonicalPrice(noBid));
    }
  });

  it('round-trips through the NUMERIC representation', () => {
    const v = new Decimal('0.426000');
    expect(fromNumeric(toNumeric(v))!.eq(v)).toBe(true);
    expect(fromNumeric(null)).toBeNull();
    expect(toNumeric(null)).toBeNull();
  });

  it('rejects prices outside [0, 1] rather than clamping them', () => {
    expect(() => assertPriceInRange(new Decimal('1.5'), 'test')).toThrow(/outside \[0, 1\]/);
    expect(() => assertPriceInRange(new Decimal('-0.1'), 'test')).toThrow();
    expect(() => assertPriceInRange(new Decimal('0.42'), 'test')).not.toThrow();
    expect(() => assertNonNegativeSize(new Decimal('-1'), 'test')).toThrow(/negative/);
  });
});
