import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBacktest } from '../src/runner.js';
import { createTestDb, type TestDb } from './helpers/pg.js';
import { mockAnthropic } from './helpers/mockAnthropic.js';
import { A, T, seedOperator } from './helpers/seed.js';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seedOperator(db.pg);
  await db.pg.exec(`insert into operators (name, status, created_by) values ('amlil', 'candidate', 'agent');
    insert into plays (operator_id, name, enabled, trigger, preset, created_by)
    values (1, 'amlil fresh dev', false,
      '{"armedWallet":{"funders":["${A.FUNDER}"],"minEth":0.009,"maxEth":0.015,"freshOnly":true,"maxAgeSec":172800,"contractMode":true},"require":["armedWallet"]}',
      '{"takeProfits":[{"pct":150,"sellPct":100}],"stopLossPct":40,"exitIfExemptSellsPct":20}', 'agent');`);
});
afterAll(async () => {
  await db.pg.close();
});

describe('runBacktest', () => {
  it('selects the play\'s launches, backtests without calling the model, and records stats', async () => {
    const mock = mockAnthropic([]);
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-bt-'));
    const r = await runBacktest(
      { playId: 1 },
      { sql: db.sql, client: mock.client, rpc: null, reportsDir: dir, logger: pino({ level: 'silent' }), now: () => new Date((T + 3 * 86_400) * 1000), limits: { maxRounds: 5, maxCostUsd: 1 }, scout: { maxClusters: 0, minClusterSize: 2, ignore: [] } },
    );
    expect(mock.requests).toHaveLength(0);
    expect(r.coins).toBe(2);
    expect(r.stats.n).toBe(2);
    expect(r.best.insufficient).toBe(true);
    expect(r.costUsd).toBe(0);
    expect(existsSync(r.reportPath)).toBe(true);
    expect(readFileSync(r.reportPath, 'utf8')).toContain('Grid search skipped: 2 coins < minimum 5');
    expect(readFileSync(r.csvPath!, 'utf8')).toContain('backtest: tp');
    const play = await db.pg.query<{ stats: { backtest: { n: number }; backtestRunId: number } }>(`select stats from plays where id = 1`);
    expect(play.rows[0]!.stats.backtest.n).toBe(2);
    expect(play.rows[0]!.stats.backtestRunId).toBe(r.runId);
    const run = await db.pg.query<{ kind: string; cost_usd: number }>(`select kind, cost_usd from agent_runs where id = $1`, [r.runId]);
    expect(run.rows[0]).toEqual({ kind: 'backtest', cost_usd: 0 });
    await expect(runBacktest({ playId: 99 }, { sql: db.sql, client: mock.client, rpc: null, reportsDir: dir, logger: pino({ level: 'silent' }), now: () => new Date(), limits: { maxRounds: 5, maxCostUsd: 1 }, scout: { maxClusters: 0, minClusterSize: 2, ignore: [] } })).rejects.toThrow(/not found/);
  });
});
