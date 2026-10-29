/** PgStore against the real @hood/db migrations on in-process PGlite. */
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, fromPglite, fromPostgres, setSetting, upsertPlay, armCandidate, type Sql } from '@hood/db';

type PgliteClient = Parameters<typeof fromPglite>[0];
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgStore } from '../src/store-db.js';
import type { ChangeChannel } from '../src/store.js';

let pg: PGlite;
let sql: Sql;
let store: PgStore;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  sql = fromPglite(pg as unknown as PgliteClient);
  await applyMigrations(sql);
  store = new PgStore(sql);
});
afterAll(async () => {
  await pg.close();
});

describe('PgStore (@hood/db on PGlite)', () => {
  it('loads enabled plays (zod defaults applied), armed candidates and settings; gets NOTIFY changes', async () => {
    const seen: [ChangeChannel, string][] = [];
    const off = await store.onChange((c, p) => seen.push([c, p]));
    const p = await upsertPlay(sql, { name: 'amlo', enabled: true, trigger: { deployerIn: ['0x81EB508048220493549302d8ea5ef73a3fde1784'] }, preset: { buyEth: 0.05 } });
    await upsertPlay(sql, { name: 'off', enabled: false, trigger: {}, preset: {} });
    await armCandidate(sql, { playId: p.id, wallet: '0xC92CC38D4403536ADE5F2413CB785455D6B37CAC', fundedValue: 12_000_000_000_000_000n, sourceFunder: '0x9999999999999999999999999999999999999999', expiresAt: new Date(Date.now() + 60_000) });
    await armCandidate(sql, { playId: p.id, wallet: '0x1111111111111111111111111111111111111111', expiresAt: new Date(Date.now() - 1) });
    await setSetting(sql, 'kill_switch', true);
    const plays = await store.loadPlays();
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ id: p.id, name: 'amlo', enabled: true, preset: { buyEth: 0.05, maxTaxBps: 1000, burst: { startMs: -120, spacingMs: 15, count: 10 } } });
    expect(plays[0]!.trigger.deployerIn).toEqual(['0x81eb508048220493549302d8ea5ef73a3fde1784']);
    const armed = await store.loadArmed();
    expect(armed).toHaveLength(1); // expired one filtered
    expect(armed[0]).toMatchObject({ playId: p.id, wallet: '0xc92cc38d4403536ade5f2413cb785455d6b37cac', fundedValue: 12_000_000_000_000_000n, status: 'armed' });
    expect(await store.loadSettings()).toEqual({ kill_switch: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(new Set(seen.map(([c]) => c))).toEqual(new Set(['plays_changed', 'armed_changed', 'settings_changed']));
    expect(JSON.parse(seen.find(([c]) => c === 'armed_changed')![1])).toMatchObject({ play_id: p.id, status: 'armed' });
    await off();
  });

  it('inserts a snipe before token/curve are known, then fills them and all result columns', async () => {
    const [play] = await store.loadPlays();
    const id = await store.insertSnipe({
      playId: play!.id!,
      token: '',
      curve: '',
      decidedAt: new Date(),
      decision: { reasons: ['deployerIn'], launch: { event: { deployer: '0x81eb508048220493549302d8ea5ef73a3fde1784' } }, minTokensOut: 5n },
      mode: 'live',
      burst: [],
      status: 'pending',
      sells: [],
      quoteIn: 70_000_000_000_000_000n,
      notes: null,
    });
    expect(id).toBeGreaterThan(0);
    await store.updateSnipe(id, {
      token: '0xE9A2DC2003A9E7E2CA11F93B64C08B55A749215D',
      curve: '0xd30a935fddef5f5855519874ee2f4e7a7ea36821',
      status: 'open',
      buyBlock: 100299826,
      buyTs: new Date(1793214022_000),
      tokensOut: 25_000_000n * 10n ** 18n,
      taxPaid: 4_326_000_000_000_000n,
      entryPrice: 2.8e-9,
      burst: [{ nonce: 42, hash: '0xab', sentAt: 1, endpoint: 'http://ohio', status: 'mined' }],
    });
    const [row] = await sql.query<Record<string, unknown>>('SELECT * FROM snipes WHERE id = $1', [String(id)]);
    expect(row).toMatchObject({
      token: '0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d',
      curve: '0xd30a935fddef5f5855519874ee2f4e7a7ea36821',
      status: 'open',
      mode: 'live',
      quote_in: '70000000000000000',
      tokens_out: '25000000000000000000000000',
      tax_paid: '4326000000000000',
    });
    expect((row!.decision as { minTokensOut: string }).minTokensOut).toBe('5');
    const stats = await store.loadSnipeStats(new Date(0), 'live');
    expect(stats.countsByPlay[play!.id!]).toBe(1);
    expect(stats.openCount).toBe(1);
    expect(stats.tokens).toEqual(['0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d']);
    expect(stats.playDeployers).toEqual([{ playId: play!.id!, deployer: '0x81eb508048220493549302d8ea5ef73a3fde1784' }]);
    await store.updateSnipe(id, { status: 'closed', realizedPnlEth: 0.1, closedAt: new Date() });
    expect((await store.loadSnipeStats(new Date(0), 'live')).realizedPnlSince).toBeCloseTo(0.1, 9);
  });

  it('L5: paper rows never touch live risk stats (and vice versa); H1: only confirmed launches mark firstBuyOnly', async () => {
    const [play] = await store.loadPlays();
    const base = { playId: play!.id!, decidedAt: new Date(), burst: [], sells: [], notes: null };
    const before = await store.loadSnipeStats(new Date(0), 'live');
    // a losing paper position (closed today), a stale paper pending row, a paper token
    const paperId = await store.insertSnipe({ ...base, token: '0x' + 'a1'.repeat(20), curve: '0x' + 'a2'.repeat(20), decision: { launch: { event: { deployer: '0x' + 'a3'.repeat(20) } } }, mode: 'paper', status: 'open' });
    await store.updateSnipe(paperId, { status: 'closed', realizedPnlEth: -0.4, closedAt: new Date() });
    await store.insertSnipe({ ...base, token: '', curve: '', decision: {}, mode: 'paper', status: 'pending' });
    const live = await store.loadSnipeStats(new Date(0), 'live');
    expect(live).toEqual(before);
    const paper = await store.loadSnipeStats(new Date(0), 'paper');
    expect(paper.realizedPnlSince).toBeCloseTo(-0.4, 9);
    expect(paper.openCount).toBe(1);
    expect(paper.tokens).toEqual(['0x' + 'a1'.repeat(20)]);
    // H1: an aborted, never-confirmed (spoofed) live launch does not block the deployer; a confirmed one does
    const spoofDeployer = '0x' + 'b1'.repeat(20);
    const realDeployer = '0x' + 'b2'.repeat(20);
    await store.insertSnipe({ ...base, token: '', curve: '', decision: { confirmed: false, launch: { event: { deployer: spoofDeployer } } }, mode: 'live', status: 'aborted' });
    await store.insertSnipe({ ...base, token: '0x' + 'b3'.repeat(20), curve: '0x' + 'b4'.repeat(20), decision: { confirmed: true, launch: { event: { deployer: realDeployer } } }, mode: 'live', status: 'aborted' });
    const after = await store.loadSnipeStats(new Date(0), 'live');
    expect(after.playDeployers.map((d) => d.deployer)).toContain(realDeployer);
    expect(after.playDeployers.map((d) => d.deployer)).not.toContain(spoofDeployer);
    expect(after.tokens).toContain('0x' + 'b3'.repeat(20));
    expect(after.countsByPlay).toEqual(before.countsByPlay); // aborted rows never count for stopAfter
    // H3: active rows per mode for the startup reconciliation
    const active = await store.loadActiveSnipes('paper');
    expect(active.map((a) => [a.mode, a.status])).toEqual([['paper', 'pending']]);
    expect((await store.loadActiveSnipes('live')).every((a) => a.mode === 'live')).toBe(true);
  });

  it('writes feed_blocks (idempotent) and snipe events', async () => {
    await store.insertFeedBlocks([
      { block: 1, ts: 1793214820, arrivalMs: 1793214820679.4, nTxs: 12 },
      { block: 2, ts: 1793214820, arrivalMs: 1793214820680, nTxs: 3 },
    ]);
    await store.insertFeedBlocks([{ block: 2, ts: 1793214820, arrivalMs: 1, nTxs: 0 }]);
    const rows = await sql.query<{ block: string; arrival_ms: string; n_txs: number }>('SELECT * FROM feed_blocks ORDER BY block');
    expect(rows.map((r) => [Number(r.block), Number(r.arrival_ms), r.n_txs])).toEqual([
      [1, 1793214820679, 12],
      [2, 1793214820680, 3],
    ]);
    await store.notifySnipeEvent(JSON.stringify({ id: 1, type: 'snipe_filled', status: 'open' }));
    await store.insertEvent({ level: 'warn', source: 'sniper', type: 'feed_gap', payload: { from: 1n, to: 2 } });
    const ev = await sql.query<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM events ORDER BY id');
    expect(ev.map((e) => e.type)).toEqual(['snipe_filled', 'feed_gap']);
    expect(ev[1]!.payload).toEqual({ from: '1', to: 2 });
  });

  it('feed_blocks retention, sweep cursors and rows by token (NEW-3) on the real schema', async () => {
    const now = Math.floor(Date.now() / 1000);
    await store.insertFeedBlocks([
      { block: 100, ts: now - 8 * 86_400, arrivalMs: 0, nTxs: 0 },
      { block: 101, ts: now - 6 * 86_400, arrivalMs: 0, nTxs: 0 },
    ]);
    const before = Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM feed_blocks'))[0]!.n);
    expect(await store.pruneFeedBlocks(new Date((now - 7 * 86_400) * 1000))).toBeGreaterThanOrEqual(1);
    const left = await sql.query<{ block: string }>('SELECT block FROM feed_blocks WHERE block >= 100 ORDER BY block');
    expect(left.map((r) => Number(r.block))).toEqual([101]);
    expect(Number((await sql.query<{ n: string }>('SELECT count(*)::text AS n FROM feed_blocks'))[0]!.n)).toBeLessThan(before);
    expect(await store.getCursor('sniped_sweep:0xabc')).toBeNull();
    await store.setCursor('sniped_sweep:0xabc', 123_456);
    await store.setCursor('sniped_sweep:0xabc', 123_999);
    expect(await store.getCursor('sniped_sweep:0xabc')).toBe(123_999);
    const tok = '0x00000000000000000000000000000000000d0c01';
    const id = await store.insertSnipe({ playId: 0, token: tok, curve: tok, decidedAt: new Date(), decision: {}, mode: 'live', burst: [], status: 'failed', sells: [], quoteIn: 7n });
    const rows = await store.findSnipesByToken(tok.toUpperCase().replace('0X', '0x'), 'live');
    expect(rows.map((r) => [r.id, r.status, r.quoteIn])).toEqual([[id, 'failed', 7n]]);
    expect(await store.findSnipesByToken(tok, 'paper')).toEqual([]);
  });

  it('NEW-2: onChange reports every (re)connect of the LISTEN connection (postgres.js onlisten) — PGlite once, a reconnecting client each time', async () => {
    let connects = 0;
    const off = await store.onChange(
      () => undefined,
      () => connects++,
    );
    expect(connects).toBe(1); // PGlite: connected once
    await off();
    // the postgres.js wrapper passes onlisten through: a client that reconnects calls it again
    const onlistens: (() => void)[] = [];
    const client = {
      unsafe: () => Object.assign(Promise.resolve([]), { simple: () => Promise.resolve([]) }),
      begin: async () => undefined,
      listen: async (_c: string, _n: (p: string) => void, onlisten?: () => void) => {
        if (onlisten) {
          onlistens.push(onlisten);
          onlisten();
        }
        return { unlisten: async () => undefined };
      },
      notify: async () => undefined,
      end: async () => undefined,
    } as unknown as Parameters<typeof fromPostgres>[0];
    let reconnects = 0;
    await new PgStore(fromPostgres(client)).onChange(
      () => undefined,
      () => reconnects++,
    );
    expect(onlistens).toHaveLength(1); // wired once (all channels share the LISTEN connection)
    onlistens[0]!(); // postgres.js re-LISTENed after a reconnect
    expect(reconnects).toBe(2);
  });
});
