/** PgStore against the real @hood/db migrations on in-process PGlite. */
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, fromPglite, setSetting, upsertPlay, armCandidate, type Sql } from '@hood/db';

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
    const stats = await store.loadSnipeStats(new Date(0));
    expect(stats.countsByPlay[play!.id!]).toBe(1);
    expect(stats.openCount).toBe(1);
    expect(stats.tokens).toEqual(['0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d']);
    expect(stats.playDeployers).toEqual([{ playId: play!.id!, deployer: '0x81eb508048220493549302d8ea5ef73a3fde1784' }]);
    await store.updateSnipe(id, { status: 'closed', realizedPnlEth: 0.1, closedAt: new Date() });
    expect((await store.loadSnipeStats(new Date(0))).realizedPnlSince).toBeCloseTo(0.1, 9);
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
});
