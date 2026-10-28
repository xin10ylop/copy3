import type { Address, RpcLog, RpcTransaction } from '../../src/types.js';
import { FakeChain } from './fake-chain.js';
import { START_RESERVES, launchTxFixture } from './fixtures.js';
import { h32, hx, mkBlock, mkReceipt, mkTx } from './blocks.js';

export const fx = launchTxFixture();
export const TOKEN = '0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d' as Address;
export const CURVE = '0xd30a935fddef5f5855519874ee2f4e7a7ea36821' as Address;
export const DEPLOYER = '0x81eb508048220493549302d8ea5ef73a3fde1784' as Address;
export const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address;
export const LAUNCH_DEPLOYER = '0x3711cea4feade896c913c68f01eda97cb06d1a42' as Address;
export const ESCROW = '0x31ea5b453a6cd60f36203830de046ff32dec2cdb' as Address;
export const FUNDER = '0x00000000000000000000000000000000000f0f0f' as Address;
export const FRESH = '0x0000000000000000000000000000000000001111' as Address;
export const LAUNCH_BLOCK = 100_299_817;
export const LAUNCH_TS = Number(fx.block.timestamp);

/** launch block (real tx + receipt) + a funding transfer to a fresh wallet */
export function chainWithLaunch(): FakeChain {
  const chain = new FakeChain();
  const launchTx: RpcTransaction = { ...fx.tx };
  const fund = mkTx(h32('f0'), FUNDER, FRESH, 12_000_000_000_000_000n);
  chain.addBlock(
    { ...mkBlock(LAUNCH_BLOCK, LAUNCH_TS, [fund, launchTx], fx.block.parentHash, fx.block.hash) },
    [mkReceipt(fund), fx.receipt],
  );
  chain.startReserves.set(CURVE, START_RESERVES);
  chain.code.set(FACTORY, '0x6080');
  chain.traces.set(fx.tx.hash, {
    type: 'CALL',
    from: DEPLOYER,
    to: FACTORY,
    value: hx(500_000_000_000_000n),
    calls: [
      { type: 'CALL', from: FACTORY, to: LAUNCH_DEPLOYER, value: '0x0', calls: [
        { type: 'CREATE', from: LAUNCH_DEPLOYER, to: TOKEN, value: '0x0' },
        { type: 'CREATE', from: LAUNCH_DEPLOYER, to: CURVE, value: '0x0' },
      ] },
      { type: 'CALL', from: FACTORY, to: ESCROW, value: hx(500_000_000_000_000n) },
    ],
  });
  return chain;
}

/** one block per curve-logs trade block, each log in its own tx sent by the log's recipient */
export function addTradeBlocks(chain: FakeChain, logs: RpcLog[], tsOf: (b: number) => number): number[] {
  const byBlock = new Map<number, RpcLog[]>();
  for (const l of logs) {
    const b = Number(l.blockNumber);
    if (b === LAUNCH_BLOCK) continue;
    byBlock.set(b, [...(byBlock.get(b) ?? []), l]);
  }
  for (const [b, ls] of byBlock) {
    const txs = ls.map((l) => mkTx(l.transactionHash, `0x${l.topics[2]!.slice(26)}`, '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc', 0n));
    chain.addBlock(mkBlock(b, tsOf(b), txs), txs.map((t, i) => mkReceipt(t, [ls[i]!])));
  }
  return [...byBlock.keys()].sort((a, b) => a - b);
}

export const tsOf = (b: number) => LAUNCH_TS + Math.floor((b - LAUNCH_BLOCK) / 10);

