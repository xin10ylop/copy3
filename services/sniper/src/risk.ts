/**
 * Risk gate (ARCHITECTURE §6). All checks are memory-only except `reserveCheck`, which uses the
 * single getReserves eth_call made right after the launch receipt.
 */
import { mcapFromReserves, type Preset, type Reserves } from '@hood/core';
import { formatEther } from 'viem';
import type { Decision, DetectedLaunch } from './types.js';

export interface RiskOptions {
  maxConcurrent: number;
  dailyLossLimitEth: number;
  maxGasPriceGwei: number;
  mode: 'live' | 'paper';
}

export interface RiskVerdict {
  ok: boolean;
  reasons: string[];
}

const truthy = (v: unknown): boolean =>
  v === true || v === 'true' || v === 1 || (typeof v === 'object' && v !== null && ((v as { enabled?: unknown }).enabled === true || (v as { on?: unknown }).on === true));

const utcDay = (ms: number): number => Math.floor(ms / 86_400_000);

export class Risk {
  private settings: Record<string, unknown> = {};
  private openCount = 0;
  private realizedTodayEth = 0;
  private day = utcDay(Date.now());
  private readonly countsByPlay = new Map<number, number>();
  private readonly tokens = new Set<string>();
  private readonly playDeployers = new Set<string>();
  /** latest L2 gas price (wei), refreshed off the hot path */
  gasPriceWei: bigint | null = null;

  constructor(private readonly opts: RiskOptions) {}

  setSettings(s: Record<string, unknown>): void {
    this.settings = s;
  }

  seed(stats: { countsByPlay: Record<number, number>; openCount: number; realizedPnlSince: number; tokens: string[]; playDeployers: { playId: number; deployer: string }[] }): void {
    for (const [k, v] of Object.entries(stats.countsByPlay)) this.countsByPlay.set(Number(k), v);
    this.openCount = stats.openCount;
    this.realizedTodayEth = stats.realizedPnlSince;
    for (const t of stats.tokens) this.tokens.add(t.toLowerCase());
    for (const pd of stats.playDeployers) this.playDeployers.add(`${pd.playId}:${pd.deployer.toLowerCase()}`);
  }

  get killSwitch(): boolean {
    return truthy(this.settings.kill_switch);
  }

  get dailyLossLimitEth(): number {
    const s = this.settings.daily_loss_limit_eth;
    return typeof s === 'number' ? s : this.opts.dailyLossLimitEth;
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

  private rollDay(now = Date.now()): void {
    const d = utcDay(now);
    if (d !== this.day) {
      this.day = d;
      this.realizedTodayEth = 0;
    }
  }

  /** Memory-only checks on the decide path. */
  preCheck(d: Decision, l: DetectedLaunch, now = Date.now()): RiskVerdict {
    this.rollDay(now);
    const reasons: string[] = [];
    const p = d.preset;
    const playId = d.play.id ?? -1;
    if (this.killSwitch) reasons.push('kill switch on');
    if (this.realizedTodayEth <= -this.dailyLossLimitEth) reasons.push(`daily loss ${this.realizedTodayEth.toFixed(4)} ETH ≥ limit ${this.dailyLossLimitEth}`);
    if (this.openCount >= this.maxConcurrent) reasons.push(`max concurrent ${this.maxConcurrent} reached`);
    const n = this.countsByPlay.get(playId) ?? 0;
    if (this.opts.mode === 'live' && n >= p.stopAfter) reasons.push(`stopAfter ${p.stopAfter} reached (${n})`);
    if (l.token && this.tokens.has(l.token)) reasons.push('token already sniped');
    if (p.firstBuyOnly && this.playDeployers.has(`${playId}:${l.event.deployer}`)) reasons.push('firstBuyOnly: deployer already sniped by this play');
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

  onSnipeStarted(playId: number, token: string | undefined, deployer: string): void {
    this.openCount++;
    this.countsByPlay.set(playId, (this.countsByPlay.get(playId) ?? 0) + 1);
    if (token) this.tokens.add(token.toLowerCase());
    this.playDeployers.add(`${playId}:${deployer.toLowerCase()}`);
  }

  onTokenKnown(token: string): void {
    this.tokens.add(token.toLowerCase());
  }

  /** Snipe ended without a position (failed/aborted): frees the slot and the stopAfter count. */
  onSnipeEnded(playId: number, counted: boolean): void {
    this.openCount = Math.max(0, this.openCount - 1);
    if (!counted) this.countsByPlay.set(playId, Math.max(0, (this.countsByPlay.get(playId) ?? 1) - 1));
  }

  onPositionClosed(pnlEth: number): void {
    this.rollDay();
    this.openCount = Math.max(0, this.openCount - 1);
    if (this.opts.mode === 'live') this.realizedTodayEth += pnlEth;
  }
}
