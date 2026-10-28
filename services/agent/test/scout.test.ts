import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScout, type AgentDeps } from '../src/runner.js';
import { clusterRunners, fingerprintOf, INFRA_ADDRESSES, type RunnerFingerprint } from '../src/scout.js';
import type { LaunchContext } from '../src/trigger.js';
import { createTestDb, type TestDb } from './helpers/pg.js';
import { mockAnthropic } from './helpers/mockAnthropic.js';
import { A, T, addr, seedOperator } from './helpers/seed.js';

const fp = (token: string, o: Partial<RunnerFingerprint>): RunnerFingerprint => ({
  token,
  name: token,
  ts: T,
  peakPct: 150,
  deployer: addr(`d${token}`),
  teamWallets: [],
  funders: [],
  deployerFunder: null,
  ...o,
});

describe('clusterRunners', () => {
  const EXCHANGE = addr('ec');
  const rows: RunnerFingerprint[] = [
    // operator 1: same sprayer, one coin via a disperse contract (creator = sprayer)
    fp('a1', { funders: [addr('5a'), EXCHANGE], ts: T + 10, peakPct: 300 }),
    fp('a2', { funders: [addr('c0'), addr('5a')], ts: T + 20 }),
    // operator 2: different deployers and funders but the same exempt team wallet
    fp('b1', { teamWallets: [addr('7e')], funders: [addr('b5')] }),
    fp('b2', { teamWallets: [addr('7e')], funders: [addr('b6'), EXCHANGE] }),
    // lone runner, its only links are the exchange hub and router infra
    fp('c1', { funders: [EXCHANGE, INFRA_ADDRESSES[4]!], teamWallets: [INFRA_ADDRESSES[1]!] }),
    // operator 3: one deployer, two coins
    fp('d1', { deployer: addr('dd') }),
    fp('d2', { deployer: addr('dd'), peakPct: 900 }),
  ];

  it('groups by shared funder, team wallet and deployer, ignoring hubs and infra', () => {
    const clusters = clusterRunners(rows, { ignore: [EXCHANGE] });
    const sets = clusters.map((c) => c.tokens.map((t) => t.token).sort().join(','));
    expect(sets).toEqual(['d1,d2', 'a1,a2', 'b1,b2', 'c1']); // size desc, then best peak
    const a = clusters.find((c) => c.key === 'a1')!;
    expect(a.sharedFunders).toEqual([addr('5a')]);
    expect(clusters.find((c) => c.key === 'b1')!.sharedTeamWallets).toEqual([addr('7e')]);
    expect(clusters.find((c) => c.key === 'd1')!.sharedDeployers).toEqual([addr('dd')]);
    expect(clusters.every((c) => !c.covered)).toBe(true);
  });

  it('merges everything through an un-ignored hub (why SCOUT_IGNORE exists) and honours minSize', () => {
    expect(clusterRunners(rows).filter((c) => c.tokens.length > 2)).toHaveLength(1);
    expect(clusterRunners(rows, { ignore: [EXCHANGE], minSize: 2 }).map((c) => c.key)).not.toContain('c1');
  });

  it('marks clusters covered by an existing play (by funder key or by trigger match)', () => {
    const plays = [
      { playId: 7, trigger: { armedWallet: { funders: [addr('5a')], minEth: 0, maxEth: 1, freshOnly: true, maxAgeSec: 3600, contractMode: true }, require: ['armedWallet' as const] } },
      { playId: 9, trigger: { nameRegex: '^b', require: [] } },
    ];
    const contexts = new Map<string, LaunchContext>(
      rows.map((r) => [r.token, { token: r.token, name: r.name, symbol: null, deployer: r.deployer, launchKind: 'noDevBuy', devBuyEth: null, teamWallets: r.teamWallets, fundings: [] }]),
    );
    const clusters = clusterRunners(rows, { ignore: [EXCHANGE], plays, contexts });
    expect(clusters.find((c) => c.key === 'a1')).toMatchObject({ covered: true, coveredBy: [7] });
    expect(clusters.find((c) => c.key === 'b1')).toMatchObject({ covered: true, coveredBy: [9] });
    expect(clusters.find((c) => c.key === 'd1')!.covered).toBe(false);
  });

  it('builds fingerprints with the funder and the creator of a funding contract', () => {
    const f = fingerprintOf(
      {
        token: 't',
        name: 'n',
        symbol: null,
        deployer: addr('de'),
        launchKind: null,
        devBuyEth: null,
        teamWallets: [addr('7e')],
        fundings: [
          { wallet: addr('de'), role: 'deployer', funder: addr('d15e'), funderCreator: addr('f1'), valueEth: 0.01, fresh: true },
          { wallet: addr('7e'), role: 'team', funder: addr('d15e'), funderCreator: addr('f1'), valueEth: 0.0004, fresh: true },
        ],
      },
      { ts: T, peakPct: 200 },
    );
    expect(f.funders.sort()).toEqual([addr('d15e'), addr('f1')].sort());
    expect(f.deployerFunder).toBe(addr('d15e'));
  });
});

describe('runScout', () => {
  let db: TestDb;
  let dir: string;
  beforeAll(async () => {
    db = await createTestDb();
    await seedOperator(db.pg);
    dir = mkdtempSync(path.join(tmpdir(), 'agent-scout-'));
  });
  afterAll(async () => {
    await db.pg.close();
  });

  const deps = (client: AgentDeps['client']): AgentDeps => ({
    sql: db.sql,
    client,
    rpc: null,
    reportsDir: dir,
    logger: pino({ level: 'silent' }),
    now: () => new Date((T + 2 * 86_400) * 1000),
    limits: { maxRounds: 10, maxCostUsd: 2 },
    scout: { maxClusters: 1, minClusterSize: 2, ignore: [] },
  });

  it('clusters runners with SQL first and only calls the model for uncovered clusters', async () => {
    const mock = mockAnthropic([{ blocks: [{ type: 'text', text: 'One operator: amlil sprayer.' }], stop: 'end_turn' }]);
    const r = await runScout({ sinceMinutes: 4 * 1440, minPeak10Pct: 100 }, deps(mock.client));
    expect(r.runners).toBe(2);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.tokens.sort()).toEqual([A.TOKEN1, A.TOKEN2].sort());
    expect(r.clusters[0]!.sharedFunders).toContain(A.FUNDER);
    expect(r.clusters[0]!.sharedTeamWallets.sort()).toEqual([A.TEAM1, A.TEAM2].sort());
    expect(r.investigated).toHaveLength(1);
    expect(mock.requests).toHaveLength(1);
    const msg = String(mock.requests[0]!.body.messages[0]!.content);
    expect(msg).toContain('Scout request');
    expect(msg).toContain(A.TOKEN2);
    const kinds = await db.pg.query<{ kind: string }>(`select kind from agent_runs order by id`);
    expect(kinds.rows.map((k) => k.kind)).toEqual(['scout', 'scout']);

    // once a play covers the sprayer, the next pass does not call the model
    await db.pg.exec(`insert into operators (name, status, created_by) values ('amlil', 'active', 'test');
      insert into plays (operator_id, name, enabled, trigger, preset, created_by)
      values (1, 'amlil', true, '{"armedWallet":{"funders":["${A.FUNDER}"],"minEth":0.009,"maxEth":0.015,"freshOnly":true,"maxAgeSec":172800,"contractMode":true},"require":["armedWallet"]}', '{}', 'test');`);
    const quiet = mockAnthropic([]);
    const r2 = await runScout({ sinceMinutes: 4 * 1440, minPeak10Pct: 100 }, deps(quiet.client));
    expect(r2.skippedCovered).toBe(1);
    expect(r2.clusters[0]!.coveredBy).toEqual([1]);
    expect(r2.investigated).toHaveLength(0);
    expect(quiet.requests).toHaveLength(0);
    expect(r2.costUsd).toBe(0);
  });
});

describe('runScout + settings.auto_approve', () => {
  let db: TestDb;
  let dir: string;
  beforeAll(async () => {
    db = await createTestDb();
    await seedOperator(db.pg);
    dir = mkdtempSync(path.join(tmpdir(), 'agent-scout-auto-'));
  });
  afterAll(async () => {
    await db.pg.close();
  });

  it('a generic fingerprint play does not cover operator clusters; a proposal clearing the policy is enabled at once', async () => {
    // the seeded generic play matches both Amlil coins (0.38 ETH team buys) but targets a pattern, not this operator
    await db.pg.exec(`insert into plays (name, enabled, trigger, preset, created_by)
      values ('team-buy-0.1', true, '{"launchSecond":{"minTeamBuyEth":0.1}}', '{}', 'seed');
      insert into settings (key, value) values ('auto_approve', '{"enabled":true,"minCoins":1,"minExpectancyEth":-1,"minWinRate":0,"maxConcurrentPlays":20}');`);
    const mock = mockAnthropic([
      {
        blocks: [
          {
            type: 'tool_use',
            name: 'propose_play',
            input: {
              operator_name: 'amlil-sprayer',
              operator_notes: 'sprayer',
              play_name: 'amlil fresh-dev',
              pattern: 'team_buys',
              trigger: { armedWallet: { funders: [A.FUNDER], minEth: 0.009, maxEth: 0.015, freshOnly: true, maxAgeSec: 172_800, contractMode: true }, require: ['armedWallet'] },
              evidence_tokens: [A.TOKEN1, A.TOKEN2],
              summary: 'two coins, one sprayer',
            },
          },
        ],
        stop: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Proposed.' }], stop: 'end_turn' },
    ]);
    const r = await runScout(
      { sinceMinutes: 4 * 1440, minPeak10Pct: 100 },
      {
        sql: db.sql,
        client: mock.client,
        rpc: null,
        reportsDir: dir,
        logger: pino({ level: 'silent' }),
        now: () => new Date((T + 2 * 86_400) * 1000),
        limits: { maxRounds: 10, maxCostUsd: 2 },
        scout: { maxClusters: 1, minClusterSize: 2, ignore: [] },
      },
    );
    expect(r.skippedCovered).toBe(0);
    expect(r.investigated).toHaveLength(1);
    const playId = r.investigated[0]!.proposedPlays[0]!.playId;
    expect(r.autoApproval).toEqual([{ playId, approved: true, reasons: [expect.stringMatching(/^n 2, expectancy/)] }]);
    expect(r.summary).toMatch(/1 play\(s\) proposed, 1 auto-approved/);
    const play = await db.pg.query<{ enabled: boolean; status: string }>(`select p.enabled, o.status from plays p join operators o on o.id = p.operator_id where p.id = $1`, [playId]);
    expect(play.rows[0]).toEqual({ enabled: true, status: 'active' });
    const ev = await db.pg.query<{ type: string }>(`select type from events where type in ('play_proposed', 'play_auto_approved', 'scout_finished') order by id`);
    expect(ev.rows.map((e) => e.type)).toEqual(['play_proposed', 'play_auto_approved', 'scout_finished']);
  });
});
