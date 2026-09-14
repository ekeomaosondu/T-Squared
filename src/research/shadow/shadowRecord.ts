import type { SimulatedFill, SimulatedOrder } from '@/src/research/execution/simulatedExchange';
import type { FillMarkout } from '@/src/research/metrics/markouts';

/**
 * The observation record of a shadow run.
 *
 * A shadow run places nothing. Its output is not a PnL, it is a DATASET: for
 * every hypothetical order, what the strategy could see when it decided, when
 * the order would have reached the exchange, what the book did in between, and
 * what each queue assumption says would have happened to it.
 *
 * ---------------------------------------------------------------------------
 * What this can and cannot establish
 * ---------------------------------------------------------------------------
 * It CAN validate the mechanics: that the strategy fires when expected, that
 * the decision-to-arrival gap behaves as modelled, that signals look the same
 * live as they did in the backtest, and how sensitive the hypothetical fills
 * are to the queue assumption.
 *
 * It CANNOT calibrate queue position. If an order is never on the exchange,
 * the exchange cannot say where in the FIFO it would have been -- so
 * `queueAheadAtEntry` here is still the model's belief, not an observation.
 * Only real resting orders answer that, which is what CALIBRATION mode is for.
 * Nothing in this file should be read as evidence about the queue model.
 */

export interface ShadowOrderRecord {
  /** Identity, so this row can be joined to the fills below. */
  clientOrderId: string;
  orderId: string;
  marketTicker: string;
  strategy: string;

  side: string;
  action: string;
  yesAction: string;
  requestedPrice: string;
  requestedYesPrice: string;
  requestedQuantity: string;

  /** When the strategy acted, in feed time. */
  decisionAtMs: string;
  /** When the order would have reached the exchange. */
  hypotheticalArrivalAtMs: string;
  decisionLatencyMs: number;
  submitLatencyMs: number;

  /** Book identity at the decision, so the state can be recovered exactly. */
  decisionBookHash: string | null;
  decisionSeq: string | null;

  decisionBid: string | null;
  decisionAsk: string | null;
  decisionBidSize: string | null;
  decisionAskSize: string | null;

  arrivalBid: string | null;
  arrivalAsk: string | null;
  /**
   * Displayed size at our price when the order would have arrived.
   *
   * The queue AHEAD under a price-time book -- but an inference, not an
   * observation. See the file comment.
   */
  displayedSizeAhead: string | null;

  status: string;
  cancelRequestedAtMs: string | null;
  cancelEffectiveAtMs: string | null;
  terminalAtMs: string | null;
}

export interface ShadowFillRecord {
  fillModel: string;
  clientOrderId: string;
  orderId: string;
  fillId: string;
  marketTicker: string;
  yesAction: string;
  yesPrice: string;
  quantity: string;
  liquidity: string;
  reason: string;
  filledAtMs: string;
  /** Modelled, not observed. */
  queueAheadAtEntry: string | null;
  queueAheadBeforeFill: string | null;
  triggeringTradeId: string | null;
  midAtFill: string | null;
  spreadAtFill: string | null;
  /** Sign-normalized markouts, positive favourable. */
  markouts: Record<string, string | null>;
  midDrift: Record<string, string | null>;
  spreadCapture: string | null;
}

const s = (v: { toFixed(dp: number): string } | null | undefined, dp = 6) =>
  v === null || v === undefined ? null : v.toFixed(dp);
const b = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

export function toShadowOrderRecords(
  orders: readonly SimulatedOrder[],
  strategy: string,
  latency: { decisionMs: number; submitMs: number },
): ShadowOrderRecord[] {
  return orders.map((o) => ({
    clientOrderId: o.clientOrderId,
    orderId: o.orderId,
    marketTicker: o.marketTicker,
    strategy,
    side: o.side,
    action: o.action,
    yesAction: o.yesAction,
    requestedPrice: o.price.toFixed(6),
    requestedYesPrice: o.yesPrice.toFixed(6),
    requestedQuantity: o.quantity.toFixed(6),
    decisionAtMs: o.submittedAtMs.toString(),
    hypotheticalArrivalAtMs: o.effectiveAtMs.toString(),
    decisionLatencyMs: latency.decisionMs,
    submitLatencyMs: latency.submitMs,
    decisionBookHash: o.decisionBookHash,
    decisionSeq: null,
    decisionBid: s(o.decisionBid),
    decisionAsk: s(o.decisionAsk),
    decisionBidSize: s(o.decisionBidSize),
    decisionAskSize: s(o.decisionAskSize),
    arrivalBid: s(o.arrivalBid),
    arrivalAsk: s(o.arrivalAsk),
    displayedSizeAhead: s(o.arrivalDisplayedSize),
    status: o.status,
    cancelRequestedAtMs: b(o.cancelRequestedAtMs),
    cancelEffectiveAtMs: b(o.cancelEffectiveAtMs),
    terminalAtMs: b(o.terminalAtMs),
  }));
}

export function toShadowFillRecords(
  fillModel: string,
  fills: readonly SimulatedFill[],
  markouts: readonly FillMarkout[],
): ShadowFillRecord[] {
  const byFill = new Map(markouts.map((m) => [m.fillId, m]));
  return fills.map((f) => {
    const m = byFill.get(f.fillId);
    return {
      fillModel,
      clientOrderId: f.clientOrderId,
      orderId: f.orderId,
      fillId: f.fillId,
      marketTicker: f.marketTicker,
      yesAction: f.yesAction,
      yesPrice: f.yesPrice.toFixed(6),
      quantity: f.quantity.toFixed(6),
      liquidity: f.liquidity,
      reason: f.reason,
      filledAtMs: f.filledAtMs.toString(),
      queueAheadAtEntry: s(f.queueAheadAtEntry),
      queueAheadBeforeFill: s(f.queueAheadBeforeFill),
      triggeringTradeId: f.triggeringTradeId,
      midAtFill: s(f.midAtFill),
      spreadAtFill: s(f.spreadAtFill),
      markouts: m?.markouts ?? {},
      midDrift: m?.midDrift ?? {},
      spreadCapture: m?.spreadCapture ?? null,
    };
  });
}
