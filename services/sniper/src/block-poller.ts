/**
 * Feed fallback (1 Nov 2026: the public sequencer feed refused the box with HTTP 403 for hours;
 * launches were only seen from the node's logs 13–22 s late). While the feed has been down for
 * `afterMs`, poll the sequencer RPC for the latest block every `intervalMs` and push each new block
 * through the same `onBlock` the feed uses. Blocks at or below the last one delivered (by either
 * source) are skipped, so the feed coming back cannot double-feed. ~60–100 ms behind the feed.
 */
import type { FeedBlock } from '@hood/core';
import type { ChainClient } from './chain.js';
import type { Logger } from './log.js';

export interface BlockPollerOptions {
  chain: Pick<ChainClient, 'getLatestBlock'>;
  onBlock: (b: FeedBlock) => void;
  logger: Logger;
  /** poll period while active. Default 100 ms. */
  intervalMs?: number;
  /** start polling this long after the feed went down. Default 2000 ms. */
  afterMs?: number;
  now?: () => number;
}

export class RpcBlockPoller {
  private timer: NodeJS.Timeout | null = null;
  private armTimer: NodeJS.Timeout | null = null;
  private lastBlock = 0;
  private inFlight = false;
  readonly stats = { polls: 0, blocks: 0, errors: 0, activations: 0 };
  private readonly o: Required<Omit<BlockPollerOptions, 'chain' | 'onBlock' | 'logger'>> & BlockPollerOptions;

  constructor(o: BlockPollerOptions) {
    this.o = { intervalMs: 100, afterMs: 2000, now: () => Date.now(), ...o };
  }

  get active(): boolean {
    return this.timer !== null;
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
      if (b && b.block > this.lastBlock) {
        this.lastBlock = b.block;
        this.stats.blocks++;
        this.o.onBlock({ ...b, receivedAt: this.o.now() });
      }
    } catch {
      this.stats.errors++;
    } finally {
      this.inFlight = false;
    }
  }

  stop(): void {
    this.feedUp();
  }
}
