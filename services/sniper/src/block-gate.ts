/**
 * One ordered entry point for blocks from every source (sequencer feed, public-RPC newHeads,
 * RPC poller): a block at or below the last delivered one is dropped, so running several sources
 * at once never double-feeds the sniper, and whichever source is first owns the stream.
 */
import type { FeedBlock } from '@hood/core';

export interface BlockGateSnapshot {
  last: number;
  lastAt: number | null;
  lastSource: string | null;
  bySource: Record<string, number>;
}

export class BlockGate {
  last = 0;
  lastAt: number | null = null;
  lastSource: string | null = null;
  readonly bySource: Record<string, number> = {};

  constructor(private readonly onBlock: (b: FeedBlock, source: string) => void) {}

  /** Deliver `b` from `source` unless an equal or newer block was already delivered. */
  deliver(b: FeedBlock, source: string): boolean {
    if (b.block <= this.last) return false;
    this.last = b.block;
    this.lastAt = b.receivedAt;
    this.lastSource = source;
    this.bySource[source] = (this.bySource[source] ?? 0) + 1;
    this.onBlock(b, source);
    return true;
  }

  snapshot(): BlockGateSnapshot {
    return { last: this.last, lastAt: this.lastAt, lastSource: this.lastSource, bySource: { ...this.bySource } };
  }
}
