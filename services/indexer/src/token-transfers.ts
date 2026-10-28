/** token_transfers extraction: ERC-20 Transfer logs emitted by launched tokens (pure). */
import { PONS_TOPICS } from './pons.js';
import { hexToBig, hexToNum } from './hex.js';
import type { Address, RpcLog, TokenTransferRow } from './types.js';

const topicAddr = (t: string) => `0x${t.slice(26)}`.toLowerCase() as Address;

export function isTransferLog(log: Pick<RpcLog, 'topics'>): boolean {
  return log.topics[0] === PONS_TOPICS.Erc20Transfer && log.topics.length === 3;
}

export function extractTokenTransfers(
  logs: readonly RpcLog[],
  isKnownToken: (token: Address) => boolean,
  tsOf: (block: number) => number | undefined,
): TokenTransferRow[] {
  const out: TokenTransferRow[] = [];
  for (const log of logs) {
    if (log.removed || !isTransferLog(log)) continue;
    const token = log.address.toLowerCase() as Address;
    if (!isKnownToken(token)) continue;
    const block = hexToNum(log.blockNumber);
    const ts = tsOf(block);
    if (ts === undefined) continue;
    out.push({
      token,
      block,
      ts,
      txHash: log.transactionHash,
      logIndex: hexToNum(log.logIndex),
      from: topicAddr(log.topics[1]!),
      to: topicAddr(log.topics[2]!),
      value: hexToBig(log.data),
    });
  }
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}
