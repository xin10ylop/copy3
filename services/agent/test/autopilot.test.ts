import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';
import {
  autoApproveProposals,
  autoApproveVerdict,
  decideNightly,
  DEFAULT_NIGHTLY,
  losingOperators,
  mergeBlacklist,
  msUntilNextRun,
  parseAutoApprovePolicy,
  proposalStats,
  refitPreset,
  rollingExpectancy,
  runNightly,
  withExits,
  type RefitResult,
} from '../src/autopilot.js';
import { loadEnv, nightlyOptions } from '../src/config.js';
import { DEFAULT_AUTO_APPROVE, PlayTriggerSchema, PresetSchema, fromPglite } from '../src/deps.js';
import { insertProposedPlay } from '../src/queries.js';
import type { ProposedPlay } from '../src/tools.js';
import { createTestDb, type TestDb } from './helpers/pg.js';
import { addr, insertClosedSnipes, insertLaunches, type SynthLaunch } from './helpers/synthetic.js';
import type { BacktestSummary, SnipeResult } from '../src/backtest.js';

const log = pino({ level: 'silent' });
const summary = (o: Partial<BacktestSummary>): BacktestSummary => ({
  n: 30,
  nSkipped: 0,
  winRate: 0.4,
  avgPnlEth: 0.003,
  avgPnlPct: 4,
  medianPnlPct: -8,
  pnlSum: 0.09,
  maxDD: 0.02,
  expectancyEth: 0.003,
  exitReasons: {},
  firstLaunchTs: 0,
  lastLaunchTs: 0,
  ...o,
});

describe('auto-approval policy (pure)', () => {
  const policy = DEFAULT_AUTO_APPROVE;
  it('parses settings.auto_approve; absent / malformed = disabled; missing fields default', () => {
    expect(parseAutoApprovePolicy(null)).toBeNull();
    expect(parseAutoApprovePolicy('on')).toBeNull();
    expect(parseAutoApprovePolicy({ enabled: true })).toEqual(DEFAULT_AUTO_APPROVE);
    expect(parseAutoApprovePolicy({ enabled: 'yes', minCoins: 50 })).toMatchObject({ enabled: false, minCoins: 50 });
  });

  it('approves only when every bar is cleared', () => {
    const ok = { n: 12, expectancyEth: 0.004, winRate: 0.4 };
    expect(autoApproveVerdict(ok, policy, 3)).toMatchObject({ approve: true });
    expect(autoApproveVerdict({ ...ok, n: 9 }, policy, 3).reasons.join()).toMatch(/n 9 < minCoins 10/);
    expect(autoApproveVerdict({ ...ok, expectancyEth: 0.0019 }, policy, 3).reasons.join()).toMatch(/expectancy 0\.0019 ETH < min 0\.002/);
    expect(autoApproveVerdict({ ...ok, winRate: 0.3 }, policy, 3).reasons.join()).toMatch(/win rate 30 % < min 35 %/);
    expect(autoApproveVerdict(ok, policy, 20).reasons.join()).toMatch(/20 plays enabled ≥ maxConcurrentPlays 20/);
    expect(autoApproveVerdict(ok, { ...policy, enabled: false }, 0)).toEqual({ approve: false, reasons: ['auto_approve disabled'] });
    expect(autoApproveVerdict(ok, null, 0).approve).toBe(false);
    expect(autoApproveVerdict(null, policy, 0).reasons).toEqual(['proposal has no backtest']);
  });

  it('reads the backtest stored by propose_play', () => {
    expect(proposalStats({ backtest: { n: 12, expectancyEth: 0.004, winRate: 0.5, maxDD: 0.1 } })).toEqual({ n: 12, expectancyEth: 0.004, winRate: 0.5 });
    expect(proposalStats({})).toBeNull();
  });
});

describe('nightly decisions (pure)', () => {
  const preset = PresetSchema.parse({ trailing: null, timeoutSec: 120 });
  const generic = PlayTriggerSchema.parse({ launchSecond: { minTeamBuyEth: 0.1 } });
  const operator = PlayTriggerSchema.parse({ deployerIn: [addr('d1')] });
  const refit = (o: Partial<RefitResult> = {}): RefitResult => ({
    n: 30,
    insufficient: false,
    current: summary({ expectancyEth: 0.001 }),
    best: { preset: { ...preset, trailing: { activatePct: 50, dropPct: 20 }, timeoutSec: 60 }, summary: summary({ expectancyEth: 0.004 }) },
    perToken: [],
    bestPerToken: [],
    ...o,
  });
  const base = { preset, ctxByToken: new Map(), opts: DEFAULT_NIGHTLY, rolling: { n: 0, expectancyEth: null } };

  it('refits when the best grid preset beats the current one by more than the margin', () => {
    const d = decideNightly({ ...base, trigger: operator, refit: refit() });
    expect(d.action).toBe('refit');
    expect(d.newPreset).toMatchObject({ trailing: { activatePct: 50, dropPct: 20 }, timeoutSec: 60, buyEth: preset.buyEth });
    expect(d.reasons.join()).toMatch(/refit: 0\.00100 → 0\.00400 ETH per snipe over 30 snipes/);
  });

  it('keeps the preset inside the margin, and when there are too few coins', () => {
    const within = refit({ best: { preset, summary: summary({ expectancyEth: 0.0014 }) } });
    expect(decideNightly({ ...base, trigger: operator, refit: within }).action).toBe('keep');
    const few = refit({ n: 4, insufficient: true, best: null, current: summary({ n: 4, expectancyEth: -0.01 }) });
    const d = decideNightly({ ...base, trigger: operator, refit: few });
    expect(d.action).toBe('insufficient'); // a refit-based disable needs minCoins too
  });

  it('disables on a rolling realised expectancy ≤ 0 (with enough trades) or a refit expectancy ≤ 0', () => {
    expect(decideNightly({ ...base, trigger: operator, refit: refit(), rolling: { n: 30, expectancyEth: -0.0001 } })).toMatchObject({ action: 'disable' });
    expect(decideNightly({ ...base, trigger: operator, refit: refit(), rolling: rollingExpectancy([-0.01, -0.01], 10) }).action).toBe('refit'); // 2 trades < 10
    const bad = refit({ current: summary({ expectancyEth: -0.002 }), best: { preset, summary: summary({ expectancyEth: 0 }) } });
    expect(decideNightly({ ...base, trigger: operator, refit: bad }).reasons.join()).toMatch(/refit expectancy 0\.00000 ETH ≤ 0 over 30 snipes/);
  });

  it('rollingExpectancy needs minTrades', () => {
    expect(rollingExpectancy([0.01, -0.02, 0.004], 3)).toEqual({ n: 3, expectancyEth: expect.closeTo(-0.002, 12) });
    expect(rollingExpectancy([0.01], 3)).toEqual({ n: 1, expectancyEth: null });
  });

  it('losingOperators: the last N launches of a deployer / team wallet all lost', () => {
    const r = (token: string, ts: number, pnl: number, entered = true): Pick<SnipeResult, 'token' | 'launchTs' | 'entered' | 'pnlEth'> => ({ token, launchTs: ts, entered, pnlEth: pnl });
    const ctx = new Map<string, { deployer: string; teamWallets: string[] }>();
    const results: ReturnType<typeof r>[] = [];
    // operator A: a win long ago, then 5 losses → blacklisted; operator B: 5 launches, one recent win → kept
    for (let i = 0; i < 6; i++) {
      ctx.set(`a${i}`, { deployer: addr('da'), teamWallets: [addr('7a')] });
      results.push(r(`a${i}`, i, i === 0 ? 0.05 : -0.01));
      ctx.set(`b${i}`, { deployer: addr('db'), teamWallets: [addr('7b')] });
      results.push(r(`b${i}`, i, i === 4 ? 0.05 : -0.01));
    }
    // operator C: only 4 launches
    for (let i = 0; i < 4; i++) {
      ctx.set(`c${i}`, { deployer: addr('dc'), teamWallets: [] });
      results.push(r(`c${i}`, i, -0.01));
    }
    expect(losingOperators(results, ctx, 5)).toEqual({ deployers: [addr('da')], teamWallets: [addr('7a')] });
    // skipped (not entered) launches do not count
    expect(losingOperators(results.map((x) => ({ ...x, entered: x.token.startsWith('b') })), ctx, 5)).toEqual({ deployers: [], teamWallets: [] });
  });

  it('generic plays blacklist losing operators; operator plays never do', () => {
    const per = Array.from({ length: 5 }, (_, i) => ({ token: `l${i}`, launchTs: i, entered: true, pnlEth: -0.01 }) as SnipeResult);
    const ctxByToken = new Map(per.map((p) => [p.token, { deployer: addr('d7'), teamWallets: [addr('71')] }]));
    const g = decideNightly({ ...base, ctxByToken, trigger: generic, refit: refit({ perToken: per, bestPerToken: per }) });
    expect(g.newTrigger).toMatchObject({ launchSecond: { minTeamBuyEth: 0.1 }, deployerNotIn: [addr('d7')], teamWalletsNotIn: [addr('71')] });
    expect(g.blacklisted).toEqual({ deployers: [addr('d7')], teamWallets: [addr('71')] });
    expect(decideNightly({ ...base, ctxByToken, trigger: operator, refit: refit({ perToken: per, bestPerToken: per }) }).newTrigger).toBeUndefined();
    // already listed → nothing new
    const listed = PlayTriggerSchema.parse({ ...generic, deployerNotIn: [addr('d7')], teamWalletsNotIn: [addr('71')] });
    expect(decideNightly({ ...base, ctxByToken, trigger: listed, refit: refit({ perToken: per, bestPerToken: per }) }).newTrigger).toBeUndefined();
  });

  it('mergeBlacklist dedupes and caps (newest kept); withExits turns a missing trailing/timeout into null (= off)', () => {
    const t = PlayTriggerSchema.parse({ launchSecond: { minTeamBuyEth: 0.1 }, deployerNotIn: [addr('1'), addr('2')] });
    const m = mergeBlacklist(t, { deployers: [addr('2'), addr('3')], teamWallets: [] }, 2);
    expect(m.trigger.deployerNotIn).toEqual([addr('2'), addr('3')]);
    expect(m.added).toEqual({ deployers: [addr('3')], teamWallets: [] });
    const p = withExits(PresetSchema.parse({}), { buyEth: 0.07, maxTaxBps: 1000, takeProfits: [{ pct: 150, sellPct: 100 }], stopLossPct: 30, abortIfExemptSellInLaunchBlock: true, trailing: undefined, timeoutSec: null });
    expect(p).toMatchObject({ takeProfits: [{ pct: 150, sellPct: 100 }], trailing: null, timeoutSec: null, stopLossPct: 30 });
  });

  it('msUntilNextRun: next NIGHTLY_HOUR_UTC strictly in the future', () => {
    expect(msUntilNextRun(new Date(Date.UTC(2026, 9, 28, 1, 30)), 3)).toBe(90 * 60_000);
    expect(msUntilNextRun(new Date(Date.UTC(2026, 9, 28, 3, 0)), 3)).toBe(24 * 3600_000);
    expect(msUntilNextRun(new Date(Date.UTC(2026, 9, 28, 22, 0)), 3)).toBe(5 * 3600_000);
  });

  it('env: NIGHTLY_HOUR_UTC 3, REFIT_DAYS 3 by default', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x' });
    expect(env.NIGHTLY_HOUR_UTC).toBe(3);
    expect(nightlyOptions(env)).toEqual({ refitDays: 3, minCoins: 20, marginEth: 0.0005, rollingTrades: 30, minTrades: 10, blacklistMinLaunches: 5 });
  });
});

// ---------------------------------------------------------------------------
// PGlite: auto-approval and the nightly job end to end
// ---------------------------------------------------------------------------

const NOW = 1_792_800_000; // 2026-10-23T…
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.pg.close();
});
beforeEach(async () => {
  await db.pg.exec(
    'TRUNCATE curve_trades, token_transfers, eth_transfers, token_metrics, armed_candidates, snipes, launches, plays, operators, wallets, agent_runs, settings, events RESTART IDENTITY CASCADE;',
  );
});

const events = async (type: string): Promise<Array<{ level: string; payload: Record<string, unknown> }>> =>
  db.pg.query<{ level: string; payload: Record<string, unknown> }>(`select level, payload from events where type = $1 order by id`, [type]).then((r) => r.rows);
const playRow = async (id: number) =>
  (await db.pg.query<{ enabled: boolean; trigger: Record<string, unknown>; preset: Record<string, unknown>; stats: Record<string, unknown> }>(`select enabled, trigger, preset, stats from plays where id = $1`, [id])).rows[0]!;

async function propose(name: string, backtest: Record<string, unknown>): Promise<ProposedPlay> {
  const trigger = PlayTriggerSchema.parse({ deployerIn: [addr('de')] });
  const preset = PresetSchema.parse({});
  const stats = { backtest };
  const rec = await insertProposedPlay(db.sql, { operatorName: `op ${name}`, operatorNotes: '', playName: name, trigger, preset, stats, runId: 1, summary: 's' });
  return { ...rec, name, operatorName: `op ${name}`, pattern: 'team_buys', trigger, preset, stats };
}

describe('autoApproveProposals (PGlite)', () => {
  it('enables a proposal that clears settings.auto_approve, activates its operator and emits play_auto_approved; the rest wait for Telegram', async () => {
    await db.pg.query(`insert into settings (key, value) values ('auto_approve', $1::jsonb)`, [JSON.stringify(DEFAULT_AUTO_APPROVE)]);
    const good = await propose('good', { n: 14, expectancyEth: 0.005, winRate: 0.43 });
    const thin = await propose('thin', { n: 6, expectancyEth: 0.02, winRate: 0.5 });
    const out = await autoApproveProposals(db.sql, [good, thin], log);
    expect(out.map((o) => [o.playId, o.approved])).toEqual([
      [good.playId, true],
      [thin.playId, false],
    ]);
    expect((await playRow(good.playId)).enabled).toBe(true);
    expect((await playRow(thin.playId)).enabled).toBe(false);
    const ops = (await db.pg.query<{ id: number; status: string }>('select id, status from operators order by id')).rows;
    expect(ops.find((o) => o.id === good.operatorId)!.status).toBe('active');
    expect(ops.find((o) => o.id === thin.operatorId)!.status).toBe('candidate');
    const ev = await events('play_auto_approved');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ playId: good.playId, name: 'good', notify: true });
  });

  it('respects maxConcurrentPlays (each approval counts) and a missing / disabled policy', async () => {
    const a = await propose('a', { n: 14, expectancyEth: 0.005, winRate: 0.43 });
    expect((await autoApproveProposals(db.sql, [a], log))[0]).toMatchObject({ approved: false, reasons: ['auto_approve disabled'] });
    await db.pg.query(`insert into settings (key, value) values ('auto_approve', $1::jsonb)`, [JSON.stringify({ ...DEFAULT_AUTO_APPROVE, maxConcurrentPlays: 1 })]);
    const b = await propose('b', { n: 14, expectancyEth: 0.005, winRate: 0.43 });
    const out = await autoApproveProposals(db.sql, [a, b], log);
    expect(out.map((o) => o.approved)).toEqual([true, false]);
    expect(out[1]!.reasons.join()).toMatch(/1 plays enabled ≥ maxConcurrentPlays 1/);
  });
});

describe('runNightly (PGlite, synthetic launches)', () => {
  const DAY = 86_400;
  const L = addr('d1a'); // the losing operator
  const LT = addr('71a'); // its team wallet
  async function scenario(): Promise<{ generic: number; rolling: number; loser: number; few: number; off: number }> {
    const launches: SynthLaunch[] = [];
    // 20 team-buy launches that run, distinct operators
    for (let i = 0; i < 20; i++) launches.push({ token: addr(`a${i}`), deployer: addr(`dd${i}`), team: [addr(`7e${i}`)], sec: NOW - 2 * DAY + i * 600, teamBuyEth: 0.2, shape: 'win' });
    // one operator whose 6 team-buy launches all dump
    for (let i = 0; i < 6; i++) launches.push({ token: addr(`b${i}`), deployer: L, team: [LT], sec: NOW - DAY + i * 600, teamBuyEth: 0.15, shape: 'lose' });
    // no team buy (never matched by the generic play) and a too-small team buy
    for (let i = 0; i < 8; i++) launches.push({ token: addr(`c${i}`), deployer: addr(`dc${i}`), team: [], sec: NOW - DAY + i * 60, teamBuyEth: 0, shape: 'flat' });
    launches.push({ token: addr('e0'), deployer: addr('de0'), team: [addr('7e0')], sec: NOW - DAY, teamBuyEth: 0.05, shape: 'win' });
    // outside the refit window
    launches.push({ token: addr('f0'), deployer: addr('df0'), team: [addr('7f0')], sec: NOW - 10 * DAY, teamBuyEth: 0.3, shape: 'win' });
    // an operator play with only two launches
    for (let i = 0; i < 2; i++) launches.push({ token: addr(`9${i}`), deployer: addr('d9'), team: [addr('79')], sec: NOW - DAY + i, teamBuyEth: 0, shape: 'win' });
    await insertLaunches(db.pg, launches);
    const ins = async (name: string, trigger: unknown, preset: unknown, enabled = true): Promise<number> =>
      (await db.pg.query<{ id: number }>(`insert into plays (name, enabled, trigger, preset) values ($1, $2, $3::jsonb, $4::jsonb) returning id`, [name, enabled, JSON.stringify(trigger), JSON.stringify(preset)])).rows[0]!.id;
    // the generic play starts with a poor preset (no trailing, 120 s timeout): the refit must find the trailing stop
    const generic = await ins('team-buy-0.1', { launchSecond: { minTeamBuyEth: 0.1 } }, { trailing: null, timeoutSec: 120, stopAfter: 1_000_000, firstBuyOnly: false });
    const rolling = await ins('op-rolling', { deployerIn: [addr('dd0')] }, {});
    const loser = await ins('op-loser', { deployerIn: [L] }, {});
    const few = await ins('op-few', { deployerIn: [addr('d9')] }, {});
    const off = await ins('disabled', { deployerIn: [addr('dd1')] }, {}, false);
    // 12 realised snipes of op-rolling, mean < 0 (paper and live both count)
    await insertClosedSnipes(db.pg, Array.from({ length: 12 }, (_, i) => ({ playId: rolling, pnlEth: i % 3 === 0 ? 0.01 : -0.008, closedSec: NOW - 3600 + i, mode: i % 2 ? 'live' : 'paper' })));
    return { generic, rolling, loser, few, off };
  }
  const now = (): Date => new Date(NOW * 1000);

  it('refits the generic play, blacklists the losing operator, disables the losers, leaves thin plays alone', async () => {
    const ids = await scenario();
    const report = await runNightly({ sql: db.sql, logger: log, now }, { minCoins: 5 });
    const byId = new Map(report.map((r) => [r.playId, r]));
    expect(byId.get(ids.generic)!.action).toBe('refit');
    expect(byId.get(ids.rolling)!.action).toBe('disable');
    expect(byId.get(ids.rolling)!.reasons.join()).toMatch(/rolling realised expectancy -0\.00200 ETH over the last 12 snipes ≤ 0/);
    expect(byId.get(ids.loser)!.action).toBe('disable');
    expect(byId.get(ids.loser)!.reasons.join()).toMatch(/refit expectancy -0\.\d+ ETH ≤ 0 over 6 snipes in the last 3 days/);
    expect(byId.get(ids.few)!.action).toBe('insufficient');
    expect(byId.has(ids.off)).toBe(false);

    const g = await playRow(ids.generic);
    expect(g.enabled).toBe(true);
    const newPreset = PresetSchema.parse(g.preset);
    // the refit found a profit-taking exit (on this synthetic path a +150 % TP or a trailing stop)
    expect(newPreset.takeProfits.length > 0 || newPreset.trailing !== null).toBe(true);
    expect(newPreset).toMatchObject({ stopAfter: 1_000_000, firstBuyOnly: false }); // non-exit fields kept
    const nightly = g.stats.nightly as { action: string; n: number; currentExpectancyEth: number; bestExpectancyEth: number };
    expect(nightly).toMatchObject({ action: 'refit', n: 26 }); // 20 runners + 6 dumps; no-team / 0.05 / old launches excluded
    expect(nightly.bestExpectancyEth).toBeGreaterThan(nightly.currentExpectancyEth + 0.0005);
    expect(nightly.bestExpectancyEth).toBeGreaterThan(0);
    // operator blacklist (generic play only)
    const trig = PlayTriggerSchema.parse(g.trigger);
    expect(trig.deployerNotIn).toEqual([L]);
    expect(trig.teamWalletsNotIn).toEqual([LT]);
    expect(trig.launchSecond).toEqual({ minTeamBuyEth: 0.1 });

    expect((await playRow(ids.rolling)).enabled).toBe(false);
    expect((await playRow(ids.loser)).enabled).toBe(false);
    expect((await playRow(ids.few)).enabled).toBe(true);
    expect((await events('play_refit')).map((e) => e.payload.playId)).toEqual([ids.generic]);
    expect((await events('play_auto_disabled')).map((e) => e.payload.playId).sort()).toEqual([ids.rolling, ids.loser].sort());
    expect((await events('play_auto_disabled'))[0]!).toMatchObject({ level: 'warn', payload: { notify: true } });
    expect((await events('operator_blacklisted'))[0]!.payload).toMatchObject({ playId: ids.generic, deployers: [L], teamWallets: [LT] });
    expect(await events('nightly_finished')).toHaveLength(1);

    // the next night: the refit preset is the best one, the blacklisted operator is excluded → keep
    const again = await runNightly({ sql: db.sql, logger: log, now }, { minCoins: 5 });
    expect(again.map((r) => [r.playId, r.action])).toEqual([
      [ids.generic, 'keep'],
      [ids.few, 'insufficient'],
    ]);
    expect(((await playRow(ids.generic)).stats.nightly as { n: number }).n).toBe(20);
    expect(await events('operator_blacklisted')).toHaveLength(1);
  });

  it('refitPreset alone: the poor preset loses, the grid finds a positive one', async () => {
    await scenario();
    const { launchesMatchingTrigger, loadBacktestItems } = await import('../src/queries.js');
    const sel = await launchesMatchingTrigger(db.sql, PlayTriggerSchema.parse({ launchSecond: { minTeamBuyEth: 0.1 } }), { sinceTs: NOW - 3 * DAY, untilTs: NOW });
    const items = await loadBacktestItems(db.sql, sel.tokens);
    const r = refitPreset(items, PresetSchema.parse({ trailing: null, timeoutSec: 120 }), { minCoins: 20, grid: DEFAULT_NIGHTLY.grid });
    expect(r.n).toBe(26);
    expect(r.current.expectancyEth).toBeLessThan(0);
    expect(r.best!.summary.expectancyEth).toBeGreaterThan(0);
    expect(r.bestPerToken).toHaveLength(26);
  });
});

describe('the db seed is understood by the agent', () => {
  it('seeded team-buy-0.1 is a generic play the nightly job handles (insufficient data → untouched)', async () => {
    const { seed } = await import('@hood/db');
    await seed(fromPglite(db.pg));
    const report = await runNightly({ sql: db.sql, logger: log, now: () => new Date(NOW * 1000) });
    expect(report).toEqual([{ playId: 1, name: 'team-buy-0.1', action: 'insufficient', reasons: ['0 simulated snipes < 20: no refit'] }]);
  });
});
