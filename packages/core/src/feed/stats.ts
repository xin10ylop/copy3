/** Rolling feed health statistics: throughput, gaps, decode cost, raw lag. */
import type { FeedBlock } from './decode.js';

export interface FeedStatsSnapshot {
  blocks: number;
  blocksPerSec: number;
  lastBlock: number | null;
  lastTimestamp: number | null;
  lastReceivedAt: number | null;
  /** receivedAt − timestamp·1000 of the last block (includes the ≤1 s timestamp quantisation). */
  rawLagMs: number | null;
  gaps: number;
  gapBlocks: number;
  duplicates: number;
  /** frames dropped because their sequence numbers were implausibly far from the head */
  bogus: number;
  resets: number;
  reconnects: number;
  failovers: number;
  currentUrl: string | null;
  decodeMs: { last: number; avg: number; p50: number; p99: number; max: number };
}

const RING = 1024;

export class FeedStats {
  blocks = 0;
  gaps = 0;
  gapBlocks = 0;
  duplicates = 0;
  bogus = 0;
  resets = 0;
  reconnects = 0;
  failovers = 0;
  currentUrl: string | null = null;
  lastBlock: number | null = null;
  lastTimestamp: number | null = null;
  lastReceivedAt: number | null = null;
  private decodeRing = new Float64Array(RING);
  private decodeN = 0;
  private decodeLast = 0;
  private decodeMax = 0;
  private decodeSum = 0;
  private arrivals: number[] = [];

  /** Record one block delivered to consumers; `decodeMs` is the frame decode cost. */
  recordBlock(b: FeedBlock, decodeMs: number): void {
    this.blocks++;
    this.lastBlock = b.block;
    this.lastTimestamp = b.timestamp;
    this.lastReceivedAt = b.receivedAt;
    this.arrivals.push(b.receivedAt);
    const cutoff = b.receivedAt - 10_000;
    while (this.arrivals.length > 0 && this.arrivals[0]! < cutoff) this.arrivals.shift();
    this.recordDecode(decodeMs);
  }

  recordDecode(ms: number): void {
    this.decodeRing[this.decodeN % RING] = ms;
    this.decodeN++;
    this.decodeLast = ms;
    this.decodeSum += ms;
    if (ms > this.decodeMax) this.decodeMax = ms;
  }

  recordGap(from: number, to: number): void {
    this.gaps++;
    this.gapBlocks += to - from + 1;
  }

  blocksPerSec(): number {
    if (this.arrivals.length < 2) return 0;
    const span = this.arrivals[this.arrivals.length - 1]! - this.arrivals[0]!;
    return span > 0 ? ((this.arrivals.length - 1) * 1000) / span : 0;
  }

  private quantile(q: number): number {
    const n = Math.min(this.decodeN, RING);
    if (n === 0) return 0;
    const arr = Array.from(this.decodeRing.subarray(0, n)).sort((a, b) => a - b);
    return arr[Math.min(n - 1, Math.floor(q * (n - 1)))]!;
  }

  snapshot(): FeedStatsSnapshot {
    return {
      blocks: this.blocks,
      blocksPerSec: this.blocksPerSec(),
      lastBlock: this.lastBlock,
      lastTimestamp: this.lastTimestamp,
      lastReceivedAt: this.lastReceivedAt,
      rawLagMs:
        this.lastReceivedAt !== null && this.lastTimestamp !== null
          ? this.lastReceivedAt - this.lastTimestamp * 1000
          : null,
      gaps: this.gaps,
      gapBlocks: this.gapBlocks,
      duplicates: this.duplicates,
      bogus: this.bogus,
      resets: this.resets,
      reconnects: this.reconnects,
      failovers: this.failovers,
      currentUrl: this.currentUrl,
      decodeMs: {
        last: this.decodeLast,
        avg: this.decodeN ? this.decodeSum / this.decodeN : 0,
        p50: this.quantile(0.5),
        p99: this.quantile(0.99),
        max: this.decodeMax,
      },
    };
  }
}

/** Process-wide stats instance used by the default `FeedClient`. */
export const feedStats = new FeedStats();
