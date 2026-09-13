import { randomUUID } from 'node:crypto';
import type { KalshiWebSocketClient } from '@/src/kalshi/websocketClient';
import { logger } from '@/src/logging/logger';

/**
 * Tracks Kalshi subscriptions for one connection.
 *
 * A `sid` is assigned by the server per subscription and is only meaningful
 * within that connection, so every sid is bound to a locally generated
 * stream_id that carries the session identity with it. Nothing here survives a
 * reconnect: a new connection produces new streams, and therefore a new
 * sequence epoch.
 *
 * Kalshi enforces a per-subscription market limit (error code 26), so a large
 * universe is sharded across several subscriptions on the same channel.
 */

export const DEFAULT_MARKETS_PER_SUBSCRIPTION = 400;

export interface Subscription {
  streamId: string;
  channel: string;
  /** Null until the server's `subscribed` response arrives. */
  sid: number | null;
  markets: Set<string>;
  /** Command id of the in-flight subscribe, used to bind the response. */
  pendingCommandId: number | null;
  createdAt: number;
}

export class SubscriptionManager {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly bySid = new Map<number, Subscription>();
  private readonly byCommandId = new Map<number, Subscription>();
  /** market_ticker -> streamIds carrying it, per channel. */
  private readonly marketIndex = new Map<string, Set<string>>();

  constructor(
    private readonly ws: KalshiWebSocketClient,
    private readonly maxMarketsPerSubscription = DEFAULT_MARKETS_PER_SUBSCRIPTION,
  ) {}

  all(): Subscription[] {
    return [...this.subscriptions.values()];
  }

  forChannel(channel: string): Subscription[] {
    return this.all().filter((s) => s.channel === channel);
  }

  bySidOrNull(sid: number): Subscription | null {
    return this.bySid.get(sid) ?? null;
  }

  byStreamId(streamId: string): Subscription | null {
    return this.subscriptions.get(streamId) ?? null;
  }

  /** Streams currently carrying a market on the given channel. */
  streamsForMarket(marketTicker: string, channel?: string): Subscription[] {
    const ids = this.marketIndex.get(marketTicker) ?? new Set();
    return [...ids]
      .map((id) => this.subscriptions.get(id))
      .filter((s): s is Subscription => !!s && (channel === undefined || s.channel === channel));
  }

  get size(): number {
    return this.subscriptions.size;
  }

  /**
   * Subscribes a channel to a set of markets, sharding as needed.
   * Returns the created subscriptions so the caller can persist streams.
   */
  subscribe(channel: string, markets: string[]): Subscription[] {
    const created: Subscription[] = [];

    // A channel with no market scoping (e.g. lifecycle) subscribes once.
    const chunks =
      markets.length === 0 ? [[]] : chunk(markets, this.maxMarketsPerSubscription);

    for (const slice of chunks) {
      const sub: Subscription = {
        streamId: randomUUID(),
        channel,
        sid: null,
        markets: new Set(slice),
        pendingCommandId: null,
        createdAt: Date.now(),
      };

      const commandId = this.ws.subscribe([channel], slice);
      sub.pendingCommandId = commandId;

      this.subscriptions.set(sub.streamId, sub);
      this.byCommandId.set(commandId, sub);
      for (const m of slice) this.indexMarket(m, sub.streamId);

      created.push(sub);
      logger.info(
        { event: 'subscription_requested', channel, stream_id: sub.streamId, marketCount: slice.length },
        'requested subscription',
      );
    }

    return created;
  }

  /** Binds the server-assigned sid from a `subscribed` response. */
  bindSid(commandId: number | undefined, sid: number, channel: string): Subscription | null {
    const sub =
      (commandId !== undefined ? this.byCommandId.get(commandId) : undefined) ??
      this.forChannel(channel).find((s) => s.sid === null);

    if (!sub) {
      logger.warn(
        { event: 'subscribed_unmatched', sid, channel, id: commandId },
        'received subscribed response that matches no pending subscription',
      );
      return null;
    }

    sub.sid = sid;
    sub.pendingCommandId = null;
    if (commandId !== undefined) this.byCommandId.delete(commandId);
    this.bySid.set(sid, sub);

    logger.info(
      { event: 'subscription_active', channel, sid, stream_id: sub.streamId, marketCount: sub.markets.size },
      'subscription active',
    );
    return sub;
  }

  /**
   * Adds markets to a channel, filling existing subscriptions up to the limit
   * before opening new ones.
   */
  addMarkets(channel: string, markets: string[]): { updated: Subscription[]; created: Subscription[] } {
    const updated: Subscription[] = [];
    const remaining = markets.filter((m) => this.streamsForMarket(m, channel).length === 0);

    for (const sub of this.forChannel(channel)) {
      if (remaining.length === 0) break;
      if (sub.sid === null) continue; // cannot update until bound

      const capacity = this.maxMarketsPerSubscription - sub.markets.size;
      if (capacity <= 0) continue;

      const take = remaining.splice(0, capacity);
      this.ws.addMarkets([sub.sid], take);
      for (const m of take) {
        sub.markets.add(m);
        this.indexMarket(m, sub.streamId);
      }
      updated.push(sub);

      logger.info(
        { event: 'subscription_markets_added', channel, sid: sub.sid, added: take.length },
        'added markets to subscription',
      );
    }

    const created = remaining.length > 0 ? this.subscribe(channel, remaining) : [];
    return { updated, created };
  }

  removeMarkets(channel: string, markets: string[]): Subscription[] {
    const touched = new Map<string, Subscription>();

    for (const market of markets) {
      for (const sub of this.streamsForMarket(market, channel)) {
        if (sub.sid === null) continue;
        sub.markets.delete(market);
        this.unindexMarket(market, sub.streamId);
        touched.set(sub.streamId, sub);
      }
    }

    for (const sub of touched.values()) {
      const removed = markets.filter((m) => !sub.markets.has(m));
      if (removed.length > 0 && sub.sid !== null) {
        this.ws.deleteMarkets([sub.sid], removed);
        logger.info(
          { event: 'subscription_markets_removed', channel, sid: sub.sid, removed: removed.length },
          'removed markets from subscription',
        );
      }
    }

    return [...touched.values()];
  }

  /**
   * Requests fresh snapshots without altering the subscription. This is the
   * recovery primitive after a sequence gap or an invariant violation.
   */
  requestSnapshots(markets: string[], channel = 'orderbook_delta'): number {
    const bySub = new Map<number, string[]>();

    for (const market of markets) {
      for (const sub of this.streamsForMarket(market, channel)) {
        if (sub.sid === null) continue;
        const list = bySub.get(sub.sid) ?? [];
        list.push(market);
        bySub.set(sub.sid, list);
      }
    }

    let requested = 0;
    for (const [sid, list] of bySub) {
      this.ws.requestSnapshot([sid], list);
      requested += list.length;
      logger.info(
        { event: 'snapshot_requested', sid, marketCount: list.length },
        'requested recovery snapshots',
      );
    }
    return requested;
  }

  /** Clears all state. Called when a connection ends; nothing is reused. */
  reset(): Subscription[] {
    const all = this.all();
    this.subscriptions.clear();
    this.bySid.clear();
    this.byCommandId.clear();
    this.marketIndex.clear();
    return all;
  }

  private indexMarket(market: string, streamId: string): void {
    const set = this.marketIndex.get(market) ?? new Set<string>();
    set.add(streamId);
    this.marketIndex.set(market, set);
  }

  private unindexMarket(market: string, streamId: string): void {
    const set = this.marketIndex.get(market);
    if (!set) return;
    set.delete(streamId);
    if (set.size === 0) this.marketIndex.delete(market);
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
