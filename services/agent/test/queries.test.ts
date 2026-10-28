import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activePlays,
  csvSources,
  exemptFlow,
  fundingPath,
  getEthUsdSetting,
  getToken,
  getTokenMetricsRaw,
  getTrades,
  insertAgentRun,
  finishAgentRun,
  insertProposedPlay,
  launchContexts,
  loadBacktestItems,
  recentLaunches,
  runners,
  siblingsFundedBy,
  tokenTransfers,
  tokensByDeployer,
  tokensByName,
  transfers,
  triggerCandidates,
  walletSummary,
  walletTrades,
} from '../src/queries.js';
import { matchTrigger } from '../src/trigger.js';
import { backtestPlay } from '../src/backtest.js';
import { createTestDb, type TestDb } from './helpers/pg.js';
import { A, T, seedOperator } from './helpers/seed.js';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seedOperator(db.pg);
});
afterAll(async () => {
  await db.pg.close();
});

describe('tokens', () => {
  it('get_token joins launch and metrics with ETH units and unix timestamps', async () => {
    const t = (await getToken(db.sql, A.TOKEN1))!;
    expect(t.name).toBe('Amlil');
    expect(t.deployer).toBe(A.DEV1);
    expect(t.ts).toBe(T);
    expect(t.exemptions).toEqual([A.DEV1, A.TEAM1, A.TEAM2]);
    expect(t.creatorTaxBps).toBe(200);
    expect(t.metrics!.peak5Pct).toBe(222);
    expect(t.metrics!.firstTaxedBuyer).toBe(A.FIRST_TAXED);
    expect(t.metrics!.taxFreeQuoteEth).toBeCloseTo(0.38, 6);
    expect(await getToken(db.sql, A.EXCHANGE)).toBeNull();
    const raw = (await getTokenMetricsRaw(db.sql, A.TOKEN1))!;
    expect(raw['peak30_pct']).toBe(377);
  });

  it('lists by deployer, by name regex (finds decoys) and recent launches with pagination', async () => {
    expect((await tokensByDeployer(db.sql, A.SPAM)).rows.map((r) => r.token).sort()).toEqual([A.DECOY1, A.DECOY2].sort());
    const byName = await tokensByName(db.sql, '^amlil');
    expect(byName.rows).toHaveLength(4);
    const p1 = await recentLaunches(db.sql, { sinceTs: T - 10 * 86_400, limit: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextOffset).toBe(2);
    const p2 = await recentLaunches(db.sql, { sinceTs: T - 10 * 86_400, limit: 2, offset: 2 });
    expect(p2.nextOffset).toBeNull();
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.token)).size).toBe(4);
  });

  it('list_runners filters on the chosen peak window and carries the funding fingerprint', async () => {
    const r = await runners(db.sql, { sinceTs: T - 10 * 86_400, minPeakPct: 200, window: 10 });
    expect(r.rows.map((x) => x.token).sort()).toEqual([A.TOKEN1, A.TOKEN2].sort());
    const t1 = r.rows.find((x) => x.token === A.TOKEN1)!;
    expect(t1.deployerFunder).toBe(A.DISPERSE);
    expect(t1.funderIsContract).toBe(true);
    expect(t1.funderCreator).toBe(A.FUNDER);
    expect(t1.deployerFresh).toBe(true);
    expect(t1.deployerFundingEth).toBeCloseTo(0.012, 9);
    const t2 = r.rows.find((x) => x.token === A.TOKEN2)!;
    expect(t2.deployerFunder).toBe(A.FUNDER);
    expect((await runners(db.sql, { sinceTs: T - 10 * 86_400, minPeakPct: 300, window: 2 })).rows).toHaveLength(0);
  });
});

describe('trades', () => {
  it('get_trades returns a window in seconds since launch with snipe tax split from creator tax', async () => {
    const r = await getTrades(db.sql, A.TOKEN1, { fromSec: 0, toSec: 1 });
    expect(r.rows).toHaveLength(3);
    const taxed = r.rows.find((x) => x.snipeTaxEth > 0)!;
    expect(taxed.secondsSinceLaunch).toBe(1);
    expect(taxed.snipeTaxEth / taxed.quoteEth).toBeCloseTo(0.0618, 6);
    expect(taxed.creatorTaxEth / taxed.quoteEth).toBeCloseTo(0.02, 6);
    expect(r.rows.filter((x) => x.exempt)).toHaveLength(2);
  });

  it('get_wallet_trades aggregates PnL per token including the snipe tax paid', async () => {
    const r = await walletTrades(db.sql, A.FIRST_TAXED);
    expect(r.rows).toHaveLength(2);
    const t1 = r.rows.find((x) => x.token === A.TOKEN1)!;
    expect(t1.ethIn).toBeCloseTo(0.035 * 1.0618, 9);
    expect(t1.ethOut).toBeCloseTo(0.09, 9);
    expect(t1.pnlEth).toBeCloseTo(0.09 - 0.035 * 1.0618, 9);
    expect(t1.firstBuySecondsSinceLaunch).toBe(1);
  });
});

describe('wallets and funding', () => {
  it('get_wallet summarises a wallet', async () => {
    const w = await walletSummary(db.sql, A.DISPERSE);
    expect(w.known).toBe(true);
    expect(w.isContract).toBe(true);
    expect(w.createdBy).toBe(A.FUNDER);
    expect(w.nOutgoing).toBe(3);
    const unknown = await walletSummary(db.sql, A.TREASURY);
    expect(unknown.known).toBe(false);
    expect(unknown.ethIn).toBeCloseTo(1.7, 9);
  });

  it('funding path walks first fundings through the disperse contract to the exchange', async () => {
    const path = await fundingPath(db.sql, A.DEV1, 5);
    expect(path.map((h) => h.address)).toEqual([A.DEV1, A.DISPERSE, A.FUNDER, A.EXCHANGE]);
    expect(path[0]).toMatchObject({ funder: A.DISPERSE, kind: 'internal', fresh: true });
    expect(path[0]!.valueEth).toBeCloseTo(0.012, 9);
    expect(path[1]).toMatchObject({ funder: A.FUNDER, kind: 'create', isContract: true, createdBy: A.FUNDER });
    expect(path[3]!.funder).toBeNull();
    expect(await fundingPath(db.sql, A.DEV1, 2)).toHaveLength(2);
  });

  it('incoming / outgoing transfers paginate and filter by value', async () => {
    const out = await transfers(db.sql, A.FUNDER, 'out');
    expect(out.rows.map((r) => r.to).sort()).toEqual([A.DEV2, A.DISPERSE].sort());
    const big = await transfers(db.sql, A.FUNDER, 'out', { minEth: 0.04 });
    expect(big.rows.map((r) => r.to)).toEqual([A.DISPERSE]);
    const inc = await transfers(db.sql, A.DEV2, 'in');
    expect(inc.rows[0]).toMatchObject({ from: A.FUNDER, kind: 'tx', counterpartyIsContract: false });
  });

  it('siblings include children funded through contracts the funder created', async () => {
    const s = await siblingsFundedBy(db.sql, A.FUNDER);
    const byWallet = new Map(s.rows.map((r) => [r.wallet, r]));
    expect(byWallet.get(A.DEV1)).toMatchObject({ via: A.DISPERSE, viaContract: true, tokensDeployed: 1, tokenNames: ['Amlil'] });
    expect(byWallet.get(A.DEV2)).toMatchObject({ via: A.FUNDER, viaContract: false, tokenNames: ['Amlil 2'] });
    expect(byWallet.get(A.TEAM1)!.valueEth).toBeCloseTo(0.0004, 9);
    const ranged = await siblingsFundedBy(db.sql, A.FUNDER, { minEth: 0.01, maxEth: 0.015 });
    expect(ranged.rows.map((r) => r.wallet).sort()).toEqual([A.DEV1, A.DEV2].sort());
  });
});

describe('team exit flow', () => {
  it('get_token_transfers filters by sender', async () => {
    const r = await tokenTransfers(db.sql, A.TOKEN1, { from: A.TEAM1 });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ to: A.DUMP, secondsSinceLaunch: 6 });
  });

  it('get_exempt_flow follows exempt wallets -> dump wallet -> treasury', async () => {
    const f = (await exemptFlow(db.sql, A.TOKEN1))!;
    const team1 = f.exemptWallets.find((w) => w.wallet === A.TEAM1)!;
    expect(team1).toMatchObject({ role: 'exemption', buys: 1, curveSells: 0, firstBuySec: 0, firstTransferOutSec: 6 });
    expect(team1.tokensTransferredOut).toBeCloseTo(90e6, 0);
    expect(f.exemptWallets.find((w) => w.wallet === A.DEV1)!.role).toBe('deployer');
    expect(f.dumpWallets).toHaveLength(1);
    expect(f.dumpWallets[0]).toMatchObject({ wallet: A.DUMP, batches: 4, sells: 2, firstSellSec: 6 });
    expect(f.dumpWallets[0]!.fromExempt.sort()).toEqual([A.TEAM1, A.TEAM2].sort());
    expect(f.dumpWallets[0]!.ethFromSells).toBeCloseTo(0.95, 9);
    expect(f.ethDestinations[0]).toMatchObject({ from: A.DUMP, to: A.TREASURY, transfers: 2 });
  });
});

describe('fingerprints, triggers and backtest data', () => {
  it('launch contexts carry deployer and team fundings, and match an armed-wallet trigger in contract mode', async () => {
    const ctx = await launchContexts(db.sql, [A.TOKEN1, A.TOKEN2, A.DECOY1]);
    const c1 = ctx.find((c) => c.token === A.TOKEN1)!;
    expect(c1.teamWallets.sort()).toEqual([A.TEAM1, A.TEAM2].sort());
    expect(c1.fundings.find((f) => f.wallet === A.DEV1)).toMatchObject({ funder: A.DISPERSE, funderCreator: A.FUNDER, fresh: true, role: 'deployer' });
    const trigger = {
      armedWallet: { funders: [A.FUNDER], minEth: 0.01, maxEth: 0.015, freshOnly: true, maxAgeSec: 172_800, contractMode: true },
      nameRegex: '^amlil',
      launchKind: 'noDevBuy' as const,
      require: ['armedWallet' as const],
    };
    expect(ctx.map((c) => [c.token, matchTrigger(c, trigger).matched])).toEqual([
      [A.DECOY1, false],
      [A.TOKEN1, true],
      [A.TOKEN2, true],
    ]);
    expect(matchTrigger(c1, { ...trigger, armedWallet: { ...trigger.armedWallet, contractMode: false } }).matched).toBe(false);
    const cands = await triggerCandidates(db.sql, { deployers: [], team: [], funders: [A.FUNDER], nameRegex: null, symbolRegex: null }, T - 10 * 86_400);
    expect(cands.sort()).toEqual([A.TOKEN1, A.TOKEN2].sort());
  });

  it('loads backtest items with exempt transfer-outs and simulates them', async () => {
    const items = await loadBacktestItems(db.sql, [A.TOKEN1, A.TOKEN2]);
    expect(items).toHaveLength(2);
    expect(items[0]!.trades.length).toBeGreaterThan(8);
    expect(items[0]!.transfers).toHaveLength(4);
    expect(items[0]!.launch.creatorTaxBps).toBe(200);
    const rep = backtestPlay(items, {
      buyEth: 0.07,
      maxTaxBps: 1000,
      takeProfits: [{ pct: 150, sellPct: 100 }],
      stopLossPct: 40,
      abortIfExemptSellInLaunchBlock: true,
      exitIfExemptSellsPct: 20,
    });
    expect(rep.n).toBe(2);
    expect(rep.perToken.every((r) => r.exitReason === 'tp')).toBe(true);
  });

  it('builds CSV sources with tax-free buyers, dump wallets and the funding route', async () => {
    const [s] = await csvSources(db.sql, [A.TOKEN1]);
    expect(s!.taxFreeBuyers.sort()).toEqual([A.TEAM1, A.TEAM2].sort());
    expect(s!.dumpWallets).toEqual([A.DUMP]);
    expect(s!.funding.map((h) => h.funder)).toEqual([A.DISPERSE, A.FUNDER, A.EXCHANGE]);
  });
});

describe('settings, runs and proposals', () => {
  it('reads eth_usd', async () => {
    expect(await getEthUsdSetting(db.sql)).toBe(4000);
  });

  it('records a run and a proposed play atomically with an event for Telegram', async () => {
    const runId = await insertAgentRun(db.sql, 'play', { ca: A.TOKEN1 });
    const rec = await insertProposedPlay(db.sql, {
      operatorName: 'amlil-sprayer',
      operatorNotes: 'disperse-contract funder',
      playName: 'amlil fresh dev',
      trigger: { require: ['armedWallet'] },
      preset: { buyEth: 0.07 },
      stats: { coins: 2 },
      runId,
      summary: '2 coins',
    });
    await finishAgentRun(db.sql, runId, { input: { ca: A.TOKEN1 }, reportMd: '# r', csvPath: '/tmp/x.csv', proposedPlay: rec, costUsd: 1.25 });
    const plays = await activePlays(db.sql);
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ id: rec.playId, enabled: false, operatorStatus: 'candidate', trigger: { require: ['armedWallet'] } });
    const ev = await db.pg.query<{ type: string; payload: { playId: number; runId: number } }>(`select type, payload from events where id = $1`, [rec.eventId]);
    expect(ev.rows[0]).toMatchObject({ type: 'play_proposed', payload: { playId: rec.playId, runId } });
    const run = await db.pg.query<{ cost_usd: number; csv_path: string }>(`select cost_usd, csv_path from agent_runs where id = $1`, [runId]);
    expect(run.rows[0]).toEqual({ cost_usd: 1.25, csv_path: '/tmp/x.csv' });
  });
});
