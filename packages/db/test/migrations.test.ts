import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestDb, type TestDb } from './pglite.js';
import { applyMigrations } from '../src/index.js';

let db: TestDb;
beforeAll(async () => {
  db = await makeTestDb();
}, 30_000);
afterAll(async () => {
  await db.close();
});

describe('migrations', () => {
  it('apply cleanly and create every table', async () => {
    const rows = await db.sql.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      'launches', 'curve_trades', 'token_metrics', 'eth_transfers', 'token_transfers',
      'wallets', 'operators', 'plays', 'armed_candidates', 'snipes', 'feed_blocks',
      'agent_runs', 'settings', 'events', 'schema_migrations',
    ]) {
      expect(names.has(t), t).toBe(true);
    }
  });

  it('are idempotent (second run applies nothing)', async () => {

    const applied = await applyMigrations(db.sql);
    expect(applied).toEqual([]);
    const done = await db.sql.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(done.some((r) => r.name === '0001_init.sql')).toBe(true);
  });

  it('curve_trades has snipe_tax and the (token, ts) index', async () => {

    const cols = await db.sql.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'curve_trades'`,
    );
    expect(cols.some((c) => c.column_name === 'snipe_tax')).toBe(true);
    expect(cols.some((c) => c.column_name === 'tax')).toBe(true);
    const idx = await db.sql.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'curve_trades'`,
    );
    expect(idx.some((i) => i.indexname === 'curve_trades_token_ts_idx')).toBe(true);
  });
});
