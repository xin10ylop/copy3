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

describe('FeedClient stale primary', () => {
  it('a stale primary is retried on the primary first; the DELAYED secondary only after two consecutive stale timeouts', async () => {
    const primary = await server();
    const secondary = await server();
    const conns: string[] = [];
    let p = 0;
    primary.wss.on('connection', (ws) => {
      conns.push('p');
      if (++p === 1) ws.send(lines[0]!); // one block on the first connection, then silence forever
    });
    secondary.wss.on('connection', (ws) => {
      conns.push('s');
      ws.send(lines[1]!);
    });
    const stats = new FeedStats();
    const c = new FeedClient({ urls: [primary.url, secondary.url], staleMs: 60, reconnectDelayMs: 5, stats });
    clients.push(c);
    c.on('error', () => undefined);
    c.start();
    await until(() => conns.length >= 3);
    // stale #1 → the primary again (no detour onto the delayed feed); stale #2 in a row → secondary
    expect(conns.slice(0, 3)).toEqual(['p', 'p', 's']);
    expect(stats.snapshot().failovers).toBe(1);
    expect(stats.snapshot().reconnects).toBe(2);
  });

  it('a primary that keeps delivering after each stale reconnect never fails over', async () => {
    const primary = await server();
    const secondary = await server();
    let n = 0;
    const conns: string[] = [];
    primary.wss.on('connection', (ws) => {
      conns.push('p');
      ws.send(lines[n++]!); // a NEW block per connection: the stale streak resets every time
    });
    secondary.wss.on('connection', () => conns.push('s'));
    const c = new FeedClient({ urls: [primary.url, secondary.url], staleMs: 60, reconnectDelayMs: 5 });
    clients.push(c);
    const got: number[] = [];
    c.on('block', (b) => got.push(b.block));
    c.on('error', () => undefined);
    c.start();
    await until(() => got.length >= 4);
    expect(conns).not.toContain('s');
  });
});

describe('FeedClient robustness', () => {
  it('M2: handleFrame never throws, even without an error listener', () => {
    const c = new FeedClient({ urls: ['ws://unused'], stats: new FeedStats() });
    for (const f of ['{"messages":[null]}', '{"messages":[{"sequenceNumber":5,"message":{"message":{"header":{"kind":3,"timestamp":1},"l2Msg":12345}}}]}', 'not json', '{"messages":7}']) {
      expect(() => c.handleFrame(f, 0)).not.toThrow();
    }
    // a throwing block listener does not break delivery of later blocks
    const c2 = new FeedClient({ urls: ['ws://unused'], stats: new FeedStats() });
    const seen: number[] = [];
    c2.on('block', (b) => {
      seen.push(b.block);
      throw new Error('listener bug');
    });
    expect(() => c2.handleFrame(lines[0]!, 1)).not.toThrow();
    expect(() => c2.handleFrame(lines[1]!, 2)).not.toThrow();
    expect(seen).toEqual([100307474, 100307475]);
  });

  it('L3: a bogus huge sequenceNumber is dropped; real frames keep flowing', () => {
    const stats = new FeedStats();
    const c = new FeedClient({ urls: ['ws://unused'], stats });
    const got: number[] = [];
    c.on('block', (b) => got.push(b.block));
    c.handleFrame(lines[0]!, 1);
    const bogus = JSON.parse(lines[1]!) as { messages: { sequenceNumber: number }[] };
    bogus.messages[0]!.sequenceNumber = 9_999_999_999;
    expect(c.handleFrame(JSON.stringify(bogus), 2)).toEqual([]);
    for (const l of lines.slice(1, 6)) c.handleFrame(l, 3);
    expect(got).toEqual([100307474, 100307475, 100307476, 100307477, 100307478, 100307479]);
    expect(stats.snapshot().bogus).toBe(1);
    expect(c.head).toBe(100307479);
  });

  it('L3: a head that is genuinely wrong recovers after consistent frames (reset), duplicates are not liveness', async () => {
    const stats = new FeedStats();
    const c = new FeedClient({ urls: ['ws://unused'], stats, resetAfter: 3 });
    const resets: { from: number; to: number }[] = [];
    c.on('reset', (r) => resets.push(r));
    // poisoned head (e.g. first frame after connect was bogus)
    const bogus = JSON.parse(lines[0]!) as { messages: { sequenceNumber: number }[] };
    bogus.messages[0]!.sequenceNumber = 9_999_999_999;
    c.handleFrame(JSON.stringify(bogus), 0);
    const got: number[] = [];
    c.on('block', (b) => got.push(b.block));
    for (const l of lines.slice(1, 6)) c.handleFrame(l, 1);
    expect(resets).toEqual([{ from: 9_999_999_999, to: 100307477 }]);
    expect(got).toEqual([100307477, 100307478, 100307479]);

    // liveness: a server that only repeats old frames is stale and gets dropped
    const { wss, url } = await server();
    let conns = 0;
    wss.on('connection', (ws) => {
      conns++;
      ws.send(lines[0]!);
      const t = setInterval(() => ws.readyState === ws.OPEN && ws.send(lines[0]!), 10); // duplicates forever
      ws.on('close', () => clearInterval(t));
    });
    const c3 = new FeedClient({ urls: [url], staleMs: 80, reconnectDelayMs: 5 });
    clients.push(c3);
    c3.on('error', () => undefined);
    c3.start();
    await until(() => conns >= 2, 3000);
    expect(c3.stats.snapshot().duplicates).toBeGreaterThan(3);
  });
});

describe('N9: forward jumps bounded by elapsed time; poisoned head recovers', () => {
  const seqOf = (l: string): number => (JSON.parse(l) as { messages: { sequenceNumber: number }[] }).messages[0]!.sequenceNumber;
  const shift = (l: string, by: number): string => {
    const f = JSON.parse(l) as { messages: { sequenceNumber: number }[] };
    for (const m of f.messages) m.sequenceNumber += by;
    return JSON.stringify(f);
  };

  it('PoC I: a bogus far-future message inside a real frame is dropped; the real ones keep flowing', () => {
    const stats = new FeedStats();
    const c = new FeedClient({ urls: ['ws://unused'], stats });
    const got: number[] = [];
    c.on('block', (b) => got.push(b.block));
    c.handleFrame(lines[0]!, 0);
    const mixed = JSON.parse(lines[1]!) as { messages: { sequenceNumber: number }[] };
    mixed.messages.push({ ...mixed.messages[0]!, sequenceNumber: mixed.messages[0]!.sequenceNumber + 49_000 });
    c.handleFrame(JSON.stringify(mixed), 1);
    for (let i = 2; i < 12; i++) c.handleFrame(lines[i]!, i);
    expect(got).toEqual(Array.from({ length: 12 }, (_, i) => seqOf(lines[0]!) + i));
    expect(c.head).toBe(seqOf(lines[11]!));
    expect(stats.snapshot().resets).toBe(0);
    expect(stats.snapshot().bogus).toBe(1);
  });

  it('a whole frame 40 000 blocks ahead (inside the old 50k window) is dropped; a real gap after a long silence is accepted', () => {
    const stats = new FeedStats();
    const c = new FeedClient({ urls: ['ws://unused'], stats });
    const gaps: FeedGap[] = [];
    c.on('gap', (g) => gaps.push(g));
    c.handleFrame(lines[0]!, 1_000);
    expect(c.handleFrame(shift(lines[1]!, 40_000), 1_100)).toEqual([]);
    expect(c.head).toBe(seqOf(lines[0]!));
    // 60 s later the feed resumes 600 blocks on (≈10 blocks/s): plausible, delivered with a gap
    expect(c.handleFrame(shift(lines[1]!, 600), 61_000)).toHaveLength(1);
    expect(c.head).toBe(seqOf(lines[1]!) + 600);
    expect(gaps).toEqual([{ from: seqOf(lines[0]!) + 1, to: seqOf(lines[1]!) + 599 }]);
  });

  it('a poisoned head (bogus first frame) is reset by the second stale reconnect, which stops requesting replay from it', async () => {
    const { wss, url } = await server();
    const replayHeaders: (string | undefined)[] = [];
    wss.on('connection', (ws, req) => {
      replayHeaders.push(req.headers['arbitrum-requested-sequence-number'] as string | undefined);
      if (replayHeaders.length === 1) ws.send(shift(lines[0]!, 30_000)); // first frame ever: poisoned head
      let i = 1;
      const t = setInterval(() => ws.readyState === ws.OPEN && i < lines.length && ws.send(lines[i++]!), 5);
      ws.on('close', () => clearInterval(t));
    });
    const c = new FeedClient({ urls: [url], staleMs: 60, reconnectDelayMs: 5 });
    clients.push(c);
    c.on('error', () => undefined);
    const resets: { from: number; to: number }[] = [];
    c.on('reset', (r) => resets.push(r));
    const got: number[] = [];
    c.on('block', (b) => got.push(b.block));
    c.start();
    await until(() => got.length >= 3, 5000);
    const poisoned = seqOf(lines[0]!) + 30_000;
    expect(got[0]).toBe(poisoned);
    expect(replayHeaders[1]).toBe(String(poisoned + 1)); // first reconnect still trusts the head
    expect(replayHeaders[2]).toBeUndefined(); // second: no replay from a head nobody confirms
    expect(resets[0]!.from).toBe(poisoned);
    expect(got.slice(1).every((b) => b < poisoned)).toBe(true);
  });
});
