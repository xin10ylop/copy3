/**
 * eth_subscribe client for `newHeads` + `logs` (topic filter only, any address),
 * with reconnect + resubscribe. Uses Node 22's global WebSocket. Missed heads
 * during a disconnect are harmless: the pipeline always processes
 * checkpoint+1..head sequentially, and also polls eth_blockNumber as a fallback.
 */
import { hexToNum } from './hex.js';
import type { Hex, RpcLog } from './types.js';

export interface HeadEvent {
  number: number;
  hash: Hex;
  parentHash: Hex;
  /** unix seconds (absent if the node omits it) */
  timestamp?: number;
}

export interface WsSubscriberOptions {
  url: string;
  /** topic0 OR-set for the logs subscription */
  topics: Hex[];
  onHead: (h: HeadEvent) => void;
  /** subscribe to newHeads (default true). INDEXER_MODE=logs may run on the logs subscription alone. */
  heads?: boolean;
  onLog?: (log: RpcLog) => void;
  onStatus?: (status: 'open' | 'closed', detail?: string) => void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** reconnect if nothing arrives for this long */
  staleMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

interface SubscriptionMsg {
  id?: number;
  result?: unknown;
  error?: { message: string };
  method?: string;
  params?: { subscription: string; result: unknown };
}

export class WsSubscriber {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private lastMessageAt = 0;
  private staleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly kinds = new Map<number, 'newHeads' | 'logs'>();
  private readonly subs = new Map<string, 'newHeads' | 'logs'>();
  connected = false;

  constructor(private readonly o: WsSubscriberOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
    const staleMs = this.o.staleMs ?? 120_000;
    this.staleTimer = setInterval(() => {
      if (this.connected && Date.now() - this.lastMessageAt > staleMs) {
        this.o.onStatus?.('closed', 'stale connection');
        this.ws?.close();
      }
    }, Math.min(staleMs, 10_000));
    this.staleTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.o.url);
    this.ws = ws;
    this.kinds.clear();
    this.subs.clear();
    ws.addEventListener('open', () => {
      this.connected = true;
      this.attempts = 0;
      this.lastMessageAt = Date.now();
      this.o.onStatus?.('open');
      if (this.o.heads !== false) this.send(1, ['newHeads'], 'newHeads');
      if (this.o.onLog) this.send(2, ['logs', { topics: [this.o.topics] }], 'logs');
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      this.lastMessageAt = Date.now();
      this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });
    ws.addEventListener('close', () => {
      this.connected = false;
      this.o.onStatus?.('closed');
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // 'close' follows; nothing else to do
    });
  }

  private send(id: number, params: unknown[], kind: 'newHeads' | 'logs'): void {
    this.kinds.set(id, kind);
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params }));
  }

  private onMessage(text: string): void {
    let msg: SubscriptionMsg;
    try {
      msg = JSON.parse(text) as SubscriptionMsg;
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const kind = this.kinds.get(msg.id);
      if (kind && typeof msg.result === 'string') this.subs.set(msg.result, kind);
      if (kind && msg.error) this.o.onStatus?.('closed', `subscribe ${kind} failed: ${msg.error.message}`);
      return;
    }
    if (msg.method !== 'eth_subscription' || !msg.params) return;
    const kind = this.subs.get(msg.params.subscription);
    if (kind === 'newHeads') {
      const h = msg.params.result as { number: Hex; hash: Hex; parentHash: Hex; timestamp?: Hex };
      this.o.onHead({
        number: hexToNum(h.number),
        hash: h.hash,
        parentHash: h.parentHash,
        ...(h.timestamp ? { timestamp: hexToNum(h.timestamp) } : {}),
      });
    } else if (kind === 'logs') {
      this.o.onLog?.(msg.params.result as RpcLog);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const min = this.o.reconnectMinMs ?? 500;
    const max = this.o.reconnectMaxMs ?? 15_000;
    const delay = Math.min(max, min * 2 ** this.attempts++);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref();
  }
}
