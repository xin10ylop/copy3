/**
 * BlockPipeline - live indexing of one block at a time (docs/SPEC.md §3 indexer).
 *
 * newHeads (and the logs subscription) only move `head`; blocks are processed
 * strictly in order from checkpoint+1, so gaps after a disconnect are filled.
 * Per block:
 *   1. eth_getBlockByNumber(full) + eth_getBlockReceipts (status, contractAddress, logs)
 *   2. reorg check: parentHash vs the stored hash of n-1 -> roll back 10 blocks
 *   3. Pons logs (+ SnipeTaxCharged joined) -> launches / curve_trades via processEvents
 *   4. ERC-20 Transfer logs of launched tokens -> token_transfers
 *   5. ETH transfers: plain value txs, creations, and (TRACE_INTERNAL) callTracer
 *   6. wallets: first funding of new addresses (+ nonce at n-1, is_contract)
 *   7. token_metrics for touched tokens (computeTokenMetrics)
 *   8. one DB transaction incl. the checkpoint, then NOTIFY transfers_block
 *
 * This is INDEXER_MODE=blocks. INDEXER_MODE=logs runs LogFollower (log-follower.ts)
 * instead, which reuses this class's book/directory/hydration through processLogRange.
 */
import { CurveBook, newCurveState } from './book.js';
import type { ChainReader } from './chain.js';
import { hexToBig, hexToNum } from './hex.js';
import { errMsg, type Log } from './log.js';
import { Lru } from './lru.js';
import {
  LAUNCH_SUPPLY,
  PONS_ADDRESSES,
  decodePonsLogs,
  ponsLogAllowed,
  type PonsEvent,
} from './pons.js';
import { curvesNeedingHydration, launchesInBatch, metricsFor, processEvents, type TxInfo } from './process.js';
import { BlockHashWindow, checkParent } from './reorg.js';
import type { Batch, IndexerStore } from './store.js';
import { extractTokenTransfers } from './token-transfers.js';
import {
  codeIsContract,
  extractTraceTransfers,
  extractTxTransfers,
  newWalletsFromTransfers,
  receiptOk,
  shouldTrace,
  sortTransfers,
} from './transfers.js';
import type { Address, Hex, LaunchRow, Reserves, RpcBlock, RpcLog, RpcReceipt, TransferRow, WalletRow } from './types.js';

export interface PipelineConfig {
  traceInternal: boolean;
  confirmations: number;
  reorgDepth: number;
  startBlock?: number | undefined;
  /** head polling fallback interval */
  pollMs: number;
  bookSize: number;
  /** when the nonce at n-1 is unavailable, fall back to 'latest' only this close to head */
  nonceLatestWithinBlocks: number;
  /** contracts created within this many blocks are traced even on 0-value calls */
  watchCreatedBlocks: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  traceInternal: false,
  confirmations: 0,
  reorgDepth: 10,
  pollMs: 1000,
  bookSize: 2000,
  nonceLatestWithinBlocks: 600,
  watchCreatedBlocks: 36_000,
};

export interface BlockOptions {
  /** reorg check + checkpoint (live). Backfill --blocks passes false. */
  live: boolean;
  notify: boolean;
}

export type BlockOutcome =
  | { status: 'ok'; block: number; launches: number; trades: number; transfers: number; wallets: number }
  | { status: 'notFound'; block: number }
  | { status: 'reorg'; block: number; rollbackFrom: number };

export interface PipelineStats {
  head: number;
  next: number;
  lastBlock: number | null;
  lastBlockTs: number | null;
  lastProcessedAt: number | null;
  processed: number;
  reorgs: number;
  errors: number;
  traceErrors: number;
  skippedUnknownCurve: number;
  wsConnected: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lc = (a: string) => a.toLowerCase() as Address;

export class BlockPipeline {
  readonly book: CurveBook;
  readonly window = new BlockHashWindow(256);
  readonly cfg: PipelineConfig;
  /** token -> curve/ts for every known launch */
  private readonly directory = new Map<Address, { curve: Address; ts: number }>();
  private readonly curveToToken = new Map<Address, Address>();
  private readonly foreignCurves = new Set<Address>();
  private readonly knownWallets = new Lru<Address, true>(200_000);
  private readonly codeCache = new Lru<Address, boolean>(100_000);
  private readonly startReservesCache = new Lru<Address, Reserves | null>(10_000);
  /** recently created non-Pons contracts -> creation block */
  private readonly watched = new Map<Address, number>();
  private readonly staleTokens = new Set<Address>();
  private readonly subLogCounts = new Lru<number, number>(4096);
  private wake: (() => void) | null = null;
  private lastPoll = 0;
  readonly stats: PipelineStats = {
    head: 0,
    next: 0,
    lastBlock: null,
    lastBlockTs: null,
    lastProcessedAt: null,
    processed: 0,
    reorgs: 0,
    errors: 0,
    traceErrors: 0,
    skippedUnknownCurve: 0,
    wsConnected: false,
  };

  constructor(
    private readonly chain: ChainReader,
    private readonly store: IndexerStore,
    private readonly log: Log,
    cfg: Partial<PipelineConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_PIPELINE_CONFIG, ...cfg };
    this.book = new CurveBook(this.cfg.bookSize);
  }

  // ------------------------------------------------------------------ lifecycle

  async init(): Promise<void> {
    await this.loadDirectory();
    this.stats.head = await this.chain.blockNumber();
    const cp = await this.store.getCheckpoint();
    if (cp) {
      this.window.set(cp.block, cp.hash);
      this.stats.next = cp.block + 1;
    } else {
      this.stats.next = this.cfg.startBlock ?? this.stats.head;
    }
    this.log.info({ head: this.stats.head, next: this.stats.next, checkpoint: cp, launches: this.directory.size }, 'pipeline init');
  }

  onHead(n: number): void {
    if (n > this.stats.head) this.stats.head = n;
    this.wake?.();
  }

  /** logs subscription: advances head early and records per-block counts for a consistency check */
  onLog(log: RpcLog): void {
    const b = hexToNum(log.blockNumber);
    if (log.removed) {
      this.log.warn({ block: b, tx: log.transactionHash }, 'removed log from subscription (reorg signal)');
    } else if (ponsLogAllowed(log)) {
      this.subLogCounts.set(b, (this.subLogCounts.get(b) ?? 0) + 1);
    }
    this.onHead(b);
  }

  async run(signal: AbortSignal): Promise<void> {
    let backoff = 250;
    while (!signal.aborted) {
      const target = this.stats.head - this.cfg.confirmations;
      if (this.stats.next > target) {
        await this.waitForWork(signal);
        continue;
      }
      try {
        const out = await this.processBlock(this.stats.next, { live: true, notify: true });
        if (out.status === 'notFound') {
          await sleep(100);
          continue;
        }
        if (out.status === 'reorg') {
          this.stats.next = out.rollbackFrom;
          continue;
        }
        this.stats.next = out.block + 1;
        backoff = 250;
      } catch (err) {
        this.stats.errors++;
        this.log.error({ block: this.stats.next, err: errMsg(err) }, 'block failed; retrying');
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async waitForWork(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.cfg.pollMs);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener('abort', () => this.wake?.(), { once: true });
    });
    this.wake = null;
    // polling fallback when the websocket is down or quiet
    if (!signal.aborted && Date.now() - this.lastPoll >= this.cfg.pollMs) {
      this.lastPoll = Date.now();
      try {
        this.onHead(await this.chain.blockNumber());
      } catch (err) {
        this.log.warn({ err: errMsg(err) }, 'head poll failed');
      }
    }
  }

  // ------------------------------------------------------------------ one block

  async processBlock(n: number, opts: BlockOptions): Promise<BlockOutcome> {
    const block = await this.chain.getBlock(n, true);
    if (!block) return { status: 'notFound', block: n };

    if (opts.live) {
      const chk = checkParent(this.window, { number: n, parentHash: block.parentHash }, this.cfg.reorgDepth);
      if (!chk.ok) {
        await this.rollback(chk.rollbackFrom, n);
        return { status: 'reorg', block: n, rollbackFrom: chk.rollbackFrom };
      }
    }

    const ts = hexToNum(block.timestamp);
    const receipts = await this.chain.getBlockReceipts(block);
    const rmap = new Map<string, RpcReceipt>(receipts.map((r) => [r.transactionHash, r]));
    const logs = receipts.flatMap((r) => (receiptOk(r) ? r.logs : []));
    const events = decodePonsLogs(logs.filter(ponsLogAllowed));
    this.crossCheckSubscription(n, logs);

    const txs = new Map<Hex, TxInfo>(
      block.transactions.map((tx) => [tx.hash, { from: lc(tx.from), to: tx.to ? lc(tx.to) : null, input: tx.input }]),
    );
    const touchedCurves = new Set<Address>();
    for (const e of events) if ('curve' in e && e.curve) touchedCurves.add(e.curve);

    try {
      await this.prepareCurves(events, n);
      const staleCurves = await this.prepareStale(n);
      const launchesHere = new Set(launchesInBatch(events).map((l) => l.token));
      const tokenTransfers = extractTokenTransfers(
        logs,
        (t) => this.directory.has(t) || launchesHere.has(t),
        () => ts,
      );
      await this.hydrateTokens(tokenTransfers.map((t) => t.token), n, 86_400, ts);

      const res = processEvents(this.book, events, tokenTransfers, {
        tsOf: () => ts,
        txOf: (h) => txs.get(h),
        startReserves: (c) => this.startReservesCache.get(c) ?? null,
      });
      this.stats.skippedUnknownCurve += res.skipped.unknownCurve;

      let transfers = extractTxTransfers(block, rmap);
      if (this.cfg.traceInternal) transfers.push(...(await this.traceBlock(block, rmap, ts)));
      const txIndex = new Map<string, number>(block.transactions.map((tx, i) => [tx.hash, i]));
      transfers = sortTransfers(transfers, txIndex);
      const wallets = await this.walletsFor(transfers, n);

      const metrics = metricsFor(this.book, new Set([...res.touched, ...staleCurves]));
      const batch: Batch = {
        launches: res.launches,
        trades: res.trades,
        tokenTransfers: res.tokenTransfers,
        transfers,
        wallets,
        metrics,
        exemptionUpdates: res.exemptionUpdates,
        graduated: res.graduated,
        ...(opts.live ? { checkpoint: { block: n, hash: block.hash } } : {}),
      };
      await this.store.writeBatch(batch);
      if (opts.notify && transfers.length > 0) await this.store.notifyTransfers(n);

      // commit in-memory side effects only after the DB write succeeded
      for (const l of res.launches) this.addToDirectory(l);
      for (const w of wallets) this.knownWallets.set(w.address, true);
      for (const t of transfers) if (t.kind === 'create' && t.from !== PONS_ADDRESSES.launchDeployer) this.watched.set(t.to, n);
      this.pruneWatched(n);
      this.staleTokens.clear();
      if (opts.live) this.window.set(n, block.hash);
      this.stats.lastBlock = n;
      this.stats.lastBlockTs = ts;
      this.stats.lastProcessedAt = Date.now();
      this.stats.processed++;
      if (res.launches.length || res.trades.length) {
        this.log.debug({ block: n, launches: res.launches.length, trades: res.trades.length, transfers: transfers.length }, 'block');
      }
      return {
        status: 'ok',
        block: n,
        launches: res.launches.length,
        trades: res.trades.length,
        transfers: transfers.length,
        wallets: wallets.length,
      };
    } catch (err) {
      // the book may hold half-applied state for these curves: drop it (re-hydrated from DB)
      for (const c of touchedCurves) this.book.evict(c);
      throw err;
    }
  }

  // ------------------------------------------------------------------ helpers

  private async loadDirectory(): Promise<void> {
    this.directory.clear();
    this.curveToToken.clear();
    for (const d of await this.store.loadDirectory()) {
      this.directory.set(d.token, { curve: d.curve, ts: d.ts });
      this.curveToToken.set(d.curve, d.token);
    }
  }

  private addToDirectory(l: LaunchRow): void {
    this.directory.set(l.token, { curve: l.curve, ts: l.ts });
    this.curveToToken.set(l.curve, l.token);
  }

  // ---- used by the backfill (shares directory, book and hydration) -------------

  async loadKnownLaunches(): Promise<void> {
    await this.loadDirectory();
  }

  isKnownToken(token: Address): boolean {
    return this.directory.has(token);
  }

  /** tokens launched at or after `sinceTs` (unix seconds) */
  tokensLaunchedSince(sinceTs: number): Address[] {
    const out: Address[] = [];
    for (const [t, d] of this.directory) if (d.ts >= sinceTs) out.push(t);
    return out;
  }

  recordLaunches(rows: readonly LaunchRow[]): void {
    for (const l of rows) this.addToDirectory(l);
  }

  startReservesOf(curve: Address): Reserves | null {
    return this.startReservesCache.get(curve) ?? null;
  }

  /** hydrate curves of recently launched tokens seen only through Transfer logs */
  async hydrateTokens(tokens: Iterable<Address>, n: number, maxAgeSec: number, nowTs: number): Promise<void> {
    for (const t of new Set(tokens)) {
      const d = this.directory.get(t);
      if (d && !this.book.has(d.curve) && nowTs - d.ts <= maxAgeSec) await this.hydrate(d.curve, n);
    }
  }

  /** start reserves for launches of this batch + hydrate unknown curves */
  async prepareCurves(events: readonly PonsEvent[], n: number): Promise<void> {
    for (const l of launchesInBatch(events)) {
      if (this.book.get(l.curve)?.launch) continue;
      // re-processing an already stored launch (backfill re-run / overlap with live data):
      // start from the stored state so metrics keep every stored trade
      if (this.directory.has(l.token)) await this.hydrate(l.curve, n);
      if (!this.book.get(l.curve)?.launch) await this.startReserves(l.curve, null);
    }
    for (const curve of curvesNeedingHydration(this.book, events)) await this.hydrate(curve, n);
  }

  private async startReserves(curve: Address, launch: LaunchRow | null): Promise<Reserves | null> {
    if (this.startReservesCache.has(curve)) return this.startReservesCache.get(curve) ?? null;
    let r = await this.chain.curveStartReserves(curve);
    if (!r && launch?.startPrice) {
      r = { quote: BigInt(Math.round(launch.startPrice * 1e18)) * 10n ** 9n, token: LAUNCH_SUPPLY };
    }
    this.startReservesCache.set(curve, r);
    return r;
  }

  async hydrate(curve: Address, n: number): Promise<void> {
    if (this.foreignCurves.has(curve) || this.book.has(curve)) return;
    const stored = await this.store.loadCurve(curve);
    if (stored?.launch) {
      const initial = await this.startReserves(curve, stored.launch);
      this.book.put(
        newCurveState({
          curve,
          token: stored.token,
          launch: stored.launch,
          initialReserves: initial,
          trades: stored.trades,
          tokenTransfers: stored.tokenTransfers,
        }),
      );
      return;
    }
    // launch not indexed (e.g. indexing started after it): validate + anchor reserves at n-1
    const known = this.curveToToken.get(curve);
    const info = known
      ? { token: known, launchedAt: this.directory.get(known)?.ts ?? null }
      : await this.chain.curveInfo(curve);
    if (!info) {
      this.foreignCurves.add(curve);
      this.log.warn({ curve }, 'ignoring events of a non-Pons curve');
      return;
    }
    const reserves = await this.chain.curveReserves(curve, n - 1);
    this.book.put(
      newCurveState({
        curve,
        token: info.token,
        launch: null,
        launchTs: info.launchedAt,
        initialReserves: null,
        reserves,
        trades: stored?.trades ?? [],
        tokenTransfers: stored?.tokenTransfers ?? [],
      }),
    );
  }

  /** curves of tokens whose rows a rollback deleted: hydrated again so their metrics get recomputed */
  async prepareStale(n: number): Promise<Address[]> {
    const curves: Address[] = [];
    for (const t of this.staleTokens) {
      const d = this.directory.get(t);
      if (!d) continue;
      await this.hydrate(d.curve, n);
      curves.push(d.curve);
    }
    return curves;
  }

  /** forget the stale set once the recomputed metrics are written */
  clearStale(): void {
    this.staleTokens.clear();
  }

  /** delete everything at block >= `from` (DB + in-memory state); `at` is only logged */
  async rollback(from: number, at: number): Promise<void> {
    this.stats.reorgs++;
    this.log.warn({ at, rollbackFrom: from }, 'reorg detected: rolling back');
    const stale = await this.store.rollbackFrom(from);
    this.book.clear();
    this.window.truncateFrom(from);
    await this.loadDirectory();
    for (const t of stale) this.staleTokens.add(t);
  }

  private async hasCode(a: Address): Promise<boolean> {
    const c = this.codeCache.get(a);
    if (c !== undefined) return c;
    const v = codeIsContract(await this.chain.getCode(a, 'latest'));
    this.codeCache.set(a, v);
    return v;
  }

  private async traceBlock(block: RpcBlock, rmap: ReadonlyMap<string, RpcReceipt>, ts: number): Promise<TransferRow[]> {
    const n = hexToNum(block.number);
    const out: TransferRow[] = [];
    const watchedSet = new Set(this.watched.keys());
    for (const tx of block.transactions) {
      const rc = rmap.get(tx.hash);
      if (!receiptOk(rc)) continue;
      const toHasCode = tx.to !== null && hexToBig(tx.value) > 0n ? await this.hasCode(lc(tx.to)) : false;
      if (!shouldTrace(tx, rc, toHasCode, watchedSet)) continue;
      try {
        const frame = await this.chain.traceTransaction(tx.hash);
        out.push(...extractTraceTransfers(frame, { block: n, ts, txHash: tx.hash }));
      } catch (err) {
        this.stats.traceErrors++;
        this.log.warn({ tx: tx.hash, err: errMsg(err) }, 'debug_traceTransaction failed (internal transfers of this tx missed)');
      }
    }
    return out;
  }

  private async walletsFor(transfers: readonly TransferRow[], n: number): Promise<WalletRow[]> {
    const fresh = [...new Set(transfers.map((t) => t.to))].filter((a) => !this.knownWallets.has(a));
    if (fresh.length === 0) return [];
    const known = await this.store.knownWallets(fresh);
    for (const a of known) this.knownWallets.set(a, true);
    const rows = newWalletsFromTransfers(transfers, (a) => this.knownWallets.has(a));
    for (const w of rows) {
      if (w.isContract === true) continue; // created in this block
      try {
        w.isContract = await this.hasCode(w.address);
      } catch (err) {
        this.log.warn({ wallet: w.address, err: errMsg(err) }, 'getCode failed');
      }
      w.txCountAtFirstFunding = w.isContract ? null : await this.nonceAt(w.address, n);
    }
    return rows;
  }

  /** nonce "at the time" of first funding: state at n-1 (falls back to latest near head). */
  private async nonceAt(a: Address, n: number): Promise<number | null> {
    try {
      return await this.chain.getTransactionCount(a, n - 1);
    } catch {
      if (this.stats.head - n > this.cfg.nonceLatestWithinBlocks) return null;
      try {
        return await this.chain.getTransactionCount(a, 'latest');
      } catch {
        return null;
      }
    }
  }

  private pruneWatched(n: number): void {
    if (this.watched.size < 5000 && n % 1000 !== 0) return;
    for (const [a, b] of this.watched) if (n - b > this.cfg.watchCreatedBlocks) this.watched.delete(a);
  }

  private crossCheckSubscription(n: number, logs: readonly RpcLog[]): void {
    const seen = this.subLogCounts.get(n);
    if (seen === undefined || !this.stats.wsConnected) return;
    const actual = logs.filter(ponsLogAllowed).length;
    if (seen !== actual) this.log.debug({ block: n, subscription: seen, receipts: actual }, 'logs subscription / receipts mismatch');
    this.subLogCounts.delete(n);
  }
}
