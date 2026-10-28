import { TOPICS, type RawLog, type Reserves, type RpcTxLike } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { StateOverride } from 'viem';
import type { ChainClient, ReceiptLite, RecentLaunch, SniperConfigState, SniperHolding } from '../../src/chain.js';
import type { RawSender, SendResult } from '../../src/rpc.js';

export class FakeChain implements ChainClient {
  receipts = new Map<string, ReceiptLite>();
  /** curve → reserves at 'latest' */
  latest = new Map<string, Reserves>();
  /** (curve, block) → reserves; falls back to latest */
  atBlock: (curve: string, block: number) => Reserves | undefined = () => undefined;
  txs = new Map<string, RpcTxLike>();
  balances = new Map<string, bigint>();
  nonce = 0;
  calls: string[] = [];
  tokenWatchers = new Map<string, (l: RawLog) => void>();
  launchWatcher: ((l: RawLog) => void) | null = null;
  blockTs = new Map<number, number>();
  /** per-address nonce (falls back to `nonce`) */
  nonces = new Map<string, number>();
  /** native balances (default 1 ETH) */
  ethBalances = new Map<string, bigint>();
  blockNumber = 0;
  /** token → PonsSniper holding; `readSniperFails` makes every read throw (RPC down) */
  holdings = new Map<string, SniperHolding>();
  readSniperFails = false;
  graduated = new Set<string>();
  receiptFails = false;
  estimate: bigint | Error = 180_000n;
  /** per-call estimate override (e.g. exits, or a revert on one candidate curve) */
  estimateFn: ((tx: { from: Address; to: Address; data: Hex; stateOverride?: StateOverride }) => Promise<bigint>) | null = null;
  estimates: { from: Address; to: Address; data: Hex; stateOverride?: StateOverride }[] = [];
  /** recent TokenLaunched logs, newest first */
  recents: RecentLaunch[] = [];
  sniperConfig: SniperConfigState | null = null;

  async getReserves(curve: Address, blockNumber?: number): Promise<Reserves> {
    this.calls.push(`getReserves:${curve}:${blockNumber ?? 'latest'}`);
    const r = (blockNumber !== undefined ? this.atBlock(curve, blockNumber) : undefined) ?? this.latest.get(curve.toLowerCase());
    if (!r) throw new Error('no contract code');
    return r;
  }
  async getTransactionCount(address?: Address): Promise<number> {
    this.calls.push('getTransactionCount');
    return (address ? this.nonces.get(address.toLowerCase()) : undefined) ?? this.nonce;
  }
  async getReceipt(hash: Hex): Promise<ReceiptLite | null> {
    this.calls.push(`getReceipt:${hash.slice(0, 10)}`);
    if (this.receiptFails) throw new Error('HTTP 429');
    return this.receipts.get(hash.toLowerCase()) ?? null;
  }
  blockNumberFails = false;
  async getBlockNumber(): Promise<number> {
    this.calls.push('getBlockNumber');
    if (this.blockNumberFails) throw new Error('HTTP 503');
    return this.blockNumber;
  }
  async readSniper(_sniper: Address, token: Address): Promise<SniperHolding> {
    this.calls.push(`readSniper:${token}`);
    if (this.readSniperFails) throw new Error('HTTP 429 rate limited');
    return this.holdings.get(token.toLowerCase()) ?? { bought: false, balance: 0n };
  }
  async curveGraduated(curve: Address): Promise<boolean> {
    this.calls.push(`curveGraduated:${curve}`);
    return this.graduated.has(curve.toLowerCase());
  }
  async estimateGas(tx: { from: Address; to: Address; data: Hex; stateOverride?: StateOverride }): Promise<bigint> {
    this.estimates.push(tx);
    if (this.estimateFn) return this.estimateFn(tx);
    if (this.estimate instanceof Error) throw this.estimate;
    return this.estimate;
  }
  async recentLaunches(_lookback: number, limit: number): Promise<RecentLaunch[]> {
    return this.recents.slice(0, limit);
  }
  async readSniperConfig(_s: Address, keys: readonly Address[]): Promise<SniperConfigState> {
    if (!this.sniperConfig) throw new Error('no contract');
    return { ...this.sniperConfig, operators: keys.map((_k, i) => this.sniperConfig!.operators[i] ?? false) };
  }
  async getGasPrice(): Promise<bigint> {
    return 20_600_000n;
  }
  async getBalance(address: Address): Promise<bigint> {
    return this.ethBalances.get(address.toLowerCase()) ?? 10n ** 18n;
  }
  async balancesOf(_token: Address, holders: Address[]): Promise<bigint[]> {
    return holders.map((h) => this.balances.get(h.toLowerCase()) ?? 0n);
  }
  async getTransaction(hash: Hex): Promise<RpcTxLike | null> {
    return this.txs.get(hash.toLowerCase()) ?? null;
  }
  async getBlockTimestamp(n: number): Promise<number> {
    return this.blockTs.get(n) ?? 0;
  }
  watchLaunches(cb: (l: RawLog) => void): () => void {
    this.launchWatcher = cb;
    return () => (this.launchWatcher = null);
  }
  watchToken(token: Address, curve: Address, cb: (l: RawLog) => void): () => void {
    this.tokenWatchers.set(`${token}:${curve}`, cb);
    return () => this.tokenWatchers.delete(`${token}:${curve}`);
  }
  emitTokenLog(l: RawLog): void {
    for (const cb of this.tokenWatchers.values()) cb(l);
  }
}

export class FakeSender implements RawSender {
  sent: { raw: Hex; at: number }[] = [];
  /** fail the next N sends (transient error), then succeed */
  failNext = 0;
  constructor(
    readonly url: string,
    private readonly now: () => number,
    private readonly fail = false,
  ) {}
  async sendRaw(raw: Hex): Promise<SendResult> {
    const at = this.now();
    this.sent.push({ raw, at });
    if (this.failNext > 0) {
      this.failNext--;
      return { endpoint: this.url, sentAt: at, doneAt: at, ok: false, error: 'HTTP 502' };
    }
    return this.fail
      ? { endpoint: this.url, sentAt: at, doneAt: at, ok: false, error: 'boom' }
      : { endpoint: this.url, sentAt: at, doneAt: at + 3, ok: true };
  }
  async request<T>(): Promise<T> {
    return '0x1237' as T;
  }
  async ping(): Promise<number> {
    return 3;
  }
  close(): void {}
}

const pad = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
const word = (n: bigint): string => n.toString(16).padStart(64, '0');

export function curveTradeLog(o: {
  curve: string;
  side: 'buy' | 'sell';
  trader: string;
  recipient: string;
  quote: bigint;
  tokens: bigint;
  fee: bigint;
  tax: bigint;
  block: number;
  txHash: string;
  logIndex: number;
}): RawLog {
  const data =
    o.side === 'buy'
      ? `0x${word(o.quote)}${word(o.tokens)}${word(o.fee)}${word(o.tax)}`
      : `0x${word(o.tokens)}${word(o.quote)}${word(o.fee)}${word(o.tax)}`;
  return {
    address: o.curve,
    topics: [o.side === 'buy' ? TOPICS.CurveBuy : TOPICS.CurveSell, pad(o.trader), pad(o.recipient)],
    data,
    blockNumber: o.block,
    transactionHash: o.txHash,
    logIndex: o.logIndex,
  };
}

export function transferLog(o: { token: string; from: string; to: string; value: bigint; block: number; txHash: string; logIndex: number }): RawLog {
  return {
    address: o.token,
    topics: [TOPICS.Erc20Transfer, pad(o.from), pad(o.to)],
    data: `0x${word(o.value)}`,
    blockNumber: o.block,
    transactionHash: o.txHash,
    logIndex: o.logIndex,
  };
}
