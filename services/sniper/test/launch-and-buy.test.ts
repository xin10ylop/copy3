/**
 * N14: the launchAndBuy router path. verifyLaunchReceipt assumes the router passes the real
 * launcher (tx.from) as `deployer` to the factory, so TokenLaunched.deployer == tx.from (if the
 * router passed itself, every router launch would be refused — fail closed, but never sniped).
 *
 *  - LIVE=1: fetch the newest router `Launched` event from the public RPC (read-only), assert the
 *    assumption on its receipt, and save tx + receipt to
 *    packages/core/test/fixtures/launch-and-buy-tx.json;
 *  - offline: the same assertions on that fixture when it exists.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PONS_V2, TOPICS, decodedTxFromRpc, launchEventFromCall, parseLaunchCall, parseTokenLaunchedLog, type RawLog, type RpcTxLike } from '@hood/core';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ReceiptLite } from '../src/chain.js';
import { verifyLaunchReceipt } from '../src/detector.js';
import type { DetectedLaunch } from '../src/types.js';

const LIVE = process.env.LIVE === '1';
const RPC = process.env.PUBLIC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
const FIXTURE = fileURLToPath(new URL('../../../packages/core/test/fixtures/launch-and-buy-tx.json', import.meta.url));

interface Fixture {
  tx: RpcTxLike & { blockNumber: string };
  receipt: { status: string; blockNumber: string; transactionHash: string; gasUsed: string; logs: RawLog[] };
  blockTimestamp: number;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await new Promise((r) => setTimeout(r, 150));
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
  }
}

/** The fixture's launch as the feed would have produced it, and its receipt. */
function fromFixture(f: Fixture): { launch: DetectedLaunch; receipt: ReceiptLite; from: string } {
  const dtx = decodedTxFromRpc(f.tx);
  const call = parseLaunchCall({ to: dtx.to, input: dtx.input, value: dtx.value });
  if (!call) throw new Error('fixture tx is not a launch call');
  const block = Number(BigInt(f.tx.blockNumber));
  const event = launchEventFromCall(call, { from: dtx.from ?? null, to: dtx.to, hash: dtx.hash, block, ts: f.blockTimestamp });
  const launch: DetectedLaunch = { event, block, ts: f.blockTimestamp, receivedAt: 0, txHash: dtx.hash as Hex, source: 'feed' };
  const receipt: ReceiptLite = {
    transactionHash: f.receipt.transactionHash as Hex,
    status: f.receipt.status === '0x1' ? 'success' : 'reverted',
    blockNumber: Number(BigInt(f.receipt.blockNumber)),
    gasUsed: BigInt(f.receipt.gasUsed),
    logs: f.receipt.logs,
  };
  return { launch, receipt, from: (dtx.from ?? '').toLowerCase() };
}

function assertRouterPassesRealDeployer(f: Fixture): void {
  expect(f.tx.to?.toLowerCase()).toBe(PONS_V2.launchAndBuyRouter);
  const { launch, receipt, from } = fromFixture(f);
  expect(launch.event.launchKind).toBe('launchAndBuy');
  const tl = receipt.logs.filter((l) => l.address.toLowerCase() === PONS_V2.factory && l.topics[0] === TOPICS.TokenLaunched).map((l) => parseTokenLaunchedLog(l));
  expect(tl).toHaveLength(1);
  expect(tl[0]!.deployer).toBe(from); // the router forwards the real launcher, not itself
  const v = verifyLaunchReceipt(receipt, launch);
  expect(v.ok).toBe(true);
  if (v.ok) expect(v.confirmation).toMatchObject({ token: tl[0]!.token, curve: tl[0]!.curve, deployer: from });
}

describe.skipIf(!LIVE)('N14 (LIVE=1): a real launchAndBuy receipt', () => {
  it('TokenLaunched.deployer == tx.from for the newest router launch; saves the fixture', { timeout: 120_000 }, async () => {
    const head = BigInt(await rpc<string>('eth_blockNumber', []));
    // the newest router launch sent STRAIGHT to the router (third-party launcher contracts also
    // call it — observed 2026-10-28: 0x6319…cce2 — with their own deployer; those are not
    // launch candidates unless listed in LAUNCHERS, and stay receipt-verified)
    let tx: Fixture['tx'] | null = null;
    for (let i = 0n; i < 12n && !tx; i++) {
      const to = head - i * 10_000n;
      const logs = await rpc<RawLog[]>('eth_getLogs', [{ address: PONS_V2.launchAndBuyRouter, topics: [TOPICS.RouterLaunched], fromBlock: `0x${(to - 9_999n).toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
      for (const l of [...logs].reverse()) {
        const t = await rpc<Fixture['tx']>('eth_getTransactionByHash', [l.transactionHash]);
        if (t.to?.toLowerCase() === PONS_V2.launchAndBuyRouter) {
          tx = t;
          break;
        }
      }
    }
    expect(tx, 'no direct router launch in the last 120k blocks').not.toBeNull();
    const hash = tx!.hash;
    const receipt = await rpc<Fixture['receipt']>('eth_getTransactionReceipt', [hash]);
    const block = await rpc<{ timestamp: string }>('eth_getBlockByNumber', [tx!.blockNumber, false]);
    const f: Fixture = { tx: tx!, receipt, blockTimestamp: Number(BigInt(block.timestamp)) };
    assertRouterPassesRealDeployer(f);
    writeFileSync(FIXTURE, `${JSON.stringify(f, null, 2)}\n`);
  });
});

describe.skipIf(!existsSync(FIXTURE))('N14 (offline): the saved launchAndBuy fixture', () => {
  it('verifyLaunchReceipt accepts the router launch (TokenLaunched.deployer == tx.from)', () => {
    assertRouterPassesRealDeployer(JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture);
  });
});
