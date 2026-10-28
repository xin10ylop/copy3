/**
 * PgStore against the real schema: packages/db migrations applied to an in-memory PGlite
 * (the same `Sql` abstraction production uses over postgres.js).
 */
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, armCandidate, fromPglite, insertSnipe, insertTrade, updateSnipe, upsertLaunch, type Sql } from '@hood/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Links } from '../src/format.js';
import { Notifier } from '../src/notifier.js';
import { Registry } from '../src/registry.js';
import { SETTINGS } from '../src/store.js';
import { PgStore } from '../src/store-pg.js';
import { CURVE, FUNDER, silentLog, TOKEN, TX, WALLET } from './helpers.js';

let pg: PGlite;
let sql: Sql;
let store: PgStore;

const TABLES = 'curve_trades, token_transfers, eth_transfers, token_metrics, armed_candidates, snipes, launches, plays, operators, wallets, feed_blocks, agent_runs, settings, events';

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  sql = fromPglite(pg as unknown as Parameters<typeof fromPglite>[0]);
  await applyMigrations(sql);
}, 60_000);
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await sql.exec(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE;`);
  store = new PgStore(sql, (what, err) => {
    throw new Error(`${what}: ${String(err)}`);
  });
});

const trigger = { armedWallet: { funders: [FUNDER], minEth: 0.01, maxEth: 0.015, freshOnly: true, maxAgeSec: 172800, contractMode: false }, require: ['armedWallet'] };

describe('plays', () => {
  it('inserts, reads, enables with a stats merge, updates the preset', async () => {
    const id = await store.insertPlay({ name: 'w', trigger, preset: { buyEth: 0.05 }, createdBy: 'telegram:@owner', enabled: false, stats: { review: { status: 'pending' } } });
    expect(id).toBe(1);
    expect(await store.getPlay(id)).toMatchObject({ id: 1, name: 'w', enabled: false, trigger, preset: { buyEth: 0.05 }, stats: { review: { status: 'pending' } }, armedCount: 0 });
    const enabled = await store.setPlayEnabled(id, true, { review: { status: 'approved', by: '@owner' } });
    expect(enabled).toMatchObject({ enabled: true, stats: { review: { status: 'approved', by: '@owner' } } });
    await store.updatePlayPreset(id, { buyEth: 0.03, trailing: { activatePct: 80, dropPct: 25 } });
    expect((await store.getPlay(id))!.preset).toEqual({ buyEth: 0.03, trailing: { activatePct: 80, dropPct: 25 } });
    expect(await store.getPlay(99)).toBeNull();
    expect((await store.listPlays()).map((p) => p.id)).toEqual([1]);
  });

  it('fires the plays_changed trigger the sniper listens to', async () => {
    const got: string[] = [];
    const unsub = await pg.listen('plays_changed', (p) => got.push(p));
    const id = await store.insertPlay({ name: 'w', trigger, preset: {}, createdBy: 'x', enabled: false });
    await store.setPlayEnabled(id, true);
    await new Promise((r) => setTimeout(r, 50));
    await unsub();
    expect(got.map((p) => JSON.parse(p) as { op: string; enabled: boolean })).toEqual([
      expect.objectContaining({ op: 'INSERT', enabled: false }),
      expect.objectContaining({ op: 'UPDATE', enabled: true }),
    ]);
  });
});

describe('armed and snipes', () => {
  it('lists armed candidates with play names and counts them per play', async () => {
    const id = await store.insertPlay({ name: 'op', trigger, preset: {}, createdBy: 'x', enabled: true });
    await armCandidate(sql, { playId: id, wallet: WALLET, sourceFunder: FUNDER, fundedValue: 57_000_000_000_000_000n, fundedTx: TX, expiresAt: new Date(Date.now() + 3600_000) });
    const [a] = await store.listArmed(10);
    expect(a).toMatchObject({ id: 1, playId: id, playName: 'op', wallet: WALLET, sourceFunder: FUNDER, fundedValueWei: 57_000_000_000_000_000n, status: 'armed' });
    expect(await store.armedAfter(0, 10)).toHaveLength(1);
    expect(await store.maxArmedId()).toBe(1);
    expect((await store.getPlay(id))!.armedCount).toBe(1);
  });

  it('reads snipes joined with the launch and the last curve price, and sums PnL', async () => {
    const id = await store.insertPlay({ name: 'op', trigger, preset: {}, createdBy: 'x', enabled: true });
    await upsertLaunch(sql, { token: TOKEN, curve: CURVE, deployer: WALLET, launchKind: 'launchToken', name: 'Amlil', symbol: 'AML', ts: new Date('2026-10-28T15:59:00Z') });
    await insertTrade(sql, { token: TOKEN, curve: CURVE, block: 10, txHash: TX, logIndex: 1, side: 'buy', priceAfter: 6e-9 });
    const s1 = await insertSnipe(sql, { playId: id, token: TOKEN, curve: CURVE, mode: 'live', burst: [{ nonce: 1, status: 'mined' }] });
    await updateSnipe(sql, s1.id, { status: 'open', quote_in: 70_000_000_000_000_000n, tokens_out: 10n ** 25n, tax_paid: 4_326_000_000_000_000n, entry_price: 4e-9, buy_ts: new Date('2026-10-28T15:59:01Z') });
    const s2 = await insertSnipe(sql, { playId: id, token: TOKEN, curve: CURVE, mode: 'live' });
    await updateSnipe(sql, s2.id, { status: 'closed', quote_in: 70_000_000_000_000_000n, tax_paid: 1_000n, realized_pnl_eth: 0.05, closed_at: new Date() });
    const s3 = await insertSnipe(sql, { playId: id, token: TOKEN, curve: CURVE, mode: 'paper' });
    await updateSnipe(sql, s3.id, { status: 'closed', realized_pnl_eth: -0.02, closed_at: new Date() });
    await insertSnipe(sql, { playId: id, token: TOKEN, curve: CURVE, mode: 'live', status: 'aborted' });

    const [open] = await store.listOpenSnipes();
    expect(open).toMatchObject({ id: 1, playName: 'op', tokenName: 'Amlil', tokenSymbol: 'AML', mode: 'live', status: 'open', quoteInWei: 70_000_000_000_000_000n, taxPaidWei: 4_326_000_000_000_000n, entryPrice: 4e-9, lastPrice: 6e-9, burst: [{ nonce: 1, status: 'mined' }] });
    expect(open!.launchTs?.toISOString()).toBe('2026-10-28T15:59:00.000Z');
    expect((await store.getSnipes([2, 3])).map((s) => s.status)).toEqual(['closed', 'closed']);
    expect((await store.snipesAfter(2, 10)).map((s) => s.id)).toEqual([3, 4]);
    expect(await store.maxSnipeId()).toBe(4);

    const pnl = await store.pnlSummary(new Date(Date.now() - 86_400_000));
    expect(pnl.live).toMatchObject({ closed: 1, wins: 1, losses: 0, pnlEth: 0.05, aborted: 1, investedWei: 70_000_000_000_000_000n, taxPaidWei: 1_000n });
    expect(pnl.paper).toMatchObject({ closed: 1, losses: 1, pnlEth: -0.02 });
    expect(pnl.byPlay).toEqual([
      { playId: id, name: 'op', mode: 'live', closed: 1, pnlEth: 0.05 },
      { playId: id, name: 'op', mode: 'paper', closed: 1, pnlEth: -0.02 },
    ]);
  });
});

describe('status, settings, events', () => {
  it('builds the /status snapshot from feed_blocks, settings, snipes, plays, events', async () => {
    await sql.query(`INSERT INTO feed_blocks (block, ts, arrival_ms, n_txs) VALUES (100302108, $1, $2, 3)`, [new Date('2026-10-28T16:00:00Z'), 1_793_203_200_085]);
    await store.setSetting(SETTINGS.killSwitch, { on: true, reason: 'test', by: '@owner' });
    await store.setSetting(SETTINGS.ethUsd, 3000);
    await store.setSetting(SETTINGS.indexerCheckpoint, { block: 100302000 });
    await store.insertPlay({ name: 'agent play', trigger, preset: {}, createdBy: 'agent', enabled: false });
    await store.insertEvent({ level: 'error', source: 'sniper', type: 'send_failed', payload: { message: 'x' } });
    const s = await store.getStatus(new Date(Date.now() - 3600_000));
    expect(s).toMatchObject({
      feed: { block: 100302108, arrivalMs: 1_793_203_200_085 },
      indexerBlock: 100302000,
      kill: { on: true, reason: 'test', by: '@owner' },
      openPositions: { live: 0, paper: 0 },
      dailyPnl: { live: 0, paper: 0 },
      enabledPlays: 0,
      pendingReview: 1,
      armed: 0,
      lastError: { source: 'sniper', type: 'send_failed' },
      ethUsd: 3000,
    });
    expect(s.feed!.ts!.toISOString()).toBe('2026-10-28T16:00:00.000Z');
  });

  it('round-trips settings and tails events by id', async () => {
    await store.setSetting('k', { a: 1 });
    expect(await store.getSetting('k')).toEqual({ a: 1 });
    expect(await store.getSetting('missing')).toBeNull();
    await store.insertEvent({ level: 'info', source: 'telegram', type: 'a', payload: { x: 1 } });
    await store.insertEvent({ level: 'error', source: 'sniper', type: 'b', payload: 'plain' });
    expect(await store.maxEventId()).toBe(2);
    const ev = await store.eventsAfter(0, 10);
    expect(ev.map((e) => [e.id, e.level, e.source, e.type, e.payload])).toEqual([
      [1, 'info', 'telegram', 'a', { x: 1 }],
      [2, 'error', 'sniper', 'b', { value: 'plain' }],
    ]);
    expect(await store.eventsAfter(1, 10)).toHaveLength(1);
    expect(await store.countEventsSince(new Date(Date.now() - 60_000), 'error')).toBe(1);
  });
});

describe('notifier end to end on the real triggers', () => {
  it('a snipe insert/update NOTIFYs snipe_events and becomes sent → filled messages', async () => {
    const id = await store.insertPlay({ name: 'op', trigger, preset: {}, createdBy: 'x', enabled: true });
    const sent: string[] = [];
    const notifier = new Notifier(
      {
        store,
        broadcast: async (html) => {
          sent.push(html.split('\n')[0]!);
          return 1;
        },
        chatCount: 1,
        registry: new Registry(),
        activeJobKinds: () => new Set(),
        listen: (channel, cb) => pg.listen(channel, cb),
        log: silentLog,
      },
      { pollMs: 3_600_000, dailySummaryHour: 23, tz: 'UTC', links: new Links(), ignoreSources: ['telegram'], armedBurstLimit: 10 },
    );
    await notifier.start();
    const s = await insertSnipe(sql, { playId: id, token: TOKEN, curve: CURVE, mode: 'paper', burst: [{ nonce: 1, sentAt: 1, endpoint: 'https://rpc.mainnet.chain.robinhood.com', status: 'sent' }] });
    await new Promise((r) => setTimeout(r, 100));
    await updateSnipe(sql, s.id, { status: 'open', entry_price: 4e-9, quote_in: 10n ** 17n });
    await new Promise((r) => setTimeout(r, 100));
    await notifier.tick();
    await notifier.stop();
    expect(sent).toEqual(['[PAPER] <b>SNIPE PLANNED</b> #1 · play #1 op', '[PAPER] <b>FILLED</b> #1 · play #1 op']);
    expect(await store.getSetting(SETTINGS.snipesCheckpoint)).toEqual({ maxId: 1, open: { '1': 'open' } });
  });
});
