/** hoodctl (packages/db/src/ctl.ts): importing it has no side effects; `status` reads the kill switch like the sniper does. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { killSwitchOn, status } from '../src/ctl.js';
import { setSetting } from '../src/helpers.js';
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

// every shape services/sniper/src/risk.ts killSwitchOn treats as ON (telegram parseKillState writes these)
const ON: unknown[] = [true, 'on', 'true', 1, { on: true }, { killed: true, by: 'tg' }, { enabled: true }];
const OFF: unknown[] = [false, 'off', 0, null, undefined, {}, { on: false, reason: null, by: 'seed', at: null }, { killed: false }];

describe('hoodctl status: kill switch', () => {
  it('killSwitchOn accepts exactly the shapes the sniper risk gate accepts', () => {
    for (const v of ON) expect(killSwitchOn(v), JSON.stringify(v)).toBe(true);
    for (const v of OFF) expect(killSwitchOn(v), JSON.stringify(v) ?? 'undefined').toBe(false);
  });

  it('status shows ON for every shape the sniper treats as ON (it showed "off" for true / "on" / 1 / {enabled:true})', async () => {
    for (const v of ON) {
      await setSetting(db.sql, 'kill_switch', v);
      const lines: string[] = [];
      await status(db.sql, (l) => lines.push(l));
      expect(lines[0], JSON.stringify(v)).toBe('kill switch : ON');
    }
    await setSetting(db.sql, 'kill_switch', { on: false, by: 'hoodctl' });
    const lines: string[] = [];
    await status(db.sql, (l) => lines.push(l));
    expect(lines[0]).toBe('kill switch : off');
  });
});
