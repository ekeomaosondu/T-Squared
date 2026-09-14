import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';
import {
  applyFillToPosition,
  collateralRequired,
  newPosition,
  settlePosition,
  unrealizedPnl,
} from '@/src/research/portfolio/accounting';
import { KalshiFeeModel, ZeroFeeModel } from '@/src/research/portfolio/fees';

const D = (v: string | number) => new Decimal(v);

describe('binary-contract accounting', () => {
  it('averages entries and realizes on the closing portion', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    applyFillToPosition(p, D(10), D('0.50'), D(0));
    expect(p.quantity.toString()).toBe('20');
    expect(p.averageEntryPrice.toString()).toBe('0.45');

    const close = applyFillToPosition(p, D(-8), D('0.60'), D(0));
    // 8 contracts closed at 0.60 against an average of 0.45.
    expect(close.realizedDelta.toString()).toBe('1.2');
    expect(p.quantity.toString()).toBe('12');
    expect(p.averageEntryPrice.toString()).toBe('0.45');
  });

  it('realizes correctly on a short closed by a buy', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(-10), D('0.60'), D(0));
    expect(p.quantity.toString()).toBe('-10');
    const close = applyFillToPosition(p, D(10), D('0.55'), D(0));
    // Sold at 0.60, bought back at 0.55.
    expect(close.realizedDelta.toString()).toBe('0.5');
    expect(p.quantity.isZero()).toBe(true);
    expect(p.averageEntryPrice.isZero()).toBe(true);
  });

  it('flips through zero, closing the old position and opening the new one', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    const flip = applyFillToPosition(p, D(-25), D('0.50'), D(0));
    expect(flip.closedQuantity.toString()).toBe('10');
    expect(flip.realizedDelta.toString()).toBe('1'); // 10 * (0.50 - 0.40)
    expect(p.quantity.toString()).toBe('-15');
    // The new short is entered at the fill price, not blended with the old long.
    expect(p.averageEntryPrice.toString()).toBe('0.5');
  });

  it('settles a long at $1 and a short at $0 without a final mark', () => {
    const long = newPosition('M');
    applyFillToPosition(long, D(10), D('0.40'), D(0));
    const s1 = settlePosition(long, 1);
    expect(s1.cashDelta.toString()).toBe('10');
    expect(s1.realizedDelta.toString()).toBe('6'); // 10 * (1 - 0.40)
    expect(long.quantity.isZero()).toBe(true);

    const short = newPosition('M');
    applyFillToPosition(short, D(-10), D('0.40'), D(0));
    const s0 = settlePosition(short, 0);
    expect(s0.cashDelta.toString()).toBe('0');
    expect(s0.realizedDelta.toString()).toBe('4'); // -10 * (0 - 0.40)
  });

  it('refuses to settle twice', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(1), D('0.5'), D(0));
    settlePosition(p, 1);
    expect(() => settlePosition(p, 0)).toThrow(/already settled/);
  });

  it('collateralises a short at one dollar minus the sale price', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(-10), D('0.30'), D(0));
    // Selling YES at 0.30 is buying NO at 0.70; the capital at risk is 0.70.
    expect(collateralRequired(p).toString()).toBe('7');
  });

  it('reports a missing mark as null rather than as zero PnL', () => {
    const p = newPosition('M');
    applyFillToPosition(p, D(10), D('0.40'), D(0));
    expect(unrealizedPnl(p, null)).toBeNull();
    expect(unrealizedPnl(p, D('0.45'))!.toString()).toBe('0.5');
  });

  it('keeps arithmetic exact where floating point would not', () => {
    const p = newPosition('M');
    for (let i = 0; i < 3; i++) applyFillToPosition(p, D(1), D('0.10'), D(0));
    applyFillToPosition(p, D(-3), D('0.30'), D(0));
    // 3 * (0.30 - 0.10) is exactly 0.6, not 0.6000000000000001.
    expect(p.realizedPnl.toString()).toBe('0.6');
  });
});

describe('Kalshi fees', () => {
  it('is quadratic in price and peaks at fifty cents', () => {
    const model = new KalshiFeeModel();
    const at = (price: string) =>
      model.fee({ marketTicker: 'M', quantity: D(100), yesPrice: D(price), liquidity: 'taker' });
    // 0.07 * 100 * 0.5 * 0.5 = 1.75
    expect(at('0.50').toString()).toBe('1.75');
    // The tails are far cheaper: 0.07 * 100 * 0.05 * 0.95 = 0.3325 -> 0.34
    expect(at('0.05').toString()).toBe('0.34');
    expect(at('0.05').lt(at('0.50'))).toBe(true);
    expect(at('0.95').equals(at('0.05'))).toBe(true);
  });

  it('rounds a fee up to the next cent', () => {
    const model = new KalshiFeeModel();
    const fee = model.fee({
      marketTicker: 'M',
      quantity: D(1),
      yesPrice: D('0.50'),
      liquidity: 'taker',
    });
    // 0.07 * 1 * 0.25 = 0.0175 -> 0.02
    expect(fee.toString()).toBe('0.02');
  });

  it('charges nothing to a maker by default, and says so in the manifest', () => {
    const model = new KalshiFeeModel();
    const fee = model.fee({
      marketTicker: 'M',
      quantity: D(100),
      yesPrice: D('0.50'),
      liquidity: 'maker',
    });
    expect(fee.isZero()).toBe(true);
    // The default is an assumption, not a measurement, and must be labelled.
    expect(model.describe().verified).toBe(false);
  });

  it('applies a configured maker fee per contract', () => {
    const model = new KalshiFeeModel({ makerFeePerContract: '0.0025' });
    const fee = model.fee({
      marketTicker: 'M',
      quantity: D(100),
      yesPrice: D('0.50'),
      liquidity: 'maker',
    });
    expect(fee.toString()).toBe('0.25');
  });

  it('does not let an absent option overwrite a default', () => {
    const model = new KalshiFeeModel({ takerRate: undefined });
    expect(model.describe().takerRate).toBe('0.07');
  });

  it('has a zero model for isolating the effect of fees', () => {
    expect(new ZeroFeeModel().fee().isZero()).toBe(true);
  });
});
