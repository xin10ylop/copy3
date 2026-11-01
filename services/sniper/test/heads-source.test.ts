import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FeedBlock } from '@hood/core';
import { BlockGate } from '../src/block-gate.js';
import { HeadsBlockSource } from '../src/heads-source.js';
import { silentLogger } from '../src/log.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16)}`;
const HASH = '0x' + 'ab'.repeat(32);

/** A public-RPC-like websocket: newHeads subscription + eth_getBlockByNumber from `have`. */
class Node {
  readonly wss: WebSocketServer;
  readonly clients = new Set<WebSocket>();
  readonly fetched: number[] = [];
  have = new Set<number>();
  url = '';
  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as { id: number; method: string; params: unknown[] };
        if (m.method === 'eth_subscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: '0xsub1' }));
        else if (m.method === 'eth_getBlockByNumber') {
          const n = Number(m.params[0]);
          this.fetched.push(n);
          const block = this.have.has(n)
            ? {
                number: hex(n),
                hash: HASH,
                timestamp: hex(1_793_000_000 + Math.floor(n / 10)),
                transactions: [
                  { hash: '0x' + n.toString(16).padStart(64, '0'), from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), input: '0x', value: '0x1', nonce: '0x0', gas: '0x5208', type: '0x2', transactionIndex: '0x0' },
                ],
              }
            : null;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: block }));
        }
      });
    });
  }
  async listen(): Promise<this> {
    await new Promise((r) => this.wss.once('listening', r));
    this.url = `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
    return this;
  }
  announce(n: number): void {
    this.have.add(n);
    for (const c of this.clients) c.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0xsub1', result: { number: hex(n), hash: HASH, timestamp: hex(1_793_000_000) } } }));
  }
  close(): void {
    for (const c of this.clients) c.terminate();
    this.wss.close();
  }
}

const nodes: Node[] = [];
const sources: HeadsBlockSource[] = [];
afterEach(() => {
  for (const s of sources) s.stop();
  for (const n of nodes) n.close();
  nodes.length = 0;
  sources.length = 0;
});

async function node(): Promise<Node> {
  const n = await new Node().listen();
  nodes.push(n);
  return n;
}

describe('HeadsBlockSource: blocks from public-RPC newHeads sockets', () => {
  it('fetches the announced block over the announcing socket, in order, once across sockets, catching up unseen blocks', async () => {
    const a = await node();
    const b = await node();
    const got: FeedBlock[] = [];
    const gate = new BlockGate((blk) => got.push(blk));
    const src = new HeadsBlockSource({ urls: [a.url, b.url], gate, logger: silentLogger, maxCatchUp: 3, pingMs: 50 });
    sources.push(src);
    src.start();
    await sleep(150);
    expect(src.connected).toBe(2);

    a.announce(100);
    await sleep(60);
    expect(got.map((x) => x.block)).toEqual([100]);
    expect(got[0]!.txs).toHaveLength(1);
    expect(got[0]!.blockHash).toBe(HASH);
    expect(a.fetched).toEqual([100]);

    // both announce 101: one fetch, on whichever announced first
    a.have.add(101);
    b.have.add(101);
    a.announce(101);
    b.announce(101);
    await sleep(60);
    expect(got.map((x) => x.block)).toEqual([100, 101]);
    expect(a.fetched.length + b.fetched.length).toBe(2);

    // b jumps to 104 (102, 103 never announced): catch-up in order, then 104
    for (const n of [102, 103, 104]) b.have.add(n);
    b.announce(104);
    await sleep(80);
    expect(got.map((x) => x.block)).toEqual([100, 101, 102, 103, 104]);
    expect(b.fetched).toEqual([102, 103, 104]);
    expect(src.snapshot()).toMatchObject({ heads: 4, blocks: 5, caughtUp: 2, gaps: 0, fetchErrors: 0, connected: 2 });

    // a hole longer than maxCatchUp (105..110 unseen, 111 announced): only the last 3 are fetched, the rest is a gap
    for (let n = 105; n <= 111; n++) a.have.add(n);
    a.announce(111);
    await sleep(80);
    expect(got.map((x) => x.block).slice(-3)).toEqual([109, 110, 111]);
    expect(got.some((x) => x.block === 108)).toBe(false);
    expect(src.snapshot()).toMatchObject({ gaps: 1 });
  });

  it('never fetches a block the feed already delivered, and falls back to another socket when the announcer cannot serve the block', async () => {
    const a = await node();
    const b = await node();
    const got: number[] = [];
    const gate = new BlockGate((blk) => got.push(blk.block));
    const src = new HeadsBlockSource({ urls: [a.url, b.url], gate, logger: silentLogger, pingMs: 50 });
    sources.push(src);
    src.start();
    await sleep(150);

    // the feed delivered 200 first: the head for 200 is a no-op
    gate.deliver({ block: 200, timestamp: 1_793_000_020, txs: [], receivedAt: Date.now(), headerKind: 3 }, 'feed');
    a.announce(200);
    await sleep(60);
    expect(a.fetched).toEqual([]);
    expect(got).toEqual([200]); // the feed's delivery; nothing from the sockets

    // a announces 201 but answers null for it (not yet executed there); b has it
    b.have.add(201);
    for (const c of a.clients) c.send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0xsub1', result: { number: hex(201), hash: HASH, timestamp: hex(1_793_000_020) } } }));
    await sleep(80);
    expect(a.fetched).toEqual([201]);
    expect(b.fetched).toEqual([201]);
    expect(got).toEqual([200, 201]);
    expect(src.snapshot().fetchErrors).toBe(0);
  });

  it('reconnects after the socket drops and resumes delivering', async () => {
    const a = await node();
    const got: number[] = [];
    const gate = new BlockGate((blk) => got.push(blk.block));
    const src = new HeadsBlockSource({ urls: [a.url], gate, logger: silentLogger, reconnectMs: 20, maxReconnectMs: 40, pingMs: 50 });
    sources.push(src);
    src.start();
    await sleep(150);
    expect(src.connected).toBe(1);
    for (const c of a.clients) c.terminate();
    await sleep(150); // reconnectMs 20: it is back up well within this
    expect(src.connected).toBe(1);
    expect(src.snapshot().reconnects).toBeGreaterThanOrEqual(1);
    a.announce(300);
    await sleep(60);
    expect(got).toEqual([300]);
  });
});
