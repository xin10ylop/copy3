/**
 * Feed fallback (1 Nov 2026: the public sequencer feed refused the box with HTTP 403 for hours;
 * launches were only seen from the node's logs 13–22 s late). While the feed has been down for
 * `afterMs`, poll the sequencer RPC for the latest block every `intervalMs` and push each new block
 * through the same `onBlock` the feed uses. Blocks at or below the last one delivered (by either
 * source) are skipped, so the feed coming back cannot double-feed. ~50 ms behind the feed on average.
 *
 * The default period is 97 ms, not 100: blocks seal on a 100 ms grid, and a poll period equal to it
 * would lock to one phase, so every arrival would carry the same unknown 0–100 ms lateness and the
 * sequencer clock's min-filter (boundary = earliest arrival per second) could never see through it.
 * At 97 ms the phase sweeps the grid every ~3 s, so within a few seconds some polls land right after
 * a seal and the clock's boundary estimate is within a few ms of the feed's.
 *
 * A poll slower than a block (an RPC hiccup) would jump from block n to n+2: the skipped blocks are
 * fetched by number and delivered in order (up to `maxCatchUp`; a longer hole is a gap, as on the feed).
 */
import type { FeedBlock } from '@hood/core';
import type { ChainClient } from './chain.js';
import type { Logger } from './log.js';

export interface BlockPollerOptions {
  chain: Pick<ChainClient, 'getLatestBlock'>;
  onBlock: (b: FeedBlock) => void;
  logger: Logger;
  /** poll period while active. Default 97 ms (see above: not a multiple of the 100 ms seal grid). */
  intervalMs?: number;
  /** most skipped blocks fetched by number after one poll (older ones are dropped as a gap). Default 20. */
  maxCatchUp?: number;
  /** start polling this long after the feed went down. Default 2000 ms. */
  afterMs?: number;
  now?: () => number;
}

export interface FallbackSnapshot {
  active: boolean;
  polls: number;
  blocks: number;
  errors: number;
  activations: number;
  /** skipped blocks fetched by number */
  caughtUp: number;
  /** holes longer than maxCatchUp (blocks never delivered) */
  gaps: number;
  lastBlockAt: number | null;
}

export class RpcBlockPoller {
  private timer: NodeJS.Timeout | null = null;
  private armTimer: NodeJS.Timeout | null = null;
  private lastBlock = 0;
  private inFlight = false;
  readonly stats = { polls: 0, blocks: 0, errors: 0, activations: 0, caughtUp: 0, gaps: 0, lastBlockAt: null as number | null };
  private readonly o: Required<Omit<BlockPollerOptions, 'chain' | 'onBlock' | 'logger'>> & BlockPollerOptions;

  constructor(o: BlockPollerOptions) {
    this.o = { intervalMs: 97, afterMs: 2000, maxCatchUp: 20, now: () => Date.now(), ...o };
  }

  get active(): boolean {
    return this.timer !== null;
  }

  /** For /healthz: whether the poller is on, its counters and when it last delivered a block. */
  snapshot(): FallbackSnapshot {
    return { active: this.active, ...this.stats };
  }

  /** The feed delivered a block: remember it (dedupe) and make sure the poller is off. */
  onFeedBlock(b: FeedBlock): void {
    if (b.block > this.lastBlock) this.lastBlock = b.block;
    this.feedUp();
  }

  /** The feed went down: arm the poller unless the feed is back within `afterMs`. */
  feedDown(): void {
    if (this.timer || this.armTimer || !this.o.chain.getLatestBlock) return;
    this.armTimer = setTimeout(() => {
      this.armTimer = null;
      this.start();
    }, this.o.afterMs);
    this.armTimer.unref?.();
  }

  feedUp(): void {
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.o.logger.info({ blocks: this.stats.blocks }, 'feed back: rpc block poller off');
    }
  }

  private start(): void {
    if (this.timer) return;
    this.stats.activations++;
    this.o.logger.warn({ intervalMs: this.o.intervalMs }, 'feed down: polling the sequencer RPC for blocks');
    this.timer = setInterval(() => void this.poll(), this.o.intervalMs);
    this.timer.unref?.();
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.inFlight || !this.o.chain.getLatestBlock) return;
    this.inFlight = true;
    this.stats.polls++;
    try {
      const b = await this.o.chain.getLatestBlock();
      if (!b || b.block <= this.lastBlock) return;
      if (this.lastBlock > 0 && b.block > this.lastBlock + 1) {
        // blocks sealed between two polls: fetch them by number, oldest first, before the latest
        const from = Math.max(this.lastBlock + 1, b.block - this.o.maxCatchUp);
        if (from > this.lastBlock + 1) {
          this.stats.gaps++;
          this.o.logger.warn({ from: this.lastBlock + 1, to: from - 1 }, 'rpc block poller gap');
        }
        for (let n = from; n < b.block; n++) {
          const m = await this.o.chain.getLatestBlock(n);
          if (!m) break;
          this.stats.caughtUp++;
          this.deliver(m);
        }
      }
      this.deliver(b);
    } catch {
      this.stats.errors++;
    } finally {
      this.inFlight = false;
    }
  }

  private deliver(b: FeedBlock): void {
    if (b.block <= this.lastBlock) return;
    this.lastBlock = b.block;
    this.stats.blocks++;
    const receivedAt = this.o.now();
    this.stats.lastBlockAt = receivedAt;
    this.o.onBlock({ ...b, receivedAt });
  }

  stop(): void {
    this.feedUp();
  }
}
