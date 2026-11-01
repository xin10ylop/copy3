/** An RPC block (raw JSON-RPC hex fields or a viem-parsed block) as a FeedBlock. */
import { decodedTxFromRpc, type DecodedTx, type FeedBlock, type RpcTxLike } from '@hood/core';
import type { Hex } from 'viem';

export interface RpcBlockLike {
  number: Hex | bigint | number | null;
  timestamp: Hex | bigint | number;
  hash?: Hex | null;
  transactions: readonly (Hex | (Omit<RpcTxLike, 'to' | 'from'> & { from: string; to?: string | null }))[];
}

export function rpcBlockToFeedBlock(b: RpcBlockLike, receivedAt: number): FeedBlock {
  const txs: DecodedTx[] = [];
  for (const t of b.transactions) {
    if (typeof t === 'string') continue;
    try {
      txs.push(decodedTxFromRpc({ ...t, from: t.from as RpcTxLike['from'], to: (t.to ?? null) as RpcTxLike['to'], transactionIndex: t.transactionIndex ?? null }));
    } catch {
      /* an undecodable tx (unknown type) is skipped; the feed decoder skips those too */
    }
  }
  return {
    block: Number(b.number ?? 0),
    timestamp: Number(b.timestamp),
    txs,
    receivedAt,
    blockHash: b.hash ?? undefined,
    headerKind: 3,
  };
}
