import { describe, expect, it } from 'vitest';
import { Decimal } from '@/src/book/decimal';
import { MemoryHistoricalDataSource } from '@/src/research/data/memorySource';
import { BacktestEngine } from '@/src/research/engine/backtestEngine';
import { BaseStrategy } from '@/src/research/strategy/strategy';
import type { StrategyContext } from '@/src/research/strategy/context';
import type { OrderIntent } from '@/src/research/strategy/orderIntent';
import type { ResearchEvent } from '@/src/research/events/researchEvent';
import type { Fill } from '@/src/research/execution/executionAdapter';
import { TouchFillModel } from '@/src/research/execution/fills/touchFillModel';
import { ConservativeQueueModel } from '@/src/research/execution/fills/conservativeQueueModel';
import { ZeroFeeModel } from '@/src/research/portfolio/fees';
import { FixedLatencyModel, ZeroLatencyModel } from '@/src/research/execution/latencyModel';
import { MARKET, delta, resetOrdinals, snapshot, trade } from './fixtures';

const request = { datasetId: 'test', startTime: new Date(0), endTime: new Date(1_000_000) };

/** Fires a scripted list of intents at fixed simulated instants. */
class Scripted extends BaseStrategy {
  readonly name = 'scripted';
  readonly fills: Fill[] = [];
  private fired = new Set<number>();

  constructor(private readonly script: { atMs: number; intent: OrderIntent }[]) {
    super();
  }

  private pump(ctx: StrategyContext): void {
    const now = Number(ctx.clock.nowMs());
    for (const [i, step] of this.script.entries()) {
      if (this.fired.has(i) || now < step.atMs) continue;
      this.fired.add(i);
      ctx.orders.submit(step.intent);
    }
  }

  onBookUpdate(_e: unknown, ctx: StrategyContext): void {
    this.pump(ctx);
  }
  onTrade(_e: unknown, ctx: StrategyContext): void {
    this.pump(ctx);
  }
  onFill(fill: Fill): void {
    this.fills.push(fill);
  }
}

async function runScript(
  events: ResearchEvent[],
  script: { atMs: number; intent: OrderIntent }[],
  opts: { latencyMs?: number; conservative?: boolean } = {},
) {
  const strategy = new Scripted(script);
  const engine = new BacktestEngine({
    source: new MemoryHistoricalDataSource(events),
    request,
    strategy,
    fillModel: opts.conservative ? new ConservativeQueueModel() : new TouchFillModel(),
    feeModel: new ZeroFeeModel(),
    latency: opts.latencyMs ? FixedLatencyModel.uniform(opts.latencyMs) : new ZeroLatencyModel(),
    verifyCheckpoints: false,
  });
  return { strategy, result: await engine.run() };
}

/** A book with three YES ask levels: 45 x 20, 46 x 30, 47 x 100. */
function laddered(): ResearchEvent[] {
  resetOrdinals();
  return [
    snapshot(
      1_000,
      [['0.400000', '50.000000']],
      [
        ['0.550000', '20.000000'],
        ['0.540000', '30.000000'],
        ['0.530000', '100.000000'],
      ],
    ),
    delta(2_000, 'yes', '0.390000', '10', '0'),
    delta(3_000, 'yes', '0.380000', '10', '0'),
  ];
}

describe('taker execution', () => {
  it('walks the ladder instead of assuming size at the touch', async () => {
    const { strategy, result } = await runScript(laddered(), [
      {
        atMs: 2_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.47'),
          quantity: new Decimal(40),
          clientOrderId: 'taker',
        },
      },
    ]);

    // 20 at 0.45, then 20 of the 30 available at 0.46.
    const prices = strategy.fills.map((f) => [f.yesPrice.toFixed(2), f.quantity.toFixed(0)]);
    expect(prices).toEqual([
      ['0.45', '20'],
      ['0.46', '20'],
    ]);
    expect(strategy.fills.every((f) => f.liquidity === 'taker')).toBe(true);
    // The fill REASON is simulator-only knowledge: it is absent from the `Fill`
    // a strategy receives and present on the record the metrics pipeline reads.
    // That asymmetry is the point, so the assertion reads it from the result.
    expect(result.fills.every((f) => f.reason === 'cross')).toBe(true);
  });

  it('stops at the limit price rather than paying through it', async () => {
    const { strategy } = await runScript(laddered(), [
      {
        atMs: 2_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.45'),
          quantity: new Decimal(100),
          clientOrderId: 'taker',
        },
      },
    ]);
    expect(strategy.fills).toHaveLength(1);
    expect(strategy.fills[0]!.quantity.toFixed(0)).toBe('20');
  });

  it('rests the unfilled remainder of a limit order', async () => {
    const { result } = await runScript(laddered(), [
      {
        atMs: 2_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.45'),
          quantity: new Decimal(100),
          clientOrderId: 'taker',
        },
      },
    ]);
    const order = result.orders.find((o) => o.clientOrderId === 'taker')!;
    expect(order.restedAtMs).not.toBeNull();
    expect(order.filledQuantity.toFixed(0)).toBe('20');
  });
});

describe('passive execution', () => {
  it('fills a resting bid only when the taker SOLD yes', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, [['0.400000', '0.000001']], [['0.550000', '50.000000']]),
      // Taker BUYS yes at our bid price. That consumes asks, not our bid.
      trade(3_000, '0.400000', '25', 'yes'),
      // Taker SELLS yes into the bid. This is the one that reaches us.
      trade(4_000, '0.400000', '25', 'no'),
    ];
    const { strategy } = await runScript(events, [
      {
        atMs: 1_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.40'),
          quantity: new Decimal(10),
          clientOrderId: 'bid',
        },
      },
    ]);
    expect(strategy.fills).toHaveLength(1);
    expect(strategy.fills[0]!.filledAtMs).toBe(4_000n);
    expect(strategy.fills[0]!.liquidity).toBe('maker');
  });

  it('never fills a maker order at the print price when its own is better', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, [['0.300000', '10.000000']], [['0.550000', '50.000000']]),
      // We are bid 0.42; the market trades at 0.40, straight through us.
      trade(3_000, '0.400000', '25', 'no'),
    ];
    const { strategy, result } = await runScript(events, [
      {
        atMs: 1_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.42'),
          quantity: new Decimal(10),
          clientOrderId: 'bid',
        },
      },
    ]);
    expect(strategy.fills).toHaveLength(1);
    expect(result.fills[0]!.reason).toBe('trade_through');
    // Our price, not the print's. Crediting the print would hand the strategy
    // two cents it never earned.
    expect(strategy.fills[0]!.yesPrice.toFixed(2)).toBe('0.42');
  });

  it('treats an offer submitted as a NO buy as a signed YES sale', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, [['0.400000', '50.000000']], [['0.550000', '0.000001']]),
      trade(3_000, '0.450000', '25', 'yes'),
    ];
    const { strategy, result } = await runScript(events, [
      {
        atMs: 1_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          // A Kalshi offer at 0.45 YES is a NO buy at 0.55.
          side: 'no',
          action: 'buy',
          price: new Decimal('0.55'),
          quantity: new Decimal(10),
          clientOrderId: 'offer',
        },
      },
    ]);
    expect(strategy.fills).toHaveLength(1);
    expect(strategy.fills[0]!.yesAction).toBe('sell');
    expect(strategy.fills[0]!.yesPrice.toFixed(2)).toBe('0.45');
    expect(strategy.fills[0]!.price.toFixed(2)).toBe('0.55');
    expect(result.portfolio.positionQuantity(MARKET).toFixed(0)).toBe('-10');
  });

  it('can be filled while a cancel is in flight', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      snapshot(1_000, [['0.400000', '0.000001']], [['0.550000', '50.000000']]),
      delta(2_000, 'yes', '0.390000', '5', '0'),
      trade(3_050, '0.400000', '25', 'no'),
      delta(4_000, 'yes', '0.380000', '5', '0'),
    ];

    class CancelRacer extends BaseStrategy {
      readonly name = 'cancel-racer';
      readonly fills: Fill[] = [];
      private submitted = false;
      private cancelled = false;

      onBookUpdate(_e: unknown, ctx: StrategyContext): void {
        if (!this.submitted) {
          this.submitted = true;
          ctx.orders.submit({
            type: 'limit',
            marketTicker: MARKET,
            side: 'yes',
            action: 'buy',
            price: new Decimal('0.40'),
            quantity: new Decimal(10),
            clientOrderId: 'racer',
          });
          return;
        }
        // Cancel at 2000, effective at 2000 + 100 + ... but the print lands at
        // 3050. The cancel wins only if latency lets it.
        if (!this.cancelled && ctx.clock.nowMs() >= 2_000n) {
          this.cancelled = true;
          ctx.orders.cancel('racer');
        }
      }
      onFill(fill: Fill): void {
        this.fills.push(fill);
      }
    }

    const slow = new CancelRacer();
    await new BacktestEngine({
      source: new MemoryHistoricalDataSource(events),
      request,
      strategy: slow,
      fillModel: new TouchFillModel(),
      feeModel: new ZeroFeeModel(),
      // A 2-second cancel latency loses the race with the 3050 print.
      latency: new FixedLatencyModel({
        marketDataMs: 0,
        decisionMs: 0,
        submitMs: 0,
        cancelMs: 2_000,
      }),
      verifyCheckpoints: false,
    }).run();
    expect(slow.fills).toHaveLength(1);

    const fast = new CancelRacer();
    await new BacktestEngine({
      source: new MemoryHistoricalDataSource(events),
      request,
      strategy: fast,
      fillModel: new TouchFillModel(),
      feeModel: new ZeroFeeModel(),
      latency: FixedLatencyModel.uniform(10),
      verifyCheckpoints: false,
    }).run();
    expect(fast.fills).toHaveLength(0);
  });

  it('rejects an order arriving into a book it cannot vouch for', async () => {
    resetOrdinals();
    const events: ResearchEvent[] = [
      // No snapshot at all: the book was never seeded.
      delta(1_000, 'yes', '0.400000', '10', '0'),
      delta(2_000, 'yes', '0.410000', '10', '0'),
      delta(3_000, 'yes', '0.420000', '10', '0'),
    ];
    const { result } = await runScript(events, [
      {
        atMs: 1_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.40'),
          quantity: new Decimal(10),
          clientOrderId: 'blind',
        },
      },
    ]);
    // Nothing was submitted, because no book update ever reached the strategy.
    expect(result.orders.filter((o) => o.status === 'filled')).toHaveLength(0);
    expect(result.bookStats.deltasSkippedInvalidBook).toBe(3);
  });

  it('rejects a duplicate client order id rather than shadowing the first', async () => {
    const { result } = await runScript(laddered(), [
      {
        atMs: 2_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.20'),
          quantity: new Decimal(10),
          clientOrderId: 'dupe',
        },
      },
      {
        atMs: 3_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.21'),
          quantity: new Decimal(10),
          clientOrderId: 'dupe',
        },
      },
    ]);
    expect(result.orders.filter((o) => o.clientOrderId === 'dupe')).toHaveLength(1);
  });

  it('cancels everything still working when the run ends', async () => {
    const { result } = await runScript(laddered(), [
      {
        atMs: 2_000,
        intent: {
          type: 'limit',
          marketTicker: MARKET,
          side: 'yes',
          action: 'buy',
          price: new Decimal('0.20'),
          quantity: new Decimal(10),
          clientOrderId: 'leftover',
        },
      },
    ]);
    const order = result.orders.find((o) => o.clientOrderId === 'leftover')!;
    expect(order.status).toBe('cancelled');
  });
});
