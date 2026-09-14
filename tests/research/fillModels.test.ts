import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';
import { newQueueState } from '@/src/research/execution/fills/fillModel';
import { TouchFillModel } from '@/src/research/execution/fills/touchFillModel';
import { ConservativeQueueModel } from '@/src/research/execution/fills/conservativeQueueModel';
import { QueueDecayModel } from '@/src/research/execution/fills/queueDecayModel';

const D = (v: string | number) => new Decimal(v);

describe('touch fill model', () => {
  it('assumes the front of the queue and fills on the first print', () => {
    const model = new TouchFillModel();
    const displayed = D(500);
    expect(model.initialQueueAhead(displayed).isZero()).toBe(true);

    const state = newQueueState(displayed, model.initialQueueAhead(displayed), 0n);
    const out = model.onTrade(state, D(10), D(10), false, 100n);
    expect(out.filled.toString()).toBe('10');
    expect(out.reason).toBe('touch');
  });
});

describe('conservative queue model', () => {
  it('puts the whole displayed level ahead of us', () => {
    const model = new ConservativeQueueModel();
    expect(model.initialQueueAhead(D(400)).toString()).toBe('400');
  });

  it('does not fill until the volume ahead has actually traded', () => {
    const model = new ConservativeQueueModel();
    const state = newQueueState(D(30), model.initialQueueAhead(D(30)), 0n);

    expect(model.onTrade(state, D(10), D(10), false, 1n).filled.isZero()).toBe(true);
    expect(state.queueAhead.toString()).toBe('20');
    expect(model.onTrade(state, D(20), D(10), false, 2n).filled.isZero()).toBe(true);
    expect(state.queueAhead.isZero()).toBe(true);

    const out = model.onTrade(state, D(10), D(10), false, 3n);
    expect(out.filled.toString()).toBe('10');
    expect(out.reason).toBe('queue_depleted');
  });

  it('gives NO credit for a level shrinking', () => {
    // A level falling from 400 to 250 says somebody left. Market-by-price data
    // cannot say whether they were ahead of us, and crediting it is the single
    // most common way a maker backtest manufactures fills.
    const model = new ConservativeQueueModel();
    const state = newQueueState(D(400), model.initialQueueAhead(D(400)), 0n);
    model.onDisplayedSizeChange(state, D(400), D(250), 5n);
    expect(state.queueAhead.toString()).toBe('400');
    expect(state.lastDisplayedSize.toString()).toBe('250');
  });

  it('fills through the queue when the market trades past our price', () => {
    // Everything at our price was passed over; the queue protects nobody.
    const model = new ConservativeQueueModel();
    const state = newQueueState(D(400), model.initialQueueAhead(D(400)), 0n);
    const out = model.onTrade(state, D(25), D(10), true, 1n);
    expect(out.filled.toString()).toBe('10');
    expect(out.reason).toBe('trade_through');
  });

  it('never fills more than the print or than the order has left', () => {
    const model = new ConservativeQueueModel();
    const state = newQueueState(D(0), model.initialQueueAhead(D(0)), 0n);
    expect(model.onTrade(state, D(3), D(10), false, 1n).filled.toString()).toBe('3');
    expect(model.onTrade(state, D(50), D(4), false, 2n).filled.toString()).toBe('4');
  });
});

describe('queue decay model', () => {
  it('credits a configured share of an unexplained withdrawal', () => {
    const model = new QueueDecayModel({ cancelCreditRatio: '0.5' });
    const state = newQueueState(D(100), model.initialQueueAhead(D(100)), 0n);
    model.onDisplayedSizeChange(state, D(100), D(60), 1n);
    // 40 withdrawn, none of it explained by a trade, half credited.
    expect(state.queueAhead.toString()).toBe('80');
  });

  it('does not credit a withdrawal twice when a trade caused it', () => {
    // A trade removes size from the level, so the delta that follows is not
    // evidence of a cancellation. Without reconciliation the queue would drain
    // at roughly double the true rate.
    const model = new QueueDecayModel({ cancelCreditRatio: '1' });
    const state = newQueueState(D(100), model.initialQueueAhead(D(100)), 0n);

    model.onTrade(state, D(30), D(10), false, 1n);
    expect(state.queueAhead.toString()).toBe('70');

    model.onDisplayedSizeChange(state, D(100), D(70), 2n);
    expect(state.queueAhead.toString()).toBe('70');
  });

  it('credits only the part of a withdrawal a trade cannot explain', () => {
    const model = new QueueDecayModel({ cancelCreditRatio: '1' });
    const state = newQueueState(D(100), model.initialQueueAhead(D(100)), 0n);
    model.onTrade(state, D(30), D(10), false, 1n); // queue 100 -> 70
    model.onDisplayedSizeChange(state, D(100), D(50), 2n); // 50 gone, 30 traded
    expect(state.queueAhead.toString()).toBe('50');
  });

  it('treats size added to the level as joining behind us', () => {
    const model = new QueueDecayModel({ cancelCreditRatio: '1' });
    const state = newQueueState(D(100), model.initialQueueAhead(D(100)), 0n);
    model.onDisplayedSizeChange(state, D(100), D(180), 1n);
    expect(state.queueAhead.toString()).toBe('100');
  });

  it('decays the queue deterministically with SIMULATED elapsed time', () => {
    const model = new QueueDecayModel({ decayPerSecond: '0.5', cancelCreditRatio: '0' });
    const at = (elapsedMs: bigint) => {
      const state = newQueueState(D(100), model.initialQueueAhead(D(100)), 0n);
      model.onTrade(state, D(0.000001), D(10), false, elapsedMs);
      return state.queueAhead;
    };
    // Halving per second: 100 -> 50 after 1s, -> 25 after 2s. Two identical
    // calls give identical answers, because nothing consults wall time.
    expect(at(1_000n).toFixed(4)).toBe('50.0000');
    expect(at(2_000n).toFixed(4)).toBe('25.0000');
    expect(at(2_000n).equals(at(2_000n))).toBe(true);
  });

  it('rejects a decay rate outside [0, 1]', () => {
    expect(() => new QueueDecayModel({ decayPerSecond: '1.5' })).toThrow(/\[0, 1\]/);
  });

  it('declares itself uncalibrated in the manifest', () => {
    expect(new QueueDecayModel().describe().calibrated).toBe(false);
  });
});

describe('calibration provenance', () => {
  it('records that the conservative anchor is MEASURED, not assumed', () => {
    // The claim in the manifest has to match what was actually established.
    // Calibration v0 matched the exchange's own queue exactly at entry in 62
    // of 67 probes, so this is a measurement and the manifest should say so.
    const c = new ConservativeQueueModel().describe().calibration as Record<string, unknown>;
    expect(c.queueAheadAtEntry).toBe('validated');
    expect(String(c.evidence)).toMatch(/67/);
    expect(String(c.betterPriceDepth)).toMatch(/excluded by measurement/);
  });

  it('does NOT claim the cancellation credit was identified', () => {
    // alpha = 0 is uncontradicted, not measured. Every step-wise model of
    // queue advance failed on this data, so nothing was fitted, and the
    // manifest must not imply otherwise.
    const c = new ConservativeQueueModel().describe().calibration as Record<string, unknown>;
    expect(String(c.cancelCreditRatio)).toMatch(/not identified/);
  });

  it('records that touch was refuted rather than merely optimistic', () => {
    const c = new TouchFillModel().describe().calibration as Record<string, unknown>;
    expect(c.queueAheadAtEntry).toBe('refuted');
  });

  it('keeps queue_decay marked uncalibrated', () => {
    const d = new QueueDecayModel().describe();
    expect(d.calibrated).toBe(false);
    expect(String(d.calibrationNote)).toMatch(/not/);
  });
});
