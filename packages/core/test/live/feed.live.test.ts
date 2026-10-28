/** LIVE=1 only: decode a real feed frame and compare tx hashes with eth_getBlockByNumber. */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { decodeFeedFrame, type FeedBlock } from '../../src/feed/decoder.js';

const LIVE = process.env.LIVE === '1';
const FEED = process.env.FEED_URL ?? 'wss://feed.mainnet.chain.robinhood.com';
const RPC = process.env.PUBLIC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  }
}

describe.skipIf(!LIVE)('live feed vs RPC', () => {
  it('decoded tx hashes equal the block tx hashes (minus ArbOS internal txs)', async () => {
    const blocks: FeedBlock[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(FEED);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('no frames'));
      }, 15_000);
      ws.on('message', (d) => {
        for (const b of decodeFeedFrame(d.toString(), Date.now())) if (b.txs.length > 0) blocks.push(b);
        if (blocks.length >= 3) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });
    const b = blocks[blocks.length - 1]!;
    // give the RPC node a moment to have the block
    await new Promise((r) => setTimeout(r, 1500));
    const rpcBlock = await rpc<{
      hash: string;
      timestamp: string;
      transactions: { hash: string; type: string }[];
    }>('eth_getBlockByNumber', [`0x${b.block.toString(16)}`, true]);
    const userTxs = rpcBlock.transactions.filter((t) => !['0x6a', '0x68', '0x69', '0x64', '0x65', '0x66'].includes(t.type));
    expect(b.txs.map((t) => t.hash)).toEqual(userTxs.map((t) => t.hash.toLowerCase()));
    expect(Number(rpcBlock.timestamp)).toBe(b.timestamp);
    if (b.blockHash) expect(rpcBlock.hash.toLowerCase()).toBe(b.blockHash);
  }, 60_000);
});
