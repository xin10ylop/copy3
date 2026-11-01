import { describe, expect, it } from 'vitest';
import type { FeedBlock } from '@hood/core';
import { RpcBlockPoller } from '../src/block-poller.js';
import { silentLogger } from '../src/log.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blk = (n: number): FeedBlock => ({ block: n, timestamp: 1_793_000_000 + Math.floor(n / 10), txs: [], receivedAt: 0, headerKind: 3 });

describe('RpcBlockPoller: blocks from the sequencer RPC while the feed is down', () => {
  it('arms after afterMs, delivers only NEW blocks, stops when the feed is back, never double-feeds', async () => {
    let latest = 100;
    const calls: number[] = [];
    const chain = { getLatestBlock: async () => (calls.push(latest), blk(latest)) };
    const got: number[] = [];
    const p = new RpcBlockPoller({ chain, onBlock: (b) => got.push(b.block), logger: silentLogger, intervalMs: 10, afterMs: 30 });
    p.onFeedBlock(blk(100)); // the feed delivered 100 before it died
    p.feedDown();
    await sleep(15);
    expect(p.active).toBe(false); // not yet: the feed may come straight back
    await sleep(40);
    expect(p.active).toBe(true);
    await sleep(25);
    expect(got).toEqual([]); // latest is still 100: already seen from the feed
    latest = 101;
    await sleep(25);
    latest = 102;
    await sleep(25);
    expect(got).toEqual([101, 102]);
    expect(p.snapshot()).toMatchObject({ active: true, blocks: 2, activations: 1, errors: 0 });
    expect(p.snapshot().lastBlockAt).toBeGreaterThan(0);
    p.feedUp();
    expect(p.active).toBe(false);
    expect(p.snapshot().active).toBe(false);
    latest = 103;
    await sleep(25);
    expect(got).toEqual([101, 102]); // off: the feed owns the stream again
    p.onFeedBlock(blk(103));
    p.feedDown();
    await sleep(60);
    expect(got).toEqual([101, 102]); // 103 came from the feed: not re-delivered by the poller
    p.stop();
    expect(calls.length).toBeGreaterThan(3);
  });

  it('a feed that comes back within afterMs never activates the poller', async () => {
    const p = new RpcBlockPoller({ chain: { getLatestBlock: async () => blk(1) }, onBlock: () => undefined, logger: silentLogger, intervalMs: 10, afterMs: 50 });
    p.feedDown();
    await sleep(20);
    p.feedUp();
    await sleep(60);
    expect(p.active).toBe(false);
    expect(p.stats.activations).toBe(0);
  });

  it('fetches the blocks a slow poll skipped, by number and in order, and counts longer holes as a gap', async () => {
    let latest = 10;
    const byNumber: number[] = [];
    const chain = {
      getLatestBlock: async (n?: number) => {
        if (n !== undefined) byNumber.push(n);
        return blk(n ?? latest);
      },
    };
    const got: number[] = [];
    const p = new RpcBlockPoller({ chain, onBlock: (b) => got.push(b.block), logger: silentLogger, intervalMs: 10, afterMs: 0, maxCatchUp: 3 });
    p.feedDown();
    await sleep(30);
    expect(got).toEqual([10]); // first poll: nothing to catch up (no earlier block known)
    latest = 13; // 11 and 12 sealed between two polls
    await sleep(30);
    expect(got).toEqual([10, 11, 12, 13]);
    expect(byNumber).toEqual([11, 12]);
    expect(p.snapshot()).toMatchObject({ caughtUp: 2, gaps: 0 });
    latest = 20; // 14..19 skipped: only the last maxCatchUp (17, 18, 19) are fetched, 14..16 are a gap
    await sleep(30);
    expect(got).toEqual([10, 11, 12, 13, 17, 18, 19, 20]);
    expect(p.snapshot()).toMatchObject({ caughtUp: 5, gaps: 1 });
    p.stop();
  });
});
