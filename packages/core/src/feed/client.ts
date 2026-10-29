/**
 * Sequencer feed websocket client: auto-reconnect with exponential backoff, primary →
 * secondary failover (and periodic return to the primary), stale-feed watchdog, gap
 * detection by sequence number, duplicate suppression, and replay-on-reconnect via the
 * nitro `Arbitrum-Requested-Sequence-Number` header.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { nowMs } from '../clock.js';
import { decodeParsedFrame, peekFrameRange, type FeedBlock } from './decode.js';
import { FeedStats, feedStats as defaultFeedStats } from './stats.js';

/** Minimal websocket surface the client needs (lets tests inject fakes). */
export interface FeedSocket {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  ping?(): void;
  terminate(): void;
  close(): void;
}

export interface FeedClientOptions {
  /** Feed URLs, primary first (e.g. own node relay, then sequencer feed, then delayed feed). */
  urls: string[];
  /** No frame for this long ⇒ drop the connection and fail over. Default 3000 ms. */
  staleMs?: number;
  /** First reconnect delay; doubles per consecutive failure up to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** While on a non-primary URL, go back to the primary after this long. Default 30 s. */
  primaryRetryMs?: number;
  /** websocket ping interval (keeps NATs/LBs open). Default 10 s. */
  pingIntervalMs?: number;
  /** Ask the server to replay from the next expected block after a reconnect. Default true. */
  requestReplay?: boolean;
  /**
   * A frame whose sequence numbers are more than this many blocks away from the head (ahead or
   * behind) is suspicious and dropped, unless `resetAfter` consecutive, mutually consistent
   * suspicious frames confirm a genuine reset. Default 50 000 (~1.4 h of blocks).
   */
  maxJump?: number;
  resetAfter?: number;
  /**
   * Forward plausibility bound (N9): a block more than `elapsed × maxBlocksPerSec + jumpMargin`
   * ahead of the head (elapsed = time since the head block arrived) cannot be real on a ~10
   * blocks/s chain and is dropped as bogus — also inside an otherwise valid frame. Defaults 12 / 100.
   */
  maxBlocksPerSec?: number;
  jumpMargin?: number;
  now?: () => number;
  stats?: FeedStats;
  createSocket?: (url: string, headers: Record<string, string>) => FeedSocket;
}

/** ws RawData (Buffer | ArrayBuffer | Buffer[] fragments) → text. */
function rawText(data: WebSocket.RawData | string): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export interface FeedGap {
  from: number;
  to: number;
}

export interface FeedClientEvents {
  block: [FeedBlock];
  gap: [FeedGap];
  connected: [string];
  disconnected: [{ url: string; reason: string }];
  error: [Error];
  reset: [{ from: number; to: number }];
}

export class FeedClient extends EventEmitter<FeedClientEvents> {
  readonly stats: FeedStats;
  private readonly opts: Required<Omit<FeedClientOptions, 'createSocket' | 'stats' | 'now'>>;
  private readonly now: () => number;
  private readonly createSocket: (url: string, headers: Record<string, string>) => FeedSocket;
  private socket: FeedSocket | null = null;
  private urlIndex = 0;
  private failures = 0;
  private running = false;
  private lastFrameAt = 0;
  private connectedAt = 0;
  private lastBlock = -1;
  /** frame arrival time of the head block (forward plausibility bound) */
  private lastBlockAt = 0;
  /** two stale connections in a row without a new block: the head may be poisoned (N9) */
  private headSuspect = false;
  private staleStreak = 0;
  private suspect: { max: number; count: number } | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: FeedClientOptions) {
    super();
    if (options.urls.length === 0) throw new Error('FeedClient: at least one url required');
    this.opts = {
      urls: options.urls,
      staleMs: options.staleMs ?? 3000,
      reconnectDelayMs: options.reconnectDelayMs ?? 200,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? 5000,
      primaryRetryMs: options.primaryRetryMs ?? 30_000,
      pingIntervalMs: options.pingIntervalMs ?? 10_000,
      requestReplay: options.requestReplay ?? true,
      maxJump: options.maxJump ?? 50_000,
      resetAfter: options.resetAfter ?? 3,
      maxBlocksPerSec: options.maxBlocksPerSec ?? 12,
      jumpMargin: options.jumpMargin ?? 100,
    };
    this.now = options.now ?? nowMs;
    this.stats = options.stats ?? defaultFeedStats;
    this.createSocket =
      options.createSocket ??
      ((url, headers) =>
        // the Robinhood feed rejects clients that do not offer permessage-deflate (HTTP 400 "Compression is required")
        new WebSocket(url, { perMessageDeflate: true, headers, handshakeTimeout: 5000 }) as FeedSocket);
  }

  /** `error` without a listener would throw (EventEmitter semantics); never let it. */
  private reportError(e: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', e);
  }

  /** Highest block delivered so far (-1 before the first). */
  get head(): number {
    return this.lastBlock;
  }

  get currentUrl(): string | null {
    return this.socket ? (this.opts.urls[this.urlIndex] ?? null) : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.watchdog = setInterval(() => this.checkStale(), Math.max(50, Math.floor(this.opts.staleMs / 4)));
    this.watchdog.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pinger) clearInterval(this.pinger);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdog = this.pinger = this.reconnectTimer = null;
    const s = this.socket;
    this.socket = null;
    s?.terminate();
  }

  /**
   * Feed a raw text frame (used by the socket handler, replays and tests). Never throws.
   * Returns the new in-order blocks it delivered (only those count as feed liveness).
   */
  handleFrame(text: string, receivedAt: number): FeedBlock[] {
    try {
      return this.handleFrameUnsafe(text, receivedAt);
    } catch (e) {
      this.reportError(new Error(`feed: frame handling failed: ${(e as Error).message}`));
      return [];
    }
  }

  private handleFrameUnsafe(text: string, receivedAt: number): FeedBlock[] {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch (e) {
      this.reportError(new Error(`feed: bad JSON frame: ${(e as Error).message}`));
      return [];
    }
    const range = peekFrameRange(frame);
    if (range === undefined) return [];
    let reset = false;
    const { maxJump, resetAfter } = this.opts;
    const head = this.lastBlock;
    const ahead = head >= 0 && range.min > this.forwardCap(receivedAt);
    const behind = head >= 0 && range.max < head - maxJump;
    if (this.headSuspect && head >= 0 && (ahead || range.max < head)) {
      // first frames after a stale reconnect (no replay requested): the server's head wins
      this.reportError(new Error(`feed: head ${head} not confirmed after a stale reconnect, resetting to ${range.min}`));
      this.emit('reset', { from: head, to: range.min });
      this.stats.resets++;
      this.lastBlock = range.min - 1;
      reset = true;
    } else if (ahead || behind) {
      // implausibly far from our head: a bogus frame, or a genuine reset (chain restart / our head is wrong)
      const consistent = this.suspect !== null && range.min > this.suspect.max && range.min - this.suspect.max <= maxJump;
      this.suspect = { max: range.max, count: consistent ? this.suspect!.count + 1 : 1 };
      this.stats.bogus++;
      if (this.suspect.count < resetAfter) return [];
      this.reportError(new Error(`feed: sequence reset ${this.lastBlock} → ${range.min} confirmed by ${resetAfter} frames`));
      this.emit('reset', { from: this.lastBlock, to: range.min });
      this.stats.resets++;
      this.lastBlock = range.min - 1;
      reset = true;
    }
    this.suspect = null;
    if (range.max <= this.lastBlock) {
      this.stats.duplicates++;
      return [];
    }
    const t0 = this.now();
    const blocks = decodeParsedFrame(frame, receivedAt, this.lastBlock);
    const decodeMs = this.now() - t0;
    const delivered: FeedBlock[] = [];
    for (const b of blocks) {
      if (b.block <= this.lastBlock) continue; // out-of-order inside a frame
      // a bogus message next to real ones (N9): never let it become the head
      if (!reset && this.lastBlock >= 0 && b.block > this.forwardCap(receivedAt)) {
        this.stats.bogus++;
        continue;
      }
      if (!reset && this.lastBlock >= 0 && b.block > this.lastBlock + 1) {
        const gap = { from: this.lastBlock + 1, to: b.block - 1 };
        this.stats.recordGap(gap.from, gap.to);
        this.emit('gap', gap);
      }
      reset = false;
      this.headSuspect = false;
      this.staleStreak = 0;
      this.lastBlock = b.block;
      this.lastBlockAt = receivedAt;
      this.lastFrameAt = receivedAt; // liveness only advances on new in-order blocks
      this.stats.recordBlock(b, decodeMs / blocks.length);
      delivered.push(b);
      try {
        this.emit('block', b);
      } catch (e) {
        this.reportError(new Error(`feed: block listener threw: ${(e as Error).message}`));
      }
    }
    return delivered;
  }

  /** Highest block number plausible at `at` (head + elapsed × max rate + margin). */
  private forwardCap(at: number): number {
    const elapsed = Math.max(0, at - this.lastBlockAt);
    return this.lastBlock + Math.ceil((elapsed / 1000) * this.opts.maxBlocksPerSec) + this.opts.jumpMargin;
  }

  private connect(): void {
    if (!this.running) return;
    const url = this.opts.urls[this.urlIndex]!;
    const headers: Record<string, string> = { 'Arbitrum-Feed-Client-Version': '2' };
    // after a stale connection the head may be poisoned: do not ask the server to replay from it
    if (this.opts.requestReplay && this.lastBlock >= 0 && !this.headSuspect) {
      headers['Arbitrum-Requested-Sequence-Number'] = String(this.lastBlock + 1);
    }
    let sock: FeedSocket;
    try {
      sock = this.createSocket(url, headers);
    } catch (e) {
      this.onDown(url, `create failed: ${(e as Error).message}`);
      return;
    }
    this.socket = sock;
    this.lastFrameAt = this.now();
    sock.on('open', () => {
      if (this.socket !== sock) return;
      this.failures = 0;
      this.connectedAt = this.now();
      this.lastFrameAt = this.connectedAt;
      this.stats.currentUrl = url;
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        try {
          sock.ping?.();
        } catch {
          /* socket closing */
        }
      }, this.opts.pingIntervalMs);
      this.pinger.unref?.();
      this.emit('connected', url);
    });
    sock.on('message', (data, isBinary) => {
      const receivedAt = this.now();
      if (this.socket !== sock || isBinary) return;
      try {
        this.handleFrame(rawText(data), receivedAt);
      } catch {
        /* handleFrame never throws; belt and braces inside the ws handler */
      }
    });
    sock.on('error', (err) => {
      if (this.socket === sock) this.reportError(err);
    });
    sock.on('close', (code, reason) => {
      if (this.socket !== sock) return;
      this.onDown(url, `close ${code} ${reason.toString()}`);
    });
  }

  private onDown(url: string, reason: string, rotate = true): void {
    this.socket = null;
    this.stats.currentUrl = null;
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    this.emit('disconnected', { url, reason });
    if (!this.running) return;
    this.failures++;
    this.stats.reconnects++;
    if (rotate && this.opts.urls.length > 1) {
      this.urlIndex = (this.urlIndex + 1) % this.opts.urls.length;
      this.stats.failovers++;
    }
    // First retry immediately-ish; back off only after a full rotation keeps failing.
    const rotations = Math.floor((this.failures - 1) / this.opts.urls.length);
    const delay = Math.min(this.opts.maxReconnectDelayMs, this.opts.reconnectDelayMs * 2 ** rotations);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private checkStale(): void {
    const s = this.socket;
    if (!s) return;
    const now = this.now();
    if (now - this.lastFrameAt > this.opts.staleMs) {
      this.reportError(new Error(`feed stale for ${Math.round(now - this.lastFrameAt)} ms`));
      this.socket = null;
      s.terminate();
      // the replay request from our head did not bring a block either: stop trusting the head
      if (++this.staleStreak >= 2) this.headSuspect = true;
      // A single stale timeout on the primary (a quiet sequencer second, a dropped frame) is
      // retried on the primary itself: the secondary is the DELAYED feed, and a 30 s detour
      // there loses every race in it (28 detours in 6 h on the Ohio box). Rotate only when
      // the primary stays stale twice in a row; socket errors / closes still rotate at once.
      this.onDown(this.opts.urls[this.urlIndex]!, 'stale', this.urlIndex !== 0 || this.staleStreak >= 2);
      return;
    }
    if (this.urlIndex !== 0 && this.connectedAt > 0 && now - this.connectedAt > this.opts.primaryRetryMs) {
      // Go back to the primary; the replay header closes the switch-over gap.
      this.socket = null;
      s.close();
      this.urlIndex = 0;
      this.failures = 0;
      this.connect();
    }
  }
}
