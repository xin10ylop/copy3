/**
 * Chain access port (reads + subscriptions). Hot-path budget: only `getReserves` right after
 * the launch receipt; everything else is off the decide path. `ViemChain` is the real
 * implementation (own node http + ws); tests use fakes.
 */
import {
  MULTICALL3,
  PONS_V2,
  curveAbi,
  factoryAbi,
  tokenAbi,
  type RawLog,
  type Reserves,
  type RpcTxLike,
} from '@hood/core';
import {
  createPublicClient,
  getAbiItem,
  http,
  webSocket,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';

export interface ReceiptLite {
  transactionHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: number;
  gasUsed: bigint;
  logs: RawLog[];
}

export interface ChainClient {
  getReserves(curve: Address, blockNumber?: number): Promise<Reserves>;
  getTransactionCount(address: Address, tag: 'latest' | 'pending'): Promise<number>;
  getReceipt(hash: Hex): Promise<ReceiptLite | null>;
  getGasPrice(): Promise<bigint>;
  getBalance(address: Address): Promise<bigint>;
  balancesOf(token: Address, holders: Address[]): Promise<bigint[]>;
  getTransaction(hash: Hex): Promise<RpcTxLike | null>;
  getBlockTimestamp(blockNumber: number): Promise<number>;
  /** TokenLaunched logs from the factory (ws). Optional: without ws we poll receipts. */
  watchLaunches?(cb: (log: RawLog) => void): () => void;
  /** CurveBuy/CurveSell on `curve` and Transfer on `token` (ws). */
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

  constructor(opts: { httpUrl: string; wsUrl?: string }) {
    this.http = createPublicClient({ transport: http(opts.httpUrl, { batch: false, retryCount: 1, timeout: 5000 }) });
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
      events: [getAbiItem({ abi: curveAbi, name: 'CurveBuy' }), getAbiItem({ abi: curveAbi, name: 'CurveSell' })],
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
