import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodedTxFromRpc, parsePlay, type DecodedTx, type FeedBlock, type Play, type RawLog, type RpcTxLike } from '@hood/core';

const fx = (name: string): string => fileURLToPath(new URL(`../../../../packages/core/test/fixtures/${name}`, import.meta.url));

export const launchFixture = JSON.parse(readFileSync(fx('launch-tx.json'), 'utf8')) as {
  tx: RpcTxLike & { blockNumber: string; blockTimestamp: string };
  receipt: { logs: RawLog[] };
};
export const tokenLaunchedLog = JSON.parse(readFileSync(fx('token-launched-log.json'), 'utf8')) as RawLog;
export const amlil = JSON.parse(readFileSync(fx('amlil-trades.json'), 'utf8')) as {
  trades: { blk: number; side: 'buy' | 'sell'; actor: string; recipient: string; q: number; tok: number; fee: number; tax: number; tx: string; ts: number; snipe_tax: number }[];
  meta: { launchedAt: number; exempt: string[] };
};
export const feedFrames = readFileSync(fx('feed-frames.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as { receivedAt: number; frame: unknown });

export const LAUNCH = {
  txHash: launchFixture.tx.hash.toLowerCase() as `0x${string}`,
  block: parseInt(launchFixture.tx.blockNumber, 16),
  ts: parseInt(launchFixture.tx.blockTimestamp, 16),
  deployer: '0x81eb508048220493549302d8ea5ef73a3fde1784' as const,
  creatorFeeRecipient: '0x44e58c19c5d979ad4457075855acd88b93f5a49b' as const,
  token: '0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d' as const,
  curve: '0xd30a935fddef5f5855519874ee2f4e7a7ea36821' as const,
};

export function launchTx(): DecodedTx {
  return decodedTxFromRpc(launchFixture.tx);
}

/** A feed block carrying the real launch tx (fields from the fixture; signature not needed). */
export function launchBlock(receivedAt: number, extra: DecodedTx[] = []): FeedBlock {
  return { block: LAUNCH.block, timestamp: LAUNCH.ts, txs: [...extra, launchTx()], receivedAt, headerKind: 3 };
}

export function emptyBlock(block: number, ts: number, receivedAt: number, txs: DecodedTx[] = []): FeedBlock {
  return { block, timestamp: ts, txs, receivedAt, headerKind: 3 };
}

export function play(over: Record<string, unknown> & { trigger?: Record<string, unknown>; preset?: Record<string, unknown> }): Play {
  return { ...parsePlay({ name: 'test', ...over }), id: (over.id as number | undefined) ?? 1, enabled: true };
}
