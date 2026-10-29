/**
 * Log-based backfill: eth_getLogs over <= 20k-block ranges (split further when the
 * node rejects a range), then the same processEvents/metrics path as the live
 * pipeline. Idempotent: rows are written with ON CONFLICT DO NOTHING and the
 * in-memory book de-duplicates trades/transfers already in the DB.
 *
 * ETH transfers / wallets are NOT in logs; use `--mode blocks` (full block scan,
 * needs an own node) for those. The per-range work lives in log-range.ts and is shared
 * with the live indexer's INDEXER_MODE=logs (log-follower.ts).
 */
import type { ChainReader } from './chain.js';
import { errMsg, type Log } from './log.js';
import { processLogRange } from './log-range.js';
import type { BlockPipeline } from './pipeline.js';
import { chunkRanges, type BlockRange } from './ranges.js';
import type { IndexerStore } from './store.js';

export { getLogsSplitting } from './log-range.js';

export interface BackfillOptions {
  from: number;
  to: number;
  chunk: number;
  /** also fetch ERC-20 Transfer logs of launched tokens */
  tokenTransfers: boolean;
  /** only tokens launched within this many seconds before a chunk get Transfer logs fetched */
  tokenWindowSec: number;
  /** max addresses per eth_getLogs address filter */
  addressBatch: number;
}

export interface BackfillStats {
  chunks: number;
  logs: number;
  launches: number;
  trades: number;
  tokenTransfers: number;
  blocksFetched: number;
  skippedUnknownCurve: number;
}

export class LogBackfill {
  readonly stats: BackfillStats = {
    chunks: 0,
    logs: 0,
    launches: 0,
    trades: 0,
    tokenTransfers: 0,
    blocksFetched: 0,
    skippedUnknownCurve: 0,
  };

  constructor(
    private readonly chain: ChainReader,
    private readonly store: IndexerStore,
    private readonly pipeline: BlockPipeline,
    private readonly log: Log,
    private readonly o: BackfillOptions,
  ) {}

  async run(signal?: AbortSignal): Promise<BackfillStats> {
    await this.pipeline.loadKnownLaunches();
    const ranges = chunkRanges(this.o.from, this.o.to, this.o.chunk);
    for (const [i, r] of ranges.entries()) {
      if (signal?.aborted) break;
      for (let attempt = 0; ; attempt++) {
        try {
          await this.processRange(r);
          break;
        } catch (err) {
          this.pipeline.book.clear();
          if (attempt >= 4) throw err;
          this.log.warn({ range: r, attempt, err: errMsg(err) }, 'chunk failed; retrying');
          await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        }
      }
      this.stats.chunks++;
      this.log.info({ chunk: `${i + 1}/${ranges.length}`, range: r, ...this.stats }, 'backfill progress');
    }
    return this.stats;
  }

  async processRange(r: BlockRange): Promise<void> {
    const res = await processLogRange({ chain: this.chain, store: this.store, pipeline: this.pipeline, log: this.log }, r, {
      tokenTransfers: this.o.tokenTransfers,
      tokenWindowSec: this.o.tokenWindowSec,
      addressBatch: this.o.addressBatch,
    });
    this.stats.logs += res.logs;
    this.stats.blocksFetched += res.blocksFetched;
    this.stats.launches += res.launches;
    this.stats.trades += res.trades;
    this.stats.tokenTransfers += res.tokenTransfers;
    this.stats.skippedUnknownCurve += res.skippedUnknownCurve;
  }
}

/** Full block scan (transfers, wallets, traces too). Needs an own node to be practical. */
export async function blockBackfill(
  pipeline: BlockPipeline,
  from: number,
  to: number,
  log: Log,
  signal?: AbortSignal,
): Promise<number> {
  await pipeline.loadKnownLaunches();
  let done = 0;
  for (let n = from; n <= to && !signal?.aborted; n++) {
    const out = await pipeline.processBlock(n, { live: false, notify: false });
    if (out.status === 'ok') done++;
    if (n % 1000 === 0) log.info({ block: n, to, done }, 'block backfill progress');
  }
  return done;
}
