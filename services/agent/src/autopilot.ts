/**
 * The "works every day without a human" layer of the agent:
 *
 *  1. Auto-approval (after every scout pass): a proposed play whose backtest clears
 *     `settings.auto_approve` ({enabled, minCoins, minExpectancyEth, minWinRate,
 *     maxConcurrentPlays}) is enabled at once (operator → active, `play_auto_approved` event);
 *     otherwise it waits for the Telegram buttons as before.
 *  2. Nightly job (`serve`, NIGHTLY_HOUR_UTC): for every enabled play
 *     - re-backtest it over the last REFIT_DAYS of indexed launches that match its trigger,
 *     - refit the exits with `gridSearch` (only with ≥ REFIT_MIN_COINS simulated snipes) and
 *       write the new preset when the expectancy improves by more than REFIT_MARGIN_ETH,
 *     - disable it when its rolling realised expectancy (last ROLLING_TRADES closed snipes,
 *       paper or live, at least DISABLE_MIN_TRADES) or its refit expectancy is ≤ 0,
 *     - generic fingerprint plays: blacklist (`deployerNotIn` / `teamWalletsNotIn`) operators
 *       whose last ≥ BLACKLIST_MIN_LAUNCHES matching launches all lost.
 *
 * Every decision is a pure function of its inputs (tested with synthetic data); the I/O wrappers
 * only read, call them and write the result plus an `events` row (`notify: true`, so Telegram
 * shows it).
 */
import type { Logger } from 'pino';
import { backtestPlay, gridSearch, type BacktestItem, type BacktestSummary, type GridResult, type GridSpec, type SimPreset, type SnipeResult } from './backtest.js';
import { DEFAULT_AUTO_APPROVE, PlayTriggerSchema, PresetSchema, type AutoApprovePolicy, type PlayTrigger, type Preset } from './deps.js';
import {
  countEnabledPlays,
  disablePlay,
  enablePlay,
  enabledPlays,
  getSettingValue,
  insertEvent,
  launchesMatchingTrigger,
  loadBacktestItems,
  recentRealizedPnls,
  updatePlayPreset,
  updatePlayStats,
  updatePlayTrigger,
  type Db,
} from './queries.js';
import type { ProposedPlay } from './tools.js';
import { isGenericTrigger, type LaunchContext } from './trigger.js';

export type { AutoApprovePolicy };

// ---------------------------------------------------------------------------
// 1. Auto-approval
// ---------------------------------------------------------------------------

/** settings.auto_approve → policy; absent or malformed = disabled (null). Missing fields take the defaults. */
export function parseAutoApprovePolicy(v: unknown): AutoApprovePolicy | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const num = (k: keyof AutoApprovePolicy): number => {
    const x = o[k];
    return typeof x === 'number' && Number.isFinite(x) ? x : (DEFAULT_AUTO_APPROVE[k] as number);
  };
  return {
    enabled: o.enabled === true,
    minCoins: num('minCoins'),
    minExpectancyEth: num('minExpectancyEth'),
    minWinRate: num('minWinRate'),
    maxConcurrentPlays: num('maxConcurrentPlays'),
  };
}

export interface ProposalStats {
  n: number;
  expectancyEth: number;
  winRate: number;
}

/** The proposal's backtest (propose_play stores it as `stats.backtest`). */
export function proposalStats(stats: Record<string, unknown> | null | undefined): ProposalStats | null {
  const b = stats?.backtest;
  if (!b || typeof b !== 'object') return null;
  const o = b as Record<string, unknown>;
  const n = Number(o.n);
  const e = Number(o.expectancyEth);
  const w = Number(o.winRate);
  return Number.isFinite(n) && Number.isFinite(e) && Number.isFinite(w) ? { n, expectancyEth: e, winRate: w } : null;
}

export function autoApproveVerdict(stats: ProposalStats | null, policy: AutoApprovePolicy | null, enabledPlays: number): { approve: boolean; reasons: string[] } {
  if (!policy || !policy.enabled) return { approve: false, reasons: ['auto_approve disabled'] };
  if (!stats) return { approve: false, reasons: ['proposal has no backtest'] };
  const reasons: string[] = [];
  if (stats.n < policy.minCoins) reasons.push(`backtest n ${stats.n} < minCoins ${policy.minCoins}`);
  if (stats.expectancyEth < policy.minExpectancyEth) reasons.push(`expectancy ${stats.expectancyEth.toFixed(4)} ETH < min ${policy.minExpectancyEth}`);
  if (stats.winRate < policy.minWinRate) reasons.push(`win rate ${(stats.winRate * 100).toFixed(0)} % < min ${(policy.minWinRate * 100).toFixed(0)} %`);
  if (enabledPlays >= policy.maxConcurrentPlays) reasons.push(`${enabledPlays} plays enabled ≥ maxConcurrentPlays ${policy.maxConcurrentPlays}`);
  return reasons.length
    ? { approve: false, reasons }
    : { approve: true, reasons: [`n ${stats.n}, expectancy ${stats.expectancyEth.toFixed(4)} ETH, win ${(stats.winRate * 100).toFixed(0)} %`] };
}

export interface AutoApproveOutcome {
  playId: number;
  approved: boolean;
  reasons: string[];
}

/** Apply the policy to this scout pass's proposals (in order; each approval counts toward maxConcurrentPlays). */
export async function autoApproveProposals(sql: Db, proposals: readonly ProposedPlay[], logger?: Logger): Promise<AutoApproveOutcome[]> {
  if (proposals.length === 0) return [];
  const policy = parseAutoApprovePolicy(await getSettingValue(sql, 'auto_approve'));
  let enabled = await countEnabledPlays(sql);
  const out: AutoApproveOutcome[] = [];
  for (const p of proposals) {
    const v = autoApproveVerdict(proposalStats(p.stats), policy, enabled);
    out.push({ playId: p.playId, approved: v.approve, reasons: v.reasons });
    if (!v.approve) {
      logger?.info({ playId: p.playId, reasons: v.reasons }, 'proposal left for Telegram approval');
      continue;
    }
    await enablePlay(sql, p.playId, p.operatorId);
    enabled++;
    await insertEvent(sql, {
      level: 'info',
      type: 'play_auto_approved',
      payload: { playId: p.playId, operatorId: p.operatorId, name: p.name, operator: p.operatorName, why: v.reasons.join('; '), policy, backtest: proposalStats(p.stats), notify: true },
    });
    logger?.info({ playId: p.playId, why: v.reasons }, 'play auto-approved');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Nightly refit / disable / blacklist
// ---------------------------------------------------------------------------

export interface NightlyOptions {
  /** look-back of the refit backtest, days */
  refitDays: number;
  /** minimum simulated snipes for a refit (and for a refit-based disable) */
  minCoins: number;
  /** a new preset must beat the current one by more than this (ETH per snipe) */
  marginEth: number;
  /** rolling window of realised snipes */
  rollingTrades: number;
  /** at least this many realised snipes before the rolling expectancy can disable a play */
  minTrades: number;
  /** blacklist an operator (deployer / team wallet) whose last N matching launches all lost */
  blacklistMinLaunches: number;
  /** cap on each blacklist (oldest entries are dropped) */
  maxBlacklist: number;
  grid: GridSpec;
}

/**
 * The refit grid: Backtest #2's walk-forward space (the winner — no TP, trailing 50/20, SL 40,
 * timeout 60 — is in it) plus a few neighbours.
 */
export const REFIT_GRID: GridSpec = {
  tp: [null, 100, 150, 300],
  trailing: [null, { activatePct: 50, dropPct: 20 }, { activatePct: 100, dropPct: 25 }, { activatePct: 150, dropPct: 30 }],
  sl: [30, 40, 60],
  timeoutSec: [30, 60, 120],
};

export const DEFAULT_NIGHTLY: NightlyOptions = {
  refitDays: 3,
  minCoins: 20,
  marginEth: 0.0005,
  rollingTrades: 30,
  minTrades: 10,
  blacklistMinLaunches: 5,
  maxBlacklist: 500,
  grid: REFIT_GRID,
};

export interface RefitResult {
  n: number;
  insufficient: boolean;
  current: BacktestSummary;
  /** best grid preset (null when insufficient) */
  best: GridResult | null;
  /** per-launch results of the current preset (operator blacklist) */
  perToken: SnipeResult[];
  /** per-launch results of the best grid preset */
  bestPerToken: SnipeResult[] | null;
}

/** Re-backtest the current preset and grid-search its exits. Pure. */
export function refitPreset(items: readonly BacktestItem[], current: Preset, opts: Pick<NightlyOptions, 'minCoins' | 'grid'>): RefitResult {
  const { perToken, ...summary } = backtestPlay(items, current);
  if (summary.n < opts.minCoins) return { n: summary.n, insufficient: true, current: summary, best: null, perToken, bestPerToken: null };
  const g = gridSearch(items, current, opts.grid, { minN: opts.minCoins, top: 1 });
  const best = g.results[0] ?? null;
  return { n: summary.n, insufficient: g.insufficient, current: summary, best, perToken, bestPerToken: best ? backtestPlay(items, best.preset).perToken : null };
}

/** Mean realised PnL of the most recent trades; null below `minTrades`. Pure. */
export function rollingExpectancy(pnls: readonly number[], minTrades: number): { n: number; expectancyEth: number | null } {
  const xs = pnls.filter((x) => Number.isFinite(x));
  if (xs.length < minTrades) return { n: xs.length, expectancyEth: null };
  return { n: xs.length, expectancyEth: xs.reduce((a, b) => a + b, 0) / xs.length };
}

/** The current preset with the exits of a grid result (trailing / timeout null = off). */
export function withExits(current: Preset, sim: SimPreset): Preset {
  return PresetSchema.parse({
    ...current,
    takeProfits: sim.takeProfits,
    trailing: sim.trailing ?? null,
    stopLossPct: sim.stopLossPct,
    timeoutSec: sim.timeoutSec ?? null,
  });
}

/**
 * Operators whose last `minLaunches` launches (matching the play, ordered by launch time) were
 * all simulated losses: their deployers and team wallets. Pure.
 */
export function losingOperators(
  results: readonly Pick<SnipeResult, 'token' | 'launchTs' | 'entered' | 'pnlEth'>[],
  ctxByToken: ReadonlyMap<string, Pick<LaunchContext, 'deployer' | 'teamWallets'>>,
  minLaunches: number,
): { deployers: string[]; teamWallets: string[] } {
  const byKey = (keys: (c: Pick<LaunchContext, 'deployer' | 'teamWallets'>) => string[]): string[] => {
    const groups = new Map<string, { ts: number; pnl: number }[]>();
    for (const r of results) {
      if (!r.entered) continue;
      const c = ctxByToken.get(r.token);
      if (!c) continue;
      for (const k of new Set(keys(c).map((x) => x.toLowerCase()))) groups.set(k, [...(groups.get(k) ?? []), { ts: r.launchTs, pnl: r.pnlEth }]);
    }
    const out: string[] = [];
    for (const [k, xs] of groups) {
      if (xs.length < minLaunches) continue;
      const last = [...xs].sort((a, b) => a.ts - b.ts).slice(-minLaunches);
      if (last.every((x) => x.pnl <= 0)) out.push(k);
    }
    return out.sort();
  };
  return { deployers: byKey((c) => [c.deployer]), teamWallets: byKey((c) => c.teamWallets) };
}

export interface NightlyDecision {
  action: 'keep' | 'refit' | 'disable' | 'insufficient';
  reasons: string[];
  /** the preset to write (refit only) */
  newPreset?: Preset;
  /** trigger with the new blacklist entries (generic plays only), when there are any */
  newTrigger?: PlayTrigger;
  blacklisted: { deployers: string[]; teamWallets: string[] };
  summary: Record<string, unknown>;
}

const r4 = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : Number(x.toFixed(6)));

/** Merge new blacklist entries into a trigger (deduped, capped, newest kept). */
export function mergeBlacklist(trigger: PlayTrigger, add: { deployers: string[]; teamWallets: string[] }, cap: number): { trigger: PlayTrigger; added: { deployers: string[]; teamWallets: string[] } } {
  const merge = (cur: readonly string[] | undefined, extra: string[]): { list: string[]; added: string[] } => {
    const have = new Set((cur ?? []).map((x) => x.toLowerCase()));
    const added = extra.filter((x) => !have.has(x));
    return { list: [...(cur ?? []), ...added].slice(-cap), added };
  };
  const d = merge(trigger.deployerNotIn, add.deployers);
  const t = merge(trigger.teamWalletsNotIn, add.teamWallets);
  const next = PlayTriggerSchema.parse({
    ...trigger,
    ...(d.list.length ? { deployerNotIn: d.list } : {}),
    ...(t.list.length ? { teamWalletsNotIn: t.list } : {}),
  });
  return { trigger: next, added: { deployers: d.added, teamWallets: t.added } };
}

/** The nightly verdict for one play. Pure. */
export function decideNightly(input: {
  trigger: PlayTrigger;
  preset: Preset;
  refit: RefitResult;
  rolling: { n: number; expectancyEth: number | null };
  ctxByToken: ReadonlyMap<string, Pick<LaunchContext, 'deployer' | 'teamWallets'>>;
  opts: NightlyOptions;
}): NightlyDecision {
  const { trigger, preset, refit, rolling, opts } = input;
  const cur = refit.current.expectancyEth;
  const best = refit.best;
  const summary: Record<string, unknown> = {
    n: refit.n,
    currentExpectancyEth: r4(cur),
    currentWinRate: r4(refit.current.winRate),
    bestExpectancyEth: r4(best?.summary.expectancyEth),
    rollingTrades: rolling.n,
    rollingExpectancyEth: r4(rolling.expectancyEth),
  };
  const none = { deployers: [], teamWallets: [] };
  if (rolling.expectancyEth !== null && rolling.expectancyEth <= 0) {
    return { action: 'disable', reasons: [`rolling realised expectancy ${rolling.expectancyEth.toFixed(5)} ETH over the last ${rolling.n} snipes ≤ 0`], blacklisted: none, summary };
  }
  if (!refit.insufficient) {
    const refitExp = Math.max(cur, best?.summary.expectancyEth ?? cur);
    if (refitExp <= 0) {
      return { action: 'disable', reasons: [`refit expectancy ${refitExp.toFixed(5)} ETH ≤ 0 over ${refit.n} snipes in the last ${opts.refitDays} days`], blacklisted: none, summary };
    }
  }
  let action: NightlyDecision['action'] = refit.insufficient ? 'insufficient' : 'keep';
  const reasons: string[] = refit.insufficient ? [`${refit.n} simulated snipes < ${opts.minCoins}: no refit`] : [];
  let newPreset: Preset | undefined;
  if (!refit.insufficient && best && best.summary.expectancyEth - cur > opts.marginEth) {
    action = 'refit';
    newPreset = withExits(preset, best.preset);
    reasons.push(`refit: ${cur.toFixed(5)} → ${best.summary.expectancyEth.toFixed(5)} ETH per snipe over ${refit.n} snipes (margin ${opts.marginEth})`);
  } else if (!refit.insufficient) {
    reasons.push(`kept: best grid ${(best?.summary.expectancyEth ?? cur).toFixed(5)} vs current ${cur.toFixed(5)} ETH (margin ${opts.marginEth})`);
  }
  // operator blacklist for generic fingerprint plays, from the results of the preset that stays active
  let blacklisted = none as { deployers: string[]; teamWallets: string[] };
  let newTrigger: PlayTrigger | undefined;
  if (isGenericTrigger(trigger)) {
    const active = action === 'refit' && refit.bestPerToken ? refit.bestPerToken : refit.perToken;
    const losers = losingOperators(active, input.ctxByToken, opts.blacklistMinLaunches);
    const m = mergeBlacklist(trigger, losers, opts.maxBlacklist);
    if (m.added.deployers.length || m.added.teamWallets.length) {
      blacklisted = m.added;
      newTrigger = m.trigger;
      reasons.push(`blacklisted ${m.added.deployers.length} deployer(s), ${m.added.teamWallets.length} team wallet(s): last ${opts.blacklistMinLaunches} launches all lost`);
    }
  }
  return { action, reasons, ...(newPreset ? { newPreset } : {}), ...(newTrigger ? { newTrigger } : {}), blacklisted, summary };
}

export interface NightlyPlayReport {
  playId: number;
  name: string;
  action: NightlyDecision['action'] | 'skipped';
  reasons: string[];
}

/** I/O wrapper: decide for every enabled play and write the outcome. */
export async function runNightly(deps: { sql: Db; logger?: Logger; now: () => Date }, partial: Partial<NightlyOptions> = {}): Promise<NightlyPlayReport[]> {
  const opts: NightlyOptions = { ...DEFAULT_NIGHTLY, ...partial };
  const { sql, logger } = deps;
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const sinceTs = nowSec - opts.refitDays * 86_400;
  const out: NightlyPlayReport[] = [];
  for (const play of await enabledPlays(sql)) {
    const t = PlayTriggerSchema.safeParse(play.trigger);
    const p = PresetSchema.safeParse(play.preset ?? {});
    if (!t.success || !p.success) {
      out.push({ playId: play.id, name: play.name, action: 'skipped', reasons: ['invalid trigger or preset'] });
      continue;
    }
    const trigger = t.data;
    const preset = p.data;
    const sel = await launchesMatchingTrigger(sql, trigger, { sinceTs, untilTs: nowSec });
    const items = await loadBacktestItems(sql, sel.tokens);
    const refit = refitPreset(items, preset, opts);
    const rolling = rollingExpectancy(await recentRealizedPnls(sql, play.id, opts.rollingTrades), opts.minTrades);
    const ctxByToken = new Map(sel.contexts.map((c) => [c.token, c]));
    const d = decideNightly({ trigger, preset, refit, rolling, ctxByToken, opts });
    const at = deps.now().toISOString();
    const base = { playId: play.id, name: play.name, ...d.summary, notify: true };
    if (d.action === 'disable') {
      await disablePlay(sql, play.id);
      await insertEvent(sql, { level: 'warn', type: 'play_auto_disabled', payload: { ...base, why: d.reasons.join('; ') } });
    }
    if (d.newPreset) {
      await updatePlayPreset(sql, play.id, d.newPreset);
      await insertEvent(sql, { level: 'info', type: 'play_refit', payload: { ...base, why: d.reasons.join('; '), preset: d.newPreset } });
    }
    if (d.newTrigger) {
      await updatePlayTrigger(sql, play.id, d.newTrigger);
      await insertEvent(sql, { level: 'info', type: 'operator_blacklisted', payload: { playId: play.id, name: play.name, ...d.blacklisted, notify: true } });
    }
    await updatePlayStats(sql, play.id, { nightly: { at, action: d.action, reasons: d.reasons, refitDays: opts.refitDays, ...d.summary } });
    logger?.info({ playId: play.id, action: d.action, reasons: d.reasons }, 'nightly');
    out.push({ playId: play.id, name: play.name, action: d.action, reasons: d.reasons });
  }
  await insertEvent(sql, { level: 'info', type: 'nightly_finished', payload: { at: deps.now().toISOString(), plays: out } });
  return out;
}

/** Milliseconds from `now` to the next `hourUtc`:00 UTC (strictly in the future). Pure. */
export function msUntilNextRun(now: Date, hourUtc: number): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
