import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { FeedClient, FeedStats, type FeedBlock, type FeedGap } from '../src/feed/decoder.js';

const lines = readFileSync(fileURLToPath(new URL('./fixtures/feed-frames.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.stringify((JSON.parse(l) as { frame: unknown }).frame));

const servers: WebSocketServer[] = [];
const clients: FeedClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.stop());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function server(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  await new Promise((r) => wss.once('listening', r));
  return { wss, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` };
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('FeedClient', () => {
  it('streams blocks, detects gaps, drops duplicates', async () => {
    const { wss, url } = await server();
    wss.on('connection', (ws) => {
      for (const [i, f] of lines.entries()) if (i !== 10) ws.send(f); // drop one block → gap
      ws.send(lines[5]!); // duplicate
    });
    const stats = new FeedStats();
    const c = new FeedClient({ urls: [url], stats });
    clients.push(c);
    const got: FeedBlock[] = [];
    const gaps: FeedGap[] = [];
    c.on('block', (b) => got.push(b));
    c.on('gap', (g) => gaps.push(g));
    c.start();
    await until(() => got.length === 38);
    expect(gaps).toEqual([{ from: 100307484, to: 100307484 }]);
    expect(stats.snapshot().duplicates).toBe(1);
    expect(stats.snapshot().gaps).toBe(1);
    expect(c.head).toBe(100307512);
    expect(stats.snapshot().decodeMs.max).toBeGreaterThan(0);
  });

  it('fails over to the secondary when the primary dies and replays from the next block', async () => {
    const primary = await server();
    const secondary = await server();
    const requested: (string | undefined)[] = [];
    primary.wss.on('connection', (ws) => {
      for (const f of lines.slice(0, 10)) ws.send(f);
      setTimeout(() => ws.terminate(), 20);
    });
    secondary.wss.on('connection', (ws, req) => {
      const h = req.headers['arbitrum-requested-sequence-number'];
      requested.push(Array.isArray(h) ? h[0] : h);
      for (const f of lines.slice(5)) ws.send(f); // overlap with primary → duplicates dropped
    });
    const c = new FeedClient({ urls: [primary.url, secondary.url], reconnectDelayMs: 10 });
    clients.push(c);
    const got: number[] = [];
    const conns: string[] = [];
    c.on('block', (b) => got.push(b.block));
    c.on('connected', (u) => conns.push(u));
    c.on('error', () => undefined);
    c.start();
    await until(() => got.length === 39);
    expect(conns).toEqual([primary.url, secondary.url]);
    expect(requested[0]).toBe(String(got[9]! + 1));
    for (let i = 1; i < got.length; i++) expect(got[i]).toBe(got[i - 1]! + 1);
  });

  it('reconnects when the feed goes stale', async () => {
    const { wss, url } = await server();
    let n = 0;
    wss.on('connection', (ws) => {
      n++;
      ws.send(lines[n]!); // one frame per connection, then silence
    });
    const c = new FeedClient({ urls: [url], staleMs: 80, reconnectDelayMs: 5 });
    clients.push(c);
    const got: number[] = [];
    c.on('block', (b) => got.push(b.block));
    c.on('error', () => undefined);
    c.start();
    await until(() => got.length >= 3);
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
