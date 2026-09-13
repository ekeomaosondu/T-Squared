import { Decimal } from '@/src/book/decimal';

/**
 * Latest non-book market facts, kept alongside the reconstructed book so a
 * sample can carry last-trade and volume context without a database round trip
 * on the sampling path.
 *
 * These come from the exchange (trade and ticker channels) and are stored as
 * Decimals. Nothing here is inferred.
 */
export interface MarketState {
  lastTradePrice: Decimal | null;
  lastTradeCount: Decimal | null;
  lastTradeAtMs: number | null;
  volume: Decimal | null;
  openInterest: Decimal | null;
  tickerYesBid: Decimal | null;
  tickerYesAsk: Decimal | null;
  updatedAtMs: number;
}

export class MarketStateCache {
  private readonly states = new Map<string, MarketState>();

  get(marketTicker: string): MarketState | undefined {
    return this.states.get(marketTicker);
  }

  private ensure(marketTicker: string): MarketState {
    let s = this.states.get(marketTicker);
    if (!s) {
      s = {
        lastTradePrice: null,
        lastTradeCount: null,
        lastTradeAtMs: null,
        volume: null,
        openInterest: null,
        tickerYesBid: null,
        tickerYesAsk: null,
        updatedAtMs: 0,
      };
      this.states.set(marketTicker, s);
    }
    return s;
  }

  recordTrade(marketTicker: string, yesPrice: string, count: string, atMs: number): void {
    const s = this.ensure(marketTicker);
    s.lastTradePrice = new Decimal(yesPrice);
    s.lastTradeCount = new Decimal(count);
    s.lastTradeAtMs = atMs;
    s.updatedAtMs = atMs;
  }

  recordTicker(
    marketTicker: string,
    fields: {
      volume?: string | null;
      openInterest?: string | null;
      yesBid?: string | null;
      yesAsk?: string | null;
      lastPrice?: string | null;
    },
    atMs: number,
  ): void {
    const s = this.ensure(marketTicker);
    if (fields.volume != null) s.volume = new Decimal(fields.volume);
    if (fields.openInterest != null) s.openInterest = new Decimal(fields.openInterest);
    if (fields.yesBid != null) s.tickerYesBid = new Decimal(fields.yesBid);
    if (fields.yesAsk != null) s.tickerYesAsk = new Decimal(fields.yesAsk);
    if (fields.lastPrice != null && s.lastTradePrice === null) {
      s.lastTradePrice = new Decimal(fields.lastPrice);
    }
    s.updatedAtMs = atMs;
  }

  remove(marketTicker: string): void {
    this.states.delete(marketTicker);
  }

  clear(): void {
    this.states.clear();
  }

  get size(): number {
    return this.states.size;
  }
}
