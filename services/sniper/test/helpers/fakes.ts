import { TOPICS, type RawLog, type Reserves, type RpcTxLike } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { ChainClient, ReceiptLite } from '../../src/chain.js';
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

  async getReserves(curve: Address, blockNumber?: number): Promise<Reserves> {
    this.calls.push(`getReserves:${curve}:${blockNumber ?? 'latest'}`);
    const r = (blockNumber !== undefined ? this.atBlock(curve, blockNumber) : undefined) ?? this.latest.get(curve.toLowerCase());
    if (!r) throw new Error('no contract code');
    return r;
  }
  async getTransactionCount(): Promise<number> {
    this.calls.push('getTransactionCount');
    return this.nonce;
  }
  async getReceipt(hash: Hex): Promise<ReceiptLite | null> {
    this.calls.push(`getReceipt:${hash.slice(0, 10)}`);
    return this.receipts.get(hash.toLowerCase()) ?? null;
  }
  async getGasPrice(): Promise<bigint> {
    return 20_600_000n;
  }
  async getBalance(): Promise<bigint> {
    return 10n ** 18n;
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
  constructor(
    readonly url: string,
    private readonly now: () => number,
    private readonly fail = false,
  ) {}
  async sendRaw(raw: Hex): Promise<SendResult> {
    const at = this.now();
    this.sent.push({ raw, at });
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
