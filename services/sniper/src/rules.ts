/**
 * Rules engine: in-memory plays + armed candidates (+ team wallet sets inside triggers),
 * loaded from the DB at start and refreshed on NOTIFY plays_changed / armed_changed.
 * `evaluate(LaunchEvent, now, launchSecondStats?)` is pure memory work (µs) — no I/O on the
 * decide path.
 *
 * Trigger semantics (SPEC §4):
 *   identity matchers: armedWallet, deployerIn, teamWalletsAny, nameRegex, symbolRegex
 *   fingerprint:       launchSecond (team / dev buys in the launch second, from the ledger);
 *                      always AND (as if listed in `require`)
 *   filters (AND):     launchKind, minDevBuyEth, maxDevBuyEth, native-ETH pair token,
 *                      deployerNotIn, teamWalletsNotIn (blacklists)
 *   `require` lists matchers that must ALL match; of the remaining configured identity
 *   matchers at least one must match (OR). A trigger with no matcher never matches (safety: it
 *   would snipe every launch). `launchSecond` counts as a matcher on its own only when it
 *   demands ETH spent in the launch second (`launchSecondIsMatcher`: minTeamBuyEth > 0,
 *   minTeamBuyers ≥ 1 or minDevBuyEth > 0).
 *
 * LIVE mode (reviewer H1): at least one matched matcher must be non-spoofable:
 *   - armedWallet / deployerIn: bound to the tx signer / TokenLaunched.deployer;
 *   - launchSecond (when it demands ETH): bound to real curve buys in the launch second. Feed
 *     hints only schedule the burst; before anything is signed the buys must be confirmed by a
 *     CurveBuy log of the receipt-proven curve (`stage = 'confirm'`), so a buy that reverts (or
 *     never happened) cannot trigger us. Residual risk, accepted and backtested: the operator
 *     really spent the ETH and can dump on us — that is exactly the game of docs/BACKTEST.md
 *     (+8 % expectancy per 0.07 ETH snipe for team buys ≥ 0.1 ETH, positive on every OOS day).
 *   name, symbol and team wallets are chosen by whoever launches, so on their own they only arm
 *   paper runs.
 */
import { QUOTE_TOKENS, launchSecondIsMatcher, type ArmedCandidate, type LaunchEvent, type LaunchSecondRule, type Play, type TriggerField } from '@hood/core';
import { formatEther } from 'viem';
import type { Decision, LaunchSecondStage, LaunchSecondStats } from './types.js';

interface CompiledPlay {
  play: Play;
  deployerIn: Set<string> | null;
  teamWallets: Set<string> | null;
  deployerNotIn: Set<string> | null;
  teamNotIn: Set<string> | null;
  nameRe: RegExp | null;
  symbolRe: RegExp | null;
  launchSecond: LaunchSecondRule | null;
  /** identity matchers + 'launchSecond' when configured */
  configured: TriggerField[];
  /** the trigger can match on its own (an identity matcher, or a launch-second rule that demands ETH) */
  hasMatcher: boolean;
  error?: string;
}

/** `/pat/flags` or a bare pattern (case-insensitive by default). */
export function compileRegex(src: string): RegExp {
  const m = /^\/(.*)\/([dgimsuvy]*)$/s.exec(src);
  return m ? new RegExp(m[1]!, m[2]!.replace('g', '')) : new RegExp(src, 'i');
}

const lowerSet = (xs: readonly string[] | undefined): Set<string> | null =>
  xs && xs.length ? new Set(xs.map((x) => x.toLowerCase())) : null;

export interface MatchExplanation {
  playId: number;
  matched: boolean;
  reasons: string[];
}

const ANCHORS: readonly TriggerField[] = ['armedWallet', 'deployerIn'];
const EPS = 1e-12;
const fmt = (x: number): string => (Math.round(x * 1e6) / 1e6).toString();

/**
 * Check a launch-second rule against the ledger. `hint`: seen totals for every bound.
 * `confirm`: minimums against confirmed totals (a reverted or unproven buy never counts), maximums
 * against seen totals (an unconfirmed buy can still push us over a maximum).
 */
export function checkLaunchSecond(rule: LaunchSecondRule, ls: LaunchSecondStats | undefined, stage: LaunchSecondStage = 'hint'): { ok: boolean; reason: string } {
  if (!ls) return { ok: false, reason: 'launchSecond: no launch-second data yet' };
  const lo = stage === 'confirm' ? ls.confirmed : ls.seen;
  const hi = ls.seen;
  const tag = stage === 'confirm' ? 'confirmed' : 'seen';
  const fail = (why: string): { ok: false; reason: string } => ({ ok: false, reason: `launchSecond: ${why} (${tag})` });
  if (rule.minTeamBuyEth !== undefined && lo.teamBuyEth + EPS < rule.minTeamBuyEth) return fail(`team buy ${fmt(lo.teamBuyEth)} ETH < min ${rule.minTeamBuyEth}`);
  if (rule.maxTeamBuyEth !== undefined && hi.teamBuyEth > rule.maxTeamBuyEth + EPS) return fail(`team buy ${fmt(hi.teamBuyEth)} ETH > max ${rule.maxTeamBuyEth}`);
  if (rule.minTeamBuyers !== undefined && lo.teamBuyers < rule.minTeamBuyers) return fail(`${lo.teamBuyers} team buyer(s) < min ${rule.minTeamBuyers}`);
  if (rule.minDevBuyEth !== undefined && lo.devBuyEth + EPS < rule.minDevBuyEth) return fail(`dev buy ${fmt(lo.devBuyEth)} ETH < min ${rule.minDevBuyEth}`);
  if (rule.maxDevBuyEth !== undefined && hi.devBuyEth > rule.maxDevBuyEth + EPS) return fail(`dev buy ${fmt(hi.devBuyEth)} ETH > max ${rule.maxDevBuyEth}`);
  if (rule.requireNoDevBuy && hi.devBuyEth > 0) return fail(`requireNoDevBuy but dev bought ${fmt(hi.devBuyEth)} ETH`);
  return {
    ok: true,
    reason: `launchSecond: team ${fmt(lo.teamBuyEth)} ETH by ${lo.teamBuyers} wallet(s), dev ${fmt(lo.devBuyEth)} ETH (${tag})`,
  };
}

export class Rules {
  private compiled: CompiledPlay[] = [];
  constructor(private readonly opts: { mode?: 'live' | 'paper' } = {}) {}

  /** playId → wallet → candidate */
  private armed = new Map<number, Map<string, ArmedCandidate>>();
  readonly stats = { evaluations: 0, matches: 0 };

  setPlays(plays: Play[]): void {
    this.compiled = plays
      .filter((p) => p.enabled)
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      .map((play) => {
        const t = play.trigger;
        const c: CompiledPlay = {
          play,
          deployerIn: lowerSet(t.deployerIn),
          teamWallets: lowerSet(t.teamWalletsAny),
          deployerNotIn: lowerSet(t.deployerNotIn),
          teamNotIn: lowerSet(t.teamWalletsNotIn),
          nameRe: null,
          symbolRe: null,
          launchSecond: t.launchSecond ?? null,
          configured: [],
          hasMatcher: false,
        };
        try {
          if (t.nameRegex) c.nameRe = compileRegex(t.nameRegex);
          if (t.symbolRegex) c.symbolRe = compileRegex(t.symbolRegex);
        } catch (e) {
          c.error = `bad regex: ${(e as Error).message}`;
        }
        if (t.armedWallet) c.configured.push('armedWallet');
        if (c.deployerIn) c.configured.push('deployerIn');
        if (c.teamWallets) c.configured.push('teamWalletsAny');
        if (t.nameRegex) c.configured.push('nameRegex');
        if (t.symbolRegex) c.configured.push('symbolRegex');
        c.hasMatcher = c.configured.length > 0 || launchSecondIsMatcher(c.launchSecond);
        if (c.launchSecond) c.configured.push('launchSecond');
        return c;
      });
  }

  setArmed(cands: ArmedCandidate[]): void {
    this.armed.clear();
    for (const c of cands) this.addArmed(c);
  }

  addArmed(c: ArmedCandidate): void {
    if (c.status !== 'armed') return;
    let m = this.armed.get(c.playId);
    if (!m) this.armed.set(c.playId, (m = new Map()));
    m.set(c.wallet.toLowerCase(), c);
  }

  removeArmed(playId: number, wallet: string): void {
    this.armed.get(playId)?.delete(wallet.toLowerCase());
  }

  get playCount(): number {
    return this.compiled.length;
  }

  get armedCount(): number {
    let n = 0;
    for (const m of this.armed.values()) n += m.size;
    return n;
  }

  /** At least one enabled play has a launch-second rule (the sniper then keeps per-launch ledgers). */
  get hasLaunchSecondPlays(): boolean {
    return this.compiled.some((c) => c.launchSecond !== null);
  }

  /** Matching plays in id order, each with human-readable reasons. */
  evaluate(ev: LaunchEvent, nowMs: number = Date.now(), ls?: LaunchSecondStats, stage: LaunchSecondStage = 'hint'): Decision[] {
    this.stats.evaluations++;
    const out: Decision[] = [];
    for (const c of this.compiled) {
      const r = this.match(c, ev, nowMs, ls, stage);
      if (r.matched) out.push({ play: c.play, preset: c.play.preset, reasons: r.reasons });
    }
    if (out.length) this.stats.matches++;
    return out;
  }

  /** Re-evaluate one play (after the launch was verified against its receipt, or right before the send). */
  evaluatePlay(
    playId: number,
    ev: LaunchEvent,
    nowMs: number = Date.now(),
    ls?: LaunchSecondStats,
    stage: LaunchSecondStage = 'hint',
  ): { matched: boolean; reasons: string[] } {
    const c = this.compiled.find((x) => (x.play.id ?? -1) === playId);
    return c ? this.match(c, ev, nowMs, ls, stage) : { matched: false, reasons: ['play no longer enabled'] };
  }

  /** Per-play explanation (matched or not) for logs / the telegram bot. */
  explain(ev: LaunchEvent, nowMs: number = Date.now(), ls?: LaunchSecondStats, stage: LaunchSecondStage = 'hint'): MatchExplanation[] {
    return this.compiled.map((c) => ({ playId: c.play.id ?? -1, ...this.match(c, ev, nowMs, ls, stage) }));
  }

  private match(c: CompiledPlay, ev: LaunchEvent, nowMs: number, ls: LaunchSecondStats | undefined, stage: LaunchSecondStage): { matched: boolean; reasons: string[] } {
    const t = c.play.trigger;
    const no = (why: string): { matched: false; reasons: string[] } => ({ matched: false, reasons: [why] });
    if (c.error) return no(c.error);
    if (!c.hasMatcher) return no('trigger has no identity matcher');
    if (ev.pairToken !== QUOTE_TOKENS.eth) return no(`pair token ${ev.pairToken} is not native ETH`);

    const deployer = ev.deployer.toLowerCase();
    const txFrom = ev.txFrom?.toLowerCase();
    // ---- blacklists (AND)
    if (c.deployerNotIn) {
      const hit = c.deployerNotIn.has(deployer) ? deployer : txFrom && c.deployerNotIn.has(txFrom) ? txFrom : null;
      if (hit) return no(`deployerNotIn: ${hit} is blacklisted`);
    }
    let team: Set<string> | null = null;
    const teamSet = (): Set<string> => (team ??= new Set([...ev.exemptions.map((x) => x.toLowerCase()), ev.creatorFeeRecipient.toLowerCase()]));
    if (c.teamNotIn) {
      const hit = [...teamSet()].find((w) => c.teamNotIn!.has(w));
      if (hit) return no(`teamWalletsNotIn: ${hit} is blacklisted`);
    }

    // ---- filters (AND)
    const devBuy = ev.devBuyQuoteIn ?? 0n;
    if (t.launchKind === 'devBuy' && devBuy === 0n) return no('launchKind=devBuy but no dev buy');
    if (t.launchKind === 'noDevBuy' && devBuy > 0n) return no(`launchKind=noDevBuy but dev bought ${formatEther(devBuy)}`);
    const devEth = Number(formatEther(devBuy));
    if (t.minDevBuyEth !== undefined && devEth < t.minDevBuyEth) return no(`dev buy ${devEth} < min ${t.minDevBuyEth}`);
    if (t.maxDevBuyEth !== undefined && devEth > t.maxDevBuyEth) return no(`dev buy ${devEth} > max ${t.maxDevBuyEth}`);

    // ---- launch-second fingerprint (always AND)
    const res = new Map<TriggerField, string | null>();
    if (c.launchSecond) {
      const r = checkLaunchSecond(c.launchSecond, ls, stage);
      if (!r.ok) return no(r.reason);
      res.set('launchSecond', r.reason);
    }

    // ---- identity matchers
    for (const f of c.configured) {
      switch (f) {
        case 'armedWallet': {
          const rule = t.armedWallet!;
          const m = this.armed.get(c.play.id ?? -1);
          let hit: string | null = null;
          for (const w of txFrom && txFrom !== deployer ? [deployer, txFrom] : [deployer]) {
            const a = m?.get(w);
            if (!a) continue;
            if (a.expiresAt && a.expiresAt.getTime() <= nowMs) continue;
            if (a.armedAt && a.armedAt.getTime() + rule.maxAgeSec * 1000 <= nowMs) continue;
            if (a.fundedValue !== undefined) {
              const eth = Number(formatEther(a.fundedValue));
              if (eth < rule.minEth || eth > rule.maxEth) continue;
            }
            const age = a.armedAt ? `${Math.round((nowMs - a.armedAt.getTime()) / 1000)}s ago` : 'age ?';
            const val = a.fundedValue !== undefined ? `${formatEther(a.fundedValue)} ETH` : '? ETH';
            hit = `armedWallet: ${w} funded by ${a.sourceFunder ?? '?'} (${val}, ${age})`;
            break;
          }
          res.set(f, hit);
          break;
        }
        case 'deployerIn':
          res.set(
            f,
            c.deployerIn!.has(deployer)
              ? `deployerIn: ${deployer}`
              : txFrom && c.deployerIn!.has(txFrom)
                ? `deployerIn: tx.from ${txFrom}`
                : null,
          );
          break;
        case 'teamWalletsAny': {
          const hits = [...teamSet()].filter((w) => c.teamWallets!.has(w));
          res.set(f, hits.length ? `teamWalletsAny: ${hits.join(',')}` : null);
          break;
        }
        case 'nameRegex':
          res.set(f, c.nameRe!.test(ev.name) ? `nameRegex ${c.nameRe} ~ "${ev.name}"` : null);
          break;
        case 'symbolRegex':
          res.set(f, c.symbolRe!.test(ev.symbol) ? `symbolRegex ${c.symbolRe} ~ "${ev.symbol}"` : null);
          break;
        case 'launchSecond':
          break; // checked above (always required)
      }
    }
    const required = new Set(t.require);
    for (const r of required) {
      if (!c.configured.includes(r)) return no(`required matcher ${r} is not configured`);
      if (!res.get(r)) return no(`required ${r} did not match`);
    }
    const optional = c.configured.filter((f) => !required.has(f) && f !== 'launchSecond');
    const optionalHits = optional.filter((f) => res.get(f));
    if (optional.length > 0 && optionalHits.length === 0) return no(`none of ${optional.join('|')} matched`);
    if ((this.opts.mode ?? 'live') === 'live') {
      const anchored = ANCHORS.some((a) => res.get(a)) || (res.has('launchSecond') && launchSecondIsMatcher(c.launchSecond));
      if (!anchored) {
        return no(
          'live play needs a non-spoofable match (armedWallet, deployerIn, or a launchSecond rule that demands ETH); name/symbol/team wallets alone only arm paper runs',
        );
      }
    }
    const reasons = [...res.values()].filter((x): x is string => !!x);
    if (devBuy > 0n) reasons.push(`dev buy ${formatEther(devBuy)} ETH`);
    return { matched: true, reasons };
  }
}
