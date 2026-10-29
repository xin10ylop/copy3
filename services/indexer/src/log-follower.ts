/**
 * LogFollower - the live indexer in INDEXER_MODE=logs.
 *
 * Instead of eth_getBlockByNumber + eth_getBlockReceipts for every block (~10 blocks/s on
 * Robinhood Chain), it repeatedly indexes [checkpoint+1, head - CONFIRMATIONS] through the
 * shared log path (log-range.ts): one eth_getLogs for the Pons topics, one full block per
 * block that has Pons logs, eth_getLogs for ERC-20 Transfers of tokens launched within the
 * token window (one call per `addressBatch` tokens), then one DB transaction with the
 * checkpoint. Steady state: about one range per `intervalMs`.
 *
 * Head: newHeads (onHead, with hash + timestamp so the checkpoint header is free) and,
 * while no head arrived for `headStaleMs`, a poll of eth_getBlockByNumber('latest') every
 * `pollMs`. Ranges are cut at `chunkBlocks` and run back to back while catching up.
 *
 * Correctness guards:
 *  - ranges are strictly consecutive from the checkpoint; a failed range is retried as a
 *    whole (book dropped, re-hydrated from the DB), so no block range is ever skipped;
 *  - the logs subscription (onLog) counts Pons logs per block; when getLogs returns fewer
 *    for a block (a lagging backend answers "no logs" instead of an error) the range is
 *    retried up to `mismatchRetries` times before the getLogs answer is accepted;
 *  - a `removed` log for an indexed block rolls back from (block - reorgDepth) through the
 *    pipeline's rollback path and re-indexes. Nitro has a single sequencer; this is a
 *    safety net, not an expected path.
 *
 * Not produced: eth_transfers, wallets, traces (TRACE_INTERNAL is ignored). The tracker's
 * transfers_block NOTIFY is sent only for blocks with ETH transfers, so it never fires here.
 */
import type { ChainReader } from './chain.js';
import { hexToNum } from './hex.js';
import { errMsg, type Log } from './log.js';
import { processLogRange, type BlockHeader } from './log-range.js';
import type { BlockPipeline } from './pipeline.js';
import { ponsLogAllowed } from './pons.js';
import type { BlockRange } from './ranges.js';
import type { IndexerStore } from './store.js';
import type { Hex, RpcLog } from './types.js';

export interface LogFollowerConfig {
  confirmations: number;
  /** blocks rolled back before the earliest `removed` log */
  reorgDepth: number;
  /** steady state: at most one range per this many ms ... */
  intervalMs: number;
  /** ... unless at least this many new blocks are pending */
  minBlocks: number;
  /** max blocks per range (= per eth_getLogs) while catching up */
  chunkBlocks: number;
  tokenTransfers: boolean;
  tokenWindowSec: number;
  addressBatch: number;
  /** head poll interval while newHeads is absent or quiet */
  pollMs: number;
  /** newHeads counts as quiet after this long without a head */
  headStaleMs: number;
  /** retries of a range whose getLogs returned fewer Pons logs than the subscription */
  mismatchRetries: number;
}

export const DEFAULT_LOG_FOLLOWER_CONFIG: LogFollowerConfig = {
  confirmations: 0,
  reorgDepth: 10,
  intervalMs: 1000,
  minBlocks: 10,
  chunkBlocks: 2000,
  tokenTransfers: true,
  tokenWindowSec: 6 * 3600,
  addressBatch: 100,
  pollMs: 1000,
  headStaleMs: 3000,
  mismatchRetries: 3,
};

export interface LogFollowerStats {
  ranges: number;
  logs: number;
  launches: number;
  trades: number;
  tokenTransfers: number;
  blocksFetched: number;
  headPolls: number;
  logMismatches: number;
  rollbacks: number;
  lastRange: BlockRange | null;
}

export interface HeadInfo {
  number: number;
  hash?: Hex;
  timestamp?: number;
}

const MAX_TRACKED = 50_000;

export class LogFollower {
  readonly cfg: LogFollowerConfig;
  readonly stats: LogFollowerStats = {
    ranges: 0,
    logs: 0,
    launches: 0,
    trades: 0,
    tokenTransfers: 0,
    blocksFetched: 0,
    headPolls: 0,
    logMismatches: 0,
    rollbacks: 0,
    lastRange: null,
  };
  /** recent headers from newHeads / head polls (checkpoint hash without an extra call) */
  private readonly headers = new Map<number, BlockHeader>();
  /** Pons logs per block seen on the logs subscription */
  private readonly subCounts = new Map<number, number>();
  private mismatch: { from: number; attempts: number } | null = null;
  private pendingRollback: number | null = null;
  /** timestamp of the last checkpoint block: lower bound for the next range's start */
  private lastTs: number | undefined;
  private lastCycleAt = Number.NEGATIVE_INFINITY;
  private lastWsHeadAt = Number.NEGATIVE_INFINITY;
  private lastPollAt = Number.NEGATIVE_INFINITY;
  private wake: (() => void) | null = null;

  constructor(
    private readonly chain: ChainReader,
    private readonly store: IndexerStore,
    private readonly pipeline: BlockPipeline,
    private readonly log: Log,
    cfg: Partial<LogFollowerConfig> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.cfg = { ...DEFAULT_LOG_FOLLOWER_CONFIG, ...cfg };
    if (this.cfg.chunkBlocks < 1) throw new Error('chunkBlocks must be >= 1');
  }

  /** newHeads */
  onHead(h: HeadInfo): void {
    this.lastWsHeadAt = this.now();
    this.noteHead(h);
  }

  /** logs subscription: per-block counts for the getLogs cross-check; `removed` -> rollback */
  onLog(l: RpcLog): void {
    if (!ponsLogAllowed(l)) return;
    const b = hexToNum(l.blockNumber);
    if (l.removed) {
      this.subCounts.set(b, Math.max(0, (this.subCounts.get(b) ?? 0) - 1));
      this.log.warn({ block: b, tx: l.transactionHash }, 'removed log from subscription (reorg signal)');
      this.pendingRollback = Math.min(this.pendingRollback ?? b, b);
      this.wake?.();
      return;
    }
    if (b < this.pipeline.stats.next) return; // already indexed (late delivery): nothing to cross-check
    this.subCounts.set(b, (this.subCounts.get(b) ?? 0) + 1);
    if (this.subCounts.size > MAX_TRACKED) this.subCounts.delete(this.subCounts.keys().next().value!);
  }

  async run(signal: AbortSignal): Promise<void> {
    const s = this.pipeline.stats;
    let backoff = 250;
    while (!signal.aborted) {
      try {
        await this.applyRollback();
        await this.maybePollHead();
        const target = s.head - this.cfg.confirmations;
        const pending = target - s.next + 1;
        const since = this.now() - this.lastCycleAt;
        if (pending <= 0 || (pending < this.cfg.minBlocks && since < this.cfg.intervalMs)) {
          const untilCycle = pending <= 0 ? this.cfg.pollMs : this.cfg.intervalMs - since;
          await this.waitFor(signal, Math.min(untilCycle, this.untilPollDue()));
          continue;
        }
        const r = { from: s.next, to: Math.min(target, s.next + this.cfg.chunkBlocks - 1) };
        this.lastCycleAt = this.now();
        await this.processRange(r);
        backoff = 250;
      } catch (err) {
        s.errors++;
        // the book may hold half-applied state: drop it (curves are re-hydrated from the DB)
        this.pipeline.book.clear();
        this.log.error({ next: s.next, err: errMsg(err) }, 'log range failed; retrying');
        await this.waitFor(signal, backoff, false);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Index one range [r.from, r.to] (must start at the checkpoint + 1) and advance. */
  async processRange(r: BlockRange): Promise<void> {
    const s = this.pipeline.stats;
    if (r.from !== s.next) throw new Error(`range ${r.from}..${r.to} does not start at ${s.next}`);
    const res = await processLogRange({ chain: this.chain, store: this.store, pipeline: this.pipeline, log: this.log }, r, {
      tokenTransfers: this.cfg.tokenTransfers,
      tokenWindowSec: this.cfg.tokenWindowSec,
      addressBatch: this.cfg.addressBatch,
      checkpoint: true,
      headers: this.headers,
      ...(this.lastTs !== undefined ? { startTsHint: this.lastTs } : {}),
      checkLogs: (logs) => this.crossCheck(r, logs),
    });
    const st = this.stats;
    st.ranges++;
    st.logs += res.logs;
    st.launches += res.launches;
    st.trades += res.trades;
    st.tokenTransfers += res.tokenTransfers;
    st.blocksFetched += res.blocksFetched;
    st.lastRange = r;
    s.skippedUnknownCurve += res.skippedUnknownCurve;
    s.processed += r.to - r.from + 1;
    s.next = r.to + 1;
    s.lastBlock = r.to;
    if (res.end) {
      s.lastBlockTs = res.end.ts;
      this.lastTs = res.end.ts;
    }
    s.lastProcessedAt = this.now();
    this.prune(r.to);
    if (res.launches || res.trades) {
      this.log.debug({ range: r, launches: res.launches, trades: res.trades, tokenTransfers: res.tokenTransfers }, 'range');
    }
  }

  // ------------------------------------------------------------------ helpers

  private noteHead(h: HeadInfo): void {
    if (h.hash && h.timestamp !== undefined && h.number >= this.pipeline.stats.next - 1) {
      this.headers.set(h.number, { hash: h.hash, ts: h.timestamp });
      if (this.headers.size > MAX_TRACKED) this.headers.delete(this.headers.keys().next().value!);
    }
    if (h.number > this.pipeline.stats.head) this.pipeline.stats.head = h.number;
    this.wake?.();
  }

  private untilPollDue(): number {
    const now = this.now();
    const quietFor = now - this.lastWsHeadAt;
    if (quietFor < this.cfg.headStaleMs) return this.cfg.headStaleMs - quietFor;
    return Math.max(0, this.cfg.pollMs - (now - this.lastPollAt));
  }

  private async maybePollHead(): Promise<void> {
    const now = this.now();
    if (now - this.lastWsHeadAt < this.cfg.headStaleMs || now - this.lastPollAt < this.cfg.pollMs) return;
    this.lastPollAt = now;
    try {
      const b = await this.chain.getBlock('latest', false);
      this.stats.headPolls++;
      if (b) this.noteHead({ number: hexToNum(b.number), hash: b.hash, timestamp: hexToNum(b.timestamp) });
    } catch (err) {
      this.log.warn({ err: errMsg(err) }, 'head poll failed');
    }
  }

  private async applyRollback(): Promise<void> {
    const b = this.pendingRollback;
    if (b === null) return;
    this.pendingRollback = null;
    const s = this.pipeline.stats;
    if (b >= s.next) return; // not indexed yet: getLogs will return the canonical logs
    const from = Math.max(0, b - this.cfg.reorgDepth);
    try {
      await this.pipeline.rollback(from, b);
    } catch (err) {
      this.pendingRollback = Math.min(this.pendingRollback ?? b, b);
      throw err;
    }
    this.stats.rollbacks++;
    s.next = from;
    s.lastBlock = from - 1;
    this.lastTs = undefined;
    for (const k of [...this.headers.keys()]) if (k >= from) this.headers.delete(k);
    this.mismatch = null;
  }

  private crossCheck(r: BlockRange, logs: readonly RpcLog[]): void {
    if (this.subCounts.size === 0) return;
    const actual = new Map<number, number>();
    for (const l of logs) {
      const b = hexToNum(l.blockNumber);
      actual.set(b, (actual.get(b) ?? 0) + 1);
    }
    const short: number[] = [];
    for (const [b, n] of this.subCounts) if (b >= r.from && b <= r.to && n > (actual.get(b) ?? 0)) short.push(b);
    if (short.length === 0) {
      this.mismatch = null;
      return;
    }
    const attempts = this.mismatch?.from === r.from ? this.mismatch.attempts + 1 : 1;
    this.mismatch = { from: r.from, attempts };
    this.stats.logMismatches++;
    const blocks = short.sort((a, b) => a - b).slice(0, 5);
    if (attempts <= this.cfg.mismatchRetries) {
      throw new Error(`eth_getLogs returned fewer Pons logs than the subscription in blocks ${blocks.join(',')} (node behind?)`);
    }
    this.log.warn({ range: r, blocks, attempts }, 'getLogs still short of the logs subscription; accepting getLogs');
    this.mismatch = null;
  }

  private prune(upTo: number): void {
    for (const k of [...this.subCounts.keys()]) if (k <= upTo) this.subCounts.delete(k);
    // keep the checkpoint header (its timestamp bounds the next range's start)
    for (const k of [...this.headers.keys()]) if (k < upTo) this.headers.delete(k);
  }

  private waitFor(signal: AbortSignal, ms: number, wakeable = true): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const t = setTimeout(done, Math.max(1, ms));
      if (wakeable) this.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
