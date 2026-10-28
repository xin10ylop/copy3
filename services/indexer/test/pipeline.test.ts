import { describe, expect, it } from 'vitest';
import { silentLog } from '../src/log.js';
import { MemoryStore } from '../src/memory-store.js';
import { BlockPipeline } from '../src/pipeline.js';
import type { Address, Hex } from '../src/types.js';
import { FakeChain } from './helpers/fake-chain.js';
import { curveLogsFixture } from './helpers/fixtures.js';
import { h32, mkBlock, mkReceipt, mkTx } from './helpers/blocks.js';
import { curveBuyLog, exemptedLog, snipeTaxLog, transferLog } from './helpers/logs.js';
import { CURVE, DEPLOYER, ESCROW, FACTORY, FRESH, FUNDER, LAUNCH_BLOCK, LAUNCH_DEPLOYER, LAUNCH_TS, TOKEN, addTradeBlocks, chainWithLaunch, fx, tsOf } from './helpers/scenario.js';

describe('BlockPipeline.processBlock on the real launch + trades', () => {
  it('indexes launch, ETH transfers (plain + traced), wallets, trades, metrics and checkpoint', async () => {
    const chain = chainWithLaunch();
    const tradeBlocks = addTradeBlocks(chain, curveLogsFixture(), tsOf);
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, { traceInternal: true, startBlock: LAUNCH_BLOCK });
    await p.init();

    const out = await p.processBlock(LAUNCH_BLOCK, { live: true, notify: true });
    expect(out).toMatchObject({ status: 'ok', launches: 1, trades: 0 });
    expect(store.launches.get(TOKEN)).toMatchObject({ name: 'SHIBA INU', symbol: 'SHIB', deployer: DEPLOYER, startMcapEth: 1.68 });

    const transfers = [...store.transfers.values()].map((t) => [t.kind, t.from, t.to, t.value, t.traceAddr]);
    expect(transfers).toEqual([
      ['tx', FUNDER, FRESH, 12_000_000_000_000_000n, ''],
      ['tx', DEPLOYER, FACTORY, 500_000_000_000_000n, ''],
      ['create', LAUNCH_DEPLOYER, TOKEN, 0n, '0,0'],
      ['create', LAUNCH_DEPLOYER, CURVE, 0n, '0,1'],
      ['internal', FACTORY, ESCROW, 500_000_000_000_000n, '1'],
    ]);
    expect(store.wallets.get(FRESH)).toMatchObject({ firstFunder: FUNDER, firstFundingValue: 12_000_000_000_000_000n, isContract: false, txCountAtFirstFunding: 0 });
    expect(store.wallets.get(FACTORY)).toMatchObject({ isContract: true, txCountAtFirstFunding: null });
    expect(store.wallets.get(CURVE)).toMatchObject({ isContract: true, firstFunder: LAUNCH_DEPLOYER });
    expect(chain.calls).toContain(`nonce:${FRESH}:${LAUNCH_BLOCK - 1}`);
    expect(store.notifications).toEqual([LAUNCH_BLOCK]);
    expect(store.checkpoint).toEqual({ block: LAUNCH_BLOCK, hash: fx.block.hash });

    for (const b of tradeBlocks) await p.processBlock(b, { live: true, notify: true });
    const trades = [...store.trades.values()];
    expect(trades).toHaveLength(9);
    expect(trades[0]).toMatchObject({ token: TOKEN, side: 'buy', txFrom: '0xb81db28acaade5d04c2c14be798c15844166edda', secondsSinceLaunch: 24 });
    expect(p.book.get(CURVE)?.reserves).toEqual({ quote: 1_680_000_000_000_000_003n, token: 10n ** 27n });
    const m = store.metrics.get(TOKEN)!;
    expect(m.firstTaxedBuyer).toBe('0xb81db28acaade5d04c2c14be798c15844166edda'); // fallback: no snipe tax at +24 s
    expect(m.nBuys60s).toBe(3);
    // no ETH transfers in trade blocks -> no tracker notifications for them
    expect(store.notifications).toEqual([LAUNCH_BLOCK]);
  });

  it('re-hydrates a curve from the store after a restart and keeps prices exact', async () => {
    const chain = chainWithLaunch();
    const logs = curveLogsFixture();
    const tradeBlocks = addTradeBlocks(chain, logs, tsOf);
    const store = new MemoryStore();
    const p1 = new BlockPipeline(chain, store, silentLog, { startBlock: LAUNCH_BLOCK });
    await p1.init();
    await p1.processBlock(LAUNCH_BLOCK, { live: true, notify: false });
    await p1.processBlock(tradeBlocks[0]!, { live: true, notify: false });
    const reference = new BlockPipeline(chain, new MemoryStore(), silentLog, {});
    await reference.processBlock(LAUNCH_BLOCK, { live: true, notify: false });
    for (const b of tradeBlocks) await reference.processBlock(b, { live: true, notify: false });

    const p2 = new BlockPipeline(chain, store, silentLog, {}); // "restart"
    await p2.init();
    expect(p2.stats.next).toBe(tradeBlocks[0]! + 1);
    for (const b of tradeBlocks.slice(1)) await p2.processBlock(b, { live: true, notify: false });
    expect(p2.book.get(CURVE)?.reserves).toEqual(reference.book.get(CURVE)?.reserves);
    expect(p2.book.get(CURVE)?.trades.map((t) => t.priceAfter)).toEqual(reference.book.get(CURVE)?.trades.map((t) => t.priceAfter));
  });

  it('records snipe tax, post-launch exemptions and exempt->dump token transfers', async () => {
    const chain = chainWithLaunch();
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, {});
    await p.processBlock(LAUNCH_BLOCK, { live: true, notify: false });

    const TEAM = '0x000000000000000000000000000000000000beef' as Address;
    const BUYER = '0x000000000000000000000000000000000000b0b0' as Address;
    const DUMP = '0x000000000000000000000000000000000000d00d' as Address;
    // +1 s: taxed buy; also the deployer exempts TEAM after launch
    const buyTx = mkTx(h32('b1'), BUYER, CURVE, 10n ** 17n);
    const exTx = mkTx(h32('e1'), DEPLOYER, CURVE, 0n);
    const n1 = LAUNCH_BLOCK + 5;
    chain.addBlock(mkBlock(n1, LAUNCH_TS + 1, [buyTx, exTx]), [
      mkReceipt(buyTx, [
        snipeTaxLog(CURVE, { block: n1, tx: buyTx.hash, logIndex: 0 }, BUYER, 6_180_000_000_000_000n),
        curveBuyLog(CURVE, { block: n1, tx: buyTx.hash, logIndex: 2 }, { buyer: BUYER, recipient: BUYER, quoteIn: 10n ** 17n, tokensOut: 50_000_000n * 10n ** 18n, fee: 7_180_000_000_000_000n, tax: 0n }),
      ]),
      mkReceipt(exTx, [exemptedLog(CURVE, { block: n1, tx: exTx.hash, logIndex: 3 }, TEAM)]),
    ]);
    await p.processBlock(n1, { live: true, notify: false });
    expect([...store.trades.values()][0]!.snipeTax).toBe(6_180_000_000_000_000n);
    expect(store.launches.get(TOKEN)!.exemptions).toContain(TEAM);

    // +6 s: the creator-fee recipient (exempt) moves tokens to a fresh dump wallet
    const FEE_RECIPIENT = '0x44e58c19c5d979ad4457075855acd88b93f5a49b';
    const dumpTx = mkTx(h32('d1'), FEE_RECIPIENT, TOKEN, 0n);
    const n2 = LAUNCH_BLOCK + 60;
    chain.addBlock(mkBlock(n2, LAUNCH_TS + 6, [dumpTx]), [
      mkReceipt(dumpTx, [transferLog(TOKEN, { block: n2, tx: dumpTx.hash, logIndex: 0 }, FEE_RECIPIENT, DUMP, 10n ** 24n)]),
    ]);
    await p.processBlock(n2, { live: true, notify: false });
    // the mint in the launch tx (0x0 -> curve) and the dump
    expect([...store.tokenTransfers.values()].map((t) => [t.from, t.to])).toEqual([
      ['0x0000000000000000000000000000000000000000', CURVE],
      [FEE_RECIPIENT, DUMP],
    ]);
    const m = store.metrics.get(TOKEN)!;
    expect(m.firstTaxedBuyer).toBe(BUYER);
    expect(m.exemptSoldWithinSec).toBe(6);
    expect(m.dumpWallets).toEqual([DUMP]);
  });

  it('ignores CurveBuy events from contracts that are not Pons curves', async () => {
    const chain = new FakeChain();
    const fake = '0x000000000000000000000000000000000000fa4e';
    const tx = mkTx(h32('aa'), FUNDER, fake, 0n);
    chain.addBlock(mkBlock(10, 1000, [tx]), [
      mkReceipt(tx, [curveBuyLog(fake, { block: 10, tx: tx.hash, logIndex: 0 }, { buyer: FUNDER, recipient: FUNDER, quoteIn: 1n, tokensOut: 1n, fee: 0n, tax: 0n })]),
    ]);
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, {});
    await p.processBlock(10, { live: true, notify: false });
    expect(store.trades.size).toBe(0);
    expect(p.stats.skippedUnknownCurve).toBe(1);
  });
});

describe('BlockPipeline run loop + reorg', () => {
  function linearChain(from: number, to: number, fork = ''): FakeChain {
    const chain = new FakeChain();
    for (let n = from; n <= to; n++) {
      const tx = mkTx(h32(`${fork}c${n}`), FUNDER, `0x${n.toString(16).padStart(40, '0')}`, 1000n);
      chain.addBlock(mkBlock(n, 2000 + n, [tx], h32(`${fork}${n - 1}`), h32(`${fork}${n}`)), [mkReceipt(tx)]);
    }
    return chain;
  }

  it('processes sequentially to head, notifies per block and checkpoints', async () => {
    const chain = linearChain(100, 105);
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, { startBlock: 100, pollMs: 20 });
    await p.init();
    const ac = new AbortController();
    const done = p.run(ac.signal);
    while (p.stats.next <= 105) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await done;
    expect(store.notifications).toEqual([100, 101, 102, 103, 104, 105]);
    expect(store.checkpoint).toEqual({ block: 105, hash: h32('105') });
    expect(store.wallets.size).toBe(6);
  });

  it('rolls back 10 blocks on a parent-hash mismatch and re-indexes the new fork', async () => {
    const chain = linearChain(100, 120);
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, { startBlock: 100 });
    await p.init();
    for (let n = 100; n <= 120; n++) await p.processBlock(n, { live: true, notify: true });
    expect(store.transfers.size).toBe(21);

    // the node now serves a different fork from 116 on
    const fork = linearChain(116, 121, 'f');
    fork.blocks.get(116)!.parentHash = h32('115');
    for (const n of [116, 117, 118, 119, 120, 121]) chain.addBlock(fork.blocks.get(n)!, fork.receipts.get(n)!);
    const out = await p.processBlock(121, { live: true, notify: true });
    expect(out).toEqual({ status: 'reorg', block: 121, rollbackFrom: 111 });
    expect(Math.max(...[...store.transfers.values()].map((t) => t.block))).toBe(110);
    expect(store.checkpoint).toBeNull();
    expect(p.stats.reorgs).toBe(1);
    for (let n = 111; n <= 121; n++) expect((await p.processBlock(n, { live: true, notify: true })).status).toBe('ok');
    expect(store.transfers.has(`${h32('fc118')}:`)).toBe(true);
    expect(store.transfers.has(`${h32('c118')}:`)).toBe(false);
    expect(store.checkpoint?.hash).toBe(h32('f121'));
  });

  it('drops half-applied curve state when the DB write fails, so the retry is exact', async () => {
    const chain = chainWithLaunch();
    const tradeBlocks = addTradeBlocks(chain, curveLogsFixture(), tsOf);
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, {});
    await p.processBlock(LAUNCH_BLOCK, { live: true, notify: false });
    const original = store.writeBatch.bind(store);
    let fail = true;
    store.writeBatch = async (b) => {
      if (fail) {
        fail = false;
        throw new Error('db down');
      }
      return original(b);
    };
    await expect(p.processBlock(tradeBlocks[0]!, { live: true, notify: false })).rejects.toThrow('db down');
    expect(p.book.has(CURVE)).toBe(false);
    await p.processBlock(tradeBlocks[0]!, { live: true, notify: false });
    for (const b of tradeBlocks.slice(1)) await p.processBlock(b, { live: true, notify: false });
    expect(p.book.get(CURVE)?.reserves).toEqual({ quote: 1_680_000_000_000_000_003n, token: 10n ** 27n });
    expect(store.trades.size).toBe(9);
  });
});

export type { Hex };
