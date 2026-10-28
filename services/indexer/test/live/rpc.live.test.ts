/**
 * Network tests against the public Robinhood Chain RPC (rate limited, non-archive).
 * Run with: LIVE=1 pnpm --filter @hood/indexer test test/live
 */
import { describe, expect, it } from 'vitest';
import { LogBackfill } from '../../src/backfill-core.js';
import { Chain } from '../../src/chain.js';
import { silentLog } from '../../src/log.js';
import { MemoryStore } from '../../src/memory-store.js';
import { BlockPipeline } from '../../src/pipeline.js';
import { HttpRpc } from '../../src/rpc.js';
import type { Address } from '../../src/types.js';

const LIVE = process.env.LIVE === '1';
const RPC = process.env.NODE_HTTP ?? 'https://rpc.mainnet.chain.robinhood.com';
const LAUNCH_BLOCK = 100_299_817;
const TOKEN = '0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d' as Address;
const CURVE = '0xd30a935fddef5f5855519874ee2f4e7a7ea36821' as Address;

describe.skipIf(!LIVE)('live: public RPC', () => {
  const chain = new Chain(new HttpRpc(RPC, { minIntervalMs: 200, maxRetries: 10 }));

  it('reads start reserves and curve info of the fixture curve', async () => {
    expect(await chain.curveStartReserves(CURVE)).toEqual({ quote: 1_680_000_000_000_000_000n, token: 10n ** 27n });
    expect(await chain.curveInfo(CURVE)).toEqual({ token: TOKEN, launchedAt: 1_793_214_021 });
    expect(await chain.curveInfo(TOKEN)).toBeNull(); // a token is not a Pons curve
  }, 60_000);

  it('indexes the real launch block (receipts, transfers, launch row)', async () => {
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, { traceInternal: false });
    const out = await p.processBlock(LAUNCH_BLOCK, { live: false, notify: false });
    expect(out).toMatchObject({ status: 'ok', launches: 1 });
    expect(store.launches.get(TOKEN)).toMatchObject({ name: 'SHIBA INU', symbol: 'SHIB', startMcapEth: 1.68 });
    expect([...store.transfers.values()].some((t) => t.kind === 'tx' && t.to === '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e')).toBe(true);
  }, 120_000);

  it('log-backfills the curve and ends at the live reserves', async () => {
    const store = new MemoryStore();
    const p = new BlockPipeline(chain, store, silentLog, {});
    const bf = new LogBackfill(chain, store, p, silentLog, {
      from: LAUNCH_BLOCK,
      to: LAUNCH_BLOCK + 400,
      chunk: 20_000,
      tokenTransfers: true,
      tokenWindowSec: 86_400,
      addressBatch: 100,
    });
    const stats = await bf.run();
    expect(stats.launches).toBeGreaterThanOrEqual(1);
    const trades = [...store.trades.values()].filter((t) => t.token === TOKEN);
    expect(trades).toHaveLength(9);
    expect(p.book.get(CURVE)?.reserves).toEqual(await chain.curveReserves(CURVE, 'latest'));
    expect([...store.tokenTransfers.values()].filter((t) => t.token === TOKEN).length).toBeGreaterThanOrEqual(10);
    expect(store.metrics.get(TOKEN)?.nBuys60s).toBe(3);
  }, 600_000);
});
