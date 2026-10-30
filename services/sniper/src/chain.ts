/**
 * Chain access port (reads + subscriptions). Hot-path budget: only `getReserves` right after
 * the launch receipt; everything else is off the decide path. `ViemChain` is the real
 * implementation (own node http + ws); tests use fakes.
 */
import { sniperAbi } from '@hood/contracts';
import {
  MULTICALL3,
  PONS_V2,
  curveAbi,
  factoryAbi,
  parseTokenLaunchedLog,
  tokenAbi,
  type RawLog,
  type Reserves,
  type RpcTxLike,
} from '@hood/core';
import {
  BaseError,
  createPublicClient,
  decodeErrorResult,
  getAbiItem,
  http,
  keccak256,
  encodeAbiParameters,
  webSocket,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type StateOverride,
  type Transport,
} from 'viem';

export interface ReceiptLite {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: number;
  gasUsed: bigint;
  logs: RawLog[];
  /** position of the tx in its block (probe mode: race position); absent when the client does not report it */
  transactionIndex?: number;
}

/** A CurveBuy log located in its block (probe mode: who bought before / after our probe tx). */
export interface CurveBuyRef {
  block: number;
  txIndex: number;
  logIndex: number;
  txHash: Hex;
}

/** What the PonsSniper contract holds for a token (chain truth for reconciliation). */
export interface SniperHolding {
  bought: boolean;
  balance: bigint;
  /** R4-2: the block both values were read at (and its timestamp): "no buy" is final only past the deadline of THIS read */
  block?: number;
  blockTs?: number;
}

export interface RecentLaunch {
  token: Address;
  curve: Address;
  block: number;
}

/**
 * PonsSniper decaying spend budget (NEW-4/5): `level` drains at `maxSpend / window` per second
 * since `updatedAt` (unix s); a buy must keep it ≤ `maxSpend`. `window == 0` = budget off.
 */
export interface SpendBudgetState {
  maxSpend: bigint;
  window: number;
  level: bigint;
  updatedAt: number;
}

/** PonsSniper admin state checked at live startup (M4 / live-mode gate). */
export interface SniperConfigState {
  owner: Address;
  factory: Address;
  maxQuoteIn: bigint;
  /** operators(key) for every key passed, same order */
  operators: boolean[];
  /** the spend budget (absent: an older contract / a fake without one) */
  spend?: SpendBudgetState;
}

/** A PonsSniper `Sniped` event (startup orphan sweep, NEW-3). */
export interface SnipedLog {
  token: Address;
  curve: Address;
  quoteIn: bigint;
  tokensOut: bigint;
  taxBps: number;
  block: number;
  txHash: Hex;
}

/** Public RPCs cap eth_getLogs ranges (often 10 000 blocks): every log scan is chunked (NEW-8). */
export const LOG_CHUNK_BLOCKS = 10_000;

/** R4-7: the smallest chunk a range error halves down to (some RPCs cap eth_getLogs at 1-5k blocks). */
export const MIN_LOG_CHUNK_BLOCKS = 500;
const RANGE_ERR_RE =
  /block range|range (is )?too (large|wide|big)|exceeds? (the )?(max|maximum|limit)|max(imum)? (block )?range|too many (blocks|results|logs)|query returned more than|response size|range limit|blocks? limit/i;

/** An eth_getLogs error that a smaller range fixes (not a rate limit / outage). */
export function isRangeError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ''}` : String(e);
  return RANGE_ERR_RE.test(m) && !/\b429\b|rate.?limit/i.test(m);
}

/**
 * R4-7: walk [from, to] in chunks — ascending or descending — fetching each with `fetch(a, b)`
 * and handing the result to `onChunk` (return false to stop). A range error halves the chunk
 * (down to MIN_LOG_CHUNK_BLOCKS) and retries the same range; the size learnt sticks in `state`.
 */
export async function scanChunks<T>(
  from: number,
  to: number,
  dir: 'asc' | 'desc',
  fetch: (a: number, b: number) => Promise<T>,
  onChunk: (r: T, a: number, b: number) => boolean | void | Promise<boolean | void>,
  state: { chunk: number } = { chunk: LOG_CHUNK_BLOCKS },
): Promise<void> {
  let lo = Math.max(0, from);
  let hi = to;
  while (lo <= hi) {
    const size = Math.max(1, state.chunk);
    const a = dir === 'asc' ? lo : Math.max(lo, hi - size + 1);
    const b = dir === 'asc' ? Math.min(hi, lo + size - 1) : hi;
    let r: T;
    try {
      r = await fetch(a, b);
    } catch (e) {
      if (isRangeError(e) && size > MIN_LOG_CHUNK_BLOCKS) {
        state.chunk = Math.max(MIN_LOG_CHUNK_BLOCKS, Math.floor(size / 2));
        continue;
      }
      throw e;
    }
    const go = await onChunk(r, a, b);
    if (dir === 'asc') lo = b + 1;
    else hi = a - 1;
    if (go === false) return;
  }
}

/** [from, to] (inclusive) split into ranges of at most `chunk` blocks, oldest first. */
export function blockRanges(from: number, to: number, chunk = LOG_CHUNK_BLOCKS): [number, number][] {
  const out: [number, number][] = [];
  for (let a = Math.max(0, from); a <= to; a += chunk) out.push([a, Math.min(to, a + chunk - 1)]);
  return out;
}

export interface ChainClient {
  getReserves(curve: Address, blockNumber?: number): Promise<Reserves>;
  getBlockNumber(): Promise<number>;
  /** sniper.bought(token) + token.balanceOf(sniper), both read at ONE block (N11) */
  readSniper(sniper: Address, token: Address): Promise<SniperHolding>;
  /** curve.graduated() — sells on the curve revert once true */
  curveGraduated(curve: Address): Promise<boolean>;
  estimateGas(tx: { from: Address; to: Address; data: Hex; value?: bigint; stateOverride?: StateOverride }): Promise<bigint>;
  /** most recent TokenLaunched logs within `lookbackBlocks`, newest first, at most `limit` (startup checks; chunked, NEW-8) */
  recentLaunches(lookbackBlocks: number, limit: number): Promise<RecentLaunch[]>;
  /**
   * PonsSniper `Sniped` events in [fromBlock, toBlock], oldest first (chunked, halving on range
   * errors). `onChunk(logs, toBlock)` runs after each chunk (return false to stop): the orphan
   * sweep advances its checkpoint per chunk (R4-7).
   */
  snipedLogs(sniper: Address, fromBlock: number, toBlock: number, onChunk?: (logs: SnipedLog[], toBlock: number) => boolean | void | Promise<boolean | void>): Promise<SnipedLog[]>;
  /** owner / factory / maxQuoteIn / operators(keys) of the PonsSniper contract */
  readSniperConfig(sniper: Address, keys: readonly Address[]): Promise<SniperConfigState>;
  getTransactionCount(address: Address, tag: 'latest' | 'pending'): Promise<number>;
  getReceipt(hash: Hex): Promise<ReceiptLite | null>;
  getGasPrice(): Promise<bigint>;
  getBalance(address: Address): Promise<bigint>;
  balancesOf(token: Address, holders: Address[]): Promise<bigint[]>;
  getTransaction(hash: Hex): Promise<RpcTxLike | null>;
  getBlockTimestamp(blockNumber: number): Promise<number>;
  /** name() / symbol() of the token and creatorTaxBps() of its curve (log-originated launches with unknown calldata). Optional. */
  tokenMeta?(token: Address, curve: Address): Promise<{ name: string; symbol: string; creatorTaxBps: number }>;
  /** TokenLaunched logs from the factory (ws). Optional: without ws we poll receipts. */
  watchLaunches?(cb: (log: RawLog) => void): () => void;
  /** CurveBuy logs of `curve` in [fromBlock, toBlock] (one eth_getLogs; race measurement). Optional. */
  curveBuyLogs?(curve: Address, fromBlock: number, toBlock: number): Promise<CurveBuyRef[]>;
  /** why a mined tx reverted: eth_call replay of it at its block, decoded against the PonsSniper errors (best effort). Optional. */
  revertReason?(hash: Hex, block: number): Promise<string | null>;
  /** CurveBuy/CurveSell/CurveCompleted/SnipeTaxExempted on `curve` and Transfer on `token` (ws). */
  watchToken?(token: Address, curve: Address, cb: (log: RawLog) => void): () => void;
}

/** Logs a reorg removed (`removed: true`) are dropped everywhere (R4-8). */
const live = <L extends { removed?: boolean }>(logs: readonly L[]): L[] => logs.filter((l) => l.removed !== true);

const toRaw = (l: Log): RawLog => ({
  address: l.address.toLowerCase(),
  topics: l.topics as string[],
  data: l.data,
  blockNumber: l.blockNumber ?? null,
  transactionHash: l.transactionHash ?? null,
  logIndex: l.logIndex ?? null,
});

export class ViemChain implements ChainClient {
  private readonly http: PublicClient;
  private readonly ws: PublicClient | null;
  /** R4-7: the eth_getLogs chunk size this endpoint accepts (learnt from range errors) */
  readonly logChunk = { chunk: LOG_CHUNK_BLOCKS };

  /**
   * Receipt endpoints raced by `getReceipt` (first to return the receipt wins). A launcher-contract
   * launch is built from its RECEIPT; Alchemy served it ~1.2 s after the launch block on the Ohio
   * box (29 Oct 2026: a 0.427 ETH team launch was recognised after the +1 s boundary and never
   * sniped), the sequencer's own RPC serves it within ~100 ms. The http client is always included.
   */
  private readonly receiptClients: PublicClient[];

  /** `transport` replaces the http transport (tests); `receiptTransports` / `receiptUrls` add receipt endpoints. */
  constructor(opts: { httpUrl: string; wsUrl?: string; transport?: Transport; receiptUrls?: string[]; receiptTransports?: Transport[] }) {
    this.http = createPublicClient({ transport: opts.transport ?? http(opts.httpUrl, { batch: false, retryCount: 1, timeout: 5000 }) });
    this.ws = opts.wsUrl ? createPublicClient({ transport: webSocket(opts.wsUrl, { keepAlive: true, reconnect: true }) }) : null;
    const extra = [
      ...(opts.receiptTransports ?? []).map((t) => createPublicClient({ transport: t })),
      ...(opts.receiptUrls ?? []).filter((u) => u && u !== opts.httpUrl).map((u) => createPublicClient({ transport: http(u, { batch: false, retryCount: 0, timeout: 3000 }) })),
    ];
    this.receiptClients = [this.http, ...extra];
  }

  async getReserves(curve: Address, blockNumber?: number): Promise<Reserves> {
    if (blockNumber === undefined && this.receiptClients.length > 1) {
      // 'latest' from whichever endpoint answers first (the sequencer RPC has the state ~100 ms
      // after a block, a third-party node up to ~1 s later); a block-pinned read needs the archive node
      const one = async (c: PublicClient): Promise<Reserves> => {
        const [q, t] = await c.readContract({ address: curve, abi: curveAbi, functionName: 'getReserves' });
        return { quote: BigInt(q as bigint), token: BigInt(t as bigint) };
      };
      try {
        return await Promise.any(this.receiptClients.map((c) => one(c)));
      } catch (e) {
        throw (e as AggregateError).errors?.[0] ?? e;
      }
    }
    const [quote, token] = await this.http.readContract({
      address: curve,
      abi: curveAbi,
      functionName: 'getReserves',
      ...(blockNumber !== undefined ? { blockNumber: BigInt(blockNumber) } : {}),
    });
    return { quote, token };
  }

  getTransactionCount(address: Address, tag: 'latest' | 'pending'): Promise<number> {
    return this.http.getTransactionCount({ address, blockTag: tag });
  }

  async getBlockNumber(): Promise<number> {
    return Number(await this.http.getBlockNumber({ cacheTime: 0 }));
  }

  async readSniper(sniper: Address, token: Address): Promise<SniperHolding> {
    // N11: both reads pinned to one block, or a buy landing in between gives bought=false + balance>0.
    // R4-2: that block (and its timestamp) is returned — the caller judges finality on THIS read, not
    // on a head read from another (possibly lagging, load-balanced) backend
    const blk = await this.http.getBlock({ blockTag: 'latest' });
    const blockNumber = blk.number!;
    const [bought, balance] = await Promise.all([
      this.http.readContract({ address: sniper, abi: sniperAbi, functionName: 'bought', args: [token], blockNumber }),
      this.http.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [sniper], blockNumber }),
    ]);
    return { bought, balance, block: Number(blockNumber), blockTs: Number(blk.timestamp) };
  }

  async tokenMeta(token: Address, curve: Address): Promise<{ name: string; symbol: string; creatorTaxBps: number }> {
    const [name, symbol, tax] = await Promise.all([
      this.http.readContract({ address: token, abi: tokenAbi, functionName: 'name' }).catch(() => ''),
      this.http.readContract({ address: token, abi: tokenAbi, functionName: 'symbol' }).catch(() => ''),
      this.http.readContract({ address: curve, abi: curveAbi, functionName: 'creatorTaxBps' }).catch(() => 0n),
    ]);
    return { name: String(name), symbol: String(symbol), creatorTaxBps: Number(tax) };
  }

  curveGraduated(curve: Address): Promise<boolean> {
    return this.http.readContract({ address: curve, abi: curveAbi, functionName: 'graduated' });
  }

  estimateGas(tx: { from: Address; to: Address; data: Hex; value?: bigint; stateOverride?: StateOverride }): Promise<bigint> {
    return this.http.estimateGas({
      account: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      ...(tx.stateOverride ? { stateOverride: tx.stateOverride } : {}),
    });
  }

  async recentLaunches(lookbackBlocks: number, limit: number): Promise<RecentLaunch[]> {
    // NEW-8: one eth_getLogs over 36 000 blocks is refused by public RPCs (range caps) and the gate
    // then failed closed forever: walk back in chunks of ≤ LOG_CHUNK_BLOCKS, newest first
    // R4-7: the chunk halves on a range error (RPCs capping at 1-5k blocks)
    const head = Number(await this.http.getBlockNumber({ cacheTime: 0 }));
    const out: RecentLaunch[] = [];
    await scanChunks(
      head - lookbackBlocks,
      head,
      'desc',
      (a, b) => this.http.getLogs({ address: PONS_V2.factory as Address, event: getAbiItem({ abi: factoryAbi, name: 'TokenLaunched' }), fromBlock: BigInt(a), toBlock: BigInt(b) }),
      (logs) => {
        for (const l of live(logs).reverse()) {
          const p = parseTokenLaunchedLog(toRaw(l as Log));
          out.push({ token: p.token as Address, curve: p.curve as Address, block: Number(l.blockNumber ?? 0n) });
          if (out.length >= limit) return false;
        }
        return true;
      },
      this.logChunk,
    );
    return out;
  }

  async snipedLogs(sniper: Address, fromBlock: number, toBlock: number, onChunk?: (logs: SnipedLog[], toBlock: number) => boolean | void | Promise<boolean | void>): Promise<SnipedLog[]> {
    const out: SnipedLog[] = [];
    await scanChunks(
      fromBlock,
      toBlock,
      'asc',
      (a, b) => this.http.getLogs({ address: sniper, event: getAbiItem({ abi: sniperAbi, name: 'Sniped' }), fromBlock: BigInt(a), toBlock: BigInt(b) }),
      async (logs, _a, b) => {
        const chunk = live(logs).map((l) => ({
          token: l.args.token!.toLowerCase() as Address,
          curve: l.args.curve!.toLowerCase() as Address,
          quoteIn: l.args.quoteIn!,
          tokensOut: l.args.tokensOut!,
          taxBps: Number(l.args.taxBps!),
          block: Number(l.blockNumber ?? 0n),
          txHash: (l.transactionHash ?? '0x') as Hex,
        }));
        out.push(...chunk);
        return onChunk ? onChunk(chunk, b) : true;
      },
      this.logChunk,
    );
    return out;
  }

  async readSniperConfig(sniper: Address, keys: readonly Address[]): Promise<SniperConfigState> {
    const r = <F extends 'owner' | 'factory' | 'maxQuoteIn' | 'maxSpendPerWindow' | 'spendWindow' | 'spendLevel' | 'spendUpdatedAt'>(functionName: F) =>
      this.http.readContract({ address: sniper, abi: sniperAbi, functionName });
    const [owner, factory, maxQuoteIn, maxSpend, window, level, updatedAt, ...ops] = await Promise.all([
      r('owner'),
      r('factory'),
      r('maxQuoteIn'),
      r('maxSpendPerWindow'),
      r('spendWindow'),
      r('spendLevel'),
      r('spendUpdatedAt'),
      ...keys.map((k) => this.http.readContract({ address: sniper, abi: sniperAbi, functionName: 'operators', args: [k] })),
    ]);
    return {
      owner: String(owner).toLowerCase() as Address,
      factory: String(factory).toLowerCase() as Address,
      maxQuoteIn: BigInt(maxQuoteIn as bigint),
      operators: ops.map((o) => o === true),
      spend: { maxSpend: BigInt(maxSpend as bigint), window: Number(window), level: BigInt(level as bigint), updatedAt: Number(updatedAt) },
    };
  }

  /** Races every receipt endpoint; the first receipt wins, "not found" everywhere = null, errors everywhere = throws the first. */
  async getReceipt(hash: Hex): Promise<ReceiptLite | null> {
    const one = async (c: PublicClient): Promise<ReceiptLite> => {
      const r = await c.getTransactionReceipt({ hash });
      return {
        transactionHash: r.transactionHash,
        status: r.status,
        blockNumber: Number(r.blockNumber),
        gasUsed: r.gasUsed,
        logs: live(r.logs).map((l) => toRaw(l as Log)),
        transactionIndex: Number(r.transactionIndex),
      };
    };
    if (this.receiptClients.length === 1) {
      try {
        return await one(this.http);
      } catch (e) {
        if ((e as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    }
    try {
      return await Promise.any(this.receiptClients.map((c) => one(c)));
    } catch (e) {
      const errors = (e as AggregateError).errors ?? [e];
      if (errors.some((x) => (x as { name?: string }).name === 'TransactionReceiptNotFoundError')) return null;
      throw errors[0];
    }
  }

  getGasPrice(): Promise<bigint> {
    return this.http.getGasPrice();
  }

  async revertReason(hash: Hex, block: number): Promise<string | null> {
    const tx = await this.http.getTransaction({ hash });
    try {
      await this.http.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: BigInt(block) });
      return 'no revert on replay (state at the end of the block differs)';
    } catch (e) {
      let data: Hex | undefined;
      if (e instanceof BaseError) {
        const raw = e.walk((x) => typeof (x as { data?: unknown }).data === 'string') as { data?: Hex } | null;
        data = raw?.data;
      }
      if (data && data.length >= 10) {
        try {
          const d = decodeErrorResult({ abi: sniperAbi, data });
          return d.args && d.args.length ? `${d.errorName}(${d.args.map(String).join(', ')})` : d.errorName;
        } catch {
          return `revert ${data.slice(0, 10)}`;
        }
      }
      return (e as Error).message.split('\n')[0] ?? 'reverted';
    }
  }

  async curveBuyLogs(curve: Address, fromBlock: number, toBlock: number): Promise<CurveBuyRef[]> {
    const logs = await this.http.getLogs({ address: curve, event: getAbiItem({ abi: curveAbi, name: 'CurveBuy' }), fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) });
    return live(logs).map((l) => ({ block: Number(l.blockNumber), txIndex: Number(l.transactionIndex), logIndex: Number(l.logIndex), txHash: l.transactionHash as Hex }));
  }

  getBalance(address: Address): Promise<bigint> {
    return this.http.getBalance({ address });
  }

  async balancesOf(token: Address, holders: Address[]): Promise<bigint[]> {
    if (holders.length === 0) return [];
    const res = await this.http.multicall({
      multicallAddress: MULTICALL3 as Address,
      allowFailure: true,
      contracts: holders.map((h) => ({ address: token, abi: tokenAbi, functionName: 'balanceOf' as const, args: [h] as const })),
    });
    return res.map((r) => (r.status === 'success' ? (r.result as bigint) : 0n));
  }

  async getTransaction(hash: Hex): Promise<RpcTxLike | null> {
    try {
      const t = await this.http.getTransaction({ hash });
      return {
        hash: t.hash,
        from: t.from,
        to: t.to ?? null,
        input: t.input,
        value: t.value,
        nonce: t.nonce,
        gas: t.gas,
        transactionIndex: t.transactionIndex ?? null,
      };
    } catch {
      return null;
    }
  }

  async getBlockTimestamp(blockNumber: number): Promise<number> {
    const b = await this.http.getBlock({ blockNumber: BigInt(blockNumber) });
    return Number(b.timestamp);
  }

  watchLaunches(cb: (log: RawLog) => void): () => void {
    if (!this.ws) return () => undefined;
    return this.ws.watchEvent({
      address: PONS_V2.factory as Address,
      event: getAbiItem({ abi: factoryAbi, name: 'TokenLaunched' }),
      onLogs: (logs) => live(logs).forEach((l) => cb(toRaw(l as Log))),
    });
  }

  watchToken(token: Address, curve: Address, cb: (log: RawLog) => void): () => void {
    if (!this.ws) return () => undefined;
    const a = this.ws.watchEvent({
      address: curve,
      events: [
        getAbiItem({ abi: curveAbi, name: 'CurveBuy' }),
        getAbiItem({ abi: curveAbi, name: 'CurveSell' }),
        getAbiItem({ abi: curveAbi, name: 'CurveCompleted' }),
        getAbiItem({ abi: curveAbi, name: 'SnipeTaxExempted' }),
      ],
      onLogs: (logs) => live(logs).forEach((l) => cb(toRaw(l as Log))),
    });
    const b = this.ws.watchEvent({
      address: token,
      event: getAbiItem({ abi: tokenAbi, name: 'Transfer' }),
      onLogs: (logs) => live(logs).forEach((l) => cb(toRaw(l as Log))),
    });
    return () => {
      a();
      b();
    };
  }
}

/**
 * State override giving `holder` a `balance` of an OpenZeppelin-layout ERC-20 (`_balances` at
 * slot 0, `_allowances` at slot 1) and a max allowance to `spender`. Used to estimate an exit
 * on a curve the contract does not hold (N15). If the token uses another layout the estimate
 * simply reverts (NothingToSell) and the caller reports that.
 */
export function erc20HoldingOverride(token: Address, holder: Address, spender: Address, balance: bigint): StateOverride {
  const balSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, 0n]));
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, 1n]));
  const allowSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner]));
  const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;
  return [{ address: token, stateDiff: [{ slot: balSlot, value: word(balance) }, { slot: allowSlot, value: word((1n << 256n) - 1n) }] }];
}
