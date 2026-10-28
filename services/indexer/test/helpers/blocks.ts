import type { Address, Hex, RpcBlock, RpcLog, RpcReceipt, RpcTransaction } from '../../src/types.js';

export const hx = (n: number | bigint): Hex => `0x${n.toString(16)}`;
export const h32 = (s: string | number): Hex => `0x${(typeof s === 'number' ? s.toString(16) : s).padStart(64, '0')}`;

export function mkTx(hash: Hex, from: string, to: string | null, value: bigint, input: Hex = '0x', nonce = 0): RpcTransaction {
  return {
    hash,
    from: from as Address,
    to: to as Address | null,
    value: hx(value),
    input,
    nonce: hx(nonce),
    blockNumber: null,
    blockHash: null,
    transactionIndex: null,
  };
}

export function mkReceipt(tx: RpcTransaction, logs: RpcLog[] = [], ok = true, contractAddress: Address | null = null): RpcReceipt {
  return {
    transactionHash: tx.hash,
    transactionIndex: '0x0',
    blockNumber: '0x0',
    blockHash: '0x0',
    from: tx.from,
    to: tx.to,
    contractAddress,
    status: ok ? '0x1' : '0x0',
    logs,
  };
}

export function mkBlock(n: number, ts: number, txs: RpcTransaction[], parentHash: Hex = h32(n - 1), hash: Hex = h32(n)): RpcBlock {
  return { number: hx(n), hash, parentHash, timestamp: hx(ts), transactions: txs };
}
