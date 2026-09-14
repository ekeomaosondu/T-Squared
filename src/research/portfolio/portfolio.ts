import { Decimal, ZERO } from '@/src/book/decimal';
import {
  applyFillToPosition,
  collateralRequired,
  newPosition,
  settlePosition,
  unrealizedPnl,
  voidPosition,
  type PositionResolution,
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
  resolution: PositionResolution;
  settlementPayout: string | null;
}

/**
 * A point on the equity curve.
 *
 * PnL covers the positions that could be PRICED. A one-sided book has no mid,
 * and across two dozen deep strikes at least one is one-sided most of the
 * time; letting a single unpriceable position null the whole total made the
 * headline figure unavailable in practically every run. Nothing is imputed --
 * the unpriced part is counted and reported alongside, so a total is never
 * read as complete when it is not.
 */
export interface EquityRow {
  atMs: string;
  cash: string;
  /** Round-trip trading only. */
  realizedTradingPnl: string;
  /** Crystallised by exchange determinations. */
  settlementPnl: string;
  /** Open positions marked at the last mid. A mark, not a result. */
  unrealizedMarkPnl: string;
  grossPnl: string;
  /**
   * Gross minus fees, or NULL when any fill's fee could not be verified.
   *
   * Null is the point. An unverified fee silently applied as zero produces a
   * number that looks like a result, and someone will quote it.
   */
  netPnl: string | null;
  feesPaid: string;
  feeVerified: boolean;
  netInventory: string;
  absInventory: string;
  collateral: string;
  /** Open positions with no mark. Excluded from the figures above. */
  unmarkedPositions: number;
  unmarkedQuantity: string;
}

export interface PortfolioSnapshot {
  atMs: string;
  cash: string;
  realizedTradingPnl: string;
  settlementPnl: string;
  unrealizedMarkPnl: string;
  feesPaid: string;
  feeVerified: boolean;
  grossPnl: string;
  netPnl: string | null;
  netInventory: string;
  absInventory: string;
  collateral: string;
  positions: PositionSnapshot[];
}

export class Portfolio {
  private readonly positions = new Map<string, PositionState>();

  private cashBalance = ZERO;
  /** Realized PnL from ROUND-TRIP TRADING only. Settlement is separate. */
  private realized = ZERO;
  /** Realized PnL from exchange determinations. */
  private settlement = ZERO;
  private fees = ZERO;
  private unknownFeeFills = 0;

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
  /** PnL crystallised by exchange determinations. */
  get settlementPnl(): Decimal {
    return this.settlement;
  }
  get unknownFeeFillCount(): number {
    return this.unknownFeeFills;
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

  /**
   * Settles a market at the payout the exchange determined.
   *
   * Kept in its OWN PnL bucket. Settlement money and trading money answer
   * different questions: the first says whether the inventory we were left
   * holding happened to be right, the second says whether the market making
   * was any good. A maker that loses on spread and is rescued by a lucky
   * determination has not found an edge, and a single net figure cannot tell
   * you that.
   */
  settle(marketTicker: string, yesPayout: Decimal): void {
    const position = this.positions.get(marketTicker);
    if (!position || position.settled) return;
    const applied = settlePosition(position, yesPayout);
    this.cashBalance = this.cashBalance.plus(applied.cashDelta);
    this.settlement = this.settlement.plus(applied.realizedDelta);
  }

  /** Closes a position in a cancelled market. Returns it at cost, not a payout. */
  voidMarket(marketTicker: string): void {
    const position = this.positions.get(marketTicker);
    if (!position || position.settled) return;
    const applied = voidPosition(position);
    this.cashBalance = this.cashBalance.plus(applied.cashDelta);
  }

  /** Records how an unsettled position finished, for the run report. */
  resolveAs(marketTicker: string, resolution: PositionResolution): void {
    const position = this.positions.get(marketTicker);
    if (!position || position.settled) return;
    position.resolution = resolution;
  }

  /** Fills whose fee could not be verified. See FeeModel. */
  noteUnknownFee(): void {
    this.unknownFeeFills += 1;
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

    for (const position of this.positions.values()) {
      abs = abs.plus(position.quantity.abs());
      collateral = collateral.plus(collateralRequired(position));
      const mark = marks.get(position.marketTicker) ?? null;
      if (position.quantity.isZero()) continue;
      // An unpriceable position contributes nothing rather than voiding the
      // whole curve. See EquityRow: it is counted separately, never imputed.
      if (mark === null) continue;
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
    let unrealized = ZERO;
    let net = ZERO;
    let abs = ZERO;
    let collateral = ZERO;
    let unmarkedPositions = 0;
    let unmarkedQuantity = ZERO;

    for (const position of this.positions.values()) {
      net = net.plus(position.quantity);
      abs = abs.plus(position.quantity.abs());
      collateral = collateral.plus(collateralRequired(position));

      const u = unrealizedPnl(position, marks.get(position.marketTicker) ?? null);
      if (u === null) {
        unmarkedPositions += 1;
        unmarkedQuantity = unmarkedQuantity.plus(position.quantity.abs());
        continue;
      }
      unrealized = unrealized.plus(u);
    }

    const gross = this.realized.plus(this.settlement).plus(unrealized);
    const feeVerified = this.unknownFeeFills === 0;

    return {
      atMs: atMs.toString(),
      cash: this.cashBalance.toFixed(6),
      realizedTradingPnl: this.realized.toFixed(6),
      settlementPnl: this.settlement.toFixed(6),
      unrealizedMarkPnl: unrealized.toFixed(6),
      grossPnl: gross.toFixed(6),
      netPnl: feeVerified ? gross.minus(this.fees).toFixed(6) : null,
      feesPaid: this.fees.toFixed(6),
      feeVerified,
      netInventory: net.toFixed(6),
      absInventory: abs.toFixed(6),
      collateral: collateral.toFixed(6),
      unmarkedPositions,
      unmarkedQuantity: unmarkedQuantity.toFixed(6),
    };
  }

  snapshot(atMs: bigint, marks: ReadonlyMap<string, Decimal | null>): PortfolioSnapshot {
    const positions: PositionSnapshot[] = [];
    let unrealized = ZERO;
    let net = ZERO;
    let abs = ZERO;
    let collateral = ZERO;

    for (const position of this.positions.values()) {
      const mark = marks.get(position.marketTicker) ?? null;
      const unreal = unrealizedPnl(position, mark);
      if (unreal !== null) unrealized = unrealized.plus(unreal);

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
        resolution: position.resolution,
        settlementPayout: position.settlementPayout?.toFixed(6) ?? null,
      });
    }

    const gross = this.realized.plus(this.settlement).plus(unrealized);
    const feeVerified = this.unknownFeeFills === 0;

    return {
      atMs: atMs.toString(),
      cash: this.cashBalance.toFixed(6),
      realizedTradingPnl: this.realized.toFixed(6),
      settlementPnl: this.settlement.toFixed(6),
      unrealizedMarkPnl: unrealized.toFixed(6),
      feesPaid: this.fees.toFixed(6),
      feeVerified,
      grossPnl: gross.toFixed(6),
      netPnl: feeVerified ? gross.minus(this.fees).toFixed(6) : null,
      netInventory: net.toFixed(6),
      absInventory: abs.toFixed(6),
      collateral: collateral.toFixed(6),
      positions: positions.sort((a, b) => (a.marketTicker < b.marketTicker ? -1 : 1)),
    };
  }
}
