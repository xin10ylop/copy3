import type { BlockTag, ChainReader, LogFilter } from '../../src/chain.js';
import type { Address, CallFrame, Hex, Reserves, RpcBlock, RpcLog, RpcReceipt } from '../../src/types.js';
import { hexToNum } from '../../src/hex.js';

/** In-memory ChainReader for pipeline tests. */
export class FakeChain implements ChainReader {
  head = 0;
  readonly blocks = new Map<number, RpcBlock>();
  readonly receipts = new Map<number, RpcReceipt[]>();
  readonly traces = new Map<string, CallFrame>();
  readonly code = new Map<string, Hex>();
  readonly nonces = new Map<string, number>();
  readonly startReserves = new Map<string, Reserves>();
  readonly reservesAt = new Map<string, Reserves>();
  readonly curveInfos = new Map<string, { token: Address; launchedAt: number }>();
  readonly calls: string[] = [];

  addBlock(block: RpcBlock, receipts: RpcReceipt[]): void {
    const n = hexToNum(block.number);
    this.blocks.set(n, block);
    this.receipts.set(n, receipts);
    if (n > this.head) this.head = n;
  }

  async blockNumber(): Promise<number> {
    return this.head;
  }

  getBlock(n: BlockTag, full: true): Promise<RpcBlock | null>;
  getBlock(n: BlockTag, full: false): Promise<RpcBlock<Hex> | null>;
  async getBlock(n: BlockTag, full: boolean): Promise<RpcBlock | RpcBlock<Hex> | null> {
    this.calls.push(`getBlock:${n}`);
    const b = this.blocks.get(n === 'latest' ? this.head : n);
    if (!b) return null;
    return full ? b : { ...b, transactions: b.transactions.map((t) => t.hash) };
  }

  async getBlockReceipts(block: RpcBlock): Promise<RpcReceipt[]> {
    return this.receipts.get(hexToNum(block.number)) ?? [];
  }

  async getLogs(f: LogFilter): Promise<RpcLog[]> {
    const out: RpcLog[] = [];
    const addrs = f.address ? new Set((Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase())) : null;
    const t0 = f.topics?.[0];
    const t0s = t0 ? new Set(Array.isArray(t0) ? t0 : [t0]) : null;
    for (const [n, rs] of this.receipts) {
      if (n < f.fromBlock || n > f.toBlock) continue;
      for (const r of rs) {
        if (r.status !== '0x1') continue;
        for (const l of r.logs) {
          if (addrs && !addrs.has(l.address.toLowerCase())) continue;
          if (t0s && !t0s.has(l.topics[0] as Hex)) continue;
          out.push({ ...l, blockTimestamp: '0x0' });
        }
      }
    }
    return out;
  }

  async getCode(a: Address): Promise<Hex> {
    return this.code.get(a.toLowerCase()) ?? '0x';
  }

  async getTransactionCount(a: Address, block: BlockTag): Promise<number> {
    this.calls.push(`nonce:${a}:${block}`);
    return this.nonces.get(a.toLowerCase()) ?? 0;
  }

  async traceTransaction(hash: Hex): Promise<CallFrame> {
    const t = this.traces.get(hash);
    if (!t) throw new Error(`no trace for ${hash}`);
    return t;
  }

  async curveStartReserves(curve: Address): Promise<Reserves | null> {
    return this.startReserves.get(curve) ?? null;
  }

  async curveReserves(curve: Address, block: BlockTag): Promise<Reserves | null> {
    return this.reservesAt.get(`${curve}:${block}`) ?? null;
  }

  async curveInfo(curve: Address): Promise<{ token: Address; launchedAt: number } | null> {
    return this.curveInfos.get(curve) ?? null;
  }
}
