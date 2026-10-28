/**
 * Log-based backfill: eth_getLogs over <= 20k-block ranges (split further when the
 * node rejects a range), then the same processEvents/metrics path as the live
 * pipeline. Idempotent: rows are written with ON CONFLICT DO NOTHING and the
 * in-memory book de-duplicates trades/transfers already in the DB.
 *
 * ETH transfers / wallets are NOT in logs; use `--mode blocks` (full block scan,
 * needs an own node) for those.
 */
import type { ChainReader } from './chain.js';
import { hexToNum } from './hex.js';
import { errMsg, type Log } from './log.js';
import { INDEXED_TOPICS, PONS_TOPICS, decodePonsLogs, ponsLogAllowed } from './pons.js';
import { launchesInBatch, metricsFor, processEvents, type TxInfo } from './process.js';
import type { BlockPipeline } from './pipeline.js';
import { chunkList, chunkRanges, splitRange, type BlockRange } from './ranges.js';
import { RpcError } from './rpc.js';
import type { IndexerStore } from './store.js';
import { extractTokenTransfers } from './token-transfers.js';
import type { Address, Hex, RpcLog } from './types.js';

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

/** eth_getLogs that halves the range when the node says it is too big. */
export async function getLogsSplitting(
  chain: Pick<ChainReader, 'getLogs'>,
  range: BlockRange,
  filter: { address?: Address[]; topics: (Hex | Hex[] | null)[] },
  log?: Log,
): Promise<RpcLog[]> {
  try {
    return await chain.getLogs({ fromBlock: range.from, toBlock: range.to, ...filter });
  } catch (err) {
    const halves = splitRange(range);
    if (!(err instanceof RpcError) || err.code === null || !halves) throw err;
    log?.debug({ range, err: errMsg(err) }, 'getLogs rejected; splitting range');
    const a = await getLogsSplitting(chain, halves[0], filter, log);
    const b = await getLogsSplitting(chain, halves[1], filter, log);
    return [...a, ...b];
  }
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
    const ponsLogs = (await getLogsSplitting(this.chain, r, { topics: [INDEXED_TOPICS] }, this.log)).filter(ponsLogAllowed);
    const events = decodePonsLogs(ponsLogs);
    this.stats.logs += ponsLogs.length;

    // full blocks for every block with Pons events: timestamps, tx.from, launch calldata
    const tsByBlock = new Map<number, number>();
    const txs = new Map<Hex, TxInfo>();
    const blocks = [...new Set(ponsLogs.map((l) => hexToNum(l.blockNumber)))].sort((a, b) => a - b);
    for (const b of blocks) {
      const blk = await this.chain.getBlock(b, true);
      this.stats.blocksFetched++;
      if (!blk) continue;
      tsByBlock.set(b, hexToNum(blk.timestamp));
      for (const tx of blk.transactions) {
        txs.set(tx.hash, {
          from: tx.from.toLowerCase() as Address,
          to: tx.to ? (tx.to.toLowerCase() as Address) : null,
          input: tx.input,
        });
      }
    }

    // ERC-20 Transfer logs of recently launched tokens (+ the ones launched in this chunk)
    let transferLogs: RpcLog[] = [];
    const chunkLaunchTokens = launchesInBatch(events).map((l) => l.token);
    if (this.o.tokenTransfers) {
      const first = await this.chain.getBlock(r.from, false);
      const startTs = first ? hexToNum(first.timestamp) : 0;
      const tokens = [...new Set([...this.pipeline.tokensLaunchedSince(startTs - this.o.tokenWindowSec), ...chunkLaunchTokens])];
      for (const batch of chunkList(tokens, this.o.addressBatch)) {
        transferLogs.push(...(await getLogsSplitting(this.chain, r, { address: batch, topics: [PONS_TOPICS.Erc20Transfer] }, this.log)));
      }
      for (const b of new Set(transferLogs.map((l) => hexToNum(l.blockNumber)))) {
        if (tsByBlock.has(b)) continue;
        const hdr = await this.chain.getBlock(b, false);
        this.stats.blocksFetched++;
        if (hdr) tsByBlock.set(b, hexToNum(hdr.timestamp));
      }
    } else {
      transferLogs = [];
    }

    await this.pipeline.prepareCurves(events, r.from);
    const launchSet = new Set(chunkLaunchTokens);
    const tokenTransfers = extractTokenTransfers(
      transferLogs,
      (t) => this.pipeline.isKnownToken(t) || launchSet.has(t),
      (b) => tsByBlock.get(b),
    );
    const lastTs = Math.max(0, ...tsByBlock.values());
    await this.pipeline.hydrateTokens(
      tokenTransfers.map((t) => t.token),
      r.from,
      this.o.tokenWindowSec,
      lastTs,
    );

    const res = processEvents(this.pipeline.book, events, tokenTransfers, {
      tsOf: (b) => tsByBlock.get(b),
      txOf: (h) => txs.get(h),
      startReserves: (c) => this.pipeline.startReservesOf(c),
    });
    const metrics = metricsFor(this.pipeline.book, res.touched);
    await this.store.writeBatch({
      launches: res.launches,
      trades: res.trades,
      tokenTransfers: res.tokenTransfers,
      transfers: [],
      wallets: [],
      metrics,
      exemptionUpdates: res.exemptionUpdates,
      graduated: res.graduated,
    });
    this.pipeline.recordLaunches(res.launches);
    this.stats.launches += res.launches.length;
    this.stats.trades += res.trades.length;
    this.stats.tokenTransfers += res.tokenTransfers.length;
    this.stats.skippedUnknownCurve += res.skipped.unknownCurve;
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
