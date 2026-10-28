import { PlayTriggerSchema, PresetSchema, parsePreset } from '@hood/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listEnabledPlays, setSetting, getSetting } from '../src/helpers.js';
import { DEFAULT_AUTO_APPROVE, GENERIC_OPERATOR, KILL_SWITCH_OFF, seed } from '../src/seed.js';
import { makeTestDb, reset, type TestDb } from './pglite.js';

let db: TestDb;
beforeAll(async () => {
  db = await makeTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await reset(db);
});

describe('seed (generic fingerprint plays + settings)', () => {
  it('creates the generic operator, team-buy-0.1 (enabled) and team-buy-0.05 (disabled), and the settings', async () => {
    const r = await seed(db.sql);
    expect(r).toMatchObject({ operatorCreated: true, playsCreated: ['team-buy-0.1', 'team-buy-0.05'], playsExisting: [], settingsCreated: ['kill_switch', 'auto_approve'] });
    const ops = await db.sql.query<{ id: number; name: string; status: string }>('SELECT id, name, status FROM operators');
    expect(ops).toEqual([{ id: r.operatorId, name: GENERIC_OPERATOR, status: 'active' }]);

    const plays = await db.sql.query<{ name: string; enabled: boolean; operator_id: number; trigger: unknown; preset: unknown; stats: Record<string, unknown> }>(
      'SELECT name, enabled, operator_id, trigger, preset, stats FROM plays ORDER BY id',
    );
    expect(plays.map((p) => [p.name, p.enabled, p.operator_id])).toEqual([
      ['team-buy-0.1', true, r.operatorId],
      ['team-buy-0.05', false, r.operatorId],
    ]);
    expect(PlayTriggerSchema.parse(plays[0]!.trigger).launchSecond).toEqual({ minTeamBuyEth: 0.1 });
    expect(PlayTriggerSchema.parse(plays[1]!.trigger).launchSecond).toEqual({ minTeamBuyEth: 0.05 });
    // the preset is the backtested default (docs/BACKTEST.md #2) plus the generic-play risk fields
    const preset = PresetSchema.parse(plays[0]!.preset);
    expect(preset).toEqual({ ...parsePreset({}), stopAfter: 1_000_000, firstBuyOnly: false });
    expect(preset).toMatchObject({ takeProfits: [], trailing: { activatePct: 50, dropPct: 20 }, stopLossPct: 40, timeoutSec: 60, exitIfExemptSellsPct: 0 });
    expect(plays[0]!.stats.source).toBe('backtest#2');
    expect((await listEnabledPlays(db.sql)).map((p) => p.name)).toEqual(['team-buy-0.1']);

    expect(await getSetting(db.sql, 'kill_switch')).toEqual(KILL_SWITCH_OFF);
    expect(await getSetting(db.sql, 'auto_approve')).toEqual(DEFAULT_AUTO_APPROVE);
  });

  it('is idempotent by play name and never overwrites tuned plays or existing settings', async () => {
    const first = await seed(db.sql);
    // a human tuned the play, turned the kill switch on and disabled auto-approval
    await db.sql.query(`UPDATE plays SET preset = jsonb_set(preset, '{buyEth}', '0.02'), enabled = false WHERE name = 'team-buy-0.1'`);
    await setSetting(db.sql, 'kill_switch', { on: true, reason: 'manual /kill', by: 'tg' });
    await setSetting(db.sql, 'auto_approve', { ...DEFAULT_AUTO_APPROVE, enabled: false });

    const again = await seed(db.sql);
    expect(again).toMatchObject({ operatorId: first.operatorId, operatorCreated: false, playsCreated: [], playsExisting: ['team-buy-0.1', 'team-buy-0.05'], settingsCreated: [] });
    expect(await db.sql.query('SELECT id FROM operators')).toHaveLength(1);
    expect(await db.sql.query('SELECT id FROM plays')).toHaveLength(2);
    const p = await db.sql.query<{ enabled: boolean; preset: { buyEth: number } }>(`SELECT enabled, preset FROM plays WHERE name = 'team-buy-0.1'`);
    expect(p[0]).toMatchObject({ enabled: false, preset: { buyEth: 0.02 } });
    expect(await getSetting(db.sql, 'kill_switch')).toMatchObject({ on: true });
    expect(await getSetting(db.sql, 'auto_approve')).toMatchObject({ enabled: false });
  });

  it('reuses an operator named generic created elsewhere and fills in a missing play', async () => {
    await db.sql.query(`INSERT INTO operators (name, status, created_by) VALUES ('generic', 'active', 'tg')`);
    await db.sql.query(`INSERT INTO plays (name, enabled, trigger, preset) VALUES ('team-buy-0.1', true, '{}'::jsonb, '{}'::jsonb)`);
    const r = await seed(db.sql);
    expect(r).toMatchObject({ operatorCreated: false, playsCreated: ['team-buy-0.05'], playsExisting: ['team-buy-0.1'] });
  });
});
