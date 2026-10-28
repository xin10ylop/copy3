import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES, buildTools, compactJson, newRunState, type ToolContext } from '../src/tools.js';
import { createTestDb, type TestDb } from './helpers/pg.js';
import { A, T, seedOperator } from './helpers/seed.js';

const SPEC_TOOLS = [
  'get_token',
  'get_trades',
  'get_token_metrics',
  'get_wallet',
  'get_wallet_funding',
  'get_wallet_outgoing',
  'list_tokens_by_deployer',
  'list_tokens_by_name',
  'list_recent_launches',
  'list_runners',
  'get_wallet_trades',
  'backtest_play',
  'write_report',
  'write_csv',
  'propose_play',
  'eth_usd',
];

interface Runnable {
  name: string;
  parse: (x: unknown) => unknown;
  run: (x: unknown) => Promise<unknown> | unknown;
  input_schema: { properties?: Record<string, unknown> };
  eager_input_streaming?: boolean;
}

let db: TestDb;
let ctx: ToolContext;
let tools: Map<string, Runnable>;

beforeAll(async () => {
  db = await createTestDb();
  await seedOperator(db.pg);
  ctx = {
    sql: db.sql,
    rpc: null,
    reportsDir: mkdtempSync(path.join(tmpdir(), 'agent-tools-')),
    runId: 1,
    kind: 'play',
    logger: pino({ level: 'silent' }),
    now: () => new Date((T + 3 * 86_400) * 1000),
    state: newRunState(),
    budgetNotice: () => null,
  };
  tools = new Map(
    buildTools(ctx)
      .filter((t): t is typeof t & Runnable => 'run' in t)
      .map((t) => [t.name, t as unknown as Runnable]),
  );
});
afterAll(async () => {
  await db.pg.close();
});

async function call(name: string, input: unknown): Promise<Record<string, unknown>> {
  const t = tools.get(name)!;
  return JSON.parse(String(await t.run(t.parse(input)))) as Record<string, unknown>;
}

describe('tool surface', () => {
  it('covers every SPEC §3 tool plus the token-transfer tools, all runnable and eagerly streamed', () => {
    expect([...tools.keys()]).toEqual([...TOOL_NAMES]);
    for (const n of SPEC_TOOLS) expect(tools.has(n)).toBe(true);
    expect([...tools.keys()].filter((n) => !SPEC_TOOLS.includes(n))).toEqual(['get_token_transfers', 'get_exempt_flow']);
    for (const t of tools.values()) expect(t.eager_input_streaming).toBe(true);
  });

  const ADDRESS_INPUTS: Array<[string, Record<string, unknown>, string]> = [
    ['get_token', {}, 'ca'],
    ['get_trades', {}, 'ca'],
    ['get_token_metrics', {}, 'ca'],
    ['get_wallet', {}, 'address'],
    ['get_wallet_funding', {}, 'address'],
    ['get_wallet_outgoing', {}, 'address'],
    ['list_tokens_by_deployer', {}, 'address'],
    ['get_wallet_trades', {}, 'address'],
    ['get_token_transfers', {}, 'ca'],
    ['get_exempt_flow', {}, 'ca'],
  ];

  it.each(ADDRESS_INPUTS)('%s rejects malformed addresses and lower-cases valid ones', (name, extra, field) => {
    const t = tools.get(name)!;
    for (const bad of ['0x123', 'a7a7c2f7cea8f9bb3b5b85802f0cd844fa9b7586', '0xZZa7c2f7cea8f9bb3b5b85802f0cd844fa9b7586', '', 42, null]) {
      expect(() => t.parse({ ...extra, [field]: bad })).toThrow();
    }
    const parsed = t.parse({ ...extra, [field]: '  0xA7A7C2F7CEA8F9BB3B5B85802F0CD844FA9B7586 ' }) as Record<string, string>;
    expect(parsed[field]).toBe('0xa7a7c2f7cea8f9bb3b5b85802f0cd844fa9b7586');
    expect(JSON.stringify(t.input_schema)).toContain('^0x[0-9a-fA-F]{40}$');
  });

  it('rejects bad addresses nested in arrays and triggers, over-sized pages and bad regexes', () => {
    expect(() => tools.get('write_csv')!.parse({ rows: [{ ca: '0xdead' }] })).toThrow();
    expect(() => tools.get('backtest_play')!.parse({ tokens: [A.TOKEN1, 'nope'] })).toThrow();
    expect(() =>
      tools.get('propose_play')!.parse({
        operator_name: 'operator-x',
        operator_notes: '',
        play_name: 'play-x',
        pattern: 'team_buys',
        trigger: { armedWallet: { funders: ['0x1'], minEth: 0, maxEth: 1, freshOnly: true, maxAgeSec: 3600, contractMode: false }, require: [] },
        evidence_tokens: [A.TOKEN1],
        summary: 's',
      }),
    ).toThrow();
    expect(() => tools.get('get_trades')!.parse({ ca: A.TOKEN1, limit: 500 })).toThrow();
    expect(tools.get('get_token')!.parse({ ca: A.TOKEN1, extra: 1 })).toEqual({ ca: A.TOKEN1 }); // unknown keys are stripped
    expect(() => tools.get('list_tokens_by_name')!.parse({ regex: '(' })).toThrow();
  });
});

describe('tool behaviour', () => {
  it('get_token marks the token as seen and lists the team wallets', async () => {
    const r = await call('get_token', { ca: A.TOKEN1 });
    expect(r['found']).toBe(true);
    expect((r['token'] as { teamWallets: string[] }).teamWallets.sort()).toEqual([A.TEAM1, A.TEAM2].sort());
    expect(ctx.state.tokensSeen.has(A.TOKEN1)).toBe(true);
  });

  it('get_wallet_outgoing defaults to children (contract mode included)', async () => {
    const r = await call('get_wallet_outgoing', { address: A.FUNDER });
    expect(r['mode']).toBe('children');
    expect((r['rows'] as Array<{ wallet: string }>).map((x) => x.wallet)).toContain(A.DEV1);
    const raw = await call('get_wallet_outgoing', { address: A.DUMP, mode: 'raw' });
    expect((raw['rows'] as Array<{ to: string }>)[0]!.to).toBe(A.TREASURY);
  });

  it('backtest_play selects launches by trigger, reports stats, the derived preset and a guarded grid', async () => {
    const r = await call('backtest_play', {
      trigger: {
        armedWallet: { funders: [A.FUNDER], minEth: 0.009, maxEth: 0.015, freshOnly: true, maxAgeSec: 172_800, contractMode: true },
        require: ['armedWallet'],
      },
      preset: { exitIfExemptSellsPct: 20, trailing: null },
      grid: true,
    });
    expect(r['coins']).toBe(2);
    const summary = r['summary'] as { n: number; winRate: number };
    expect(summary.n).toBe(2);
    expect(summary.winRate).toBe(1);
    expect((r['preset'] as Record<string, unknown>)['trailing']).toBeUndefined();
    expect((r['derivedFromPeaks'] as { takeProfits: unknown[] }).takeProfits).toHaveLength(1);
    expect((r['grid'] as { insufficient: boolean }).insufficient).toBe(true); // 2 coins < 5
    expect(ctx.state.lastBacktest?.n).toBe(2);
  });

  it('write_report renders the template with DB-backed coin rows', async () => {
    const r = await call('write_report', {
      title: 'Amlil sprayer',
      pattern: 'team_buys',
      operator_summary: 'Team wallets buy in the launch second.',
      how_funded: 'Sprayer -> disperse -> fresh dev.',
      how_to_catch: 'Watch the sprayer.',
      recommended_preset: 'TP +150 %.',
      caveats: 'Two coins.',
      tokens: [A.TOKEN1, A.TOKEN2],
    });
    const md = readFileSync(String(r['path']), 'utf8');
    expect(md).toContain('2 coins');
    expect(md).toContain('Derived from the peak distribution');
    expect(md).toContain('ETH/USD 4000 (settings)');
    expect(ctx.state.reportPath).toBe(r['path']);
  });

  it('eth_usd reads the setting', async () => {
    expect(await call('eth_usd', {})).toMatchObject({ usd: 4000, source: 'settings' });
  });

  it('propose_play refuses a trigger with no condition', async () => {
    const t = tools.get('propose_play')!;
    const input = t.parse({
      operator_name: 'operator-x',
      operator_notes: '',
      play_name: 'empty',
      pattern: 'unknown',
      trigger: { require: [] },
      evidence_tokens: [A.TOKEN1],
      summary: 's',
    });
    await expect(Promise.resolve(t.run(input))).rejects.toThrow(/at least one condition/);
    expect((await db.pg.query('select 1 from plays')).rows).toHaveLength(0);
  });
});

describe('compactJson', () => {
  it('halves the largest array until the payload fits and says so', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
    const out = JSON.parse(compactJson({ rows, next_offset: 500 }, 10_000)) as { rows: unknown[]; truncated: string };
    expect(out.rows.length).toBeLessThan(100);
    expect(out.truncated).toMatch(/rows cut/);
  });
});
