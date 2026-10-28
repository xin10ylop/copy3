/**
 * Rules engine: in-memory plays + armed candidates (+ team wallet sets inside triggers),
 * loaded from the DB at start and refreshed on NOTIFY plays_changed / armed_changed.
 * `evaluate(LaunchEvent)` is pure memory work (µs) — no I/O on the decide path.
 *
 * Trigger semantics (SPEC §4):
 *   identity matchers: armedWallet, deployerIn, teamWalletsAny, nameRegex, symbolRegex
 *   filters (always AND): launchKind, minDevBuyEth, maxDevBuyEth, native-ETH pair token
 *   `require` lists matchers that must ALL match; of the remaining configured matchers at
 *   least one must match (OR). A trigger with no identity matcher never matches (safety: it
 *   would snipe every launch).
 */
import { QUOTE_TOKENS, type ArmedCandidate, type LaunchEvent, type Play, type TriggerField } from '@hood/core';
import { formatEther } from 'viem';
import type { Decision } from './types.js';

interface CompiledPlay {
  play: Play;
  deployerIn: Set<string> | null;
  teamWallets: Set<string> | null;
  nameRe: RegExp | null;
  symbolRe: RegExp | null;
  configured: TriggerField[];
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

export class Rules {
  private compiled: CompiledPlay[] = [];
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
          nameRe: null,
          symbolRe: null,
          configured: [],
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

  /** Matching plays in id order, each with human-readable reasons. */
  evaluate(ev: LaunchEvent, nowMs: number = Date.now()): Decision[] {
    this.stats.evaluations++;
    const out: Decision[] = [];
    for (const c of this.compiled) {
      const r = this.match(c, ev, nowMs);
      if (r.matched) out.push({ play: c.play, preset: c.play.preset, reasons: r.reasons });
    }
    if (out.length) this.stats.matches++;
    return out;
  }

  /** Per-play explanation (matched or not) for logs / the telegram bot. */
  explain(ev: LaunchEvent, nowMs: number = Date.now()): MatchExplanation[] {
    return this.compiled.map((c) => ({ playId: c.play.id ?? -1, ...this.match(c, ev, nowMs) }));
  }

  private match(c: CompiledPlay, ev: LaunchEvent, nowMs: number): { matched: boolean; reasons: string[] } {
    const t = c.play.trigger;
    const no = (why: string): { matched: false; reasons: string[] } => ({ matched: false, reasons: [why] });
    if (c.error) return no(c.error);
    if (c.configured.length === 0) return no('trigger has no identity matcher');
    if (ev.pairToken !== QUOTE_TOKENS.eth) return no(`pair token ${ev.pairToken} is not native ETH`);

    // ---- filters (AND)
    const devBuy = ev.devBuyQuoteIn ?? 0n;
    if (t.launchKind === 'devBuy' && devBuy === 0n) return no('launchKind=devBuy but no dev buy');
    if (t.launchKind === 'noDevBuy' && devBuy > 0n) return no(`launchKind=noDevBuy but dev bought ${formatEther(devBuy)}`);
    const devEth = Number(formatEther(devBuy));
    if (t.minDevBuyEth !== undefined && devEth < t.minDevBuyEth) return no(`dev buy ${devEth} < min ${t.minDevBuyEth}`);
    if (t.maxDevBuyEth !== undefined && devEth > t.maxDevBuyEth) return no(`dev buy ${devEth} > max ${t.maxDevBuyEth}`);

    // ---- identity matchers
    const res = new Map<TriggerField, string | null>();
    const deployer = ev.deployer.toLowerCase();
    const txFrom = ev.txFrom?.toLowerCase();
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
          const team = new Set([...ev.exemptions.map((x) => x.toLowerCase()), ev.creatorFeeRecipient.toLowerCase()]);
          const hits = [...team].filter((w) => c.teamWallets!.has(w));
          res.set(f, hits.length ? `teamWalletsAny: ${hits.join(',')}` : null);
          break;
        }
        case 'nameRegex':
          res.set(f, c.nameRe!.test(ev.name) ? `nameRegex ${c.nameRe} ~ "${ev.name}"` : null);
          break;
        case 'symbolRegex':
          res.set(f, c.symbolRe!.test(ev.symbol) ? `symbolRegex ${c.symbolRe} ~ "${ev.symbol}"` : null);
          break;
      }
    }
    const required = new Set(t.require);
    for (const r of required) {
      if (!c.configured.includes(r)) return no(`required matcher ${r} is not configured`);
      if (!res.get(r)) return no(`required ${r} did not match`);
    }
    const optional = c.configured.filter((f) => !required.has(f));
    const optionalHits = optional.filter((f) => res.get(f));
    if (optional.length > 0 && optionalHits.length === 0) return no(`none of ${optional.join('|')} matched`);
    const reasons = [...res.values()].filter((x): x is string => !!x);
    if (devBuy > 0n) reasons.push(`dev buy ${formatEther(devBuy)} ETH`);
    return { matched: true, reasons };
  }
}
