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

/** PonsSniper admin state checked at live startup (M4 / live-mode gate). */
export interface SniperConfigState {
  owner: Address;
  factory: Address;
  maxQuoteIn: bigint;
  /** operators(key) for every key passed, same order */
  operators: boolean[];
}

export interface ChainClient {
  getReserves(curve: Address, blockNumber?: number): Promise<Reserves>;
  getBlockNumber(): Promise<number>;
  /** sniper.bought(token) + token.balanceOf(sniper), both read at ONE block (N11) */
  readSniper(sniper: Address, token: Address): Promise<SniperHolding>;
  /** curve.graduated() — sells on the curve revert once true */
  curveGraduated(curve: Address): Promise<boolean>;
  estimateGas(tx: { from: Address; to: Address; data: Hex; value?: bigint; stateOverride?: StateOverride }): Promise<bigint>;
  /** most recent TokenLaunched logs within `lookbackBlocks`, newest first, at most `limit` (startup checks) */
  recentLaunches(lookbackBlocks: number, limit: number): Promise<RecentLaunch[]>;
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
    const head = await this.http.getBlockNumber();
    const logs = await this.http.getLogs({
      address: PONS_V2.factory as Address,
      event: getAbiItem({ abi: factoryAbi, name: 'TokenLaunched' }),
      fromBlock: head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n,
      toBlock: head,
    });
    return logs
      .slice(-limit)
      .reverse()
      .map((l) => {
        const p = parseTokenLaunchedLog(toRaw(l as Log));
        return { token: p.token as Address, curve: p.curve as Address, block: Number(l.blockNumber ?? 0n) };
      });
  }

  async readSniperConfig(sniper: Address, keys: readonly Address[]): Promise<SniperConfigState> {
    const [owner, factory, maxQuoteIn, ...ops] = await Promise.all([
      this.http.readContract({ address: sniper, abi: sniperAbi, functionName: 'owner' }),
      this.http.readContract({ address: sniper, abi: sniperAbi, functionName: 'factory' }),
      this.http.readContract({ address: sniper, abi: sniperAbi, functionName: 'maxQuoteIn' }),
      ...keys.map((k) => this.http.readContract({ address: sniper, abi: sniperAbi, functionName: 'operators', args: [k] })),
    ]);
    return {
      owner: owner.toLowerCase() as Address,
      factory: factory.toLowerCase() as Address,
      maxQuoteIn: BigInt(maxQuoteIn),
      operators: ops.map((o) => o === true),
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
