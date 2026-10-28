import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestDb, reset, type TestDb } from './pglite.js';
import {
  upsertLaunch,
  insertTrade,
  upsertTokenMetrics,
  insertTransfer,
  insertTokenTransfer,
  upsertWallet,
  listEnabledPlays,
  upsertPlay,
  armCandidate,
  listArmed,
  expireArmed,
  insertSnipe,
  updateSnipe,
  getSetting,
  setSetting,
  insertEvent,
  insertAgentRun,
  toWei,
} from '../src/index.js';

let db: TestDb;
beforeAll(async () => {
  db = await makeTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await reset(db);
});

const TOKEN = '0xa7a7c2f7cea8f9bb3b5b85802f0cd844fa9b7586';
const CURVE = '0xe2df162de883b0fb133f0f67466423d8d6533be2';

describe('launch + trade helpers', () => {
  it('upsertLaunch round-trips and lower-cases, keeps wei lossless', async () => {
    const row = await upsertLaunch(db.sql, {
      token: TOKEN.toUpperCase(),
      curve: CURVE,
      deployer: '0xC92CC38D4403536ADE5F2413CB785455D6B37CAC',
      launchKind: 'launchToken',
      creatorFeeRecipient: '0x0000000000000000000000000000000000000000',
      creatorTaxBps: 200,
      name: 'Amlil',
      symbol: 'AMLIL',
      exemptions: ['0x3E572CE00DD5BA0386D868FC42C33A9CD73ED91A'],
      graduationThreshold: 4_200_000_000_000_000_000n,
      launchConfigId: 0n,
    });
    expect(row.token).toBe(TOKEN);
    expect(row.deployer).toBe('0xc92cc38d4403536ade5f2413cb785455d6b37cac');
    expect(row.exemptions).toEqual(['0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a']);
    expect(toWei(row.graduation_threshold)).toBe(4_200_000_000_000_000_000n);
    // upsert again updates in place (same pk)
    const row2 = await upsertLaunch(db.sql, { token: TOKEN, curve: CURVE, deployer: '0xc92cc38d4403536ade5f2413cb785455d6b37cac', launchKind: 'launchAndBuy', symbol: 'AMLIL2' });
    expect(row2.token).toBe(TOKEN);
    expect(row2.launch_kind).toBe('launchAndBuy');
    expect(row2.symbol).toBe('AMLIL2');
    const count = await db.sql.query<{ c: number }>('SELECT count(*)::int c FROM launches');
    expect(count[0]!.c).toBe(1);
  });

  it('insertTrade ignores duplicate (tx_hash, log_index) and stores creator tax + snipe tax', async () => {
    const t = {
      token: TOKEN,
      curve: CURVE,
      txHash: '0xf69dee0b12a761abc21d52b374bfa2a01807a2f2944e002ef4762a0fad2df66c',
      logIndex: 0,
      side: 'buy' as const,
      recipient: '0xc54d3914f91f984d61b63d491f38934c4e706b79',
      quote: 35_000_000_000_000_000n,
      tokens: 12_527_995_440_080_858_823_886_271n,
      fee: 2_513_000_000_000_000n,
      tax: 700_000_000_000_000n, // creator tax
      snipeTax: 2_163_000_000_000_000n, // snipe tax
    };
    const first = await insertTrade(db.sql, t);
    expect(first).not.toBeNull();
    expect(toWei(first!.tax)).toBe(700_000_000_000_000n);
    expect(toWei(first!.snipe_tax)).toBe(2_163_000_000_000_000n);
    const dup = await insertTrade(db.sql, t);
    expect(dup).toBeNull();
    const count = await db.sql.query<{ c: number }>('SELECT count(*)::int c FROM curve_trades');
    expect(count[0]!.c).toBe(1);
  });

  it('upsertTokenMetrics merges fields', async () => {
    await upsertTokenMetrics(db.sql, TOKEN, { first_taxed_buyer: '0xc54d3914f91f984d61b63d491f38934c4e706b79', peak5_pct: 222 });
    const m = await upsertTokenMetrics(db.sql, TOKEN, { peak30_pct: 377, n_buys_60s: 125 });
    expect(m.first_taxed_buyer).toBe('0xc54d3914f91f984d61b63d491f38934c4e706b79');
    expect(m.peak5_pct).toBe(222);
    expect(m.peak30_pct).toBe(377);
    expect(m.n_buys_60s).toBe(125);
  });

  it('insertTransfer / insertTokenTransfer ignore duplicates', async () => {
    const e = { txHash: '0xdead', traceAddr: '', fromAddr: '0xaa', toAddr: '0xbb', value: 15_000_000_000_000_000n, kind: 'tx' as const };
    expect(await insertTransfer(db.sql, e)).not.toBeNull();
    expect(await insertTransfer(db.sql, e)).toBeNull();

    const tt = { token: TOKEN, txHash: '0xbeef', logIndex: 3, fromAddr: '0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a', toAddr: '0xa98da960', value: 180_000_000n };
    expect(await insertTokenTransfer(db.sql, tt)).not.toBeNull();
    expect(await insertTokenTransfer(db.sql, tt)).toBeNull();
  });

  it('upsertWallet keeps first-funding and ORs is_contract and merges labels', async () => {
    await upsertWallet(db.sql, { address: '0xC95B258A', firstFunder: '0xFUND', firstFundingValue: 25_000_000_000_000n, txCountAtFirstFunding: 0, labels: { team: true } });
    const w = await upsertWallet(db.sql, { address: '0xc95b258a', isContract: true, labels: { seen: 2 } });
    expect(w.first_funder).toBe('0xfund');
    expect(toWei(w.first_funding_value)).toBe(25_000_000_000_000n);
    expect(w.is_contract).toBe(true);
    expect(w.labels).toEqual({ team: true, seen: 2 });
    expect(w.tx_count_at_first_funding).toBe(0);
  });
});

describe('plays / armed / snipes / settings', () => {
  it('upsertPlay inserts then updates; listEnabledPlays filters', async () => {
    const p = await upsertPlay(db.sql, { name: 'Amlo', enabled: false, trigger: { launchKind: 'noDevBuy' }, preset: { buyEth: 0.07 } });
    expect(p.enabled).toBe(false);
    expect((p.trigger as { launchKind: string }).launchKind).toBe('noDevBuy');
    expect(await listEnabledPlays(db.sql)).toHaveLength(0);
    const p2 = await upsertPlay(db.sql, { id: p.id, enabled: true });
    expect(p2.enabled).toBe(true);
    expect(p2.name).toBe('Amlo'); // COALESCE keeps name
    const enabled = await listEnabledPlays(db.sql);
    expect(enabled).toHaveLength(1);
  });

  it('armCandidate is idempotent; listArmed + expireArmed work', async () => {
    const p = await upsertPlay(db.sql, { name: 'x' });
    const past = new Date(Date.now() - 1000);
    await armCandidate(db.sql, { playId: p.id, wallet: '0xWALLET', sourceFunder: '0xFUND', fundedValue: 10_000_000_000_000_000n, expiresAt: past });
    const again = await armCandidate(db.sql, { playId: p.id, wallet: '0xwallet', fundedValue: 20_000_000_000_000_000n, expiresAt: past });
    expect(toWei(again.funded_value)).toBe(20_000_000_000_000_000n);
    expect(await listArmed(db.sql)).toHaveLength(1);
    const n = await expireArmed(db.sql, new Date());
    expect(n).toBe(1);
    expect(await listArmed(db.sql, 'armed')).toHaveLength(0);
    expect(await listArmed(db.sql, 'expired')).toHaveLength(1);
  });

  it('insertSnipe + updateSnipe round-trip numeric/jsonb', async () => {
    const p = await upsertPlay(db.sql, { name: 'x' });
    const s = await insertSnipe(db.sql, { playId: p.id, token: TOKEN, curve: CURVE, mode: 'paper', decision: { reason: 'armed' }, burst: [{ nonce: 1 }] });
    expect(s.status).toBe('pending');
    const u = await updateSnipe(db.sql, s.id, {
      status: 'open',
      quote_in: 70_000_000_000_000_000n,
      tokens_out: 39_000_000_000_000_000_000_000_000n,
      entry_price: 2.79e-9,
      sells: [{ reason: 'tp' }],
    });
    expect(u.status).toBe('open');
    expect(toWei(u.quote_in)).toBe(70_000_000_000_000_000n);
    expect(toWei(u.tokens_out)).toBe(39_000_000_000_000_000_000_000_000n);
    expect(u.entry_price).toBeCloseTo(2.79e-9, 15);
    expect(u.sells).toEqual([{ reason: 'tp' }]);
  });

  it('getSetting/setSetting round-trip JSON values', async () => {
    expect(await getSetting(db.sql, 'kill')).toBeNull();
    await setSetting(db.sql, 'kill', { on: false });
    await setSetting(db.sql, 'eth_usd', 3200);
    expect(await getSetting(db.sql, 'kill')).toEqual({ on: false });
    expect(await getSetting<number>(db.sql, 'eth_usd')).toBe(3200);
    await setSetting(db.sql, 'kill', { on: true });
    expect(await getSetting(db.sql, 'kill')).toEqual({ on: true });
  });

  it('insertEvent and insertAgentRun persist', async () => {
    const e = await insertEvent(db.sql, { level: 'warn', source: 'sniper', type: 'armed', payload: { token: TOKEN } });
    expect(e.payload).toEqual({ token: TOKEN });
    const r = await insertAgentRun(db.sql, { kind: 'play', input: { ca: TOKEN }, reportMd: '# report', proposedPlay: { name: 'Amlo' }, costUsd: 0.12 });
    expect(r.kind).toBe('play');
    expect(r.proposed_play).toEqual({ name: 'Amlo' });
    expect(r.cost_usd).toBeCloseTo(0.12, 6);
  });
});
