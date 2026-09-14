import { Decimal, ZERO } from '@/src/book/decimal';
import {
  applyFillToPosition,
  collateralRequired,
  newPosition,
  settlePosition,
  unrealizedPnl,
  type PositionState,
} from '@/src/research/portfolio/accounting';
import type { SimulatedFill } from '@/src/research/execution/simulatedExchange';

/**
 * Cash, positions and PnL across every market in a run.
 *
 * Exact throughout. A market maker's per-fill edge is a fraction of a cent, so
 * accumulating it in binary floating point across a hundred thousand fills
 * produces drift of the same order as the result being measured.
 */

export interface PositionSnapshot {
  marketTicker: string;
  quantity: string;
  averageEntryPrice: string;
  realizedPnl: string;
  unrealizedPnl: string | null;
  feesPaid: string;
  mark: string | null;
  collateral: string;
  settled: boolean;
}

export interface EquityRow {
  atMs: string;
  cash: string;
  realizedPnl: string;
  unrealizedPnl: string | null;
  grossPnl: string | null;
  netPnl: string | null;
  feesPaid: string;
  netInventory: string;
  absInventory: string;
  collateral: string;
}

export interface PortfolioSnapshot {
  atMs: string;
  cash: string;
  realizedPnl: string;
  unrealizedPnl: string | null;
  feesPaid: string;
  netPnl: string | null;
  grossPnl: string | null;
  netInventory: string;
  absInventory: string;
  collateral: string;
  positions: PositionSnapshot[];
}

export class Portfolio {
  private readonly positions = new Map<string, PositionState>();

  private cashBalance = ZERO;
  private realized = ZERO;
  private fees = ZERO;

  /** Peak absolute inventory summed across markets, and its running integral. */
  private maxAbsInventory = ZERO;
  private inventoryTimeIntegral = ZERO;
  private lastInventoryMs: bigint | null = null;
  private lastAbsInventory = ZERO;

  private maxCollateral = ZERO;
  private peakEquity: Decimal | null = null;
  private maxDrawdownValue = ZERO;

  position(marketTicker: string): PositionState {
    let p = this.positions.get(marketTicker);
    if (!p) {
      p = newPosition(marketTicker);
      this.positions.set(marketTicker, p);
    }
    return p;
  }

  positionQuantity(marketTicker: string): Decimal {
    return this.positions.get(marketTicker)?.quantity ?? ZERO;
  }

  allPositions(): PositionState[] {
    return [...this.positions.values()];
  }

  get cash(): Decimal {
    return this.cashBalance;
  }
  get realizedPnl(): Decimal {
    return this.realized;
  }
  get feesPaid(): Decimal {
    return this.fees;
  }
  get maxAbsoluteInventory(): Decimal {
    return this.maxAbsInventory;
  }
  get maxCollateralUsed(): Decimal {
    return this.maxCollateral;
  }
  get maxDrawdown(): Decimal {
    return this.maxDrawdownValue;
  }

  applyFill(fill: SimulatedFill): void {
    const position = this.position(fill.marketTicker);
    const signed = fill.yesAction === 'buy' ? fill.quantity : fill.quantity.neg();

    const applied = applyFillToPosition(position, signed, fill.yesPrice, fill.fee);
    this.cashBalance = this.cashBalance.plus(applied.cashDelta);
    this.realized = this.realized.plus(applied.realizedDelta);
    this.fees = this.fees.plus(fill.fee);
  }

  /** Settles a market at its terminal outcome. Explicit, never a final mark. */
  settle(marketTicker: string, outcome: 0 | 1): void {
    const position = this.positions.get(marketTicker);
    if (!position || position.settled) return;
    const applied = settlePosition(position, outcome);
    this.cashBalance = this.cashBalance.plus(applied.cashDelta);
    this.realized = this.realized.plus(applied.realizedDelta);
  }

  /**
   * Records inventory and equity at an instant.
   *
   * Called on a coarse grid rather than per event: mean inventory and drawdown
   * are time-weighted statistics, and sampling them on every delta would make
   * them a function of message rate instead of of the strategy.
   */
  mark(atMs: bigint, marks: ReadonlyMap<string, Decimal | null>): void {
    let abs = ZERO;
    let collateral = ZERO;
    let equity = this.cashBalance;
    let marksComplete = true;

    for (const position of this.positions.values()) {
      abs = abs.plus(position.quantity.abs());
      collateral = collateral.plus(collateralRequired(position));
      const mark = marks.get(position.marketTicker) ?? null;
      if (position.quantity.isZero()) continue;
      if (mark === null) {
        marksComplete = false;
        continue;
      }
      equity = equity.plus(position.quantity.mul(mark));
    }

    if (this.lastInventoryMs !== null && atMs > this.lastInventoryMs) {
      const dt = new Decimal((atMs - this.lastInventoryMs).toString());
      this.inventoryTimeIntegral = this.inventoryTimeIntegral.plus(this.lastAbsInventory.mul(dt));
    }
    this.lastInventoryMs = atMs;
    this.lastAbsInventory = abs;

    if (abs.gt(this.maxAbsInventory)) this.maxAbsInventory = abs;
    if (collateral.gt(this.maxCollateral)) this.maxCollateral = collateral;

    // Drawdown is only meaningful when every open position has a mark; a
    // missing mid must not be read as a position worth zero.
    if (!marksComplete) return;
    if (this.peakEquity === null || equity.gt(this.peakEquity)) this.peakEquity = equity;
    const drawdown = this.peakEquity.minus(equity);
    if (drawdown.gt(this.maxDrawdownValue)) this.maxDrawdownValue = drawdown;
  }

  /** Time-weighted mean absolute inventory over the marked interval. */
  meanAbsInventory(firstMs: bigint | null, lastMs: bigint | null): Decimal | null {
    if (firstMs === null || lastMs === null || lastMs <= firstMs) return null;
    const span = new Decimal((lastMs - firstMs).toString());
    return this.inventoryTimeIntegral.div(span);
  }

  /**
   * A compact equity row, for the per-second PnL series.
   *
   * `snapshot()` serializes every position and is far too heavy to call on a
   * one-second grid: a trading day across 24 markets would allocate a couple
   * of million objects to produce a curve with 86,400 points on it.
   */
  equityRow(atMs: bigint, marks: ReadonlyMap<string, Decimal | null>): EquityRow {
    let unrealized: Decimal | null = ZERO;
    let net = ZERO;
    let abs = ZERO;
    let collateral = ZERO;

    for (const position of this.positions.values()) {
      net = net.plus(position.quantity);
      abs = abs.plus(position.quantity.abs());
      collateral = collateral.plus(collateralRequired(position));
      const u = unrealizedPnl(position, marks.get(position.marketTicker) ?? null);
      if (u === null) unrealized = null;
      else if (unrealized !== null) unrealized = unrealized.plus(u);
    }

    const gross = unrealized === null ? null : this.realized.plus(unrealized);
    return {
      atMs: atMs.toString(),
      cash: this.cashBalance.toFixed(6),
      realizedPnl: this.realized.toFixed(6),
      unrealizedPnl: unrealized === null ? null : unrealized.toFixed(6),
      grossPnl: gross === null ? null : gross.toFixed(6),
      netPnl: gross === null ? null : gross.minus(this.fees).toFixed(6),
      feesPaid: this.fees.toFixed(6),
      netInventory: net.toFixed(6),
      absInventory: abs.toFixed(6),
      collateral: collateral.toFixed(6),
    };
  }

  snapshot(atMs: bigint, marks: ReadonlyMap<string, Decimal | null>): PortfolioSnapshot {
    const positions: PositionSnapshot[] = [];
    let unrealizedTotal: Decimal | null = ZERO;
    let net = ZERO;
    let abs = ZERO;
    let collateral = ZERO;

    for (const position of this.positions.values()) {
      const mark = marks.get(position.marketTicker) ?? null;
      const unreal = unrealizedPnl(position, mark);
      if (unreal === null) unrealizedTotal = null;
      else if (unrealizedTotal !== null) unrealizedTotal = unrealizedTotal.plus(unreal);

      net = net.plus(position.quantity);
      abs = abs.plus(position.quantity.abs());
      collateral = collateral.plus(collateralRequired(position));

      positions.push({
        marketTicker: position.marketTicker,
        quantity: position.quantity.toFixed(6),
        averageEntryPrice: position.averageEntryPrice.toFixed(6),
        realizedPnl: position.realizedPnl.toFixed(6),
        unrealizedPnl: unreal === null ? null : unreal.toFixed(6),
        feesPaid: position.feesPaid.toFixed(6),
        mark: mark === null ? null : mark.toFixed(6),
        collateral: collateralRequired(position).toFixed(6),
        settled: position.settled,
      });
    }

    // Realized and unrealized PnL are both GROSS of fees: fees are accumulated
    // separately and deducted from cash. So gross is their sum and net
    // subtracts fees -- which also makes net equal cash plus the marked value
    // of open positions, and that identity is asserted in the tests.
    const grossPnl = unrealizedTotal === null ? null : this.realized.plus(unrealizedTotal);
    const netPnl = grossPnl === null ? null : grossPnl.minus(this.fees);
    return {
      atMs: atMs.toString(),
      cash: this.cashBalance.toFixed(6),
      realizedPnl: this.realized.toFixed(6),
      unrealizedPnl: unrealizedTotal === null ? null : unrealizedTotal.toFixed(6),
      feesPaid: this.fees.toFixed(6),
      netPnl: netPnl === null ? null : netPnl.toFixed(6),
      grossPnl: grossPnl === null ? null : grossPnl.toFixed(6),
      netInventory: net.toFixed(6),
      absInventory: abs.toFixed(6),
      collateral: collateral.toFixed(6),
      positions: positions.sort((a, b) => (a.marketTicker < b.marketTicker ? -1 : 1)),
    };
  }
}
