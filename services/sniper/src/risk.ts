/**
 * Risk gate (ARCHITECTURE §6). All checks are memory-only except `reserveCheck`, which uses the
 * single getReserves eth_call made right after the launch receipt.
 *
 * Accounting (reviewer H1/H2/H3):
 *  - `reserve()` takes a concurrency slot at decision time — nothing else; a spoofed or failed
 *    launch must not burn `stopAfter` or `firstBuyOnly` for the real one.
 *  - `confirm()` runs once the receipt proved the launch (TokenLaunched from the factory with the
 *    same deployer): counts the play for `stopAfter`, marks the token (token cap) and the
 *    deployer (`firstBuyOnly`: this deployer's first real launch has been played).
 *  - `release()` frees the slot of a run that ended without a position; a confirmed run that never
 *    filled is un-counted for `stopAfter` (the DB counts pending/open/closed rows only), while the
 *    token and the deployer stay marked (the launch was real and has been played).
 *  - positions (incl. ones rebuilt at startup) hold their slot until closed.
 *  - `sendCheck()` (kill switch, daily loss) runs at decide time AND right before the first send.
 *
 * Daily loss limit (realised live PnL of the UTC day): `settings.daily_loss_limit_eth`, else
 * DAILY_LOSS_LIMIT_ETH, else a percentage (`settings.daily_loss_limit_pct`, else
 * DAILY_LOSS_LIMIT_PCT, default 15 %) of the bankroll at the start of the day (the first bankroll
 * figure seen that UTC day: contract ETH balance live, paper bankroll in paper mode). Until a
 * bankroll is known the percentage mode falls back to 0.5 ETH.
 */
import { mcapFromReserves, type Preset, type Reserves } from '@hood/core';
import { formatEther } from 'viem';
import type { Decision, DetectedLaunch } from './types.js';

export interface RiskOptions {
  maxConcurrent: number;
  /** fixed limit (ETH); undefined = percentage of the day's starting bankroll */
  dailyLossLimitEth?: number | undefined;
  /** percentage mode (default 15) */
  dailyLossLimitPct?: number | undefined;
  maxGasPriceGwei: number;
  mode: 'live' | 'paper';
}

/** Percentage mode before any bankroll figure is known. */
export const FALLBACK_DAILY_LOSS_ETH = 0.5;

export interface RiskVerdict {
  ok: boolean;
  reasons: string[];
}

/** Same value shapes the telegram bot writes/reads (services/telegram parseKillState). */
export function killSwitchOn(v: unknown): boolean {
  if (v === true || v === 'on' || v === 'true' || v === 1) return true;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return o.on === true || o.enabled === true || o.killed === true;
  }
  return false;
}

const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);

export class Risk {
  private settings: Record<string, unknown> = {};
  private openCount = 0;
  private realizedTodayEth = 0;
  private day = utcDay(Date.now());
  /** first bankroll figure of the current UTC day (ETH) */
  private dayBankrollEth: number | null = null;
  private readonly countsByPlay = new Map<number, number>();
  private readonly tokens = new Set<string>();
  private readonly playDeployers = new Set<string>();
  /** latest L2 gas price (wei), refreshed off the hot path */
  gasPriceWei: bigint | null = null;

  constructor(private readonly opts: RiskOptions) {}

  setSettings(s: Record<string, unknown>): void {
    this.settings = s;
  }

  seed(stats: { countsByPlay: Record<number, number>; realizedPnlSince: number; tokens: string[]; playDeployers: { playId: number; deployer: string }[] }): void {
    for (const [k, v] of Object.entries(stats.countsByPlay)) this.countsByPlay.set(Number(k), v);
    this.realizedTodayEth = stats.realizedPnlSince;
    for (const t of stats.tokens) this.tokens.add(t.toLowerCase());
    for (const pd of stats.playDeployers) this.playDeployers.add(`${pd.playId}:${pd.deployer.toLowerCase()}`);
  }

  get killSwitch(): boolean {
    return killSwitchOn(this.settings.kill_switch);
  }

  get dailyLossLimitEth(): number {
    const s = this.settings.daily_loss_limit_eth;
    if (typeof s === 'number') return s;
    if (this.opts.dailyLossLimitEth !== undefined) return this.opts.dailyLossLimitEth;
    this.rollDay();
    if (this.dayBankrollEth === null) return FALLBACK_DAILY_LOSS_ETH;
    return (this.dailyLossLimitPct / 100) * this.dayBankrollEth;
  }

  get dailyLossLimitPct(): number {
    const s = this.settings.daily_loss_limit_pct;
    return typeof s === 'number' ? s : (this.opts.dailyLossLimitPct ?? 15);
  }

  /** Feed the current bankroll (ETH); the first figure of each UTC day is the percentage base. */
  setBankroll(eth: number | null, now = Date.now()): void {
    this.rollDay(now);
    if (eth !== null && Number.isFinite(eth) && this.dayBankrollEth === null) this.dayBankrollEth = eth;
  }

  get bankrollAtDayStart(): number | null {
    return this.dayBankrollEth;
  }

  get maxConcurrent(): number {
    const s = this.settings.max_concurrent;
    return typeof s === 'number' ? s : this.opts.maxConcurrent;
  }

  get open(): number {
    return this.openCount;
  }

  get realizedToday(): number {
    this.rollDay();
    return this.realizedTodayEth;
  }

  playCount(playId: number): number {
    return this.countsByPlay.get(playId) ?? 0;
  }

  private rollDay(now = Date.now()): void {
    const d = utcDay(now);
    if (d !== this.day) {
      this.day = d;
      this.realizedTodayEth = 0;
      this.dayBankrollEth = null;
    }
  }

  /** Global stops that must hold at decide time AND right before the first send. */
  sendCheck(now = Date.now()): RiskVerdict {
    this.rollDay(now);
    const reasons: string[] = [];
    if (this.killSwitch) reasons.push('kill switch on');
    if (this.realizedTodayEth <= -this.dailyLossLimitEth) reasons.push(`daily loss ${this.realizedTodayEth.toFixed(4)} ETH ≥ limit ${this.dailyLossLimitEth}`);
    return { ok: reasons.length === 0, reasons };
  }

  /** Memory-only checks on the decide path. */
  preCheck(d: Decision, l: DetectedLaunch, now = Date.now()): RiskVerdict {
    const reasons = [...this.sendCheck(now).reasons];
    const p = d.preset;
    const playId = d.play.id ?? -1;
    if (this.openCount >= this.maxConcurrent) reasons.push(`max concurrent ${this.maxConcurrent} reached`);
    const n = this.countsByPlay.get(playId) ?? 0;
    if (this.opts.mode === 'live' && n >= p.stopAfter) reasons.push(`stopAfter ${p.stopAfter} reached (${n})`);
    if (l.token && this.tokens.has(l.token)) reasons.push('token already sniped');
    if (p.firstBuyOnly && this.playDeployers.has(`${playId}:${l.event.deployer.toLowerCase()}`)) reasons.push('firstBuyOnly: deployer already sniped by this play');
    if (p.maxFeeGwei <= 0) reasons.push('maxFeeGwei must be > 0');
    if (this.gasPriceWei !== null && Number(this.gasPriceWei) / 1e9 > this.opts.maxGasPriceGwei)
      reasons.push(`gas price ${Number(this.gasPriceWei) / 1e9} gwei > cap ${this.opts.maxGasPriceGwei}`);
    if (p.buyEth <= 0) reasons.push('buyEth must be > 0');
    return { ok: reasons.length === 0, reasons };
  }

  /** Post-receipt check with the single getReserves call. */
  reserveCheck(p: Preset, r: Reserves): RiskVerdict {
    const reasons: string[] = [];
    if (p.minQuoteReserveEth !== undefined && Number(formatEther(r.quote)) < p.minQuoteReserveEth)
      reasons.push(`quote reserve ${formatEther(r.quote)} < min ${p.minQuoteReserveEth}`);
    const mcap = mcapFromReserves(r);
    if (p.maxEntryMcapEth !== undefined && mcap > p.maxEntryMcapEth)
      reasons.push(`mcap ${mcap.toFixed(3)} ETH > max entry ${p.maxEntryMcapEth}`);
    return { ok: reasons.length === 0, reasons };
  }

  /** Token cap applies once addresses are known. */
  tokenCheck(token: string): RiskVerdict {
    return this.tokens.has(token.toLowerCase()) ? { ok: false, reasons: ['token already sniped'] } : { ok: true, reasons: [] };
  }

  /** Effective max fee (gwei) = min(preset, global cap). */
  maxFeeGwei(p: Preset): number {
    return Math.min(p.maxFeeGwei, this.opts.maxGasPriceGwei);
  }

  /** Concurrency slot for a decided run (no other bookkeeping yet). */
  reserve(): void {
    this.openCount++;
  }

  /** Re-check token cap / firstBuyOnly / stopAfter with the confirmed launch (a sibling run may have confirmed first). */
  confirmCheck(playId: number, p: Preset, token: string, deployer: string): RiskVerdict {
    const reasons: string[] = [];
    if (this.tokens.has(token.toLowerCase())) reasons.push('token already sniped');
    if (p.firstBuyOnly && this.playDeployers.has(`${playId}:${deployer.toLowerCase()}`)) reasons.push('firstBuyOnly: deployer already sniped by this play');
    const n = this.countsByPlay.get(playId) ?? 0;
    if (this.opts.mode === 'live' && n >= p.stopAfter) reasons.push(`stopAfter ${p.stopAfter} reached (${n})`);
    return { ok: reasons.length === 0, reasons };
  }

  /** The receipt proved the launch: count it for stopAfter / firstBuyOnly / token cap. */
  confirm(playId: number, token: string, deployer: string): void {
    this.countsByPlay.set(playId, (this.countsByPlay.get(playId) ?? 0) + 1);
    this.tokens.add(token.toLowerCase());
    this.playDeployers.add(`${playId}:${deployer.toLowerCase()}`);
  }

  /** A run ended without a position: free its slot; un-count a confirmed run for stopAfter. */
  release(playId: number, confirmed: boolean): void {
    this.openCount = Math.max(0, this.openCount - 1);
    if (confirmed) this.countsByPlay.set(playId, Math.max(0, (this.countsByPlay.get(playId) ?? 1) - 1));
  }

  /** firstBuyOnly bookkeeping (tests / introspection). */
  hasPlayedDeployer(playId: number, deployer: string): boolean {
    return this.playDeployers.has(`${playId}:${deployer.toLowerCase()}`);
  }

  /** A position rebuilt at startup holds a slot (and its token / play count). */
  adoptPosition(playId: number, token: string, deployer: string | null): void {
    this.openCount++;
    this.tokens.add(token.toLowerCase());
    if (deployer) this.playDeployers.add(`${playId}:${deployer.toLowerCase()}`);
  }

  /** Realized PnL of a position closed without a slot here (reconciled after startup). Live only. */
  bookRealized(pnlEth: number): void {
    this.rollDay();
    if (this.opts.mode === 'live') this.realizedTodayEth += pnlEth;
  }

  onPositionClosed(pnlEth: number): void {
    this.rollDay();
    this.openCount = Math.max(0, this.openCount - 1);
    if (this.opts.mode === 'live') this.realizedTodayEth += pnlEth;
  }
}
