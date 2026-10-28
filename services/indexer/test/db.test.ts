import { describe, expect, it } from 'vitest';
import { LogBackfill } from '../src/backfill-core.js';
import { fundingPath, incomingTransfers, siblingsOf } from '../src/funding.js';
import { silentLog } from '../src/log.js';
import { MemoryStore } from '../src/memory-store.js';
import { PgStore } from '../src/pg-store.js';
import { BlockPipeline } from '../src/pipeline.js';
import { TRANSFERS_CHANNEL, emptyBatch } from '../src/store.js';
import type { Address, Hex, TransferRow, WalletRow } from '../src/types.js';
import { curveLogsFixture } from './helpers/fixtures.js';
import { h32, mkBlock, mkReceipt, mkTx } from './helpers/blocks.js';
import { transferLog } from './helpers/logs.js';
import { pgliteSql } from './helpers/pglite-sql.js';
import { CURVE, FRESH, FUNDER, LAUNCH_BLOCK, LAUNCH_TS, TOKEN, addTradeBlocks, chainWithLaunch, tsOf } from './helpers/scenario.js';

async function indexScenario(store: PgStore | MemoryStore) {
  const chain = chainWithLaunch();
  const blocks = addTradeBlocks(chain, curveLogsFixture(), tsOf);
  const p = new BlockPipeline(chain, store, silentLog, { traceInternal: true, startBlock: LAUNCH_BLOCK });
  await p.init();
  for (const b of [LAUNCH_BLOCK, ...blocks]) await p.processBlock(b, { live: true, notify: true });
  return { chain, blocks, p };
}

describe('PgStore round trip on PGlite (packages/db migration)', () => {
  it('writes every table, reads the curve back identically, checkpoints and notifies', async () => {
    const { sql, db, source } = await pgliteSql();
    expect(['packages/db', 'stub']).toContain(source);
    const store = new PgStore(sql);
    const notes: string[] = [];
    await db.listen(TRANSFERS_CHANNEL, (p) => notes.push(p));
    const { p, blocks } = await indexScenario(store);

    const [launch] = await sql.query<{ name: string; exemptions: string[]; launch_kind: string; start_mcap_eth: number; dev_buy_quote: string }>(
      `select name, exemptions, launch_kind, start_mcap_eth, dev_buy_quote::text as dev_buy_quote from launches where token = $1`,
      [TOKEN],
    );
    expect(launch).toEqual({
      name: 'SHIBA INU',
      exemptions: ['0x44e58c19c5d979ad4457075855acd88b93f5a49b', '0x81eb508048220493549302d8ea5ef73a3fde1784'],
      launch_kind: 'launchToken',
      start_mcap_eth: 1.68,
      dev_buy_quote: '0',
    });
    const counts = await sql.query<{ t: string; n: number }>(
      `select 'trades' t, count(*)::int n from curve_trades union all select 'eth', count(*)::int from eth_transfers
       union all select 'tok', count(*)::int from token_transfers union all select 'wallets', count(*)::int from wallets
       union all select 'metrics', count(*)::int from token_metrics`,
    );
    expect(Object.fromEntries(counts.map((c) => [c.t, c.n]))).toEqual({ trades: 9, eth: 5, tok: 1, wallets: 5, metrics: 1 });
    const [w] = await sql.query<{ first_funder: string; tx_count_at_first_funding: number; is_contract: boolean }>(
      `select first_funder, tx_count_at_first_funding, is_contract from wallets where address = $1`,
      [FRESH],
    );
    expect(w).toEqual({ first_funder: FUNDER, tx_count_at_first_funding: 0, is_contract: false });

    // the stored curve reloads to exactly the in-memory state
    const stored = await store.loadCurve(CURVE);
    const mem = p.book.get(CURVE)!;
    expect(stored?.trades).toEqual(mem.trades);
    expect(stored?.launch).toEqual(mem.launch);
    expect(await store.getCheckpoint()).toEqual({ block: blocks.at(-1)!, hash: h32(blocks.at(-1)!) });
    expect(await store.knownWallets([FRESH, '0x0000000000000000000000000000000000000001' as Address])).toEqual(new Set([FRESH]));
    await new Promise((r) => setTimeout(r, 20));
    expect(notes).toEqual([String(LAUNCH_BLOCK)]);

    // idempotent re-write of the same batch
    const again = new BlockPipeline(chainWithLaunch(), store, silentLog, {});
    await again.processBlock(LAUNCH_BLOCK, { live: false, notify: false });
    const [{ n }] = (await sql.query<{ n: number }>(`select count(*)::int n from eth_transfers`)) as [{ n: number }];
    expect(n).toBe(5);

    // rollback deletes rows at/after the block and reports stale tokens
    const stale = await store.rollbackFrom(blocks[1]!);
    expect(stale).toEqual([TOKEN]);
    const [{ n: left }] = (await sql.query<{ n: number }>(`select count(*)::int n from curve_trades`)) as [{ n: number }];
    expect(left).toBe(3);
    expect(await store.getCheckpoint()).toBeNull();
    await sql.end();
  });

  it('stores dump_wallets / operator_sell_eth when the migration has them', async () => {
    const { sql } = await pgliteSql(
      `alter table token_metrics add column if not exists dump_wallets text[] default '{}';
       alter table token_metrics add column if not exists operator_sell_eth double precision;`,
    );
    const store = new PgStore(sql);
    const b = emptyBatch();
    b.metrics.push({
      token: TOKEN, firstTaxedBuyer: null, firstTaxedTs: 1_800_000_001, firstTaxedBlock: null, firstTaxedPrice: null,
      firstTaxedMcapEth: null, taxFreeBuyCount: 2, taxFreeQuote: 380_186_069_901_936_130n, athPrice: 1e-8, athTs: null,
      athMcapEth: 10, peak2Pct: 43.9, peak5Pct: null, peak10Pct: null, peak30Pct: null, peak60Pct: null, mcap2: null,
      mcap5: null, mcap10: null, mcap30: null, mcap60: null, lowAfterEntryPct: null, nBuys60s: 1, nSells60s: 0,
      exemptSoldWithinSec: 6, dumpWallets: ['0xa98da960d6bbd1dcbbae5435ada744009adcea35'], operatorSellEth: 1.31,
    });
    await store.writeBatch(b);
    const [m] = await sql.query<Record<string, unknown>>(
      `select dump_wallets, operator_sell_eth, tax_free_quote::text as q, extract(epoch from first_taxed_ts)::float8 as ts from token_metrics`,
    );
    expect(m).toEqual({ dump_wallets: ['0xa98da960d6bbd1dcbbae5435ada744009adcea35'], operator_sell_eth: 1.31, q: '380186069901936130', ts: 1_800_000_001 });
    await sql.end();
  });
});

describe('funding graph (fundingPath / siblingsOf) on PGlite', () => {
  const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
  const tx = (n: number) => h32(n) as Hex;
  const ROOT = a(0xf0), F = a(0xf1), C = a(0xc0), D = a(0xd0), X = a(0xee);
  const W = a(0x101), W2 = a(0x102), W3 = a(0x103), W4 = a(0x104), W5 = a(0x105);
  const E = 10n ** 15n;
  const tr = (block: number, txN: number, traceAddr: string, from: Address, to: Address, value: bigint, kind: TransferRow['kind']): TransferRow =>
    ({ block, ts: 1_000 + block, txHash: tx(txN), traceAddr, from, to, value, kind });
  const transfers: TransferRow[] = [
    tr(1, 1, '', ROOT, F, 1000n * E, 'tx'),
    tr(2, 2, '', F, W, 12n * E, 'tx'), // direct
    tr(3, 3, '', F, C, 0n, 'create'), // sprayer contract
    tr(4, 4, '', F, C, 50n * E, 'tx'),
    tr(5, 5, '0', C, W2, 12n * E, 'internal'), // contract mode
    tr(5, 5, '1', C, W3, 13n * E, 'internal'),
    tr(6, 6, '', F, D, 30n * E, 'tx'), // public disperse contract, same tx
    tr(6, 6, '0', D, W4, 15n * E, 'internal'),
    tr(6, 6, '1', D, W5, 15n * E, 'internal'),
    tr(7, 7, '', X, W2, 1n * E, 'tx'), // later, unrelated top-up
  ];
  const wallets: WalletRow[] = [W, W2, W3, W4, W5].map((w, i) => ({
    address: w, firstSeenBlock: 2, firstSeenTs: 1002, firstFunder: F, firstFundingValue: 1n,
    firstFundingTx: w === W ? tx(2) : w === W2 || w === W3 ? tx(5) : tx(6), isContract: false, txCountAtFirstFunding: i === 4 ? 3 : 0,
  }));
  wallets.push({ address: D, firstSeenBlock: 6, firstSeenTs: 1006, firstFunder: F, firstFundingValue: 30n * E, firstFundingTx: tx(6), isContract: true, txCountAtFirstFunding: null });

  async function seeded() {
    const { sql } = await pgliteSql();
    const store = new PgStore(sql);
    await store.writeBatch({ ...emptyBatch(), transfers, wallets });
    return sql;
  }

  it('follows first fundings through internal and create hops', async () => {
    const sql = await seeded();
    const path = await fundingPath(sql, W2, 5);
    expect(path.map((h) => [h.depth, h.wallet, h.funder, h.kind, h.value])).toEqual([
      [1, W2, C, 'internal', 12n * E],
      [2, C, F, 'create', 0n],
      [3, F, ROOT, 'tx', 1000n * E],
    ]);
    expect(await fundingPath(sql, W2, 1)).toHaveLength(1);
    expect(await incomingTransfers(sql, W2)).toHaveLength(2);
    await sql.end();
  });

  it('lists siblings funded directly, via a created contract, and via a same-tx disperse', async () => {
    const sql = await seeded();
    const sibs = await siblingsOf(sql, F, 0);
    expect(sibs.map((s) => [s.wallet, s.via, s.from, s.fresh])).toEqual([
      [W, 'direct', F, true],
      [W2, 'contract', C, true],
      [W3, 'contract', C, true],
      [W4, 'sameTx', D, true],
      [W5, 'sameTx', D, false],
    ]);
    expect((await siblingsOf(sql, F, 1_006)).map((s) => s.wallet)).toEqual([W4, W5]);
    expect((await siblingsOf(sql, F, new Date(1_005_000))).map((s) => s.wallet)).toEqual([W2, W3, W4, W5]);
    await sql.end();
  });
});

describe('LogBackfill (eth_getLogs ranges -> same processing path)', () => {
  function chainWithDump() {
    const chain = chainWithLaunch();
    const blocks = addTradeBlocks(chain, curveLogsFixture(), tsOf);
    const FEE_RECIPIENT = '0x44e58c19c5d979ad4457075855acd88b93f5a49b';
    const DUMP = '0x000000000000000000000000000000000000d00d';
    const t = mkTx(h32('d2'), FEE_RECIPIENT, TOKEN, 0n);
    const n = LAUNCH_BLOCK + 50;
    chain.addBlock(mkBlock(n, LAUNCH_TS + 5, [t]), [mkReceipt(t, [transferLog(TOKEN, { block: n, tx: t.hash, logIndex: 0 }, FEE_RECIPIENT, DUMP, 10n ** 24n)])]);
    return { chain, last: blocks.at(-1)! };
  }

  it('backfills launches, trades, token transfers and metrics in chunks, idempotently', async () => {
    const { chain, last } = chainWithDump();
    const { sql } = await pgliteSql();
    const store = new PgStore(sql);
    const opts = { from: LAUNCH_BLOCK, to: last, chunk: 100, tokenTransfers: true, tokenWindowSec: 86_400, addressBatch: 100 };
    const bf = new LogBackfill(chain, store, new BlockPipeline(chain, store, silentLog, {}), silentLog, opts);
    const stats = await bf.run();
    expect(stats).toMatchObject({ launches: 1, trades: 9, tokenTransfers: 2, chunks: Math.ceil((last - LAUNCH_BLOCK + 1) / 100) });
    const [m] = await sql.query<{ exempt_sold_within_sec: number; first_taxed_buyer: string }>(`select exempt_sold_within_sec, first_taxed_buyer from token_metrics`);
    expect(m).toEqual({ exempt_sold_within_sec: 5, first_taxed_buyer: '0xb81db28acaade5d04c2c14be798c15844166edda' });
    const prices = await sql.query<{ price_after: number }>(`select price_after from curve_trades order by block, log_index`);
    expect(prices.at(-1)!.price_after).toBeCloseTo(1.68e-9, 15);

    // second run over the same range adds nothing
    const bf2 = new LogBackfill(chain, store, new BlockPipeline(chain, store, silentLog, {}), silentLog, opts);
    const s2 = await bf2.run();
    expect(s2).toMatchObject({ launches: 0, trades: 0 });
    const [{ n }] = (await sql.query<{ n: number }>(`select count(*)::int n from curve_trades`)) as [{ n: number }];
    expect(n).toBe(9);
    await sql.end();
  });
});
