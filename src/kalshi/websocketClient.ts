import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { KalshiSigner } from '@/src/kalshi/auth';
import { WsEnvelope, type OutboundCommand } from '@/src/kalshi/schemas';
import { logger } from '@/src/logging/logger';

/**
 * Kalshi market-data WebSocket client.
 *
 * Scope is deliberately narrow: connect, authenticate, subscribe, and surface
 * every frame with an accurate receipt timestamp. It owns NO book state and NO
 * database access, so it can be driven identically by the daemon, by a Vercel
 * rolling session, and by tests with a fake server.
 *
 * The receipt clock is read at the very top of the message handler, before any
 * parsing, so `received_at_ms` measures when the bytes arrived rather than when
 * we got around to them.
 */

const WS_PATH = '/trade-api/ws/v2';

/** Reconnect schedule in seconds, per the recorder spec. Jitter is applied. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const;

export interface RawFrame {
  /** Wall clock at receipt. */
  receivedAt: Date;
  receivedAtMs: number;
  /** Monotonic clock; only comparable within one process. */
  recvMonotonicNs: bigint;
  /** The verbatim text frame. */
  text: string;
  /** Envelope after minimal parsing; null when the frame was not valid JSON. */
  envelope: WsEnvelope | null;
  parseError?: string;
}

export type WsClientState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

export interface WebSocketClientOptions {
  url: string;
  signer: KalshiSigner;
  /** Kalshi closes idle connections; we ping well inside that window. */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Test seam for injecting a fake WebSocket implementation. */
  webSocketImpl?: typeof WebSocket;
  maxReconnectAttempts?: number;
}

export interface KalshiWebSocketClientEvents {
  frame: [RawFrame];
  open: [{ attempt: number; url: string }];
  close: [{ code: number; reason: string; wasClean: boolean }];
  error: [Error];
  reconnecting: [{ attempt: number; delayMs: number; reason: string }];
}

export class KalshiWebSocketClient extends EventEmitter {
  // Typed event surface. Declared as overrides rather than by merging an
  // interface into the class, which is unsound in the general case.
  override on<K extends keyof KalshiWebSocketClientEvents>(
    event: K,
    listener: (...args: KalshiWebSocketClientEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof KalshiWebSocketClientEvents>(
    event: K,
    listener: (...args: KalshiWebSocketClientEvents[K]) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof KalshiWebSocketClientEvents>(
    event: K,
    ...args: KalshiWebSocketClientEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  private ws: WebSocket | null = null;
  private state: WsClientState = 'idle';

  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  private nextCommandId = 1;
  private reconnectAttempt = 0;
  private shuttingDown = false;

  private readonly opts: Required<Omit<WebSocketClientOptions, 'signer' | 'webSocketImpl'>> & {
    signer: KalshiSigner;
    webSocketImpl: typeof WebSocket;
  };

  constructor(options: WebSocketClientOptions) {
    super();
    this.opts = {
      url: options.url,
      signer: options.signer,
      pingIntervalMs: options.pingIntervalMs ?? 10_000,
      pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY,
      webSocketImpl: options.webSocketImpl ?? WebSocket,
    };
  }

  getState(): WsClientState {
    return this.state;
  }

  get url(): string {
    return this.opts.url;
  }

  get isOpen(): boolean {
    return this.state === 'open' && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Monotonically increasing command id, echoed back in responses. */
  allocateCommandId(): number {
    return this.nextCommandId++;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.state === 'open' || this.state === 'connecting') return;
    this.shuttingDown = false;
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    this.state = 'connecting';

    // The upgrade request is signed exactly like a REST GET on the WS path.
    const headers = this.opts.signer.headers('GET', WS_PATH);

    const ws = new this.opts.webSocketImpl(this.opts.url, {
      headers,
      handshakeTimeout: this.opts.connectTimeoutMs,
      // Kalshi sends large snapshot frames for deep books.
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = (code: number, reason: Buffer) => {
        cleanup();
        reject(new Error(`socket closed during handshake: ${code} ${reason.toString()}`));
      };
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.once('close', onClose);
    });

    this.state = 'open';
    this.reconnectAttempt = 0;
    this.attachHandlers(ws);
    this.startHeartbeat();

    logger.info({ event: 'ws_connected', url: this.opts.url }, 'websocket connected');
    this.emit('open', { attempt: this.reconnectAttempt, url: this.opts.url });
  }

  private attachHandlers(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      // Clock first. Everything else can wait.
      const receivedAtMs = Date.now();
      const recvMonotonicNs = process.hrtime.bigint();

      const text = typeof data === 'string' ? data : data.toString('utf8');

      let envelope: WsEnvelope | null = null;
      let parseError: string | undefined;
      try {
        const parsed = WsEnvelope.safeParse(JSON.parse(text));
        if (parsed.success) envelope = parsed.data;
        else parseError = parsed.error.issues.map((i) => i.message).join('; ');
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }

      this.emit('frame', {
        receivedAt: new Date(receivedAtMs),
        receivedAtMs,
        recvMonotonicNs,
        text,
        envelope,
        parseError,
      });
    });

    ws.on('pong', () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });

    ws.on('error', (err: Error) => {
      logger.warn({ event: 'ws_error', err: err.message }, 'websocket error');
      this.emit('error', err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const wasClean = this.shuttingDown;
      this.stopHeartbeat();
      this.state = 'closed';
      this.ws = null;

      logger.warn(
        { event: 'ws_disconnected', code, reason: reason.toString(), wasClean },
        'websocket closed',
      );
      this.emit('close', { code, reason: reason.toString(), wasClean });

      if (!this.shuttingDown) void this.scheduleReconnect(`close ${code}`);
    });
  }

  /**
   * Reconnects with the fixed backoff schedule plus jitter.
   *
   * Reconnecting NEVER restores book state: the caller is expected to treat the
   * new connection as a fresh epoch and rebuild every book from exchange
   * snapshots. This client keeps no state to restore.
   */
  private async scheduleReconnect(reason: string): Promise<void> {
    if (this.shuttingDown) return;

    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > this.opts.maxReconnectAttempts) {
      this.emit('error', new Error(`giving up after ${this.reconnectAttempt - 1} reconnect attempts`));
      return;
    }

    const idx = Math.min(this.reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1);
    const base = RECONNECT_DELAYS_MS[idx]!;
    const delayMs = Math.round(base / 2 + Math.random() * (base / 2) + Math.random() * (base / 2));

    logger.warn(
      { event: 'ws_reconnect_scheduled', attempt: this.reconnectAttempt, delayMs, reason },
      'scheduling websocket reconnect',
    );
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs, reason });

    await delay(delayMs);
    if (this.shuttingDown) return;

    try {
      await this.openSocket();
    } catch (err) {
      logger.warn(
        { event: 'ws_reconnect_failed', attempt: this.reconnectAttempt, err: String(err) },
        'websocket reconnect failed',
      );
      void this.scheduleReconnect(err instanceof Error ? err.message : 'reconnect failed');
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.isOpen) return;
      this.ws?.ping();

      // A missed pong means the connection is dead even though the socket
      // still looks open; force a close so the reconnect path runs.
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          logger.warn({ event: 'ws_pong_timeout' }, 'no pong received; terminating socket');
          this.ws?.terminate();
        }, this.opts.pongTimeoutMs);
        this.pongTimer.unref?.();
      }
    }, this.opts.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  async close(code = 1000, reason = 'shutdown'): Promise<void> {
    this.shuttingDown = true;
    this.state = 'closing';
    this.stopHeartbeat();

    const ws = this.ws;
    if (!ws) {
      this.state = 'closed';
      return;
    }

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.once('close', done);
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
        resolve();
        return;
      }
      setTimeout(() => {
        ws.terminate();
        resolve();
      }, 5000).unref?.();
    });

    this.state = 'closed';
    this.ws = null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  send(command: OutboundCommand): void {
    if (!this.isOpen) throw new Error('cannot send: websocket is not open');
    this.ws!.send(JSON.stringify(command));
    logger.debug({ event: 'ws_command_sent', cmd: command.cmd, id: command.id }, 'sent command');
  }

  subscribe(channels: string[], marketTickers?: string[]): number {
    const id = this.allocateCommandId();
    this.send({
      id,
      cmd: 'subscribe',
      params: {
        channels,
        ...(marketTickers && marketTickers.length > 0 ? { market_tickers: marketTickers } : {}),
      },
    });
    return id;
  }

  addMarkets(sids: number[], marketTickers: string[]): number {
    const id = this.allocateCommandId();
    this.send({ id, cmd: 'update_subscription', params: { sids, market_tickers: marketTickers, action: 'add_markets' } });
    return id;
  }

  deleteMarkets(sids: number[], marketTickers: string[]): number {
    const id = this.allocateCommandId();
    this.send({ id, cmd: 'update_subscription', params: { sids, market_tickers: marketTickers, action: 'delete_markets' } });
    return id;
  }

  /**
   * Requests a fresh orderbook snapshot WITHOUT modifying the subscription.
   * This is the recovery primitive used after a sequence gap or an invariant
   * violation.
   */
  requestSnapshot(sids: number[], marketTickers: string[]): number {
    const id = this.allocateCommandId();
    this.send({ id, cmd: 'update_subscription', params: { sids, market_tickers: marketTickers, action: 'get_snapshot' } });
    return id;
  }

  unsubscribe(sids: number[]): number {
    const id = this.allocateCommandId();
    this.send({ id, cmd: 'unsubscribe', params: { sids } });
    return id;
  }
}
