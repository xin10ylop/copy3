import { describe, expect, it } from 'vitest';
import { LogBackfill } from '../src/backfill-core.js';
import type { BlockTag } from '../src/chain.js';
import { LogFollower, type LogFollowerConfig } from '../src/log-follower.js';
import { silentLog } from '../src/log.js';
import { MemoryStore } from '../src/memory-store.js';
import { BlockPipeline } from '../src/pipeline.js';
import type { Address, Hex, RpcBlock, RpcLog } from '../src/types.js';
import { h32, mkBlock, mkReceipt, mkTx } from './helpers/blocks.js';
import { FakeChain } from './helpers/fake-chain.js';
import { START_RESERVES, curveLogsFixture } from './helpers/fixtures.js';
import { curveBuyLog, tokenLaunchedLog, transferLog } from './helpers/logs.js';
import { CURVE, FACTORY, LAUNCH_BLOCK, TOKEN, addTradeBlocks, chainWithLaunch, tsOf } from './helpers/scenario.js';

const TOKEN2 = '0x0000000000000000000000000000000000002222' as Address;
const CURVE2 = '0x0000000000000000000000000000000000003333' as Address;
const DEPLOYER2 = '0x0000000000000000000000000000000000004444' as Address;
const BUYER2 = '0x0000000000000000000000000000000000005555' as Address;
const DUMP = '0x000000000000000000000000000000000000d00d' as Address;
const FEE_RECIPIENT = '0x44e58c19c5d979ad4457075855acd88b93f5a49b' as Address;
const ROUTER = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc';
const END = LAUNCH_BLOCK + 400;

/** FakeChain whose head moves `step` blocks per eth_getBlockByNumber('latest') (one per head poll). */
class TickingChain extends FakeChain {
  end = 0;
  step = 0;
  override getBlock(n: BlockTag, full: true): Promise<RpcBlock | null>;
  override getBlock(n: BlockTag, full: false): Promise<RpcBlock<Hex> | null>;
  override getBlock(n: BlockTag, full: boolean): Promise<RpcBlock | RpcBlock<Hex> | null> {
    if (n === 'latest' && this.step > 0) this.head = Math.min(this.end, this.head + this.step);
    return full ? super.getBlock(n, true) : super.getBlock(n, false);
  }
}

/**
 * LAUNCH_BLOCK .. END (401 blocks): the real SHIB launch + its 9 trades (+245/+309/+329),
 * a second launch at +200 with a buy at +250, and ERC-20 transfers of both tokens in blocks
 * that have no Pons logs (+300, +320). Every other block is empty.
 */
function scenario<C extends FakeChain>(chain: C, from = LAUNCH_BLOCK, to = END): C {
  const base = chainWithLaunch();
  for (const [n, b] of base.blocks) chain.addBlock(b, base.receipts.get(n)!);
  for (const [k, v] of base.startReserves) chain.startReserves.set(k, v);
  for (const [k, v] of base.code) chain.code.set(k, v);
  addTradeBlocks(chain, curveLogsFixture(), tsOf);

  const add = (n: number, from: string, to: string, logs: (n: number, tx: Hex) => RpcLog[]) => {
    const tx = mkTx(h32(`a${n}`), from, to, 0n);
    chain.addBlock(mkBlock(n, tsOf(n), [tx]), [mkReceipt(tx, logs(n, tx.hash))]);
  };
  add(LAUNCH_BLOCK + 200, DEPLOYER2, FACTORY, (n, tx) => [
    tokenLaunchedLog(FACTORY, { block: n, tx, logIndex: 0 }, { token: TOKEN2, curve: CURVE2, deployer: DEPLOYER2 }),
    transferLog(TOKEN2, { block: n, tx, logIndex: 1 }, '0x0000000000000000000000000000000000000000', CURVE2, 10n ** 27n),
  ]);
  chain.startReserves.set(CURVE2, START_RESERVES);
  add(LAUNCH_BLOCK + 250, BUYER2, ROUTER, (n, tx) => [
    curveBuyLog(CURVE2, { block: n, tx, logIndex: 0 }, { buyer: BUYER2, recipient: BUYER2, quoteIn: 10n ** 17n, tokensOut: 50_000_000n * 10n ** 18n, fee: 10n ** 15n, tax: 0n }),
  ]);
  add(LAUNCH_BLOCK + 300, FEE_RECIPIENT, TOKEN, (n, tx) => [transferLog(TOKEN, { block: n, tx, logIndex: 0 }, FEE_RECIPIENT, DUMP, 10n ** 24n)]);
  add(LAUNCH_BLOCK + 320, BUYER2, TOKEN2, (n, tx) => [transferLog(TOKEN2, { block: n, tx, logIndex: 0 }, BUYER2, DUMP, 10n ** 20n)]);

  for (let n = from; n <= to; n++) if (!chain.blocks.has(n)) chain.addBlock(mkBlock(n, tsOf(n), []), []);
  return chain;
}

const PONS_EVENT_BLOCKS = 6; // launch, +200, +245, +250, +309, +329

const FAST: Partial<LogFollowerConfig> = { pollMs: 1, intervalMs: 5, headStaleMs: 1 };

async function runUntil(f: LogFollower, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const ac = new AbortController();
  const running = f.run(ac.signal);
  const t0 = Date.now();
  while (!done()) {
    if (Date.now() - t0 > timeoutMs) {
      ac.abort();
      await running;
      throw new Error('timeout');
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  ac.abort();
  await running;
}

const strip = <T extends object>(m: Map<unknown, T>) => [...m.values()].map((v) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as unknown);

describe('LogFollower (INDEXER_MODE=logs)', () => {
  it('follows the head in ~10-block ranges: same rows as block mode, ~2 getLogs per range, no receipts/traces', async () => {
    const chain = scenario(new TickingChain());
    chain.end = END;
    chain.step = 10; // ~1 s of Robinhood Chain per head poll
    chain.head = LAUNCH_BLOCK - 1;
    const store = new MemoryStore();
    const pipeline = new BlockPipeline(chain, store, silentLog, { startBlock: LAUNCH_BLOCK, traceInternal: true });
    await pipeline.init();
    const f = new LogFollower(chain, store, pipeline, silentLog, { ...FAST, minBlocks: 10 });
    await runUntil(f, () => pipeline.stats.next > END);

    // reference: the full per-block pipeline over the same blocks
    const refChain = scenario(new FakeChain());
    const ref = new MemoryStore();
    const refPipeline = new BlockPipeline(refChain, ref, silentLog, {});
    for (let n = LAUNCH_BLOCK; n <= END; n++) await refPipeline.processBlock(n, { live: false, notify: false });

    expect(store.launches.size).toBe(2);
    expect(store.trades.size).toBe(10);
    expect(store.tokenTransfers.size).toBe(4); // 2 mints + 2 transfers out
    expect(strip(store.launches)).toEqual(strip(ref.launches));
    expect(strip(store.trades)).toEqual(strip(ref.trades));
    expect(strip(store.tokenTransfers)).toEqual(strip(ref.tokenTransfers));
    expect(strip(store.metrics)).toEqual(strip(ref.metrics));
    expect(store.metrics.get(TOKEN)).toMatchObject({ dumpWallets: [DUMP] });
    expect(pipeline.book.get(CURVE)?.reserves).toEqual(refPipeline.book.get(CURVE)?.reserves);
    // logs mode writes no ETH transfers / wallets and therefore never NOTIFYs transfers_block
    expect(store.transfers.size).toBe(0);
    expect(store.wallets.size).toBe(0);
    expect(store.notifications).toEqual([]);

    expect(store.checkpoint).toEqual({ block: END, hash: h32(END) });
    const s = pipeline.stats;
    expect(s.head - (s.lastBlock ?? s.next - 1)).toBe(0);
    expect(s.processed).toBe(END - LAUNCH_BLOCK + 1);

    const blocks = END - LAUNCH_BLOCK + 1;
    const getLogs = chain.count('getLogs');
    const headPolls = chain.calls.filter((c) => c === 'getBlock:latest').length;
    const headers = chain.count('getBlockHeader') - headPolls;
    console.info(
      `logs mode, ${blocks} blocks: ranges=${f.stats.ranges} getLogs=${getLogs} getBlock(full)=${chain.count('getBlockFull')} ` +
        `headers=${headers} headPolls=${headPolls} receipts=${chain.count('getBlockReceipts')} traces=${chain.count('traceTransaction')} ` +
        `| block mode: getBlock(full)=${refChain.count('getBlockFull')} receipts=${refChain.count('getBlockReceipts')}`,
    );
    expect(chain.count('getBlockReceipts')).toBe(0);
    expect(chain.count('traceTransaction')).toBe(0);
    expect(chain.count('getTransactionCount')).toBe(0);
    expect(chain.count('getBlockFull')).toBe(PONS_EVENT_BLOCKS);
    // one Pons getLogs + one Transfer getLogs (both tokens fit one address batch) per range
    expect(f.stats.ranges).toBeLessThanOrEqual(Math.ceil(blocks / 10) + 1);
    expect(getLogs).toBe(2 * f.stats.ranges);
    expect(getLogs).toBeLessThan(blocks / 4);
    // checkpoint headers come from the head polls (or newHeads); only the two blocks that have
    // token transfers but no Pons logs (+300, +320) need a header for their timestamp
    expect(headers).toBe(2);
    // block mode: two calls per block
    expect(refChain.count('getBlockFull')).toBe(blocks);
    expect(refChain.count('getBlockReceipts')).toBe(blocks);
  });

  it('catches up from a checkpoint far behind in ranges of <= chunkBlocks, covering every block exactly once', async () => {
    const S = LAUNCH_BLOCK - 7_000;
    const chain = scenario(new FakeChain(), S, END);
    expect(chain.head).toBe(END);
    const store = new MemoryStore();
    store.checkpoint = { block: S - 1, hash: h32(S - 1) };
    const pipeline = new BlockPipeline(chain, store, silentLog, {});
    await pipeline.init();
    expect(pipeline.stats.next).toBe(S);
    const f = new LogFollower(chain, store, pipeline, silentLog, { ...FAST, chunkBlocks: 2000 });
    const ranges: { from: number; to: number }[] = [];
    const orig = f.processRange.bind(f);
    f.processRange = async (r) => {
      ranges.push(r);
      return orig(r);
    };
    await runUntil(f, () => pipeline.stats.next > END);

    expect(ranges.length).toBe(Math.ceil((END - S + 1) / 2000));
    expect(ranges[0]!.from).toBe(S);
    expect(ranges.at(-1)!.to).toBe(END);
    for (const [i, r] of ranges.entries()) {
      expect(r.to - r.from + 1).toBeLessThanOrEqual(2000);
      if (i > 0) expect(r.from).toBe(ranges[i - 1]!.to + 1);
    }
    // the Pons getLogs calls (no address filter) are exactly these ranges
    expect(chain.logRanges.filter((l) => !l.address).map(({ from, to }) => ({ from, to }))).toEqual(ranges);
    expect(store.checkpoint).toEqual({ block: END, hash: h32(END) });
    expect(store.launches.size).toBe(2);
    expect(store.trades.size).toBe(10);
    expect(store.tokenTransfers.size).toBe(4);
    expect(chain.count('getBlockReceipts')).toBe(0);
    console.info(`catch-up, ${END - S + 1} blocks: ranges=${ranges.length} getLogs=${chain.count('getLogs')} getBlock(full)=${chain.count('getBlockFull')} headers=${chain.count('getBlockHeader')}`);
  });

  it('retries a range when getLogs returns fewer Pons logs than the logs subscription saw', async () => {
    const chain = scenario(new FakeChain());
    const tradeBlock = LAUNCH_BLOCK + 250;
    const realGetLogs = chain.getLogs.bind(chain);
    let lagging = true;
    chain.getLogs = async (filter) => {
      const out = await realGetLogs(filter);
      // a lagging backend: "no logs" for the newest block instead of an error, once
      if (lagging && !filter.address && filter.toBlock >= tradeBlock) {
        lagging = false;
        return out.filter((l) => Number(l.blockNumber) !== tradeBlock);
      }
      return out;
    };
    const store = new MemoryStore();
    const pipeline = new BlockPipeline(chain, store, silentLog, { startBlock: LAUNCH_BLOCK });
    await pipeline.init();
    const f = new LogFollower(chain, store, pipeline, silentLog, FAST);
    const subLog = chain.receipts.get(tradeBlock)![0]!.logs[0]!;
    f.onLog(subLog);
    await runUntil(f, () => pipeline.stats.next > END);
    expect(f.stats.logMismatches).toBe(1);
    expect(pipeline.stats.errors).toBe(1);
    expect(store.trades.size).toBe(10);
    expect([...store.trades.values()].some((t) => t.block === tradeBlock)).toBe(true);
  });

  it('rolls back and re-indexes when the subscription delivers a removed log for an indexed block', async () => {
    const chain = scenario(new FakeChain());
    const store = new MemoryStore();
    const pipeline = new BlockPipeline(chain, store, silentLog, { startBlock: LAUNCH_BLOCK });
    await pipeline.init();
    const f = new LogFollower(chain, store, pipeline, silentLog, FAST);
    await runUntil(f, () => pipeline.stats.next > END);
    const before = { trades: strip(store.trades), metrics: strip(store.metrics) };

    const removed = { ...chain.receipts.get(LAUNCH_BLOCK + 309)![0]!.logs[0]!, removed: true };
    const rollbackFrom = LAUNCH_BLOCK + 309 - 10;
    const deleted: number[] = [];
    const orig = store.rollbackFrom.bind(store);
    store.rollbackFrom = async (b) => {
      deleted.push(b);
      return orig(b);
    };
    f.onLog(removed);
    await runUntil(f, () => f.stats.rollbacks === 1 && pipeline.stats.next > END);
    expect(deleted).toEqual([rollbackFrom]);
    expect(pipeline.stats.reorgs).toBe(1);
    expect(f.stats.lastRange).toEqual({ from: rollbackFrom, to: END });
    expect(strip(store.trades)).toEqual(before.trades);
    expect(strip(store.metrics)).toEqual(before.metrics);
    expect(store.checkpoint).toEqual({ block: END, hash: h32(END) });
  });
});

describe('LogBackfill (shared range path)', () => {
  it('indexes the same rows through processLogRange and leaves the checkpoint alone', async () => {
    const chain = scenario(new FakeChain());
    const store = new MemoryStore();
    const pipeline = new BlockPipeline(chain, store, silentLog, {});
    const bf = new LogBackfill(chain, store, pipeline, silentLog, {
      from: LAUNCH_BLOCK,
      to: END,
      chunk: 150,
      tokenTransfers: true,
      tokenWindowSec: 86_400,
      addressBatch: 100,
    });
    const stats = await bf.run();
    expect(stats).toMatchObject({ chunks: 3, launches: 2, trades: 10, tokenTransfers: 4 });
    expect(store.checkpoint).toBeNull();
    expect(chain.count('getBlockReceipts')).toBe(0);
  });
});

describe('indexer env', () => {
  const base = { NODE_HTTP: 'http://127.0.0.1:8547', DATABASE_URL: 'postgres://x' };
  it('defaults to blocks mode with newHeads; logs mode settings parse', async () => {
    const { parseIndexerEnv } = await import('../src/env.js');
    expect(parseIndexerEnv(base)).toMatchObject({ INDEXER_MODE: 'blocks', WS_NEW_HEADS: true, LOGS_CHUNK_BLOCKS: 2000, LOGS_INTERVAL_MS: 1000 });
    expect(parseIndexerEnv({ ...base, INDEXER_MODE: 'logs', WS_NEW_HEADS: '0', LOGS_TOKEN_WINDOW_HOURS: '6' })).toMatchObject({
      INDEXER_MODE: 'logs',
      WS_NEW_HEADS: false,
      LOGS_TOKEN_WINDOW_HOURS: 6,
    });
    expect(() => parseIndexerEnv({ ...base, INDEXER_MODE: 'receipts' })).toThrow(/INDEXER_MODE/);
    expect(() => parseIndexerEnv({ ...base, LOGS_CHUNK_BLOCKS: '50000' })).toThrow(/LOGS_CHUNK_BLOCKS/);
  });
});
