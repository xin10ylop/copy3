import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSV_COLUMNS } from '../src/report.js';
import { FALLBACK_BETA, MODEL, accountMessage, emptyUsage, runPlayFinder, type AgentDeps } from '../src/runner.js';
import { SYSTEM_PROMPT } from '../src/prompts.js';
import { TOOL_NAMES } from '../src/tools.js';
import { createTestDb, type TestDb } from './helpers/pg.js';
import { mockAnthropic, type ScriptedTurn } from './helpers/mockAnthropic.js';
import { A, T, seedOperator } from './helpers/seed.js';

let db: TestDb;
let dir: string;

beforeEach(async () => {
  db = await createTestDb();
  await seedOperator(db.pg);
  dir = mkdtempSync(path.join(tmpdir(), 'agent-run-'));
});
afterEach(async () => {
  await db.pg.close();
});

function deps(client: AgentDeps['client'], over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    sql: db.sql,
    client,
    rpc: { getBalance: async () => 25_000_000_000_000n },
    reportsDir: dir,
    logger: pino({ level: 'silent' }),
    now: () => new Date((T + 5 * 86_400) * 1000),
    limits: { maxRounds: 60, maxCostUsd: 8 },
    scout: { maxClusters: 1, minClusterSize: 2, ignore: [] },
    ...over,
  };
}

const PLAY_SCRIPT: ScriptedTurn[] = [
  {
    blocks: [
      { type: 'thinking', thinking: 'Start with the token.' },
      { type: 'text', text: 'Looking up the token.' },
      { type: 'tool_use', name: 'get_token', input: { ca: A.TOKEN1.toUpperCase().replace('0X', '0x') } },
    ],
    stop: 'tool_use',
  },
  { blocks: [{ type: 'tool_use', name: 'get_wallet_funding', input: { address: A.DEV1, depth: 4 } }], stop: 'tool_use' },
  {
    blocks: [
      {
        type: 'tool_use',
        name: 'write_csv',
        input: {
          rows: [
            { ca: A.TOKEN1, notes: 'team buys, dump via transfer' },
            { ca: A.TOKEN2, notes: 'same sprayer, direct funding' },
          ],
          slug: 'amlil-sprayer',
        },
      },
    ],
    stop: 'tool_use',
  },
  {
    blocks: [
      {
        type: 'tool_use',
        name: 'propose_play',
        input: {
          operator_name: 'amlil-sprayer',
          operator_notes: 'Sprayer funds fresh devs directly or via a disperse contract it creates.',
          play_name: 'amlil fresh-dev 0.010-0.015',
          pattern: 'team_buys',
          trigger: {
            armedWallet: { funders: [A.FUNDER], minEth: 0.009, maxEth: 0.015, freshOnly: true, maxAgeSec: 172_800, contractMode: true },
            launchKind: 'noDevBuy',
            require: ['armedWallet'],
          },
          preset: { takeProfits: [{ pct: 150, sellPct: 100 }], stopLossPct: 40, exitIfExemptSellsPct: 20 },
          evidence_tokens: [A.TOKEN1, A.TOKEN2],
          summary: 'Two coins from one sprayer; team wallets exit via a dump wallet at +6 s.',
        },
      },
    ],
    stop: 'tool_use',
  },
  { blocks: [{ type: 'text', text: 'Operator amlil-sprayer (team buys), 2 coins. Play proposed for approval.' }], stop: 'end_turn' },
];

describe('runPlayFinder with a scripted model', () => {
  it('runs get_token -> get_wallet_funding -> write_csv -> propose_play and records the run', async () => {
    const mock = mockAnthropic(PLAY_SCRIPT);
    const r = await runPlayFinder({ ca: A.TOKEN1, hint: 'the video coin' }, deps(mock.client));

    expect(mock.requests).toHaveLength(5);
    expect(mock.remaining()).toBe(0);
    expect(r.stop).toBe('end_turn');
    expect(r.rounds).toBe(5);
    expect(r.summary).toContain('Operator amlil-sprayer');

    // request shape (claude-api skill)
    const first = mock.requests[0]!;
    expect(first.url).toContain('/v1/messages');
    expect(first.body['model']).toBe(MODEL);
    expect(first.body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(first.body['output_config']).toEqual({ effort: 'high' });
    expect(first.body['fallbacks']).toBe('default');
    expect(first.body['stream']).toBe(true);
    expect(first.body['tool_choice']).toBeUndefined();
    expect(first.body['max_iterations']).toBeUndefined();
    expect(first.body['cache_control']).toEqual({ type: 'ephemeral' });
    expect(first.body['system']).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(first.headers.get('anthropic-beta')).toContain(FALLBACK_BETA);
    const tools = first.body.tools!;
    expect(tools.map((t) => t['name'])).toEqual([...TOOL_NAMES]);
    expect(tools.every((t) => t['eager_input_streaming'] === true)).toBe(true);
    expect(tools.every((t) => t['run'] === undefined)).toBe(true);
    expect(String(first.body.messages[0]!.content)).toContain(A.TOKEN1);
    // the prefix (system + tools) is byte-identical on every turn, so the cache can hit
    for (const req of mock.requests) {
      expect(JSON.stringify(req.body['system'])).toBe(JSON.stringify(first.body['system']));
      expect(JSON.stringify(req.body.tools)).toBe(JSON.stringify(first.body.tools));
    }

    // tool results were fed back (the upper-case CA was lower-cased by the schema)
    const second = mock.requests[1]!;
    const toolResult = (second.body.messages[2]!.content as Array<{ type: string; content: string; is_error?: boolean }>)[0]!;
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.is_error).toBeUndefined();
    expect(toolResult.content).toContain('"found":true');
    expect(toolResult.content).toContain(A.TEAM1);
    const fundingResult = (mock.requests[2]!.body.messages[4]!.content as Array<{ content: string }>)[0]!.content;
    expect(fundingResult).toContain(A.DISPERSE);

    // files
    expect(r.csvPath).not.toBeNull();
    expect(existsSync(r.csvPath!)).toBe(true);
    expect(path.dirname(r.csvPath!)).toBe(path.resolve(dir));
    const csv = readFileSync(r.csvPath!, 'utf8').trim().split('\n');
    expect(csv[0]).toBe(CSV_COLUMNS.join(','));
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain(A.TOKEN1);
    expect(csv[1]).toContain('YES 2');
    expect(r.reportPath).not.toBeNull();
    expect(readFileSync(r.reportPath!, 'utf8')).toContain('(incomplete)'); // the script never called write_report

    // proposed play
    expect(r.proposedPlay).toBeDefined();
    expect(r.proposedPlay!.preset.exitIfExemptSellsPct).toBe(20);
    expect(r.proposedPlay!.preset.buyEth).toBe(0.07);
    expect(r.proposedPlay!.stats['triggerMatches']).toBe(2);
    const plays = await db.pg.query<{ id: number; enabled: boolean; status: string; created_by: string }>(
      `select p.id, p.enabled, o.status, p.created_by from plays p join operators o on o.id = p.operator_id`,
    );
    expect(plays.rows).toEqual([{ id: r.proposedPlay!.playId, enabled: false, status: 'candidate', created_by: 'agent' }]);
    const events = await db.pg.query<{ type: string; payload: Record<string, unknown> }>(`select type, payload from events order by id`);
    expect(events.rows.map((e) => e.type)).toEqual(['play_proposed', 'agent_run_finished']);
    expect(events.rows[0]!.payload).toMatchObject({ playId: r.proposedPlay!.playId, runId: r.runId, needsApproval: true });

    // run record: 5 turns x (1000 in x $4 + 200 out x $20 + 5000 cache read x $0.20) / 1e6
    expect(r.costUsd).toBeCloseTo(0.045, 9);
    const run = await db.pg.query<{ kind: string; cost_usd: number; csv_path: string; proposed_play: { playId: number }; report_md: string; input: { args: { ca: string }; meta: { rounds: number; toolCalls: Array<{ name: string; ok: boolean }> } } }>(
      `select kind, cost_usd, csv_path, proposed_play, report_md, input from agent_runs where id = $1`,
      [r.runId],
    );
    const row = run.rows[0]!;
    expect(row.kind).toBe('play');
    expect(row.cost_usd).toBeCloseTo(0.045, 9);
    expect(row.csv_path).toBe(r.csvPath);
    expect(row.proposed_play.playId).toBe(r.proposedPlay!.playId);
    expect(row.report_md).toContain('## Operator summary');
    expect(row.input.args.ca).toBe(A.TOKEN1);
    expect(row.input.meta.rounds).toBe(5);
    expect(row.input.meta.toolCalls.map((c) => c.name)).toEqual(['get_token', 'get_wallet_funding', 'write_csv', 'propose_play']);
    expect(row.input.meta.toolCalls.every((c) => c.ok)).toBe(true);
  });

  it('returns a validation error to the model for a bad address instead of running the tool', async () => {
    const mock = mockAnthropic([
      { blocks: [{ type: 'tool_use', name: 'get_wallet', input: { address: '0x1234' } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: 'Bad address.' }], stop: 'end_turn' },
    ]);
    const r = await runPlayFinder({ ca: A.TOKEN1 }, deps(mock.client));
    const result = (mock.requests[1]!.body.messages[2]!.content as Array<{ is_error?: boolean; content: string }>)[0]!;
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/address/);
    expect(r.stop).toBe('end_turn');
  });

  it('stops on a refusal without running that turn\'s tools and still returns report + CSV', async () => {
    const mock = mockAnthropic([
      {
        blocks: [{ type: 'tool_use', name: 'propose_play', input: { operator_name: 'x' } }],
        stop: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: 'declined by policy' },
      },
    ]);
    const r = await runPlayFinder({ ca: A.TOKEN1 }, deps(mock.client));
    expect(mock.requests).toHaveLength(1);
    expect(r.stop).toBe('refusal');
    expect(r.summary).toContain('cyber');
    expect(r.proposedPlays).toHaveLength(0);
    expect((await db.pg.query(`select 1 from plays`)).rows).toHaveLength(0);
    expect(readFileSync(r.csvPath!, 'utf8')).toContain(A.TOKEN1);
    expect(existsSync(r.reportPath!)).toBe(true);
    const ev = await db.pg.query<{ level: string; type: string }>(`select level, type from events`);
    expect(ev.rows).toEqual([{ level: 'warn', type: 'agent_run_finished' }]);
  });

  it('enforces the tool-round cap and the cost budget', async () => {
    const loop: ScriptedTurn[] = Array.from({ length: 10 }, () => ({ blocks: [{ type: 'tool_use', name: 'eth_usd', input: {} }], stop: 'tool_use' as const }));
    const capped = mockAnthropic(loop);
    const r1 = await runPlayFinder({ ca: A.TOKEN1 }, deps(capped.client, { limits: { maxRounds: 3, maxCostUsd: 100 } }));
    expect(r1.stop).toBe('max_rounds');
    expect(capped.requests).toHaveLength(3);
    // the last turn's tool result carried the budget notice before the cap
    const lastResult = (capped.requests[2]!.body.messages.at(-1)!.content as Array<{ content: string }>)[0]!.content;
    expect(lastResult).toContain('budget_notice');

    const pricey = mockAnthropic(loop.map((t) => ({ ...t, usage: { input_tokens: 100_000, output_tokens: 10_000 } })));
    const r2 = await runPlayFinder({ ca: A.TOKEN1 }, deps(pricey.client, { limits: { maxRounds: 60, maxCostUsd: 1 } }));
    expect(r2.stop).toBe('budget');
    expect(pricey.requests).toHaveLength(2); // 0.6 USD per turn
    expect(r2.costUsd).toBeCloseTo(1.2, 9);
  });

  it('rejects an invalid CA before touching the model', async () => {
    const mock = mockAnthropic([]);
    await expect(runPlayFinder({ ca: 'not-an-address' }, deps(mock.client))).rejects.toThrow(/invalid contract address/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('cost accounting', () => {
  it('prices fallback iterations at the serving model rates', () => {
    const t = emptyUsage();
    accountMessage(t, {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
        inference_geo: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
        iterations: [
          { type: 'message', input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null } as never,
        ],
      },
    });
    // declined attempt on the requested model (Opus 5.5, $4/MTok) + fallback served by Opus 4.8 ($5/MTok)
    expect(t.costUsd).toBeCloseTo(9, 9);
    expect(t.fallbacks).toBe(1);
  });
});
