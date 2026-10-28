import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeTestDb, reset, type TestDb } from './pglite.js';
import { upsertPlay, armCandidate, insertSnipe, setSetting, CHANNELS } from '../src/index.js';

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

/** Collect NOTIFY payloads on a channel until a short settle delay. */
async function capture(db: TestDb, channel: string, action: () => Promise<void>): Promise<unknown[]> {
  const got: unknown[] = [];
  const unsub = await db.pg.listen(channel, (p: string) => got.push(JSON.parse(p)));
  await action();
  await new Promise((r) => setTimeout(r, 80));
  await unsub();
  return got;
}

describe('NOTIFY triggers fire with small JSON payloads', () => {
  it('plays_changed on insert and update', async () => {
    const payloads = await capture(db, CHANNELS.plays, async () => {
      const p = await upsertPlay(db!.sql, { name: 'Amlo', enabled: false });
      await upsertPlay(db!.sql, { id: p.id, enabled: true });
    });
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    const last = payloads.at(-1) as { enabled: boolean; op: string };
    expect(last.enabled).toBe(true);
    expect(['INSERT', 'UPDATE']).toContain(last.op);
  });

  it('armed_changed on arm', async () => {
    const p = await upsertPlay(db.sql, { name: 'x' });
    const payloads = await capture(db, CHANNELS.armed, async () => {
      await armCandidate(db!.sql, { playId: p.id, wallet: '0xwallet' });
    });
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as { wallet: string }).wallet).toBe('0xwallet');
  });

  it('snipe_events on insert', async () => {
    const p = await upsertPlay(db.sql, { name: 'x' });
    const payloads = await capture(db, CHANNELS.snipes, async () => {
      await insertSnipe(db!.sql, { playId: p.id, token: '0xtoken', curve: '0xcurve' });
    });
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as { status: string }).status).toBe('pending');
  });

  it('settings_changed on upsert', async () => {
    const payloads = await capture(db, CHANNELS.settings, async () => {
      await setSetting(db!.sql, 'kill', { on: true });
    });
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as { key: string }).key).toBe('kill');
  });
});
