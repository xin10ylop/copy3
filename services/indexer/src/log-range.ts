/**
 * One block range through the log path (shared by `backfill --mode logs` and the live
 * indexer in INDEXER_MODE=logs):
 *   1. eth_getLogs over the range with the indexed Pons topics (any address)
 *   2. one full block per block that has Pons logs (timestamps, tx.from, launch calldata;
 *      Nitro returns blockTimestamp = 0x0 in eth_getLogs)
 *   3. ERC-20 Transfer logs of recently launched tokens (+ the ones launched in the range),
 *      eth_getLogs with address batches, plus a header per block that has only such logs
 *   4. processEvents -> launches / curve_trades / token_transfers / token_metrics,
 *      one store.writeBatch (with the checkpoint when `checkpoint` is set)
 * No ETH transfers, wallets or traces: those need every block (INDEXER_MODE=blocks).
 */
import type { ChainReader } from './chain.js';
import { hexToNum } from './hex.js';
import { errMsg, type Log } from './log.js';
import { INDEXED_TOPICS, PONS_TOPICS, decodePonsLogs, ponsLogAllowed } from './pons.js';
import type { BlockPipeline } from './pipeline.js';
import { launchesInBatch, metricsFor, processEvents, type TxInfo } from './process.js';
import { chunkList, splitRange, type BlockRange } from './ranges.js';
import { RpcError } from './rpc.js';
import type { IndexerStore } from './store.js';
import { extractTokenTransfers } from './token-transfers.js';
import type { Address, Hex, RpcLog } from './types.js';

export interface BlockHeader {
  hash: Hex;
  ts: number;
}

export interface LogRangeOptions {
  /** also fetch ERC-20 Transfer logs of launched tokens */
  tokenTransfers: boolean;
  /** only tokens launched within this many seconds before the range get Transfer logs fetched */
  tokenWindowSec: number;
  /** max addresses per eth_getLogs address filter */
  addressBatch: number;
  /** live: write {block: r.to, hash} as the checkpoint in the same transaction */
  checkpoint?: boolean;
  /** headers already known (live: from newHeads / head polls); saves header fetches */
  headers?: ReadonlyMap<number, BlockHeader>;
  /** a lower bound for the timestamp of r.from (live: the previous checkpoint's timestamp) */
  startTsHint?: number;
  /** sees the range's (allowed) Pons logs before anything is fetched or written; may throw */
  checkLogs?: (logs: readonly RpcLog[]) => void;
}

export interface LogRangeResult {
  logs: number;
  launches: number;
  trades: number;
  tokenTransfers: number;
  /** eth_getBlockByNumber calls made for this range (full blocks + headers) */
  blocksFetched: number;
  skippedUnknownCurve: number;
  /** header of r.to when it is known (always when `checkpoint` is set) */
  end: BlockHeader | null;
}

export interface LogRangeDeps {
  chain: ChainReader;
  store: IndexerStore;
  pipeline: BlockPipeline;
  log: Log;
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

/**
 * Index [r.from, r.to] from logs. Throws on any RPC/DB failure; the caller then drops the
 * curve book (`pipeline.book.clear()`, it may hold half-applied state) and retries the range.
 */
export async function processLogRange(d: LogRangeDeps, r: BlockRange, o: LogRangeOptions): Promise<LogRangeResult> {
  const { chain, store, pipeline, log } = d;
  const ponsLogs = (await getLogsSplitting(chain, r, { topics: [INDEXED_TOPICS] }, log)).filter(
    (l) => !l.removed && ponsLogAllowed(l),
  );
  o.checkLogs?.(ponsLogs);
  const events = decodePonsLogs(ponsLogs);
  let blocksFetched = 0;

  const headers = new Map<number, BlockHeader>();
  const known = (b: number) => headers.get(b) ?? o.headers?.get(b);
  const fetchHeader = async (b: number): Promise<BlockHeader | undefined> => {
    const hdr = await chain.getBlock(b, false);
    blocksFetched++;
    if (!hdr) return undefined;
    const h = { hash: hdr.hash, ts: hexToNum(hdr.timestamp) };
    headers.set(b, h);
    return h;
  };

  // full blocks for every block with Pons events: timestamps, tx.from, launch calldata
  const txs = new Map<Hex, TxInfo>();
  const eventBlocks = [...new Set(ponsLogs.map((l) => hexToNum(l.blockNumber)))].sort((a, b) => a - b);
  for (const b of eventBlocks) {
    const blk = await chain.getBlock(b, true);
    blocksFetched++;
    if (!blk) throw new Error(`block ${b} with Pons logs not found`);
    headers.set(b, { hash: blk.hash, ts: hexToNum(blk.timestamp) });
    for (const tx of blk.transactions) {
      txs.set(tx.hash, {
        from: tx.from.toLowerCase() as Address,
        to: tx.to ? (tx.to.toLowerCase() as Address) : null,
        input: tx.input,
      });
    }
  }

  // ERC-20 Transfer logs of recently launched tokens (+ the ones launched in this range)
  const transferLogs: RpcLog[] = [];
  const rangeLaunchTokens = launchesInBatch(events).map((l) => l.token);
  if (o.tokenTransfers) {
    const startTs = o.startTsHint ?? known(r.from)?.ts ?? (await fetchHeader(r.from))?.ts ?? 0;
    const tokens = [...new Set([...pipeline.tokensLaunchedSince(startTs - o.tokenWindowSec), ...rangeLaunchTokens])];
    for (const batch of chunkList(tokens, o.addressBatch)) {
      transferLogs.push(...(await getLogsSplitting(chain, r, { address: batch, topics: [PONS_TOPICS.Erc20Transfer] }, log)));
    }
    for (const b of new Set(transferLogs.map((l) => hexToNum(l.blockNumber)))) {
      if (!known(b)) await fetchHeader(b);
    }
  }

  let end: BlockHeader | null = known(r.to) ?? null;
  if (o.checkpoint && !end) {
    end = (await fetchHeader(r.to)) ?? null;
    if (!end) throw new Error(`block ${r.to} not found (checkpoint)`);
  }
  const tsOf = (b: number) => known(b)?.ts;

  await pipeline.prepareCurves(events, r.from);
  const staleCurves = await pipeline.prepareStale(r.from);
  const launchSet = new Set(rangeLaunchTokens);
  const tokenTransfers = extractTokenTransfers(transferLogs, (t) => pipeline.isKnownToken(t) || launchSet.has(t), tsOf);
  const lastTs = Math.max(0, ...[...headers.values()].map((h) => h.ts), ...tokenTransfers.map((t) => t.ts));
  await pipeline.hydrateTokens(
    tokenTransfers.map((t) => t.token),
    r.from,
    o.tokenWindowSec,
    lastTs,
  );

  const res = processEvents(pipeline.book, events, tokenTransfers, {
    tsOf,
    txOf: (h) => txs.get(h),
    startReserves: (c) => pipeline.startReservesOf(c),
  });
  const metrics = metricsFor(pipeline.book, new Set([...res.touched, ...staleCurves]));
  await store.writeBatch({
    launches: res.launches,
    trades: res.trades,
    tokenTransfers: res.tokenTransfers,
    transfers: [],
    wallets: [],
    metrics,
    exemptionUpdates: res.exemptionUpdates,
    graduated: res.graduated,
    ...(o.checkpoint && end ? { checkpoint: { block: r.to, hash: end.hash } } : {}),
  });
  // in-memory side effects only after the DB write succeeded
  pipeline.recordLaunches(res.launches);
  pipeline.clearStale();
  return {
    logs: ponsLogs.length,
    launches: res.launches.length,
    trades: res.trades.length,
    tokenTransfers: res.tokenTransfers.length,
    blocksFetched,
    skippedUnknownCurve: res.skipped.unknownCurve,
    end,
  };
}
