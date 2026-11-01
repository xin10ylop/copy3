/**
 * Blocks from public RPC websockets (1 Nov 2026: the sequencer feed refuses the box's address
 * range with HTTP 403; Robinhood's own public RPC only updates `latest` in ~500 ms batches, so a
 * launch block there is ≥ 650 ms old). Third-party public nodes push `newHeads` for every block
 * ~70 ms after sealing; on each head the full block is fetched over the same socket
 * (`eth_getBlockByNumber`, one round trip) and delivered through the shared `BlockGate`, in order.
 *
 * - several sockets at once: the first head for a block wins, the others are no-ops;
 * - a head for block n with blocks between the gate's last and n unseen fetches those first
 *   (up to `maxCatchUp`; a longer hole is a gap, as on the feed);
 * - a block the feed already delivered is never fetched (the gate knows it), so while the feed
 *   works this source costs the public nodes nothing beyond the subscription;
 * - a fetch that fails or returns null on the announcing socket is retried on the others;
 * - sockets reconnect with a backoff (1 s doubling to 30 s) and are reset when silent for 30 s.
 */
import WebSocket from 'ws';
import type { BlockGate } from './block-gate.js';
import type { Logger } from './log.js';
import { rpcBlockToFeedBlock, type RpcBlockLike } from './rpc-block.js';

export interface HeadsSourceOptions {
  urls: string[];
  gate: BlockGate;
  logger: Logger;
  /** most unseen blocks fetched before an announced head. Default 20. */
  maxCatchUp?: number;
  /** one eth_getBlockByNumber round trip. Default 1500 ms. */
  fetchTimeoutMs?: number;
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** ws ping period; a socket silent for 2 periods is reset. Default 15 000 ms. */
  pingMs?: number;
  now?: () => number;
}

export interface HeadsSnapshot {
  connected: number;
  urls: number;
  heads: number;
  blocks: number;
  caughtUp: number;
  gaps: number;
  fetchErrors: number;
  reconnects: number;
  lastBlockAt: number | null;
  /** head arrival → block delivered, last block */
  lastFetchMs: number | null;
  byUrl: Record<string, { connected: boolean; heads: number; blocks: number; reconnects: number }>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class Sock {
  ws: WebSocket | null = null;
  connected = false;
  heads = 0;
  blocks = 0;
  reconnects = 0;
  backoff: number;
  lastMessageAt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    readonly url: string,
    private readonly o: Required<Omit<HeadsSourceOptions, 'urls' | 'gate' | 'logger'>> & { logger: Logger },
    private readonly onHead: (sock: Sock, head: { number: string }) => void,
    private readonly onOpen: (sock: Sock) => void,
    private readonly onClose: (sock: Sock) => void,
  ) {
    this.backoff = o.reconnectMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 8000, perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.lastMessageAt = this.o.now();
      this.call('eth_subscribe', ['newHeads'])
        .then((id) => {
          if (ws !== this.ws) return;
          this.connected = true;
          this.backoff = this.o.reconnectMs;
          this.o.logger.info({ url: this.url, subscription: id }, 'heads source connected');
          this.onOpen(this);
        })
        .catch((e: unknown) => {
          this.o.logger.warn({ url: this.url, err: e }, 'heads source: newHeads subscription failed');
          ws.terminate();
        });
    });
    ws.on('message', (data) => {
      this.lastMessageAt = this.o.now();
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { result?: { number?: string } } };
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error'));
        else p.resolve(msg.result);
        return;
      }
      const head = msg.method === 'eth_subscription' ? msg.params?.result : undefined;
      if (head && typeof head.number === 'string') {
        this.heads++;
        this.onHead(this, head as { number: string });
      }
    });
    ws.on('pong', () => {
      this.lastMessageAt = this.o.now();
    });
    const down = (why: string): void => {
      if (ws !== this.ws) return;
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`socket closed (${why})`));
        this.pending.delete(id);
      }
      if (was) this.o.logger.warn({ url: this.url, why }, 'heads source disconnected');
      this.onClose(this);
      this.scheduleReconnect();
    };
    ws.on('close', (code) => down(`close ${code}`));
    ws.on('error', (e) => {
      this.o.logger.warn({ url: this.url, err: e }, 'heads source socket error');
      down('error');
    });
    ws.on('unexpected-response', (_req, res) => {
      this.o.logger.warn({ url: this.url, status: res.statusCode }, 'heads source handshake refused');
      ws.terminate();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.o.maxReconnectMs, this.backoff * 2);
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Ping, and reset a socket that has been silent for two ping periods. */
  tick(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.o.now() - this.lastMessageAt > 2 * this.o.pingMs) {
      this.o.logger.warn({ url: this.url }, 'heads source silent: resetting the socket');
      ws.terminate();
      return;
    }
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }

  call(method: string, params: unknown[], timeoutMs = this.o.fetchTimeoutMs): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('socket not open'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('stopped'));
      this.pending.delete(id);
    }
    ws?.terminate();
  }
}

export class HeadsBlockSource {
  private readonly socks: Sock[];
  private readonly o: Required<Omit<HeadsSourceOptions, 'urls' | 'gate' | 'logger'>> & { logger: Logger };
  private readonly gate: BlockGate;
  private queue: Promise<void> = Promise.resolve();
  private queuedUpTo = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  readonly stats = { heads: 0, blocks: 0, caughtUp: 0, gaps: 0, fetchErrors: 0, lastBlockAt: null as number | null, lastFetchMs: null as number | null };

  constructor(opts: HeadsSourceOptions) {
    this.o = {
      maxCatchUp: 20,
      fetchTimeoutMs: 1500,
      reconnectMs: 1000,
      maxReconnectMs: 30_000,
      pingMs: 15_000,
      now: () => Date.now(),
      ...opts,
    };
    this.gate = opts.gate;
    this.socks = opts.urls.map(
      (url) =>
        new Sock(
          url,
          this.o,
          (sock, head) => this.onHead(sock, head),
          () => undefined,
          () => undefined,
        ),
    );
  }

  get connected(): number {
    return this.socks.filter((s) => s.connected).length;
  }

  start(): void {
    for (const s of this.socks) s.start();
    this.pingTimer = setInterval(() => {
      for (const s of this.socks) s.tick();
    }, this.o.pingMs);
    this.pingTimer.unref?.();
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const s of this.socks) s.stop();
  }

  private onHead(sock: Sock, head: { number: string }): void {
    this.stats.heads++;
    const n = Number(BigInt(head.number));
    if (!Number.isFinite(n) || n <= this.gate.last || n <= this.queuedUpTo) return;
    this.queuedUpTo = n;
    const announcedAt = this.o.now();
    this.queue = this.queue.then(() => this.fetchAndDeliver(n, sock, announcedAt)).catch(() => undefined);
  }

  private async fetchAndDeliver(n: number, preferred: Sock, announcedAt: number): Promise<void> {
    const last = this.gate.last;
    if (n <= last) return;
    let from = last > 0 ? last + 1 : n;
    if (n - from + 1 > this.o.maxCatchUp) {
      this.stats.gaps++;
      this.o.logger.warn({ from, to: n - this.o.maxCatchUp }, 'heads source gap');
      from = n - this.o.maxCatchUp + 1;
    }
    for (let m = from; m <= n; m++) {
      if (m <= this.gate.last) continue; // the feed delivered it meanwhile
      const b = await this.fetchBlock(m, preferred);
      if (!b) {
        this.stats.fetchErrors++;
        return; // the next head retries from the gate's last block
      }
      if (m < n) this.stats.caughtUp++;
      if (this.gate.deliver(b, 'heads')) {
        this.stats.blocks++;
        preferred.blocks++;
        this.stats.lastBlockAt = b.receivedAt;
        if (m === n) this.stats.lastFetchMs = b.receivedAt - announcedAt;
      }
    }
  }

  private async fetchBlock(n: number, preferred: Sock): Promise<ReturnType<typeof rpcBlockToFeedBlock> | null> {
    const order = [preferred, ...this.socks.filter((s) => s !== preferred && s.connected)];
    for (const s of order) {
      try {
        const raw = (await s.call('eth_getBlockByNumber', [`0x${n.toString(16)}`, true])) as RpcBlockLike | null;
        if (raw && raw.number !== null && Number(raw.number) === n) return rpcBlockToFeedBlock(raw, this.o.now());
      } catch (e) {
        this.o.logger.debug({ url: s.url, block: n, err: e }, 'heads source: block fetch failed');
      }
    }
    return null;
  }

  snapshot(): HeadsSnapshot {
    const byUrl: HeadsSnapshot['byUrl'] = {};
    for (const s of this.socks) byUrl[s.url] = { connected: s.connected, heads: s.heads, blocks: s.blocks, reconnects: s.reconnects };
    return {
      connected: this.connected,
      urls: this.socks.length,
      ...this.stats,
      reconnects: this.socks.reduce((a, s) => a + s.reconnects, 0),
      byUrl,
    };
  }
}
