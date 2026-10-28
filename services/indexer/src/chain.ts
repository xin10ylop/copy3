/** Typed chain reads used by the indexer (thin wrappers over raw JSON-RPC). */
import { numToHex, hexToBig, hexToNum } from './hex.js';
import { PONS_ADDRESSES } from './pons.js';
import { RpcError, type Rpc } from './rpc.js';
import type { Address, CallFrame, Hex, Reserves, RpcBlock, RpcLog, RpcReceipt, RpcTransaction } from './types.js';

export type BlockTag = number | 'latest';
const tag = (b: BlockTag) => (b === 'latest' ? 'latest' : numToHex(b));

/** curve view selectors (docs/RESEARCH.md §3) */
export const CURVE_SELECTORS = {
  getReserves: '0x0902f1ac',
  phantomQuote: '0xc57eadfc',
  launchSupply: '0x3f7ed6b7',
  launchedAt: '0xbf56b371',
  token: '0xfc0c546a',
  factory: '0xc45a0155',
} as const;

const word = (data: Hex, i: number): bigint => hexToBig(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
const wordAddr = (data: Hex, i: number) => `0x${data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`.toLowerCase() as Address;

export interface LogFilter {
  fromBlock: number;
  toBlock: number;
  address?: Address | Address[];
  topics?: (Hex | Hex[] | null)[];
}

/** The read surface the pipeline/backfill need (tests pass a fake). */
export type ChainReader = Pick<
  Chain,
  | 'blockNumber'
  | 'getBlock'
  | 'getBlockReceipts'
  | 'getLogs'
  | 'getCode'
  | 'getTransactionCount'
  | 'traceTransaction'
  | 'curveStartReserves'
  | 'curveReserves'
  | 'curveInfo'
>;

export class Chain {
  private receiptsSupported = true;

  constructor(readonly rpc: Rpc) {}

  async blockNumber(): Promise<number> {
    return hexToNum(await this.rpc.request<Hex>('eth_blockNumber', []));
  }

  getBlock(n: BlockTag, full: true): Promise<RpcBlock | null>;
  getBlock(n: BlockTag, full: false): Promise<RpcBlock<Hex> | null>;
  getBlock(n: BlockTag, full: boolean): Promise<RpcBlock | RpcBlock<Hex> | null> {
    return this.rpc.request('eth_getBlockByNumber', [tag(n), full]);
  }

  /** eth_getBlockReceipts with a per-tx fallback for nodes that lack it. */
  async getBlockReceipts(block: RpcBlock): Promise<RpcReceipt[]> {
    if (this.receiptsSupported) {
      try {
        const r = await this.rpc.request<RpcReceipt[] | null>('eth_getBlockReceipts', [block.number]);
        if (r) return r;
      } catch (err) {
        if (!(err instanceof RpcError) || err.code !== -32601) throw err;
        this.receiptsSupported = false;
      }
    }
    const out: RpcReceipt[] = [];
    for (const tx of block.transactions) {
      const r = await this.rpc.request<RpcReceipt | null>('eth_getTransactionReceipt', [tx.hash]);
      if (r) out.push(r);
    }
    return out;
  }

  getLogs(f: LogFilter): Promise<RpcLog[]> {
    return this.rpc.request('eth_getLogs', [
      { fromBlock: numToHex(f.fromBlock), toBlock: numToHex(f.toBlock), address: f.address, topics: f.topics },
    ]);
  }

  getTransaction(hash: Hex): Promise<RpcTransaction | null> {
    return this.rpc.request('eth_getTransactionByHash', [hash]);
  }

  getCode(address: Address, block: BlockTag = 'latest'): Promise<Hex> {
    return this.rpc.request('eth_getCode', [address, tag(block)]);
  }

  async getTransactionCount(address: Address, block: BlockTag): Promise<number> {
    return hexToNum(await this.rpc.request<Hex>('eth_getTransactionCount', [address, tag(block)]));
  }

  call(to: Address, data: Hex, block: BlockTag = 'latest'): Promise<Hex> {
    return this.rpc.request('eth_call', [{ to, data }, tag(block)]);
  }

  traceTransaction(hash: Hex): Promise<CallFrame> {
    return this.rpc.request('debug_traceTransaction', [hash, { tracer: 'callTracer', timeout: '10s' }]);
  }

  /** Reserves before any trade: (phantomQuote, launchSupply). Both are immutable per curve. */
  async curveStartReserves(curve: Address): Promise<Reserves | null> {
    try {
      const q = await this.call(curve, CURVE_SELECTORS.phantomQuote);
      const t = await this.call(curve, CURVE_SELECTORS.launchSupply);
      const quote = hexToBig(q);
      const token = hexToBig(t);
      return quote > 0n && token > 0n ? { quote, token } : null;
    } catch {
      return null;
    }
  }

  /** getReserves() -> (quoteReserve, tokenReserve) at a block (needs state for that block). */
  async curveReserves(curve: Address, block: BlockTag): Promise<Reserves | null> {
    try {
      const data = await this.call(curve, CURVE_SELECTORS.getReserves, block);
      if (data.length < 2 + 128) return null;
      return { quote: word(data, 0), token: word(data, 1) };
    } catch {
      return null;
    }
  }

  /** factory/token/launchedAt of a curve; null if it is not a Pons V2 curve. */
  async curveInfo(curve: Address): Promise<{ token: Address; launchedAt: number } | null> {
    try {
      const factory = await this.call(curve, CURVE_SELECTORS.factory);
      if (factory.length < 66 || wordAddr(factory, 0) !== PONS_ADDRESSES.factory) return null;
      const token = wordAddr(await this.call(curve, CURVE_SELECTORS.token), 0);
      const launchedAt = Number(word(await this.call(curve, CURVE_SELECTORS.launchedAt), 0));
      return { token, launchedAt };
    } catch {
      return null;
    }
  }

  /** Binary-search the first block with timestamp >= ts (for `backfill --since-days`). */
  async blockAtOrAfter(ts: number, lo = 0, hi?: number): Promise<number> {
    let high = hi ?? (await this.blockNumber());
    let low = lo;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const b = await this.getBlock(mid, false);
      if (!b) throw new Error(`block ${mid} not found`);
      if (hexToNum(b.timestamp) < ts) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}
