/**
 * Minimal JSON-RPC over node:http(s) with keep-alive agents (no fetch/undici pool surprises):
 * pre-warmed sockets, pre-serialised bodies, per-send timestamps. Used for the burst fan-out
 * (`eth_sendRawTransaction` to every SEND_ENDPOINT) and RTT measurement.
 */
import http from 'node:http';
import https from 'node:https';
import { nowMs } from '@hood/core';
import type { Hex } from 'viem';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface SendResult {
  endpoint: string;
  sentAt: number;
  doneAt: number;
  ok: boolean;
  hash?: Hex;
  error?: string;
}

export interface RawSender {
  readonly url: string;
  sendRaw(raw: Hex): Promise<SendResult>;
  request<T>(method: string, params: unknown[], timeoutMs?: number): Promise<T>;
  ping(): Promise<number>;
  close(): void;
}

export class JsonRpcHttp implements RawSender {
  private readonly agent: http.Agent;
  private readonly mod: typeof http | typeof https;
  private readonly target: URL;
  private id = 1;
  readonly rtts: number[] = [];

  constructor(
    readonly url: string,
    private readonly opts: { timeoutMs?: number; maxSockets?: number; now?: () => number } = {},
  ) {
    this.target = new URL(url);
    const isHttps = this.target.protocol === 'https:';
    this.mod = isHttps ? https : http;
    const agentOpts = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: opts.maxSockets ?? 8, scheduling: 'lifo' as const };
    this.agent = isHttps ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
  }

  private now(): number {
    return (this.opts.now ?? nowMs)();
  }

  private post(body: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = this.mod.request(
        {
          protocol: this.target.protocol,
          hostname: this.target.hostname,
          port: this.target.port || undefined,
          path: `${this.target.pathname}${this.target.search}`,
          method: 'POST',
          agent: this.agent,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) >= 400) reject(new RpcError(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`, res.statusCode));
            else resolve(text);
          });
          res.on('error', reject);
        },
      );
      req.setNoDelay(true);
      req.on('timeout', () => req.destroy(new RpcError(`timeout after ${timeoutMs} ms`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  async request<T>(method: string, params: unknown[], timeoutMs = this.opts.timeoutMs ?? 5000): Promise<T> {
    const text = await this.post(JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }), timeoutMs);
    const j = JSON.parse(text) as { result?: T; error?: { code?: number; message?: string } };
    if (j.error) throw new RpcError(j.error.message ?? 'rpc error', j.error.code);
    return j.result as T;
  }

  async sendRaw(raw: Hex): Promise<SendResult> {
    const body = `{"jsonrpc":"2.0","id":${this.id++},"method":"eth_sendRawTransaction","params":["${raw}"]}`;
    const sentAt = this.now();
    try {
      const text = await this.post(body, this.opts.timeoutMs ?? 3000);
      const j = JSON.parse(text) as { result?: Hex; error?: { message?: string } };
      const doneAt = this.now();
      if (j.error) return { endpoint: this.url, sentAt, doneAt, ok: false, error: j.error.message ?? 'rpc error' };
      return { endpoint: this.url, sentAt, doneAt, ok: true, ...(j.result ? { hash: j.result } : {}) };
    } catch (e) {
      return { endpoint: this.url, sentAt, doneAt: this.now(), ok: false, error: (e as Error).message };
    }
  }

  /** eth_chainId round trip (keeps a socket warm and measures RTT). */
  async ping(): Promise<number> {
    const t0 = this.now();
    await this.request<string>('eth_chainId', [], 2000);
    const rtt = this.now() - t0;
    this.rtts.push(rtt);
    if (this.rtts.length > 30) this.rtts.shift();
    return rtt;
  }

  /** Robust RTT: min of the recent pings (null before the first). */
  get rttMs(): number | null {
    return this.rtts.length ? Math.min(...this.rtts) : null;
  }

  close(): void {
    this.agent.destroy();
  }
}
