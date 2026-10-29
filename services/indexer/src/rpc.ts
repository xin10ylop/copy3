/**
 * Minimal JSON-RPC over HTTP with request spacing and retry/backoff.
 * The public Robinhood Chain RPC answers 429 under load; space calls
 * (`minIntervalMs`, default 0 for an own node, >=150 for the public RPC) and
 * retry 429 / 5xx / network errors with exponential backoff + jitter.
 */
export interface Rpc {
  request<T>(method: string, params: readonly unknown[]): Promise<T>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly method: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface HttpRpcOptions {
  minIntervalMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  onRetry?: (info: { method: string; attempt: number; delayMs: number; reason: string }) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Serialises request *start* times so that consecutive starts are >= interval apart. */
export class Spacer {
  private next = 0;
  constructor(
    private readonly intervalMs: number,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  async wait(): Promise<void> {
    if (this.intervalMs <= 0) return;
    const t = this.now();
    const start = Math.max(t, this.next);
    this.next = start + this.intervalMs;
    if (start > t) await this.sleep(start - t);
  }
}

export function backoffMs(attempt: number, base: number, max: number, rand: () => number = Math.random): number {
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.round(exp / 2 + rand() * (exp / 2));
}

const RETRYABLE_RPC_CODES = new Set([429, -32005, -32603, -32000]);

function isRetryableRpcError(code: number | null, message: string): boolean {
  const m = message.toLowerCase();
  // "query returned more than N results" / "block range too large": not transient, caller splits the range
  if (m.includes('result') || m.includes('range') || m.includes('response size')) return false;
  if (code !== null && (code === 429 || code === -32005)) return true;
  if (m.includes('rate limit') || m.includes('too many requests') || m.includes('timeout') || m.includes('try again')) return true;
  // -32603/-32000 are generic; only retry when they look transient
  return code !== null && RETRYABLE_RPC_CODES.has(code) && (m.includes('busy') || m.includes('temporar') || m.includes('header not found'));
}

let nextId = 1;

/** Per-method request counters (every HTTP request sent, retries included = what the provider bills). */
export class RpcCounter {
  private readonly counts = new Map<string, number>();

  add(method: string): void {
    this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counts].sort(([a], [b]) => a.localeCompare(b)));
  }

  total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
}

/** counts in `cur` minus `prev` (per method, zero deltas dropped) */
export function diffCounts(prev: Record<string, number>, cur: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cur)) {
    const d = v - (prev[k] ?? 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

export class HttpRpc implements Rpc {
  readonly counter = new RpcCounter();
  private readonly spacer: Spacer;
  private readonly o: Required<Omit<HttpRpcOptions, 'onRetry'>> & Pick<HttpRpcOptions, 'onRetry'>;

  constructor(
    readonly url: string,
    opts: HttpRpcOptions = {},
  ) {
    this.o = {
      minIntervalMs: opts.minIntervalMs ?? 0,
      maxRetries: opts.maxRetries ?? 8,
      baseBackoffMs: opts.baseBackoffMs ?? 250,
      maxBackoffMs: opts.maxBackoffMs ?? 15_000,
      timeoutMs: opts.timeoutMs ?? 30_000,
      onRetry: opts.onRetry,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? defaultSleep,
      now: opts.now ?? Date.now,
    };
    this.spacer = new Spacer(this.o.minIntervalMs, this.o.sleep, this.o.now);
  }

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.spacer.wait();
      this.counter.add(method);
      let reason: string;
      try {
        const res = await this.o.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          reason = `http ${res.status}`;
        } else {
          const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
          if (body.error) {
            const { code, message, data } = body.error;
            if (!isRetryableRpcError(code, message)) throw new RpcError(message, code, method, data);
            reason = `rpc ${code} ${message}`;
          } else if (!res.ok) {
            throw new RpcError(`http ${res.status}`, res.status, method);
          } else {
            return body.result as T;
          }
        }
      } catch (err) {
        if (err instanceof RpcError) throw err;
        reason = err instanceof Error ? err.message : String(err);
      }
      if (attempt >= this.o.maxRetries) throw new RpcError(`${method} failed after ${attempt + 1} attempts: ${reason}`, null, method);
      const delayMs = backoffMs(attempt, this.o.baseBackoffMs, this.o.maxBackoffMs);
      this.o.onRetry?.({ method, attempt, delayMs, reason });
      await this.o.sleep(delayMs);
    }
  }
}
