import { describe, expect, it } from 'vitest';
import { HttpRpc, RpcError, Spacer, backoffMs } from '../src/rpc.js';

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: unknown[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('HttpRpc', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  it('retries 429 (HTTP and JSON-RPC) and network errors with backoff', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429 },
      { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too Many Requests' } } },
      new Error('ECONNRESET'),
      { status: 200, body: { jsonrpc: '2.0', id: 1, result: '0x5faa700' } },
    ]);
    const retries: string[] = [];
    const rpc = new HttpRpc('http://x', { fetchImpl: impl, sleep, onRetry: (i) => retries.push(i.reason) });
    await expect(rpc.request<string>('eth_blockNumber', [])).resolves.toBe('0x5faa700');
    expect(calls).toHaveLength(4);
    expect(retries).toEqual(['http 429', 'rpc 429 Too Many Requests', 'ECONNRESET']);
  });

  it('throws non-retryable JSON-RPC errors with their code', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { error: { code: -32601, message: 'the method debug_traceTransaction does not exist/is not available' } } }]);
    const rpc = new HttpRpc('http://x', { fetchImpl: impl, sleep });
    const err = await rpc.request('debug_traceTransaction', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32601);
  });

  it('does not retry "too many results" (the backfill splits the range instead)', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { error: { code: -32005, message: 'query returned more than 10000 results' } } }]);
    const rpc = new HttpRpc('http://x', { fetchImpl: impl, sleep });
    await expect(rpc.request('eth_getLogs', [])).rejects.toBeInstanceOf(RpcError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const { impl } = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const rpc = new HttpRpc('http://x', { fetchImpl: impl, sleep, maxRetries: 2 });
    await expect(rpc.request('eth_chainId', [])).rejects.toThrow(/after 3 attempts/);
  });
});

describe('Spacer / backoff', () => {
  it('spaces request starts by the interval', async () => {
    let now = 1000;
    const waits: number[] = [];
    const s = new Spacer(150, async (ms) => {
      waits.push(ms);
    }, () => now);
    await s.wait();
    await s.wait();
    await s.wait();
    expect(waits).toEqual([150, 300]);
    now = 2000;
    await s.wait();
    expect(waits).toEqual([150, 300]);
  });

  it('backs off exponentially with jitter and a cap', () => {
    expect(backoffMs(0, 250, 10_000, () => 0)).toBe(125);
    expect(backoffMs(3, 250, 10_000, () => 1)).toBe(2000);
    expect(backoffMs(20, 250, 10_000, () => 1)).toBe(10_000);
  });
});
