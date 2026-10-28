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
  createPublicClient,
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
}

/** What the PonsSniper contract holds for a token (chain truth for reconciliation). */
export interface SniperHolding {
  bought: boolean;
  balance: bigint;
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
  /** PonsSniper `Sniped` events in [fromBlock, toBlock], oldest first (chunked ≤ LOG_CHUNK_BLOCKS) */
  snipedLogs(sniper: Address, fromBlock: number, toBlock: number): Promise<SnipedLog[]>;
  /** owner / factory / maxQuoteIn / operators(keys) of the PonsSniper contract */
  readSniperConfig(sniper: Address, keys: readonly Address[]): Promise<SniperConfigState>;
  getTransactionCount(address: Address, tag: 'latest' | 'pending'): Promise<number>;
  getReceipt(hash: Hex): Promise<ReceiptLite | null>;
  getGasPrice(): Promise<bigint>;
  getBalance(address: Address): Promise<bigint>;
  balancesOf(token: Address, holders: Address[]): Promise<bigint[]>;
  getTransaction(hash: Hex): Promise<RpcTxLike | null>;
  getBlockTimestamp(blockNumber: number): Promise<number>;
  /** TokenLaunched logs from the factory (ws). Optional: without ws we poll receipts. */
  watchLaunches?(cb: (log: RawLog) => void): () => void;
  /** CurveBuy/CurveSell/CurveCompleted/SnipeTaxExempted on `curve` and Transfer on `token` (ws). */
  watchToken?(token: Address, curve: Address, cb: (log: RawLog) => void): () => void;
}

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

  /** `transport` replaces the http transport (tests). */
  constructor(opts: { httpUrl: string; wsUrl?: string; transport?: Transport }) {
    this.http = createPublicClient({ transport: opts.transport ?? http(opts.httpUrl, { batch: false, retryCount: 1, timeout: 5000 }) });
    this.ws = opts.wsUrl ? createPublicClient({ transport: webSocket(opts.wsUrl, { keepAlive: true, reconnect: true }) }) : null;
  }

  async getReserves(curve: Address, blockNumber?: number): Promise<Reserves> {
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
    // N11: both reads pinned to one block, or a buy landing in between gives bought=false + balance>0
    const blockNumber = await this.http.getBlockNumber({ cacheTime: 0 });
    const [bought, balance] = await Promise.all([
      this.http.readContract({ address: sniper, abi: sniperAbi, functionName: 'bought', args: [token], blockNumber }),
      this.http.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [sniper], blockNumber }),
    ]);
    return { bought, balance };
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
    const head = Number(await this.http.getBlockNumber({ cacheTime: 0 }));
    const out: RecentLaunch[] = [];
    for (const [a, b] of blockRanges(head - lookbackBlocks, head).reverse()) {
      const logs = await this.http.getLogs({
        address: PONS_V2.factory as Address,
        event: getAbiItem({ abi: factoryAbi, name: 'TokenLaunched' }),
        fromBlock: BigInt(a),
        toBlock: BigInt(b),
      });
      for (const l of [...logs].reverse()) {
        const p = parseTokenLaunchedLog(toRaw(l as Log));
        out.push({ token: p.token as Address, curve: p.curve as Address, block: Number(l.blockNumber ?? 0n) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async snipedLogs(sniper: Address, fromBlock: number, toBlock: number): Promise<SnipedLog[]> {
    const out: SnipedLog[] = [];
    for (const [a, b] of blockRanges(fromBlock, toBlock)) {
      const logs = await this.http.getLogs({ address: sniper, event: getAbiItem({ abi: sniperAbi, name: 'Sniped' }), fromBlock: BigInt(a), toBlock: BigInt(b) });
      for (const l of logs) {
        out.push({
          token: l.args.token!.toLowerCase() as Address,
          curve: l.args.curve!.toLowerCase() as Address,
          quoteIn: l.args.quoteIn!,
          tokensOut: l.args.tokensOut!,
          taxBps: Number(l.args.taxBps!),
          block: Number(l.blockNumber ?? 0n),
          txHash: (l.transactionHash ?? '0x') as Hex,
        });
      }
    }
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

  async getReceipt(hash: Hex): Promise<ReceiptLite | null> {
    try {
      const r = await this.http.getTransactionReceipt({ hash });
      return {
        transactionHash: r.transactionHash,
        status: r.status,
        blockNumber: Number(r.blockNumber),
        gasUsed: r.gasUsed,
        logs: r.logs.map((l) => toRaw(l as Log)),
      };
    } catch (e) {
      if ((e as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
      throw e;
    }
  }

  getGasPrice(): Promise<bigint> {
    return this.http.getGasPrice();
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
      onLogs: (logs) => logs.forEach((l) => cb(toRaw(l as Log))),
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
      onLogs: (logs) => logs.forEach((l) => cb(toRaw(l as Log))),
    });
    const b = this.ws.watchEvent({
      address: token,
      event: getAbiItem({ abi: tokenAbi, name: 'Transfer' }),
      onLogs: (logs) => logs.forEach((l) => cb(toRaw(l as Log))),
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
