import { Decimal, D, ONE, ZERO, canonicalPrice, type DecimalInput } from '@/src/book/decimal';
import type { TwoSidedBbo } from '@/src/research/engine/marketState';
import type { CaptureGapEvent } from '@/src/research/events/researchEvent';
import type { OrderUpdate } from '@/src/research/execution/executionAdapter';
import { BaseStrategy } from '@/src/research/strategy/strategy';
import type { MarketState, StrategyContext } from '@/src/research/strategy/context';

/**
 * Shared two-sided quoting machinery.
 *
 * The three benchmark strategies differ ONLY in what prices they want to show.
 * Everything else -- when to pull quotes, how to reprice, how orders are
 * identified, what happens on a data gap -- is here, identical for all of
 * them.
 *
 * That is deliberate and it is the point of the benchmark set. If each
 * strategy managed its own orders, a difference in the comparison table could
 * come from a difference in order handling rather than from the quoting idea
 * being tested, and the comparison would be worthless.
 *
 * ---------------------------------------------------------------------------
 * How quotes are expressed
 * ---------------------------------------------------------------------------
 * A bid is a YES buy. An offer is submitted as a NO BUY at (1 - price), which
 * is what a Kalshi offer physically is, rather than as a synthetic "YES sell".
 * The normalization back to a signed YES position happens once, in the order
 * layer, so the strategies read as a market maker would describe them.
 */

export interface QuotingParams {
  /** Contracts per quote. */
  size: DecimalInput;
  /** Maximum absolute signed YES position per market. */
  maxInventory: DecimalInput;
  /** Do not quote at all when the market's spread is below this, in cents. */
  minSpreadCents: number;
  /** Reprice when the target moves at least this far, in cents. */
  repriceThresholdCents: number;
  /** Markets to quote. Empty means every market in the run's universe. */
  marketTickers?: string[];
}

export const QUOTING_DEFAULTS: QuotingParams = {
  size: '10',
  maxInventory: '50',
  minSpreadCents: 2,
  repriceThresholdCents: 1,
};

export interface DesiredQuote {
  /** YES price to bid at, or null to show no bid. */
  bid: Decimal | null;
  /** YES price to offer at, or null to show no offer. */
  ask: Decimal | null;
}

interface WorkingQuote {
  clientOrderId: string;
  yesPrice: Decimal;
}

export abstract class QuotingStrategy extends BaseStrategy {
  protected readonly params: QuotingParams;

  private readonly working = new Map<string, WorkingQuote>();
  private seq = 0;
  private quotable: Set<string> | null = null;

  protected constructor(params: Partial<QuotingParams> = {}) {
    super();
    this.params = { ...QUOTING_DEFAULTS, ...params };
  }

  parameters(): Record<string, unknown> {
    return {
      size: D(this.params.size).toString(),
      maxInventory: D(this.params.maxInventory).toString(),
      minSpreadCents: this.params.minSpreadCents,
      repriceThresholdCents: this.params.repriceThresholdCents,
      marketTickers: this.params.marketTickers ?? null,
      ...this.extraParameters(),
    };
  }

  /** Parameters specific to the subclass, merged into the manifest. */
  protected extraParameters(): Record<string, unknown> {
    return {};
  }

  /**
   * The prices this strategy wants to show, given a valid two-sided book.
   *
   * Returning null for a side means "show nothing there". Inventory limits are
   * applied by the base class AFTER this, so a subclass never has to remember
   * them.
   */
  protected abstract desiredQuotes(
    state: MarketState,
    bbo: TwoSidedBbo,
    ctx: StrategyContext,
  ): DesiredQuote;

  onStart(ctx: StrategyContext): void {
    const configured = this.params.marketTickers;
    this.quotable = configured && configured.length > 0 ? new Set(configured) : null;
    ctx.log('start', { markets: ctx.markets().length, params: this.parameters() });
  }

  onBookUpdate(event: { marketTicker?: string }, ctx: StrategyContext): void {
    const ticker = event.marketTicker;
    if (!ticker) return;
    if (this.quotable && !this.quotable.has(ticker)) return;
    this.requote(ticker, ctx);
  }

  onOrderUpdate(update: OrderUpdate, ctx: StrategyContext): void {
    if (update.status === 'filled' || update.status === 'cancelled' || update.status === 'rejected') {
      for (const [key, quote] of this.working) {
        if (quote.clientOrderId === update.clientOrderId) this.working.delete(key);
      }
    }
    void ctx;
  }

  onDataGap(event: CaptureGapEvent, ctx: StrategyContext): void {
    // The exchange has already cancelled these under the default policy; the
    // strategy drops its own record so it does not try to replace an order
    // that no longer exists.
    const affected = new Set(event.affectedMarkets);
    for (const key of [...this.working.keys()]) {
      const ticker = key.slice(0, key.lastIndexOf('|'));
      if (affected.size === 0 || affected.has(ticker)) this.working.delete(key);
    }
    ctx.log('data_gap', { markets: event.affectedMarkets.length, reason: event.reason });
  }

  onDataResume(marketTicker: string, ctx: StrategyContext): void {
    ctx.log('data_resume', { market: marketTicker });
  }

  // -------------------------------------------------------------------------

  private requote(ticker: string, ctx: StrategyContext): void {
    const state = ctx.state(ticker);

    // No book we can vouch for means no quotes. Not "keep the last ones a
    // little longer": a stale quote in a market that has moved is precisely
    // the order that gets picked off.
    if (!state || !state.valid) return this.pullAll(ticker, ctx);

    const bbo = state.book.bbo();
    if (bbo.bid === null || bbo.ask === null || bbo.spread === null) {
      return this.pullAll(ticker, ctx);
    }
    if (bbo.spread.mul(100).lt(this.params.minSpreadCents)) return this.pullAll(ticker, ctx);

    const desired = this.desiredQuotes(
      state,
      bbo as TwoSidedBbo,
      ctx,
    );

    const position = ctx.position(ticker);
    const size = D(this.params.size);
    const maxInventory = D(this.params.maxInventory);

    // A quote is suppressed when filling it would breach the limit. Checked
    // against the position the fill WOULD create, not the current one.
    const bid = position.plus(size).abs().gt(maxInventory) ? null : desired.bid;
    const ask = position.minus(size).abs().gt(maxInventory) ? null : desired.ask;

    this.reconcile(ticker, 'bid', bid, ctx);
    this.reconcile(ticker, 'ask', ask, ctx);
  }

  private reconcile(
    ticker: string,
    side: 'bid' | 'ask',
    target: Decimal | null,
    ctx: StrategyContext,
  ): void {
    const key = `${ticker}|${side}`;
    const current = this.working.get(key);

    if (target === null) {
      if (current) {
        ctx.orders.cancel(current.clientOrderId);
        this.working.delete(key);
      }
      return;
    }

    if (current) {
      const moved = current.yesPrice.minus(target).abs().mul(100);
      if (moved.lt(this.params.repriceThresholdCents)) return;
      const next = this.nextClientOrderId(ticker, side);
      ctx.orders.replace(current.clientOrderId, next, { price: this.submitPrice(side, target) });
      this.working.set(key, { clientOrderId: next, yesPrice: target });
      return;
    }

    const clientOrderId = this.nextClientOrderId(ticker, side);
    ctx.orders.submit({
      type: 'limit',
      marketTicker: ticker,
      // An offer on Kalshi is a NO buy at the complement. Submitting it that
      // way keeps the simulated order identical to the live one.
      side: side === 'bid' ? 'yes' : 'no',
      action: 'buy',
      price: this.submitPrice(side, target),
      quantity: D(this.params.size),
      clientOrderId,
      tag: side,
    });
    this.working.set(key, { clientOrderId, yesPrice: target });
  }

  private submitPrice(side: 'bid' | 'ask', yesPrice: Decimal): Decimal {
    return side === 'bid' ? yesPrice : ONE.minus(yesPrice);
  }

  private pullAll(ticker: string, ctx: StrategyContext): void {
    for (const side of ['bid', 'ask'] as const) {
      const key = `${ticker}|${side}`;
      const current = this.working.get(key);
      if (!current) continue;
      ctx.orders.cancel(current.clientOrderId);
      this.working.delete(key);
    }
  }

  private nextClientOrderId(ticker: string, side: string): string {
    return `${this.name}:${ticker}:${side}:${++this.seq}`;
  }

  /** Rounds a YES price to the cent grid Kalshi actually quotes on. */
  protected toCentGrid(price: Decimal, direction: 'down' | 'up'): Decimal {
    const cents = price.mul(100);
    const rounded = direction === 'down' ? cents.floor() : cents.ceil();
    return D(canonicalPrice(rounded.div(100)));
  }

  /** Clamps a YES price into the tradable interval. */
  protected clampPrice(price: Decimal): Decimal | null {
    if (price.lte(ZERO) || price.gte(ONE)) return null;
    return price;
  }
}
