import { describe, expect, it } from 'vitest';
import type { FeedBlock } from '@hood/core';
import { BlockGate } from '../src/block-gate.js';

const blk = (n: number, receivedAt = n * 100): FeedBlock => ({ block: n, timestamp: 1_793_000_000 + Math.floor(n / 10), txs: [], receivedAt, headerKind: 3 });

describe('BlockGate: one ordered entry point for every block source', () => {
  it('delivers only strictly newer blocks, whatever the source, and counts per source', () => {
    const got: string[] = [];
    const g = new BlockGate((b, src) => got.push(`${src}:${b.block}`));
    expect(g.deliver(blk(10), 'feed')).toBe(true);
    expect(g.deliver(blk(10), 'heads')).toBe(false); // same block from a second source: dropped
    expect(g.deliver(blk(9), 'rpc-poll')).toBe(false); // older: dropped
    expect(g.deliver(blk(11), 'heads')).toBe(true); // the first source with the next block owns it
    expect(g.deliver(blk(11), 'feed')).toBe(false);
    expect(g.deliver(blk(12), 'feed')).toBe(true);
    expect(got).toEqual(['feed:10', 'heads:11', 'feed:12']);
    expect(g.snapshot()).toEqual({ last: 12, lastAt: 1200, lastSource: 'feed', bySource: { feed: 2, heads: 1 } });
  });
});
