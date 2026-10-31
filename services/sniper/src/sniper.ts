/**
 * Orchestrator: feed → clock + LaunchDetector → Rules → Risk → launch receipt (H1) → one
 * getReserves → ExecutionBackend (live burst / paper) → Positions → Recorder. Everything on the
 * decide path is memory; config arrives via NOTIFY into memory.
 *
 * Launch-second plays (`trigger.launchSecond`): while such a play is enabled, every launch seen
 * in the feed gets a `LaunchSecondLedger` that every later feed block of the launch second (and
 * node CurveBuy/Transfer logs) updates. Each change re-runs `rules.evaluate` with the ledger's
 * totals (µs); a match schedules the burst for the T+1 boundary exactly like an immediate match.
 * Before signing, the buys behind the match must be confirmed by CurveBuy logs (receipts) of the
 * receipt-proven curve, and right before the first send the play is re-checked (maximums, exempt
 * outflows) — see rules.ts for the H1 reasoning.
 *
 * Run lifecycle: decided (risk slot reserved) → confirmed (receipt: TokenLaunched from the
 * factory with the same deployer; play state recorded) → armed → filled (position) or ended
 * (`endRun`: slot released exactly once). A fill always opens a position, even after an abort
 * (H2). In live mode a "no fill" is checked against the chain (`bought(token)`, `balanceOf`)
 * before it is believed (H3); at startup every pending/open row is reconciled the same way.
 */
import {
  CURVE_FEE_BPS,
  TOPICS,
  decodedTxFromRpc,
  launchEventFromCall,
  parseLaunchCall,
  parsePlay,
  parsePreset,
  parseTokenLaunchedLog,
  quoteSell,
  type ArmedCandidate,
  type DecodedTx,
  type FeedBlock,
  type LaunchEvent,
  type LaunchKind,
  type Preset,
  type RawLog,
  type Reserves,
  type SequencerClock,
} from '@hood/core';
import { formatEther, parseEther, type Address, type Hex } from 'viem';
import type { ChainClient, SnipedLog, SniperHolding, SpendBudgetState } from './chain.js';
import { LaunchDetector, verifyLaunchReceipt, type ReceiptVerdict } from './detector.js';
import { SNIPE_DEADLINE_SECONDS, decodeSniped, snipeDeadlineTs, snipeTaxFromLogs, type ExecutionBackend } from './executor.js';
import type { HealthState } from './health.js';
import { LEDGER_SELECTORS, LaunchSecondLedger, SEL_SELL, SEL_TRANSFER, SEL_TRANSFER_FROM, outflowFrom } from './ledger.js';
import type { Logger } from './log.js';
import { Positions, type PositionEntry, type SaleRecord } from './positions.js';
import { DEFAULT_LAUNCH_RESERVES, MAX_TAX_BPS, launchReserves, planMinOut, worstTaxBps } from './pricing.js';
import { RaceTracker, raceNote, roundMs, type RaceRecord } from './race.js';
import { Recorder } from './recorder.js';
import { Risk } from './risk.js';
import { Rules } from './rules.js';
import type { Scheduler } from './scheduler.js';
import { PaperBankroll, SIZE_STEP_WEI, sizeBuy } from './sizing.js';
import { ContractLimits } from './limits.js';
import type { ActiveSnipe, ChangeChannel, SniperStore } from './store.js';
import type { Decision, DetectedLaunch, Fill, SnipeRun } from './types.js';

export interface SniperOptions {
  mode: 'live' | 'paper';
  store: SniperStore;
  chain: ChainClient;
  backend: ExecutionBackend;
  clock: SequencerClock;
  scheduler: Scheduler;
  logger: Logger;
  detector?: LaunchDetector;
  rttMs: () => number;
  maxConcurrent?: number;
  /** fixed daily loss limit (ETH). Unset with `dailyLossLimitPct` set = percentage of the day's starting bankroll. */
  dailyLossLimitEth?: number | undefined;
  /** DAILY_LOSS_LIMIT_PCT: used when `dailyLossLimitEth` is unset (neither set = 0.5 ETH fixed) */
  dailyLossLimitPct?: number | undefined;
  /** paper bankroll for `sizing.mode = 'bankroll'`: PAPER_BANKROLL_ETH + realised paper PnL. Default 0.1. */
  paperBankrollEth?: number;
  maxGasPriceGwei?: number;
  deadlineBlocks?: number;
  addressTimeoutMs?: number;
  /** launch receipt polling while confirming a launch (H1). Default 20 ms. */
  receiptPollMs?: number;
  reservesPollMs?: number;
  gasPollMs?: number;
  /** launches whose TokenLaunched log arrives without a feed tx after this long go the fallback path */
  fallbackDelayMs?: number;
  recordFeedBlocks?: boolean;
  nonce?: () => number | null;
  /** start reserves per launchConfigId (default: config 0 = 1.68 ETH virtual quote / 1e27 tokens) */
  launchReserves?: Readonly<Record<string, Reserves>>;
  /**
   * Re-price minTokensOut this many ms before the first send, from the launch-second buys
   * confirmed since the decision (ledger) and 'latest' reserves polled from the sequencer RPC
   * every ~100 ms while waiting (plus one last read, ≤ 60 ms). 0 = off. Default 250 (main.ts).
   * Team buys made through helper contracts are invisible to the feed and their CurveBuy logs
   * reach the node ws a few hundred ms after the decision; a bound priced without them reverted
   * SlippageExceeded at +1 s on two launches of one operator (30 Oct 2026).
   */
  repriceLeadMs?: number;
  /** skip a team's launches for this many minutes after one of them closed at a loss (0 = off); see Risk */
  teamCoolOffMin?: number;
  /** max wait for getReserves when start reserves are known. Default 5 ms. */
  reservesWaitMs?: number;
  /** live: the PonsSniper contract (chain-truth reconciliation, H3/H4) */
  sniperContract?: Address;
  /** retry unresolved runs / re-check terminal positions. Default 30 s. */
  reconcileMs?: number;
  maxExitRounds?: number;
  exitBackoffMs?: number;
  /** cap of the transient-failure exit backoff (N2). Default 60 s. */
  maxExitBackoffMs?: number;
  /** re-arm a stuck position this long after it got stuck (N2). Default 5 min. */
  stuckRearmMs?: number;
  /** NEW-2: re-read settings (kill switch) this often whatever NOTIFY delivered. Default 10 s. */
  settingsReloadMs?: number;
  /** NEW-2: re-read plays and armed candidates this often. Default 60 s. */
  playsReloadMs?: number;
  /** keep `feed_blocks` rows this many days (pruned hourly from the reconcile timer); 0 = keep all. Default 7. */
  feedBlocksRetentionDays?: number;
  /** NEW-3: startup sweep of the contract's Sniped events — first run looks back this many blocks; 0 = off. Default 864 000 (~1 day). */
  sweepLookbackBlocks?: number;
  /** R4-2: re-run the sweep from its checkpoint this often. Default 5 min. */
  sweepIntervalMs?: number;
  /** NEW-4/6 paper mode: the contract caps live would have (live reads them from the chain via the gate) */
  paperLimits?: { maxQuoteIn: bigint; maxSpend: bigint; spendWindow: number };
  /** race measurement (feed blocks, `race_*` counters); shared with the probe backend. Default: own tracker. */
  race?: RaceTracker;
}

/** NEW-4: alert at most this often for the same refusal type */
const ALERT_EVERY_MS = 10 * 60_000;
/** R4-2: a run unresolved longer than this raises `snipe_unresolved_long` */
const UNRESOLVED_ALERT_MS = 120_000;


const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Paper defaults = the deploy defaults (maxQuoteIn 0.3, budget 4 × per 3600 s). */
export const DEFAULT_PAPER_LIMITS = { maxQuoteIn: parseEther('0.3'), maxSpend: parseEther('1.2'), spendWindow: 3600 } as const;

type RecoverResult = Fill | null | 'unknown';

export class Sniper {
  readonly rules: Rules;
  readonly risk: Risk;
  readonly detector: LaunchDetector;
  readonly positions: Positions;
  readonly recorder: Recorder;
  /** where our txs land vs the first T+1 block (probe txs, live buys) — race.ts */
  readonly race: RaceTracker;
  readonly counters: Record<string, number> = {
    launches_seen: 0,
    decisions: 0,
    aborted: 0,
    failed: 0,
    fills: 0,
    fills_recovered: 0,
    fills_after_abort: 0,
    closed: 0,
    fallback_launches: 0,
    log_launches: 0,
    log_launches_stale: 0,
    spoof_rejected: 0,
    positions_rebuilt: 0,
    alerts: 0,
    errors: 0,
    ledger_launches: 0,
    ledger_matches: 0,
    launch_second_unconfirmed: 0,
  };
  lastError: string | null = null;
  lastDecideUs = 0;
  /** paper mode: the simulated contract balance for bankroll sizing */
  readonly paperBank: PaperBankroll | null;
  private readonly runs = new Map<string, SnipeRun>();
  /** live runs whose outcome could not be read from the chain yet (H3) */
  private readonly unresolvedRuns = new Map<string, SnipeRun>();
  /** startup rows whose chain read failed; retried by the reconcile timer */
  private readonly unresolvedRows = new Map<number, ActiveSnipe>();
  private readonly blockTs = new Map<number, number>();
  private readonly curveTax = new Map<string, number>();
  /** launch tx hash → launch-second ledger (only while a launch-second play is enabled) */
  private readonly ledgers = new Map<string, LaunchSecondLedger>();
  private settingsReloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** block timestamp → feed txs with a ledger selector (buy/sell/transfer), last few seconds */
  private readonly secondTxs = new Map<number, { block: number; tx: DecodedTx }[]>();
  private ledgerSecond = 0;
  private readonly timers: NodeJS.Timeout[] = [];
  /** NEW-3: one-shot re-checks of runs waiting for their deadline block */
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private unsubs: (() => void | Promise<void>)[] = [];
  private seq = 0;
  private statsLoaded = false;
  /**
   * PonsSniper.maxQuoteIn and the spend budget (N15, NEW-4/6): live from the gate (refreshed every
   * GATE_REFRESH_MS), paper from `paperLimits`. Bankroll sizes are clamped to them; a fixed buyEth
   * above maxQuoteIn and a budget below quoteIn are refused at decide time.
   */
  readonly limits: ContractLimits;
  private readonly lastAlertAt = new Map<string, number>();
  /** runs whose no-fill check is being settled (timer and reconcile tick never overlap) */
  private readonly settling = new Set<string>();
  private lastFeedPrune = 0;
  /** tx hashes already handled by the log-originated launch path */
  private readonly logOrigin = new Set<string>();
  /** R4-2: the last bought()/balanceOf() read per run (with the block it was pinned to) */
  private readonly lastRead = new Map<string, SniperHolding>();
  private sweepRunning: Promise<number> | null = null;
  /** R4-5: generation of the config loads started / last applied, per kind */
  private readonly cfgGen = { settings: { next: 0, applied: 0 }, plays: { next: 0, applied: 0 }, armed: { next: 0, applied: 0 } };
  /** R4-8: how often a ledger was re-opened after a refuted launch-second confirmation */
  private readonly ledgerReopens = new WeakMap<LaunchSecondLedger, number>();
  /** NEW-3: the startup orphan sweep (tests await it) */
  sweeping: Promise<number> = Promise.resolve(0);
  private readonly startedAt = Date.now();

  constructor(private readonly o: SniperOptions) {
    this.rules = new Rules({ mode: o.mode });
    this.risk = new Risk({
      mode: o.mode,
      maxConcurrent: o.maxConcurrent ?? 3,
      dailyLossLimitEth: o.dailyLossLimitEth ?? (o.dailyLossLimitPct === undefined ? 0.5 : undefined),
      dailyLossLimitPct: o.dailyLossLimitPct,
      maxGasPriceGwei: o.maxGasPriceGwei ?? 1,
      teamCoolOffMin: o.teamCoolOffMin ?? 0,
    });
    this.paperBank = o.mode === 'paper' ? new PaperBankroll(parseEther(String(o.paperBankrollEth ?? 0.1))) : null;
    const pl = o.paperLimits ?? DEFAULT_PAPER_LIMITS;
    this.limits =
      o.mode === 'paper'
        ? new ContractLimits({ maxQuoteIn: pl.maxQuoteIn, spend: { maxSpend: pl.maxSpend, window: pl.spendWindow, level: 0n, updatedAt: 0 } })
        : new ContractLimits();
    this.detector = o.detector ?? new LaunchDetector();
    this.race = o.race ?? new RaceTracker({ chain: o.chain, logger: o.logger });
    this.recorder = new Recorder(o.store, o.logger, { recordFeedBlocks: o.recordFeedBlocks ?? true });
    this.positions = new Positions({
      backend: o.backend,
      chain: o.chain,
      logger: o.logger,
      now: () => o.scheduler.now(),
      ...(o.mode === 'live' && o.sniperContract ? { sniper: o.sniperContract } : {}),
      ...(o.maxExitRounds !== undefined ? { maxExitRounds: o.maxExitRounds } : {}),
      ...(o.exitBackoffMs !== undefined ? { exitBackoffMs: o.exitBackoffMs } : {}),
      ...(o.maxExitBackoffMs !== undefined ? { maxExitBackoffMs: o.maxExitBackoffMs } : {}),
      ...(o.stuckRearmMs !== undefined ? { stuckRearmMs: o.stuckRearmMs } : {}),
      onExitSignal: (p, s, r) => {
        // the trigger reading, in the log and on the run (hoodctl trades shows the notes)
        o.logger.info({ key: p.key, token: p.token, reason: s.reason, ...r }, 'exit signal');
        p.run.notes.push(
          `exit ${s.reason} at ${r.pnlPct.toFixed(1)}% (peak ${r.peakPnlPct.toFixed(1)}%, held ${(r.heldMs / 1000).toFixed(1)}s, snapshot block ${r.snapshotBlock} +${r.deltas} logs, last block ${r.lastBlock ?? '?'})`,
        );
      },
      onSale: (p, s) => {
        this.recorder.snipe(p.run, p, 'snipe_sell');
        o.logger.info({ key: p.key, reason: s.reason, tokensIn: s.tokensIn.toString(), quoteOut: s.quoteOut.toString(), estimated: s.estimated }, 'sold');
      },
      onClosed: (p, pnl) => {
        p.run.status = 'closed';
        p.run.ended = true;
        this.counters.closed!++;
        // R4-1: an adopted orphan holds no MAX_CONCURRENT slot and its PnL is not daily-loss PnL
        this.risk.onPositionClosed(p.run.orphan ? 0 : pnl, p.run.slot !== false, p.exempt);
        this.paperBank?.close(p.key, pnl);
        this.runs.delete(p.key);
        this.recorder.snipe(p.run, p, 'snipe_closed');
        o.logger.info({ key: p.key, pnlEth: pnl }, 'position closed');
      },
      onExitFailed: (p, err) => this.error(`exit failed for ${p.token}: ${err}`),
      onAlert: (p, type, detail) => {
        p.run.notes.push(`${type}: ${JSON.stringify(detail)}`);
        this.recorder.snipe(p.run, p, 'snipe_update'); // persist the note; the typed event is the alert
        this.alert(type, { key: p.key, snipeId: p.run.id, token: p.token, curve: p.curve, phase: p.phase, ...detail }, type === 'sale_from_chain' ? 'warn' : 'error');
      },
    });
  }

  /** Contract limits learnt by the live gate (N15, NEW-4): maxQuoteIn and the spend budget. */
  setContractLimits(l: { maxQuoteIn: bigint | null; spend?: SpendBudgetState | null }): void {
    this.limits.set(l);
  }

  /** An alert that repeats at most every ALERT_EVERY_MS per type. */
  private alertThrottled(type: string, payload: Record<string, unknown>, level: 'warn' | 'error' = 'error'): void {
    const now = Date.now();
    if ((this.lastAlertAt.get(type) ?? -Infinity) + ALERT_EVERY_MS > now) return;
    this.lastAlertAt.set(type, now);
    this.alert(type, payload, level);
  }

  /** Bankroll for sizing: the cached contract ETH balance (live) or the paper bankroll. Memory-only. */
  bankrollWei(): bigint | null {
    return this.paperBank ? this.paperBank.balanceWei() : (this.o.backend.bankrollWei?.() ?? null);
  }

  /**
   * The daily-loss percentage base is the WHOLE bankroll: free balance + the cost of the open
   * positions. `bankrollWei()` is the free balance (paper: start + realised − committed; live:
   * the contract's ETH, which drops while positions are open), so the first sample of the day
   * taken with three positions open gave a base of 0.024 ETH on a 0.127 ETH bankroll (Ohio,
   * 29 Oct 2026) — a 0.0036 ETH limit that a normal losing streak trips.
   */
  private feedBankroll(): void {
    this.risk.setBankroll(this.totalBankrollEth());
  }

  /** Free bankroll + cost basis of the open positions (ETH); null when the free figure is unknown. */
  totalBankrollEth(): number | null {
    if (this.paperBank) return Number(this.paperBank.totalWei()) / 1e18;
    const b = this.bankrollWei();
    if (b === null) return null;
    let open = 0n;
    for (const p of this.positions.open) open += p.costBasis;
    return Number(b + open) / 1e18;
  }

  /** Creator tax for a curve we have seen launch (paper fills/exits). */
  creatorTaxBps(curve: Address): number {
    return this.curveTax.get(curve.toLowerCase()) ?? 0;
  }

  private error(msg: string, err?: unknown): void {
    this.counters.errors!++;
    this.lastError = `${new Date().toISOString()} ${msg}`;
    this.o.logger.error({ err }, msg);
  }

  /** Operational alert: log + `events` row (telegram tails it). */
  alert(type: string, payload: Record<string, unknown>, level: 'warn' | 'error' = 'warn'): void {
    this.counters.alerts!++;
    this.o.logger[level]({ alert: type, ...payload }, `alert: ${type}`);
    this.recorder.event(level, type, payload);
  }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    const { store } = this.o;
    const [plays, armed, settings] = await Promise.all([store.loadPlays(), store.loadArmed(), store.loadSettings()]);
    this.rules.setPlays(plays);
    this.rules.setArmed(armed);
    this.risk.setSettings(settings);
    // H3: chain truth first, so stale pending rows are resolved before the risk aggregates load
    await this.reconcileStartup();
    const stats = await store.loadSnipeStats(new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000), this.o.mode);
    this.risk.seed(stats);
    this.paperBank?.seedRealized(stats.realizedPnlTotal ?? 0);
    this.feedBankroll();
    this.statsLoaded = true;
    this.o.logger.info({ plays: plays.length, armed: armed.length, positions: this.positions.open.length, unresolved: this.unresolvedRows.size }, 'state loaded');
    const off = await store.onChange(
      (c, p) => {
        this.onChange(c, p).catch((e: unknown) => this.error(`refresh on ${c} failed`, e));
      },
      // NEW-2: the LISTEN connection (re)connected — NOTIFYs sent while it was down are lost for good
      () => {
        this.reloadConfig('all', 'listen (re)connected').catch((e: unknown) => this.error('config reload on reconnect failed', e));
      },
    );
    this.unsubs.push(off);
    // NEW-3: tokens the contract bought that no row manages (e.g. a member that landed after its
    // run was written off) become positions again; in the background, after the reconciliation
    this.sweeping = this.sweepOrphans().catch((e: unknown) => {
      this.error('startup orphan sweep failed', e);
      this.alert('orphan_sweep_failed', { err: (e as Error).message }, 'warn');
      return 0;
    });
    if (this.detector.predictionMode === 'nonce') {
      try {
        this.detector.seedNonce(await this.o.chain.getTransactionCount(this.detector.launchDeployer as Address, 'latest'));
      } catch (e) {
        this.error('nonce seed failed', e);
      }
    }
    const unwatch = this.o.chain.watchLaunches?.((l) => {
      try {
        this.onTokenLaunchedLog(l);
      } catch (e) {
        this.error('TokenLaunched log handling failed', e); // never throw into the ws client (M2)
      }
    });
    if (unwatch) this.unsubs.push(unwatch);
    this.recorder.start();
    const every = (ms: number, fn: () => Promise<void> | void, what: string): void => {
      const t = setInterval(() => {
        try {
          const r = fn();
          if (r) r.catch((e: unknown) => this.error(`${what} failed`, e));
        } catch (e) {
          this.error(`${what} failed`, e);
        }
      }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.o.gasPollMs ?? 5000, async () => {
      this.feedBankroll();
      this.risk.gasPriceWei = await this.o.chain.getGasPrice();
    }, 'gas poll');
    every(this.o.reservesPollMs ?? 500, () => this.pollReserves(), 'reserves poll');
    every(250, () => this.positions.tick(), 'positions tick');
    every(this.o.reconcileMs ?? 30_000, () => this.reconcileTick(), 'reconcile');
    // NEW-2: never rely on NOTIFY alone (a kill switch written during a reconnect is not replayed)
    every(this.o.settingsReloadMs ?? 10_000, () => this.reloadConfig('settings', 'periodic'), 'settings reload');
    every(this.o.playsReloadMs ?? 60_000, () => this.reloadConfig('all', 'periodic'), 'plays reload');
    // R4-2: the orphan sweep runs from its checkpoint periodically, not only at startup
    if (this.o.mode === 'live' && this.o.sniperContract && (this.o.sweepLookbackBlocks ?? 864_000) > 0)
      every(this.o.sweepIntervalMs ?? 300_000, () => this.periodicSweep(), 'orphan sweep');
  }

  /**
   * NEW-2: re-read the config from the store — settings only (kill switch, limits: every 10 s) or
   * plays + armed candidates + settings (every 60 s and on every LISTEN (re)connect).
   */
  async reloadConfig(scope: 'settings' | 'all', why: string): Promise<void> {
    if (scope === 'all') await Promise.all([this.loadConfig('plays', why), this.loadConfig('armed', why), this.loadConfig('settings', why)]);
    else await this.loadConfig('settings', why);
  }

  /**
   * R4-5: every config load (NOTIFY-driven, periodic, on reconnect) takes a generation number when
   * it STARTS; a load that finishes after a newer one already applied is dropped. An older periodic
   * read can therefore never put back a kill switch a newer NOTIFY load just turned on.
   */
  private async loadConfig(what: 'settings' | 'plays' | 'armed', why: string): Promise<boolean> {
    const g = this.cfgGen[what];
    const mine = ++g.next;
    const { store } = this.o;
    const value = what === 'settings' ? await store.loadSettings() : what === 'plays' ? await store.loadPlays() : await store.loadArmed();
    if (mine < g.applied) return false; // a newer load already applied
    g.applied = mine;
    if (what === 'settings') {
      const wasKilled = this.risk.killSwitch;
      this.risk.setSettings(value as Record<string, unknown>);
      if (this.risk.killSwitch !== wasKilled) this.o.logger.warn({ killSwitch: this.risk.killSwitch, why }, 'kill switch changed');
    } else if (what === 'plays') this.rules.setPlays(value as Awaited<ReturnType<SniperStore['loadPlays']>>);
    else this.rules.setArmed(value as ArmedCandidate[]);
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    for (const lg of this.ledgers.values()) lg.unwatch?.();
    this.ledgers.clear();
    for (const u of this.unsubs) await u();
    await this.recorder.stop();
  }

  private async onChange(channel: ChangeChannel, payload: string): Promise<void> {
    if (channel === 'plays_changed') await this.loadConfig('plays', 'notify');
    else if (channel === 'armed_changed') {
      // @hood/db trigger payload: {op, id, play_id, wallet, status}
      const n = tryParse<{ play_id: number; playId: number; wallet: string; status: ArmedCandidate['status'] }>(payload);
      const playId = n?.play_id ?? n?.playId;
      if (n && playId !== undefined && n.wallet && n.status && n.status !== 'armed') {
        // R4-5: newer than any armed load still in flight (that one may predate the removal)
        const g = this.cfgGen.armed;
        g.applied = ++g.next;
        this.rules.removeArmed(playId, n.wallet);
      } else await this.loadConfig('armed', 'notify');
    } else if (channel === 'settings_changed') {
      // Checkpoint-style keys are filtered by the trigger (migration 0004); coalesce the rest so a
      // burst of settings writes causes one reload (R4-5 generations keep the newest load).
      const key = tryParse<{ key?: string }>(payload)?.key ?? '';
      if (/checkpoint|^indexer:|^sweep:/.test(key)) return;
      if (key === 'kill_switch' || key === '' || key === 'daily_loss' || key === 'auto_approve') {
        // safety keys and unknown payloads reload at once; never debounce the kill switch
        await this.loadConfig('settings', 'notify');
        this.o.logger.info({ channel, key, plays: this.rules.playCount, armed: this.rules.armedCount }, 'config refreshed');
        return;
      }
      if (this.settingsReloadTimer) return;
      this.settingsReloadTimer = setTimeout(() => {
        this.settingsReloadTimer = null;
        this.loadConfig('settings', 'notify').then(
          () => this.o.logger.info({ channel, plays: this.rules.playCount, armed: this.rules.armedCount }, 'config refreshed'),
          (e: unknown) => this.error('settings reload', e),
        );
      }, 250);
      return;
    }
    this.o.logger.info({ channel, plays: this.rules.playCount, armed: this.rules.armedCount }, 'config refreshed');
  }

  // ------------------------------------------------------------------ feed path
  onFeedBlock(b: FeedBlock): void {
    try {
      this.o.clock.ingest(b.timestamp, b.receivedAt, b.block);
      this.blockTs.set(b.block, b.timestamp);
      if (this.blockTs.size > 4096) this.blockTs.delete(this.blockTs.keys().next().value!);
      this.recorder.feedBlock(b);
      this.race.onFeedBlock(b);
      this.o.backend.onFeedBlock(b);
    } catch (e) {
      this.error('feed block bookkeeping', e);
    }
    this.positions.onFeedBlock(b).catch((e: unknown) => this.error('positions feed', e));
    try {
      this.ledgerFeed(b);
    } catch (e) {
      this.error('launch-second ledger', e);
    }
    if (this.runs.size) this.checkLaunchSecondDumps(b).catch((e: unknown) => this.error('launch-second dump check', e));
    let launchy = false;
    for (const tx of b.txs) {
      if (this.detector.isThirdPartyLauncher(tx.to)) {
        // a configured third-party launcher (any selector — 0x6319… uses an unknown one): the early
        // path polls its receipt; the launch is built from the factory's TokenLaunched log in it
        this.launchFromLog(tx.hash, { tx, addressSource: 'receipt' }).catch((e: unknown) => this.error(`launcher tx ${tx.hash}`, e));
        continue;
      }
      if (!launchy && this.detector.isCandidate(tx)) launchy = true;
    }
    if (launchy) {
      this.detector.detect(b).then(
        (ls) => {
          for (const l of ls) this.handleLaunch(l).catch((e: unknown) => this.error('handleLaunch', e));
        },
        (e: unknown) => this.error('detect', e),
      );
    }
  }

  blockTimestamp(block: number): number | undefined {
    return this.blockTs.get(block);
  }

  /** abortIfExemptSellInLaunchBlock: exempt wallets selling/transferring during the launch second. */
  private async checkLaunchSecondDumps(b: FeedBlock): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.status !== 'pending' || !run.decision.preset.abortIfExemptSellInLaunchBlock) continue;
      if (b.timestamp !== run.launch.ts || b.block <= run.launch.block) continue;
      const exempt = new Set(run.launch.event.exemptions.map((x) => x.toLowerCase()));
      for (const tx of b.txs) {
        if (!tx.selector || (tx.selector !== SEL_SELL && tx.selector !== SEL_TRANSFER && tx.selector !== SEL_TRANSFER_FROM)) continue;
        const tokenOrCurve = run.launch.token && run.launch.curve ? tx.to === run.launch.token || tx.to === run.launch.curve : true;
        if (!tokenOrCurve) continue;
        let from: string;
        try {
          from = await tx.recoverFrom();
        } catch {
          continue;
        }
        if (!exempt.has(from)) continue;
        this.abortRun(run, `exempt wallet ${from} ${tx.selector === SEL_SELL ? 'sold' : 'moved tokens'} in the launch second (${tx.hash})`);
        break;
      }
    }
  }

  /**
   * Cancel the members not sent yet. Members already in flight can still fill: the run stays
   * registered until the backend reports, and a fill then opens a position that exits at once (H2).
   */
  private abortRun(run: SnipeRun, why: string): void {
    if (run.status !== 'pending') return;
    run.status = 'aborted';
    run.abortReason = why;
    run.notes.push(why);
    const cancelled = this.o.backend.abort(run.key);
    this.recorder.snipe(run, undefined, 'snipe_aborted');
    this.o.logger.warn({ key: run.key, why, cancelled }, 'snipe aborted');
  }

  // ------------------------------------------------------------------ launch-second ledger
  /**
   * Feed block → per-second buffer of buy/sell/transfer-shaped txs, and every ledger of that
   * second (memory only). The buffer lets a ledger catch up on blocks it saw before the launch
   * was registered or before its curve address was known (CREATE2: only the receipt / the
   * TokenLaunched log tells).
   */
  private ledgerFeed(b: FeedBlock): void {
    if (this.ledgers.size === 0 && !this.rules.hasLaunchSecondPlays) return;
    let mine: DecodedTx[] | null = null;
    for (const tx of b.txs) if (tx.selector !== null && LEDGER_SELECTORS.has(tx.selector)) (mine ??= []).push(tx);
    if (mine) {
      const list = this.secondTxs.get(b.timestamp) ?? [];
      for (const tx of mine) list.push({ block: b.block, tx });
      this.secondTxs.set(b.timestamp, list);
    }
    if (b.timestamp > this.ledgerSecond) {
      this.ledgerSecond = b.timestamp;
      for (const ts of [...this.secondTxs.keys()]) if (ts < b.timestamp - 3) this.secondTxs.delete(ts);
      for (const [k, lg] of [...this.ledgers]) {
        if (lg.ts >= b.timestamp - 10) continue;
        lg.unwatch?.();
        lg.unwatch = null;
        this.ledgers.delete(k); // a run still holds its ledger for the guard
      }
    }
    for (const lg of this.ledgers.values()) {
      if (b.timestamp > lg.ts) {
        if (!lg.secondOver) {
          lg.secondOver = true;
          lg.firstBlockAfter = b.block;
        }
        continue;
      }
      if (!mine || b.timestamp !== lg.ts || b.block < lg.launch.block) continue;
      let changed = false;
      for (const tx of mine) changed = this.ledgerIngest(lg, tx, b.block) || changed;
      if (changed) this.onLedgerChanged(lg);
    }
  }

  /** One feed tx into a ledger. Outflows whose sender is unknown are recovered off the decide path. */
  private ledgerIngest(lg: LaunchSecondLedger, tx: DecodedTx, block: number): boolean {
    const r = lg.ingestTx(tx, block);
    if (r === 'out-needs-sender') {
      const kind = tx.selector === SEL_SELL ? 'sell' : 'transfer';
      const apply = (from: string): void => {
        if (lg.addOut(tx.hash, from, kind)) this.onLedgerChanged(lg);
      };
      const known = outflowFrom(tx);
      if (known) apply(known);
      else tx.recoverFrom().then(apply, () => undefined);
      return false;
    }
    return r === 'buy' || r === 'out';
  }

  private openLedger(l: DetectedLaunch): LaunchSecondLedger {
    const lg = new LaunchSecondLedger(l);
    this.ledgers.set(l.txHash.toLowerCase(), lg);
    this.counters.ledger_launches!++;
    // addresses from an early TokenLaunched log: replay now (handleLaunch evaluates right after)
    if (l.token && l.curve && (l.addressSource === 'log' || l.addressSource === 'receipt')) this.ledgerAddresses(lg, l.token, l.curve);
    this.resolveLedger(lg).catch((e: unknown) => this.error('launch-second ledger: launch receipt', e));
    return lg;
  }

  /** Set token/curve once (trusted source), replay the buffered feed txs of the launch second, watch node logs. */
  private ledgerAddresses(lg: LaunchSecondLedger, token: string, curve: string): boolean {
    if (!lg.setAddresses(token, curve)) return false;
    let changed = false;
    for (const { block, tx } of this.secondTxs.get(lg.ts) ?? []) if (block >= lg.launch.block) changed = this.ledgerIngest(lg, tx, block) || changed;
    const unwatch = this.o.chain.watchToken?.(lg.token as Address, lg.curve as Address, (log) => {
      try {
        this.ledgerLog(lg, log);
      } catch (e) {
        this.error('launch-second ledger: node log', e); // never throw into the ws client (M2)
      }
    });
    lg.unwatch = unwatch ?? null;
    return changed;
  }

  /** CurveBuy / CurveSell / Transfer from the node: only blocks of the launch second count. */
  private ledgerLog(lg: LaunchSecondLedger, log: RawLog): void {
    if (lg.dead || log.blockNumber === null || log.blockNumber === undefined) return;
    const b = Number(log.blockNumber);
    if (!lg.inSecond(b, this.blockTs.get(b))) return;
    if (lg.ingestLog(log)) this.onLedgerChanged(lg);
  }

  /**
   * The launch receipt for a ledger (every launch, not only matched ones): token, curve, the
   * exempt set (SnipeTaxExempted) and the launchAndBuy dev buy. Woken early by the TokenLaunched
   * ws log; gives up after ~2.5 s (the launch second is long over by then).
   */
  private async resolveLedger(lg: LaunchSecondLedger): Promise<void> {
    const l = lg.launch;
    const poll = this.o.receiptPollMs ?? 20;
    const until = this.o.scheduler.now() + 2500;
    const realUntil = Date.now() + 2500 + poll;
    for (;;) {
      const r = await this.o.chain.getReceipt(l.txHash).catch(() => null);
      if (r) {
        const v = verifyLaunchReceipt(r, l, this.detector.factory);
        if (!v.ok) {
          lg.dead = true; // spoofed or reverted: never fire from this ledger
          return;
        }
        const c = v.confirmation;
        this.ledgerAddresses(lg, c.token, c.curve);
        lg.setExemptions(c.exemptions);
        lg.applyReceipt(r);
        this.onLedgerChanged(lg);
        return;
      }
      if (this.o.scheduler.now() >= until || Date.now() >= realUntil || lg.dead) return;
      const known = l.token !== undefined && l.curve !== undefined && l.addressSource !== undefined;
      await (known ? sleep(poll) : Promise.race([sleep(poll), this.detector.waitAddresses(l, poll)]));
    }
  }

  /** The ledger changed: re-run the rules for launch-second plays (memory, µs) and fire on a match. */
  private onLedgerChanged(lg: LaunchSecondLedger): void {
    lg.wake(); // a confirmation loop waiting on this ledger re-evaluates now (N16)
    if (lg.decided || lg.dead) return;
    const t0 = performance.now();
    const stats = lg.stats();
    const ds = this.rules.evaluate(lg.launch.event, Date.now(), stats, 'hint').filter((d) => d.play.trigger.launchSecond);
    if (ds.length === 0) return;
    lg.decided = true;
    // abortIfExemptSellInLaunchBlock: the team already moved tokens in the launch second
    const d = ds.find((x) => !(stats.exemptOut > 0 && x.preset.abortIfExemptSellInLaunchBlock));
    if (!d) {
      this.o.logger.info({ tx: lg.launch.txHash, outflows: lg.outflows }, 'launch-second match refused: exempt outflow already seen in the launch second');
      return;
    }
    this.counters.ledger_matches!++;
    this.decide(lg.launch, d, t0, lg, 'launch-second').catch((e: unknown) => this.error('launch-second decision', e));
  }

  /**
   * H1 for launch-second plays: re-evaluate with minimums against CONFIRMED buys only (CurveBuy
   * logs of the receipt-proven curve), fetching the receipts of pending feed hints, until the
   * play holds or `until` (scheduler ms) passes. A buy that reverted never counts.
   */
  private async confirmLaunchSecond(run: SnipeRun, until: number): Promise<{ ok: boolean; reason: string; refuted?: boolean }> {
    const lg = run.ledger;
    if (!lg) return { ok: false, reason: 'launch-second play without a ledger (the feed did not show the launch second)' };
    const poll = this.o.receiptPollMs ?? 20;
    const realUntil = Date.now() + Math.max(0, until - this.o.scheduler.now()) + poll;
    for (;;) {
      const v = this.rules.evaluatePlay(run.playId, run.launch.event, Date.now(), lg.stats(), 'confirm');
      if (v.matched) {
        run.notes.push(`launch-second confirmed: ${v.reasons.join('; ')}`);
        return { ok: true, reason: '' };
      }
      const pending = lg.pendingHints();
      if (pending.length === 0) return { ok: false, reason: `launch-second fingerprint not confirmed: ${v.reasons.join('; ')}`, refuted: true };
      if (this.o.scheduler.now() >= until || Date.now() >= realUntil) {
        return { ok: false, reason: `launch-second buys not confirmed in time (${pending.length} pending): ${v.reasons.join('; ')}` };
      }
      const receipts = await Promise.all(pending.map((h) => this.o.chain.getReceipt(h).catch(() => null)));
      let progressed = false;
      for (const r of receipts) if (r) progressed = lg.applyReceipt(r) || progressed;
      // N16: a node CurveBuy log confirms a buy as soon as it lands: wake on any ledger change
      if (!progressed) await lg.changed(Math.max(1, Math.min(poll, until - this.o.scheduler.now())));
    }
  }

  // ------------------------------------------------------------------ node logs
  onTokenLaunchedLog(log: RawLog): void {
    if (log.topics[0] !== TOPICS.TokenLaunched || log.address.toLowerCase() !== this.detector.factory) return;
    let parsed: ReturnType<typeof parseTokenLaunchedLog>;
    try {
      parsed = parseTokenLaunchedLog(log);
    } catch {
      return;
    }
    if (!parsed.txHash) return;
    const hash = parsed.txHash;
    const known = this.detector.resolve(hash, {
      token: parsed.token,
      curve: parsed.curve,
      source: 'log',
      deployer: parsed.deployer,
      ...(parsed.block !== undefined ? { block: parsed.block } : {}),
    });
    const lg = this.ledgers.get(hash.toLowerCase());
    if (lg && parsed.deployer.toLowerCase() === lg.launch.event.deployer.toLowerCase() && this.ledgerAddresses(lg, parsed.token, parsed.curve)) {
      this.onLedgerChanged(lg);
    }
    if (known || this.detector.get(hash)) return;
    // the feed did not classify this tx as a launch (a third-party launcher contract, or the feed
    // missed it): build it from the factory log. Right away when the feed already showed the
    // block (it will not classify it any more), else after a short grace period.
    const go = (): void => {
      if (this.detector.get(hash)) return;
      this.fallbackLaunch(hash, parsed.block, parsed.token, parsed.curve).catch((e: unknown) => this.error(`fallback launch ${hash} failed (log-originated)`, e));
    };
    if (parsed.block !== undefined && this.blockTs.has(parsed.block)) go();
    else {
      const t = setTimeout(go, this.o.fallbackDelayMs ?? 150);
      t.unref?.();
    }
  }

  /** A factory TokenLaunched log for a tx the feed did not classify: a log-originated launch. */
  async fallbackLaunch(txHash: Hex, _block?: number, _token?: Address, _curve?: Address): Promise<SnipeRun | null> {
    return this.launchFromLog(txHash, { addressSource: 'fallback' });
  }

  /**
   * Log-originated launch (production: ~50 % of Pons launches go through third-party launcher
   * contracts — 0x6319…cce2 with an unknown selector, 0x9dcc…3961 — that the calldata path never
   * saw). Built from the tx's RECEIPT: it must hold exactly one `TokenLaunched` emitted by the
   * factory; deployer, token, curve, pair and config come from that log — the factory's own truth,
   * not calldata an arbitrary contract chose, so H1's guarantee holds (the original H1 concern was
   * calldata-derived deployers). Exemptions are the curve's SnipeTaxExempted logs in the receipt,
   * the dev buy the launch tx's own CurveBuys; name / symbol / creator tax come from the calldata
   * when its selector is a known launch selector, else from token.name() / symbol() and
   * curve.creatorTaxBps(). Skipped when its block is older than MAX_LAUNCH_AGE_MS. Then exactly the
   * feed path: launch-second ledger, rules, receipt confirmation, burst at T+1.
   */
  async launchFromLog(txHash: Hex, o: { tx?: DecodedTx; addressSource: 'receipt' | 'fallback' }): Promise<SnipeRun | null> {
    const key = txHash.toLowerCase();
    if (this.logOrigin.has(key)) return null;
    this.logOrigin.add(key);
    if (this.logOrigin.size > 4096) this.logOrigin.delete(this.logOrigin.keys().next().value!);
    const poll = this.o.receiptPollMs ?? 20;
    const until = Date.now() + Math.max(500, this.detector.maxLaunchAge);
    let r: Awaited<ReturnType<ChainClient['getReceipt']>> = null;
    for (;;) {
      r = await this.o.chain.getReceipt(txHash).catch(() => null);
      if (r || Date.now() >= until || this.stopped) break;
      await sleep(poll);
    }
    if (!r || r.status !== 'success') return null;
    const feed = this.detector.get(txHash);
    if (feed && !this.detector.isThirdPartyLauncher(feed.event.launcher)) return null; // the feed path owns it
    const f = this.detector.factory;
    const launched = r.logs
      .filter((x) => x.address.toLowerCase() === f && x.topics[0] === TOPICS.TokenLaunched)
      .flatMap((x) => {
        try {
          return [parseTokenLaunchedLog(x)];
        } catch {
          return [];
        }
      });
    if (launched.length !== 1) return null; // no launch, or a batch: nothing we can attribute safely
    const tl = launched[0]!;
    const token = tl.token as Address;
    const curve = tl.curve as Address;
    const blk = r.blockNumber;
    const ts = this.blockTs.get(blk) ?? (await this.o.chain.getBlockTimestamp(blk));
    if (this.o.scheduler.now() - ts * 1000 > this.detector.maxLaunchAge) {
      this.counters.log_launches_stale!++;
      return null; // too late for the +1 s boundary (replay / slow node), like a stale feed launch
    }
    const dtx = o.tx ?? (await this.o.chain.getTransaction(txHash).then((t) => (t ? decodedTxFromRpc(t) : null)).catch(() => null));
    let call: ReturnType<typeof parseLaunchCall> | null = null;
    try {
      call = dtx && dtx.to ? parseLaunchCall({ to: dtx.to, input: dtx.input, value: dtx.value }) : null;
    } catch {
      call = null;
    }
    const exempt = new Set<string>();
    let devBuy = 0n;
    let devBuyRecipient: string | undefined;
    for (const x of r.logs) {
      if (x.address.toLowerCase() !== curve) continue;
      if (x.topics[0] === TOPICS.SnipeTaxExempted) exempt.add(`0x${(x.topics[1] ?? '').slice(26)}`.toLowerCase());
      if (x.topics[0] === TOPICS.CurveBuy) {
        // the launch tx's own buy; the ledger classifies it by recipient (deployer → dev, other
        // exempt wallet → team: the 0x6319… launcher pattern), see LaunchSecondLedger.kindOf
        devBuy += BigInt(`0x${x.data.slice(2, 66) || '0'}`);
        devBuyRecipient = `0x${(x.topics[2] ?? '').slice(26)}`.toLowerCase();
      }
    }
    const meta = call ? null : await this.o.chain.tokenMeta?.(token, curve).catch(() => null);
    exempt.add(tl.deployer.toLowerCase());
    exempt.delete(ZERO);
    const event: LaunchEvent = {
      deployer: tl.deployer as Address,
      name: call?.name ?? meta?.name ?? '',
      symbol: call?.symbol ?? meta?.symbol ?? '',
      launchKind: call?.kind ?? 'launchTokenFor',
      exemptions: [...exempt] as Address[],
      creatorFeeRecipient: (call?.creatorFeeRecipient ?? ZERO) as Address,
      creatorTaxBps: call?.creatorTaxBps ?? meta?.creatorTaxBps ?? 0,
      devBuyQuoteIn: devBuy,
      ...(devBuyRecipient && devBuyRecipient !== tl.deployer.toLowerCase() ? { devBuyRecipient: devBuyRecipient as Address } : {}),
      pairToken: tl.pairToken as Address,
      launchConfigId: tl.launchConfigId,
      token,
      curve,
      block: blk,
      ts,
      txHash: key as Hex,
      ...(dtx?.from ? { txFrom: dtx.from.toLowerCase() as Address } : {}),
      ...(dtx?.to ? { launcher: dtx.to.toLowerCase() as Address } : {}),
    };
    if (o.addressSource === 'fallback') this.counters.fallback_launches!++;
    this.counters.log_launches!++;
    this.o.logger.info({ tx: key, launcher: event.launcher, deployer: event.deployer, token, ageMs: this.o.scheduler.now() - ts * 1000 }, 'log-originated launch');
    return this.handleLaunch({
      event,
      block: blk,
      ts,
      receivedAt: this.o.scheduler.now(),
      txHash: key as Hex,
      token,
      curve,
      addressSource: o.addressSource,
      source: 'log',
      origin: 'log',
    });
  }

  onTokenLog(log: RawLog): void {
    this.positions.onLog(log);
  }

  /**
   * H1: poll the launch receipt (woken early by the TokenLaunched ws log) until `until` and
   * verify it. null = no receipt in time.
   */
  private async confirmLaunch(l: DetectedLaunch, until: number): Promise<ReceiptVerdict | null> {
    const poll = this.o.receiptPollMs ?? 20;
    const realUntil = Date.now() + Math.max(0, until - this.o.scheduler.now()) + poll;
    for (;;) {
      // N16: whichever arrives first — the node's TokenLaunched ws log or the receipt
      const viaLog = this.detector.logConfirmation(l);
      if (viaLog) {
        l.token = viaLog.token;
        l.curve = viaLog.curve;
        l.addressSource = l.addressSource === 'fallback' ? 'fallback' : 'log';
        return { ok: true, confirmation: viaLog, notes: ['launch confirmed by the TokenLaunched ws log (receipt verified in the background)'], viaLog: true };
      }
      const r = await this.o.chain.getReceipt(l.txHash).catch(() => null);
      if (r) {
        const v = verifyLaunchReceipt(r, l, this.detector.factory);
        if (v.ok) {
          const c = v.confirmation;
          const source = l.addressSource === 'log' || l.addressSource === 'fallback' ? l.addressSource : 'receipt';
          this.detector.resolve(l.txHash, { token: c.token, curve: c.curve, source, deployer: c.deployer });
          l.token = c.token;
          l.curve = c.curve;
          l.addressSource = source;
        }
        return v;
      }
      const left = until - this.o.scheduler.now();
      if (left <= 0 || Date.now() >= realUntil) return null;
      const step = Math.max(1, Math.min(poll, left));
      // until the ws TokenLaunched log has been seen, its arrival wakes the poll early
      const known = l.token !== undefined && l.curve !== undefined && l.addressSource !== undefined;
      await (known ? sleep(step) : Promise.race([sleep(step), this.detector.waitAddresses(l, step)]));
    }
  }

  /**
   * N16: a launch confirmed by its TokenLaunched ws log is still checked against the receipt in
   * the background: a contradiction aborts the run (an in-flight fill then exits at once, H2);
   * the receipt's SnipeTaxExempted set replaces the calldata team set.
   */
  private verifyLaunchLater(run: SnipeRun): void {
    const l = run.launch;
    const check = async (): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const r = await this.o.chain.getReceipt(l.txHash).catch(() => null);
        if (r) {
          const v = verifyLaunchReceipt(r, l, this.detector.factory);
          if (!v.ok) {
            const filled = this.positions.get(run.key) !== undefined;
            this.alert('launch_receipt_mismatch', { key: run.key, tx: l.txHash, reason: v.reason, filled }, 'error');
            if (filled) {
              // NEW-7: we already hold the token of a launch the receipt does not prove: get out
              run.notes.push(`launch receipt contradicts the TokenLaunched log after the fill (${v.reason}): exiting`);
              this.positions.forceExit(run.key, 'launch_receipt_mismatch');
              return;
            }
            run.abortExit = 'launch_receipt_mismatch'; // a member still in flight that fills exits at once
            this.abortRun(run, `launch receipt contradicts the TokenLaunched log: ${v.reason}`);
            return;
          }
          const ex = v.confirmation.exemptions;
          l.event = { ...l.event, exemptions: ex };
          run.ledger?.setExemptions(ex);
          this.positions.setExempt(run.key, ex);
          return;
        }
        await sleep(Math.max(20, this.o.receiptPollMs ?? 20) * 5);
      }
      this.alert('launch_receipt_missing', { key: run.key, tx: l.txHash }, 'warn');
    };
    check().catch((e: unknown) => this.error('background launch receipt check', e));
  }

  // ------------------------------------------------------------------ decide + execute
  private newRun(l: DetectedLaunch, d: Decision): SnipeRun {
    // Preset.sizing: fixed buyEth, or a share of the bankroll (cached balance, memory only)
    let sizing = sizeBuy(d.preset, d.preset.sizing?.mode === 'bankroll' ? this.bankrollWei() : null, this.risk.maxConcurrent);
    // NEW-6: a bankroll size is clamped to what the contract takes now — min(maxEth, maxQuoteIn,
    // remaining spend budget) — instead of refusing the whole play
    const cap = sizing.mode === 'bankroll' ? this.limits.cap() : null;
    if (cap !== null && sizing.quoteIn > cap) {
      const stepped = cap - (cap % SIZE_STEP_WEI);
      sizing = { ...sizing, quoteIn: stepped, clamped: 'contract', note: `${sizing.note} → clamped to the contract cap ${formatEther(cap)} ETH (maxQuoteIn / spend budget)` };
    }
    const quoteIn = sizing.quoteIn;
    const maxTaxBps = Math.max(0, Math.min(MAX_TAX_BPS, Math.floor(d.preset.maxTaxBps)));
    const run: SnipeRun = {
      id: 0,
      key: `${l.txHash.slice(0, 18)}:${d.play.id ?? 0}:${this.seq++}`,
      mode: this.o.mode,
      playId: d.play.id ?? 0,
      launch: l,
      decision: d,
      status: 'pending',
      decidedAt: Date.now(),
      quoteIn,
      minTokensOut: 0n,
      maxTaxBps,
      deadlineBlock: l.block + (this.o.deadlineBlocks ?? 40),
      deadlineTs: l.ts + SNIPE_DEADLINE_SECONDS,
      burst: [],
      notes: [],
      sizing,
    };
    if (maxTaxBps !== d.preset.maxTaxBps) run.notes.push(`maxTaxBps ${d.preset.maxTaxBps} clamped to ${maxTaxBps} (M3)`);
    if (sizing.mode === 'bankroll') run.notes.push(`size: ${sizing.note}`);
    return run;
  }

  /**
   * The most advanced view of the curve right before the burst: the ledger's confirmed
   * launch-second buys applied to the launch reserves, or a fresh 'latest' read (≤ 25 ms, the
   * fast endpoints), whichever has absorbed more buying (the larger quote reserve).
   */
  private async freshReserves(curve: Address, lg: LaunchSecondLedger | undefined, afterLaunch: Reserves | null, creatorTaxBps: number, current: Reserves, budgetMs = 60): Promise<Reserves> {
    const fromLedger = lg && afterLaunch && lg.priceMovingBuys > 0 ? lg.reservesAfter(afterLaunch, creatorTaxBps) : null;
    // budget 0: no time left for an RPC round trip, the ledger's confirmed logs and the poll decide
    const fromRpc = budgetMs > 0 ? await Promise.race([this.o.chain.getReserves(curve).catch(() => null), sleep(budgetMs).then(() => null)]) : null;
    let best = current;
    for (const r of [fromLedger, fromRpc]) if (r && r.quote > best.quote) best = r;
    return best;
  }

  /** Decide on a detected launch and, if it matches, run the snipe to a fill (or not). */
  async handleLaunch(l: DetectedLaunch): Promise<SnipeRun | null> {
    const t0 = performance.now();
    this.counters.launches_seen!++;
    if (l.origin !== 'log') {
      if (l.event.launcher && !this.detector.isLauncher(l.event.launcher)) {
        this.counters.spoof_rejected!++;
        return null; // H1 defence in depth (the detector already filters on tx.to)
      }
      // a third-party launcher's calldata deployer is not the factory's (N14): the log path owns it
      if (this.detector.isThirdPartyLauncher(l.event.launcher)) return null;
    }
    // every feed launch — and every launch built from the factory's TokenLaunched log — gets a
    // ledger while a launch-second play is enabled: later blocks of the launch second can still
    // make it match (onLedgerChanged)
    const ledger = (l.source === 'feed' || l.origin === 'log') && this.rules.hasLaunchSecondPlays ? this.openLedger(l) : undefined;
    const decisions = this.rules.evaluate(l.event, Date.now(), ledger?.stats());
    if (decisions.length === 0) {
      this.lastDecideUs = (performance.now() - t0) * 1000;
      const st = ledger?.stats();
      // a launcher-contract launch, or any launch with real team money, is rare enough to explain at info
      if (l.origin === 'log' || (st && st.seen.teamBuyEth >= 0.05)) {
        const why = this.rules.explain(l.event, Date.now(), st).map((x) => `${x.playId}: ${x.reasons.join('; ')}`);
        this.o.logger.info({ tx: l.txHash, origin: l.origin, ageMs: this.o.scheduler.now() - l.ts * 1000, seen: st?.seen, why }, 'launch: no play');
      } else this.o.logger.debug({ tx: l.txHash, name: l.event.name, deployer: l.event.deployer, ledger: ledger !== undefined }, 'launch: no play');
      return null;
    }
    if (ledger) ledger.decided = true;
    return this.decide(l, decisions[0]!, t0, ledger, 'launch');
  }

  /** A play matched (at the launch block or later from the launch-second ledger): risk, then execute. */
  private async decide(l: DetectedLaunch, d: Decision, t0: number, ledger: LaunchSecondLedger | undefined, source: 'launch' | 'launch-second'): Promise<SnipeRun> {
    const run = this.newRun(l, d);
    if (ledger) run.ledger = ledger;
    const verdict = this.risk.preCheck(d, l);
    // N15 / NEW-4 / NEW-6: what the contract would refuse (QuoteTooLarge, SpendLimitExceeded) is refused here
    const lim = this.limitsCheck(run, d.preset);
    if (lim.reasons.length) {
      verdict.ok = false;
      verdict.reasons.push(...lim.reasons);
      if (lim.budgetExhausted) {
        const b = this.limits.budget;
        this.alertThrottled('spend_budget_exhausted', {
          key: run.key,
          quoteInEth: formatEther(run.quoteIn),
          availableEth: formatEther(this.limits.available() ?? 0n),
          ...(b ? { maxSpendEth: formatEther(b.maxSpend), windowSec: b.window } : {}),
          mode: this.o.mode,
        });
      }
    }
    this.lastDecideUs = (performance.now() - t0) * 1000;
    this.counters.decisions!++;
    this.o.logger.info(
      {
        key: run.key,
        play: d.play.id,
        name: l.event.name,
        symbol: l.event.symbol,
        reasons: d.reasons,
        risk: verdict.reasons,
        decideUs: Math.round(this.lastDecideUs),
        source,
      },
      'launch matched',
    );
    if (!verdict.ok) {
      run.status = 'aborted';
      run.ended = true;
      run.notes.push(...verdict.reasons.map((r) => `risk: ${r}`));
      this.counters.aborted!++;
      this.recorder.snipe(run, undefined, 'snipe_aborted');
      return run;
    }
    // N10: no MAX_CONCURRENT slot yet — it is taken once the launch receipt proved the launch
    this.paperBank?.commit(run.key, run.quoteIn);
    this.limits.reserve(run.key, run.quoteIn); // R4-6: concurrent runs cannot both count on the same budget
    this.runs.set(run.key, run);
    this.recorder.snipe(run, undefined, 'snipe_decided');
    try {
      await this.execute(run);
    } catch (e) {
      this.error(`snipe ${run.key} crashed`, e);
      this.endRun(run, 'failed', `error: ${(e as Error).message}`);
    }
    return run;
  }

  /**
   * N15 / NEW-4 / NEW-6 (memory only): a FIXED buyEth above maxQuoteIn is refused (the preset can
   * never buy); a bankroll size was already clamped to the caps, and is refused only when that left
   * it below `minEth`; a remaining spend budget below quoteIn is refused (`spend_budget_exhausted`).
   */
  private limitsCheck(run: SnipeRun, p: Preset): { reasons: string[]; budgetExhausted: boolean } {
    const reasons: string[] = [];
    let budgetExhausted = false;
    const mq = this.limits.maxQuoteIn;
    const bankroll = p.sizing?.mode === 'bankroll';
    if (!bankroll && mq !== null && run.quoteIn > mq) reasons.push(`preset buys up to ${p.buyEth} ETH > contract maxQuoteIn ${formatEther(mq)} ETH (preset refused)`);
    const avail = this.limits.available();
    if (bankroll && run.sizing?.clamped === 'contract' && run.quoteIn < parseEther(String(p.sizing.minEth))) {
      reasons.push(`bankroll size clamped to the contract cap ${formatEther(run.quoteIn)} ETH < minEth ${p.sizing.minEth}`);
      budgetExhausted = avail !== null && (mq === null || avail < mq);
    } else if (avail !== null && avail < run.quoteIn) {
      const b = this.limits.budget!;
      reasons.push(`spend budget exhausted: ${formatEther(avail)} ETH left < quoteIn ${formatEther(run.quoteIn)} ETH (${formatEther(b.maxSpend)} ETH per ${b.window} s, refilling)`);
      budgetExhausted = true;
    }
    return { reasons, budgetExhausted };
  }

  /** Paper twin of the live L8 contract-balance pre-check: the simulated contract balance must cover quoteIn. */
  private paperPreflight(run: SnipeRun): string[] {
    const bank = this.paperBank;
    if (!bank) return [];
    const free = bank.freeWeiExcluding(run.key);
    return free < run.quoteIn ? [`paper: contract balance ${formatEther(free)} ETH < quoteIn ${formatEther(run.quoteIn)} ETH`] : [];
  }

  /** A run ends without a position: release its slot exactly once. */
  private endRun(run: SnipeRun, status: 'failed' | 'aborted', why: string): SnipeRun {
    if (run.ended || this.positions.get(run.key)) return run;
    run.ended = true;
    const final = run.status === 'aborted' ? 'aborted' : status;
    run.status = final;
    run.notes.push(why);
    this.counters[final]!++;
    this.risk.release(run.playId, run.confirmed === true, run.slot === true);
    this.paperBank?.release(run.key);
    this.limits.release(run.key);
    this.lastRead.delete(run.key);
    this.runs.delete(run.key);
    this.unresolvedRuns.delete(run.key);
    this.recorder.snipe(run, undefined, final === 'failed' ? 'snipe_failed' : 'snipe_aborted');
    this.o.logger.warn({ key: run.key, why }, `snipe ${final}`);
    return run;
  }

  /**
   * Last memory-only checks, evaluated again right before the first member is sent (L2). For a
   * launch-second play also the ledger: an exempt outflow in the launch second, or a maximum the
   * later blocks of the second pushed us over, blocks the burst.
   */
  private sendGuard(run?: SnipeRun): string | null {
    const v = this.risk.sendCheck();
    if (!v.ok) return v.reasons.join('; ');
    const lg = run?.ledger;
    if (run && lg && run.decision.play.trigger.launchSecond) {
      const s = lg.stats();
      if (s.exemptOut > 0 && run.decision.preset.abortIfExemptSellInLaunchBlock) {
        return `exempt wallet ${lg.outflows[0]?.from ?? '?'} moved tokens in the launch second`;
      }
      const m = this.rules.evaluatePlay(run.playId, run.launch.event, Date.now(), s, 'confirm');
      if (!m.matched) return `launch-second fingerprint no longer holds: ${m.reasons.join('; ')}`;
    }
    return null;
  }

  private async execute(run: SnipeRun): Promise<void> {
    const { clock, scheduler, chain } = this.o;
    const l = run.launch;
    const p = run.decision.preset;
    const rttMs = this.o.rttMs();
    let plan = clock.planBurst({ launchTs: l.ts, now: scheduler.now(), burst: p.burst, rttMs });
    if (plan.times.length === 0) {
      this.endRun(run, 'aborted', 'too late: past boundary(T+2) − rtt');
      return;
    }

    // 1) H1: the receipt must prove the launch before anything is signed
    const waitMs = Math.max(0, Math.min(this.o.addressTimeoutMs ?? 1500, plan.latestMs - scheduler.now()));
    const verdict = await this.confirmLaunch(l, scheduler.now() + waitMs);
    if (run.status !== 'pending') {
      this.endRun(run, 'aborted', `aborted before the burst: ${run.abortReason ?? ''}`);
      return;
    }
    if (!verdict) {
      this.endRun(run, 'aborted', 'launch not confirmed in time (no receipt)');
      return;
    }
    if (!verdict.ok) {
      if (verdict.spoof) {
        this.counters.spoof_rejected!++;
        this.alert('launch_rejected', { key: run.key, tx: l.txHash, deployer: l.event.deployer, reason: verdict.reason });
      }
      this.endRun(run, 'aborted', `launch rejected: ${verdict.reason}`);
      return;
    }
    const c = verdict.confirmation;
    if (verdict.viaLog) this.verifyLaunchLater(run);
    const before = new Set(l.event.exemptions.map((x) => x.toLowerCase()));
    const teamChanged = c.exemptions.length !== before.size || c.exemptions.some((x) => !before.has(x));
    l.event = { ...l.event, token: c.token, curve: c.curve, exemptions: c.exemptions };
    run.notes.push(...verdict.notes);
    this.curveTax.set(c.curve, l.event.creatorTaxBps);
    const lg = run.ledger;
    if (lg) {
      lg.setExemptions(c.exemptions);
      this.ledgerAddresses(lg, c.token, c.curve);
    }
    // the deployer is proven equal; only the team set can differ from the calldata → re-match then
    if (teamChanged) {
      const again = this.rules.evaluatePlay(run.playId, l.event, Date.now(), lg?.stats());
      if (!again.matched) {
        this.endRun(run, 'aborted', `play no longer matches the confirmed launch: ${again.reasons.join('; ')}`);
        return;
      }
    }
    // launch-second plays: the buys behind the match must be proven before anything is signed
    if (run.decision.play.trigger.launchSecond) {
      const lc = await this.confirmLaunchSecond(run, plan.latestMs);
      if (run.status !== 'pending') {
        this.endRun(run, 'aborted', `aborted before the burst: ${run.abortReason ?? ''}`);
        return;
      }
      if (!lc.ok) {
        this.counters.launch_second_unconfirmed!++;
        this.endRun(run, 'aborted', lc.reason);
        // R4-8: a reverting fake team-buy hint must not use up the launch: once the hints behind
        // the match are refuted, the ledger may decide again on later CONFIRMED buys (bounded; the
        // burst window still applies — a late re-decision ends "too late")
        const lg2 = run.ledger;
        if (lc.refuted && lg2 && !lg2.dead) {
          const n = this.ledgerReopens.get(lg2) ?? 0;
          if (n < 3) {
            this.ledgerReopens.set(lg2, n + 1);
            lg2.decided = false;
            this.onLedgerChanged(lg2);
          }
        }
        return;
      }
    }
    const cc = this.risk.confirmCheck(run.playId, p, c.token, c.deployer);
    if (!cc.ok) {
      this.endRun(run, 'aborted', cc.reasons.join('; '));
      return;
    }
    this.risk.reserve();
    run.slot = true;
    this.risk.confirm(run.playId, c.token, c.deployer);
    run.confirmed = true;
    this.recorder.snipe(run, undefined, 'snipe_confirmed');
    const { token, curve } = c;

    // 2) the single eth_call on the decide path: getReserves (node may lag the feed by a block).
    //    When the launch config's start reserves are known we do not wait more than
    //    `reservesWaitMs` for it: config start + exact dev-buy math gives the same numbers.
    const rpcReserves = (async (): Promise<Reserves | null> => {
      for (let i = 0; i < 5; i++) {
        const r = await chain.getReserves(curve).catch(() => null);
        if (r) return r;
        await sleep(15);
      }
      return null;
    })();
    const start = (this.o.launchReserves ?? DEFAULT_LAUNCH_RESERVES)[String(l.event.launchConfigId)];
    const afterLaunch = start ? launchReserves(start, l.event.devBuyQuoteIn, l.event.creatorTaxBps) : null;
    // the ledger knows the launch-second buys (team buys move the price; the node may lag)
    const ledgerBasis = afterLaunch !== null && lg !== undefined && lg.priceMovingBuys > 0;
    const derived = ledgerBasis ? lg.reservesAfter(afterLaunch, l.event.creatorTaxBps) : afterLaunch;
    let reserves: Reserves | null;
    if (derived && ledgerBasis) {
      reserves = derived;
      run.notes.push(`reserves: launch config + ${lg.priceMovingBuys} launch-second buy(s) from the ledger`);
    } else if (derived) {
      const wait = this.o.reservesWaitMs ?? 5;
      reserves = (await Promise.race([rpcReserves, sleep(wait).then(() => null)])) ?? derived;
      rpcReserves.then(
        (r) => {
          if (r && (r.quote !== derived.quote || r.token !== derived.token))
            this.o.logger.debug({ key: run.key, rpc: [r.quote.toString(), r.token.toString()] }, 'reserves differ from launch-config start (trades already landed)');
        },
        () => undefined,
      );
    } else reserves = await rpcReserves;
    if (run.status !== 'pending') {
      this.endRun(run, 'aborted', `aborted before the burst: ${run.abortReason ?? ''}`);
      return;
    }
    if (!reserves) {
      this.endRun(run, 'aborted', 'getReserves failed');
      return;
    }
    const rc = this.risk.reserveCheck(p, reserves);
    if (!rc.ok) {
      this.endRun(run, 'aborted', rc.reasons.join('; '));
      return;
    }
    const mo = planMinOut({ ...p, maxTaxBps: run.maxTaxBps }, reserves, run.quoteIn, l.event.creatorTaxBps);
    run.minTokensOut = mo.minTokensOut;
    run.notes.push(`minOut basis ${mo.basis}, expected ${mo.expectedOut} @${mo.taxBps}bps`);

    // 3) kill switch / daily loss (L2) and balances (L8) right before the burst
    const sc = this.risk.sendCheck();
    if (!sc.ok) {
      this.endRun(run, 'aborted', `risk: ${sc.reasons.join('; ')}`);
      return;
    }
    const pf = this.o.backend.preflight?.({ quoteIn: run.quoteIn, gasLimit: p.gasLimit, maxFeeGwei: this.risk.maxFeeGwei(p) }) ?? this.paperPreflight(run);
    if (pf.length) {
      if (pf.some((r) => r.includes('balance'))) this.alert('low_balance', { key: run.key, reasons: pf }, 'error');
      this.endRun(run, 'aborted', `preflight: ${pf.join('; ')}`);
      return;
    }

    // 4) re-plan with the current time, then sign + fire (live) or arm the simulation (paper)
    plan = clock.planBurst({ launchTs: l.ts, now: scheduler.now(), burst: p.burst, rttMs });
    run.plan = { ...plan, rttMs };
    if (plan.times.length === 0) {
      this.endRun(run, 'aborted', 'too late after confirming the launch');
      return;
    }
    // 4b) re-price right before the first send (see `repriceLeadMs`)
    const lead = this.o.repriceLeadMs ?? 0;
    if (lead > 0 && plan.times.length > 0) {
      // poll 'latest' reserves from the fast endpoints while waiting (every ~50 ms): a single
      // read at the re-price point lost the race to its own 25 ms budget on 30 Oct 2026 (17:40
      // UTC: 0.97 ETH of helper-contract team buys, the ledger had seen half, the read timed out)
      const polled: { r: Reserves | null; on: boolean } = { r: null, on: true };
      void (async (): Promise<void> => {
        while (polled.on) {
          const r = await this.o.chain.getReserves(curve).catch(() => null);
          if (r && (!polled.r || r.quote > polled.r.quote)) polled.r = r;
          if (polled.on) await sleep(50);
        }
      })();
      // Re-price `lead` ms before the first send, or right now when less than that is left: the
      // decision can fire mid-way through a helper contract's buy logs (31 Oct 2026 00:05 UTC: 2 of
      // 6 logs seen, 0.22 of 0.89 ETH priced, no time for the lead → six SlippageExceeded reverts).
      // Whatever time is left, the ledger's confirmed logs and the poll are re-read before signing.
      const sendAt = plan.times[0]!;
      const at = Math.max(scheduler.now(), sendAt - lead);
      const actualLead = sendAt - at;
      if (at > scheduler.now()) await new Promise<void>((res) => scheduler.at(at, res));
      polled.on = false;
      if (run.status !== 'pending') {
        this.endRun(run, 'aborted', `aborted before the burst: ${run.abortReason ?? ''}`);
        return;
      }
      const budget = Math.max(0, Math.min(60, sendAt - scheduler.now() - 10));
      const fresh = await this.freshReserves(curve, lg, afterLaunch, l.event.creatorTaxBps, polled.r && polled.r.quote > reserves.quote ? polled.r : reserves, budget);
      if (fresh.quote !== reserves.quote || fresh.token !== reserves.token) {
        const rc2 = this.risk.reserveCheck(p, fresh);
        if (!rc2.ok) {
          this.endRun(run, 'aborted', `repriced ${actualLead} ms before the first send: ${rc2.reasons.join('; ')}`);
          return;
        }
        const mo2 = planMinOut({ ...p, maxTaxBps: run.maxTaxBps }, fresh, run.quoteIn, l.event.creatorTaxBps);
        run.notes.push(`repriced ${actualLead} ms before the first send: expected ${mo2.expectedOut} (was ${mo.expectedOut}), ${lg?.priceMovingBuys ?? 0} launch-second buy(s) priced`);
        run.minTokensOut = mo2.minTokensOut;
        reserves = fresh;
      } else {
        run.notes.push(`repriced ${actualLead} ms before the first send: unchanged, ${lg?.priceMovingBuys ?? 0} launch-second buy(s) priced`);
      }
      plan = clock.planBurst({ launchTs: l.ts, now: scheduler.now(), burst: p.burst, rttMs });
      run.plan = { ...plan, rttMs };
      if (plan.times.length === 0) {
        this.endRun(run, 'aborted', 'too late after re-pricing');
        return;
      }
    }
    this.recorder.snipe(run, undefined, 'snipe_armed');
    const fill = await this.o.backend.execute({
      run,
      token,
      curve,
      times: plan.times,
      gasLimit: p.gasLimit,
      maxFeeGwei: this.risk.maxFeeGwei(p),
      priorityFeeGwei: p.priorityFeeGwei,
      guard: () => this.sendGuard(run),
    });
    if (this.o.mode === 'live' && run.burst.some((m) => m.status !== 'skipped' && m.status !== 'planned'))
      this.measureLiveRace(run, curve, fill).catch((e: unknown) => this.error(`race measurement ${run.key}`, e));
    if (fill) {
      this.onFill(run, fill);
      return;
    }
    if (this.o.mode === 'live' && run.burst.some((m) => m.status !== 'skipped' && m.status !== 'planned')) {
      const v = await this.settleNoFill(run);
      if (v !== 'no_buy') return; // filled, or kept unresolved (slot held) and retried
    }
    // (status is mutated by abortRun while we await: read it through a function, not narrowed)
    this.endRun(run, 'failed', statusOf(run) === 'aborted' ? 'no fill after the abort' : 'no burst member bought');
  }

  /**
   * Race measurement of a live burst (off the decide path): the member that bought, or — no buy —
   * the first member that landed, with its revert reason (AlreadyBought, TaxTooHigh, Expired …).
   * Same record as a probe tx (`decision.race`, `race_*` counters, `hoodctl race`).
   */
  private async measureLiveRace(run: SnipeRun, curve: Address, fill: Fill | null): Promise<void> {
    const buy = fill?.txHash ? run.burst.find((m) => m.hash.toLowerCase() === fill.txHash!.toLowerCase()) : undefined;
    const landed = run.burst.filter((m) => m.status === 'mined' || m.status === 'reverted').sort((a, b) => a.index - b.index);
    const sent = run.burst.filter((m) => m.sentAt !== undefined).sort((a, b) => a.index - b.index);
    const m = buy ?? landed[0] ?? sent[0];
    if (!m) return;
    const boundaryMs = run.plan?.boundaryMs;
    const rec: RaceRecord = {
      source: 'live',
      status: 'planned',
      member: m.index,
      bought: buy !== undefined,
      hash: m.hash,
      nonce: m.nonce,
      ...(run.signer ? { key: run.signer } : {}),
      scheduledAt: m.scheduledAt,
      ...(m.sentAt !== undefined ? { sentAt: m.sentAt } : {}),
      ...(boundaryMs !== undefined ? { boundaryMs, rttMs: run.plan!.rttMs } : {}),
      ...(boundaryMs !== undefined && m.sentAt !== undefined ? { sendVsBoundaryMs: roundMs(m.sentAt - boundaryMs) } : {}),
      sends: m.sends,
    };
    this.race.count('race_sent');
    const r = buy || landed.length ? await this.o.chain.getReceipt(m.hash).catch(() => null) : null;
    if (!r) {
      rec.status = 'not_mined';
      if (buy || landed.length) rec.reason = 'receipt not readable';
      this.race.count('race_not_mined');
    } else {
      await this.race.measure(rec, { curve, launchBlock: run.launch.block, launchTs: run.launch.ts, receipt: r });
      if (rec.status === 'reverted') rec.revertReason = (await this.o.chain.revertReason?.(m.hash, r.blockNumber).catch(() => null)) ?? null;
    }
    run.race = rec;
    run.notes.push(raceNote(rec));
    this.o.logger.info({ key: run.key, race: rec }, 'race measured');
    this.recorder.update(run, this.positions.get(run.key), 'race');
  }

  /**
   * H3 + NEW-3 + R4-2: the burst reported no fill. "No buy" is final only when bought()/balanceOf()
   * were read AT a block past `deadlineBlock`, or at a block whose timestamp is past `deadlineTs`
   * (members expire there on chain). The block is the one `readSniper` pinned both calls to — not a
   * separate head read, which a load-balanced RPC may serve from another (fresher) backend. Until
   * then — a stalled sequencer, a backlog, a stale node — the run stays unresolved with its
   * MAX_CONCURRENT slot held and is retried (soon, and by the reconcile timer); an unreadable chain
   * likewise (`snipe_unresolved`). A run unresolved for more than 2 min raises
   * `snipe_unresolved_long` (e.g. a NODE_HTTP stuck on an old block).
   */
  private async settleNoFill(run: SnipeRun): Promise<'filled' | 'pending' | 'no_buy'> {
    const first = !this.unresolvedRuns.has(run.key);
    run.unresolvedSince ??= Date.now();
    // fallback only for a ChainClient whose readSniper does not report its block: read the head FIRST
    const headBefore = await this.o.chain.getBlockNumber().catch(() => null);
    const rec = await this.recoverFill(run);
    if (rec === 'unknown') {
      if (first) {
        run.notes.push('UNRESOLVED: no fill seen and the chain could not be read; retrying');
        this.alert('snipe_unresolved', { key: run.key, token: run.launch.token, curve: run.launch.curve }, 'error');
      }
      this.unresolvedRuns.set(run.key, run);
      return 'pending';
    }
    if (rec) {
      this.unresolvedRuns.delete(run.key);
      this.onFill(run, rec);
      return 'filled';
    }
    const read = this.lastRead.get(run.key);
    const at = read?.block ?? headBefore;
    const deadlineTs = snipeDeadlineTs(run);
    const final = (at !== null && at !== undefined && at > run.deadlineBlock) || (read?.blockTs !== undefined && read.blockTs > deadlineTs);
    if (!final) {
      if (first) {
        run.notes.push(
          `no fill seen yet but bought()/balanceOf() were read at block ${at ?? 'unknown'} (ts ${read?.blockTs ?? '?'}), not past the deadline (block ${run.deadlineBlock}, ts ${deadlineTs}): run kept (slot held) until a read is (NEW-3, R4-2)`,
        );
        this.o.logger.info({ key: run.key, at, deadlineBlock: run.deadlineBlock, deadlineTs }, 'no fill yet; waiting for the burst deadline');
      }
      this.unresolvedRuns.set(run.key, run);
      this.alertLongUnresolved(run, at ?? null);
      this.retrySoon(run, at ?? null);
      return 'pending';
    }
    this.unresolvedRuns.delete(run.key);
    this.lastRead.delete(run.key);
    return 'no_buy';
  }

  /** R4-2: an unresolved run older than 2 min is an operational problem (stale node, stalled sequencer). */
  private alertLongUnresolved(run: SnipeRun, at: number | null): void {
    if (run.unresolvedAlerted || run.unresolvedSince === undefined || Date.now() - run.unresolvedSince < UNRESOLVED_ALERT_MS) return;
    run.unresolvedAlerted = true;
    this.alert(
      'snipe_unresolved_long',
      { key: run.key, token: run.launch.token, readAtBlock: at, deadlineBlock: run.deadlineBlock, deadlineTs: snipeDeadlineTs(run), sinceSec: Math.round((Date.now() - run.unresolvedSince) / 1000), note: 'slot held: is NODE_HTTP stuck / the sequencer down?' },
      'error',
    );
  }

  /** NEW-3: re-check a run waiting for its deadline block about when the head should pass it. */
  private retrySoon(run: SnipeRun, head: number | null): void {
    const ms = Math.min(10_000, Math.max(500, ((head === null ? 10 : run.deadlineBlock - head) + 1) * 100 + 300));
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.retryTimers.delete(t);
      if (!this.stopped) void this.retryUnresolved(run).catch((e: unknown) => this.error(`unresolved run ${run.key}`, e));
    }, ms);
    t.unref?.();
    this.retryTimers.add(t);
  }

  private async retryUnresolved(run: SnipeRun): Promise<void> {
    if (!this.unresolvedRuns.has(run.key) || this.settling.has(run.key) || run.ended) return;
    this.settling.add(run.key);
    try {
      const v = await this.settleNoFill(run);
      if (v === 'no_buy') this.endRun(run, 'failed', `no burst member bought (chain read past the deadline block ${run.deadlineBlock})`);
    } finally {
      this.settling.delete(run.key);
    }
  }

  /** Any fill opens a position; a fill on an aborted run exits at once (H2). */
  private onFill(run: SnipeRun, fill: Fill): void {
    const abortedFor = run.status === 'aborted' ? (run.abortReason ?? 'aborted') : null;
    run.fill = fill;
    run.status = 'open';
    this.unresolvedRuns.delete(run.key);
    this.counters.fills!++;
    // NEW-4 / R4-6: the reservation becomes a charge at the fill's block time (kept until a chain read includes it)
    this.limits.release(run.key);
    this.limits.charge(fill.quoteIn, fill.ts > 0 ? fill.ts : Date.now() / 1000);
    if (fill.recovered) this.counters.fills_recovered!++;
    // team set: the launch's exemptions plus any wallet exempted later in the launch second
    const team = [...new Set([...run.launch.event.exemptions.map((x) => x.toLowerCase()), ...(run.ledger?.exemptions ?? [])])];
    const pos = this.positions.openPosition(run, fill, run.decision.preset, team);
    this.recorder.snipe(run, pos, 'snipe_filled');
    this.o.logger.info(
      { key: run.key, token: pos.token, block: fill.block, taxBps: fill.taxBps, tokensOut: fill.tokensOut.toString(), entryPrice: fill.entryPrice, recovered: fill.recovered },
      'filled',
    );
    if (!fill.reserves) this.seedReserves(pos, fill.recovered ? undefined : fill.block);
    if (abortedFor !== null) {
      this.counters.fills_after_abort!++;
      run.notes.push(`filled after the abort (member already in flight): exiting immediately`);
      this.alert('fill_after_abort', { key: run.key, token: pos.token, why: abortedFor }, 'error');
      this.positions.forceExit(run.key, run.abortExit ?? 'exempt_dump');
    }
  }

  /** M5: start the live book from the reserves AT the fill block (contains our buy). */
  private seedReserves(p: PositionEntry, block: number | undefined): void {
    const at = (b: number | undefined): Promise<void> =>
      this.o.chain.getReserves(p.curve, b).then((r) => this.positions.onReserves(p.curve, r, b));
    (block !== undefined ? at(block) : this.o.chain.getBlockNumber().then((n) => at(n))).catch((e: unknown) =>
      this.o.logger.debug({ err: e, key: p.key }, 'seed reserves failed (poll will catch up)'),
    );
  }

  /**
   * H3: the burst reported no fill. Re-read the members' receipts once more (earlier receipt
   * errors were swallowed), then ask the contract: bought(token) + balanceOf(sniper).
   */
  private async recoverFill(run: SnipeRun): Promise<RecoverResult> {
    const sniper = this.o.sniperContract;
    const token = run.launch.token;
    const curve = run.launch.curve;
    if (!sniper || !token || !curve) return null;
    for (const m of run.burst) {
      if (m.status === 'skipped' || m.status === 'planned' || m.hash === '0x') continue;
      const r = await this.o.chain.getReceipt(m.hash).catch(() => null);
      if (!r || r.status !== 'success') continue;
      const s = decodeSniped(r.logs, sniper);
      if (!s || s.token !== token.toLowerCase()) continue;
      m.status = 'mined';
      m.block = r.blockNumber;
      return {
        block: r.blockNumber,
        ts: this.blockTs.get(r.blockNumber) ?? (await this.o.chain.getBlockTimestamp(r.blockNumber).catch(() => 0)),
        quoteIn: s.quoteIn,
        tokensOut: s.tokensOut,
        taxBps: s.taxBps,
        taxPaid: snipeTaxFromLogs(r.logs, curve),
        entryPrice: s.tokensOut > 0n ? Number(s.quoteIn) / Number(s.tokensOut) : 0,
        txHash: r.transactionHash,
      };
    }
    for (let i = 0; i < 3; i++) {
      try {
        const h = await this.o.chain.readSniper(sniper, token);
        this.lastRead.set(run.key, h);
        if (h.balance > 0n) {
          run.notes.push(`H3: receipts missed the buy; chain shows bought=${h.bought} balance=${h.balance}`);
          this.alert('fill_recovered_from_chain', { key: run.key, token, balance: h.balance.toString(), bought: h.bought }, 'error');
          return {
            block: run.launch.block + 1,
            ts: run.launch.ts + 1,
            quoteIn: run.quoteIn,
            tokensOut: h.balance,
            taxBps: worstTaxBps(run.maxTaxBps),
            taxPaid: 0n,
            entryPrice: Number(run.quoteIn) / Number(h.balance),
            recovered: true,
          };
        }
        if (h.bought) {
          run.notes.push('chain shows bought=true but no balance');
          this.alert('bought_without_balance', { key: run.key, token }, 'error');
        }
        return null;
      } catch {
        await sleep(300);
      }
    }
    return 'unknown';
  }

  private async pollReserves(): Promise<void> {
    const curves = new Set(this.positions.open.filter((p) => p.phase === 'open').map((p) => p.curve));
    if (curves.size === 0) return;
    // M5: one explicit block for every snapshot; logs at or below it are ignored by the book.
    // N13: without a block number an unpinned snapshot could double count: skip this tick.
    const block = await this.o.chain.getBlockNumber().catch(() => undefined);
    if (block === undefined) return;
    await Promise.all(
      [...curves].map((c) =>
        this.o.chain.getReserves(c, block).then(
          (r) => this.positions.onReserves(c, r, block),
          () => undefined,
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ reconciliation (H3)
  /** Rebuild positions / resolve stale rows of this mode from the chain at startup. */
  async reconcileStartup(): Promise<void> {
    let rows: ActiveSnipe[];
    try {
      rows = await this.o.store.loadActiveSnipes(this.o.mode);
    } catch (e) {
      this.error('loading active snipes failed', e);
      return;
    }
    for (const row of rows) {
      try {
        await this.reconcileRow(row);
        this.unresolvedRows.delete(row.id);
      } catch (e) {
        this.unresolvedRows.set(row.id, row);
        if (e instanceof NotFinalYet) this.o.logger.info({ snipeId: row.id, why: e.message }, 'snipe row not final yet: retrying');
        else this.alert('snipe_unresolved', { snipeId: row.id, token: row.token, err: (e as Error).message }, 'error');
      }
    }
  }

  private async reconcileTick(): Promise<void> {
    for (const row of [...this.unresolvedRows.values()]) {
      try {
        await this.reconcileRow(row);
        this.unresolvedRows.delete(row.id);
      } catch {
        /* next tick */
      }
    }
    for (const run of [...this.unresolvedRuns.values()]) await this.retryUnresolved(run);
    await this.positions.recheck();
    await this.pruneFeedBlocks();
  }

  /** `feed_blocks` retention (FEED_BLOCKS_RETENTION_DAYS, default 7): at most hourly, from the reconcile timer. */
  async pruneFeedBlocks(now = Date.now()): Promise<number> {
    const days = this.o.feedBlocksRetentionDays ?? 7;
    if (days <= 0 || now - this.lastFeedPrune < 3_600_000) return 0;
    this.lastFeedPrune = now;
    const n = await this.o.store.pruneFeedBlocks(new Date(now - days * 86_400_000));
    if (n > 0) this.o.logger.info({ deleted: n, days }, 'feed_blocks pruned');
    return n;
  }

  // ------------------------------------------------------------------ orphan sweep (NEW-3, R4-1/2/7)
  /**
   * Every token the contract bought (`Sniped` events since the stored checkpoint; the first run
   * looks back `sweepLookbackBlocks`) that still has a balance but is not managed — no position,
   * no run, no unresolved row. Runs at startup and every `sweepIntervalMs` (R4-2: a run written off
   * at runtime is caught without a restart).
   *  - R4-1 dust (< 0.5 % of the tokens bought, or worth less than the exit gas, e.g. a 1-wei
   *    transfer by anyone): ignored (`orphan_dust_ignored`, info);
   *  - the token's newest row is `closed` (its PnL is booked): alert only
   *    (`orphan_balance_on_closed_row`), nothing is adopted or re-booked;
   *  - otherwise the balance becomes a position at COST 0 that holds no MAX_CONCURRENT slot and
   *    books no daily-loss PnL (`orphan_position_recovered`, error); its newest row is reused when
   *    there is one (preset, notes), else a row is written.
   * R4-7: the checkpoint advances after every chunk whose tokens could all be read.
   */
  async sweepOrphans(): Promise<number> {
    if (this.sweepRunning) return this.sweepRunning;
    const run = this.doSweep().finally(() => {
      this.sweepRunning = null;
    });
    this.sweepRunning = run;
    return run;
  }

  private async doSweep(): Promise<number> {
    const sniper = this.o.sniperContract;
    const lookback = this.o.sweepLookbackBlocks ?? 864_000;
    if (this.o.mode !== 'live' || !sniper || lookback <= 0) return 0;
    const key = `sniped_sweep:${sniper.toLowerCase()}`;
    const head = await this.o.chain.getBlockNumber();
    const cp = await this.o.store.getCursor(key);
    const from = cp !== null ? cp + 1 : Math.max(0, head - lookback);
    if (from > head) return 0;
    let recovered = 0;
    let seen = 0;
    let complete = true;
    await this.o.chain.snipedLogs(sniper, from, head, async (chunk, toBlock) => {
      const latest = new Map<string, SnipedLog>();
      for (const ev of chunk) latest.set(ev.token.toLowerCase(), ev);
      seen += latest.size;
      for (const ev of latest.values()) {
        if (this.managesToken(ev.token)) continue;
        try {
          const h = await this.o.chain.readSniper(sniper, ev.token);
          if (h.balance <= 0n || this.managesToken(ev.token)) continue;
          if (await this.handleOrphan(ev, h.balance)) recovered++;
        } catch (e) {
          complete = false;
          this.error(`orphan sweep: ${ev.token} could not be read`, e);
        }
      }
      if (!complete) return false; // retried from this chunk next time
      await this.o.store.setCursor(key, toBlock);
      return true;
    });
    this.o.logger.info({ from, head, sniped: seen, recovered, complete }, 'orphan sweep done');
    return recovered;
  }

  /** the periodic sweep (R4-2): failures are alerted at most every 10 min */
  private async periodicSweep(): Promise<void> {
    try {
      await this.sweepOrphans();
    } catch (e) {
      this.alertThrottled('orphan_sweep_failed', { err: (e as Error).message }, 'warn');
    }
  }

  /** R4-1: dust is never adopted: < 0.5 % of the tokens bought, or worth less than an exit's gas. */
  private async dustReason(ev: SnipedLog, balance: bigint, gasLimit: number): Promise<string | null> {
    if (ev.tokensOut > 0n && balance * 200n < ev.tokensOut) return `balance ${balance} < 0.5 % of the ${ev.tokensOut} tokens bought`;
    const r = await this.o.chain.getReserves(ev.curve).catch(() => null);
    if (!r) return null;
    const gasPrice = this.risk.gasPriceWei ?? (await this.o.chain.getGasPrice().catch(() => null));
    if (gasPrice === null) return null;
    const value = quoteSell(r, balance, CURVE_FEE_BPS, 0);
    const gas = BigInt(gasLimit) * gasPrice;
    return value < gas ? `worth ${formatEther(value)} ETH < exit gas ${formatEther(gas)} ETH` : null;
  }

  /** One unmanaged balance found by the sweep: ignore dust, alert on a closed row, else adopt (true). */
  private async handleOrphan(ev: SnipedLog, balance: bigint): Promise<boolean> {
    const rows = await this.o.store.findSnipesByToken(ev.token, 'live');
    const prev = rows[0];
    const dec0 = prev ? decisionOf(prev) : null;
    const gasLimit = dec0 ? parsePlay({ name: 'x', trigger: {}, preset: dec0.preset }).preset.gasLimit : 300_000;
    const dust = await this.dustReason(ev, balance, gasLimit);
    const info = { token: ev.token, curve: ev.curve, balance: balance.toString(), snipedBlock: ev.block, tx: ev.txHash, previousRow: prev?.id ?? null, previousStatus: prev?.status ?? null };
    if (dust) {
      this.recorder.event('info', 'orphan_dust_ignored', { ...info, why: dust });
      return false;
    }
    if (prev?.status === 'closed') {
      // its PnL is booked already: a leftover (or a transfer to the contract) is not re-adopted
      this.alert('orphan_balance_on_closed_row', { ...info, action: 'not adopted; sweep it with the owner (sweepToken) if it matters' }, 'warn');
      return false;
    }
    await this.adoptOrphan(ev, balance, prev);
    return true;
  }

  /** A position, a run (in flight or unresolved) or an unresolved startup row already covers `token`. */
  private managesToken(token: string): boolean {
    const t = token.toLowerCase();
    if (this.positions.open.some((p) => p.token.toLowerCase() === t)) return true;
    if ([...this.runs.values()].some((r) => r.launch.token?.toLowerCase() === t)) return true;
    return [...this.unresolvedRows.values()].some((r) => r.token.toLowerCase() === t);
  }

  private async adoptOrphan(ev: SnipedLog, balance: bigint, prev: ActiveSnipe | undefined): Promise<void> {
    const reusable = prev && prev.status !== 'closed' ? prev : undefined;
    const ts = this.blockTs.get(ev.block) ?? (await this.o.chain.getBlockTimestamp(ev.block).catch(() => 0));
    const fromRow = reusable ? decisionOf(reusable) : null;
    const dec: StoredDecision = fromRow ?? {
      playName: 'orphan (startup sweep)',
      preset: {},
      reasons: [`orphan recovered by the startup sweep: Sniped at block ${ev.block} (${ev.txHash})`],
      event: { deployer: ZERO as Address, name: '', symbol: '', launchKind: 'launchToken', exemptions: [], creatorFeeRecipient: ZERO as Address, creatorTaxBps: 0, devBuyQuoteIn: 0n, pairToken: ZERO as Address, launchConfigId: 0n },
      block: Math.max(0, ev.block - 1),
      ts: ts > 0 ? ts - 1 : 0,
      txHash: ev.txHash,
      deadlineBlock: 0,
      deadlineTs: 0,
    };
    // R4-1: cost basis 0 (the original spend is never booked a second time); the exit rules price
    // from the real entry (quoteIn / tokensOut of the Sniped event)
    const entryPrice = ev.tokensOut > 0n ? Number(ev.quoteIn) / Number(ev.tokensOut) : null;
    const cost = 0n;
    const row: ActiveSnipe = reusable
      ? { ...reusable, curve: reusable.curve || ev.curve, quoteIn: cost, tokensOut: reusable.tokensOut ?? ev.tokensOut, entryPrice: reusable.entryPrice ?? entryPrice, buyBlock: reusable.buyBlock ?? ev.block }
      : {
          id: 0,
          playId: 0,
          token: ev.token,
          curve: ev.curve,
          mode: 'live',
          status: 'open',
          decidedAt: new Date(ts > 0 ? ts * 1000 : Date.now()),
          decision: null,
          quoteIn: cost,
          tokensOut: ev.tokensOut,
          entryPrice,
          buyBlock: ev.block,
          sells: [],
        };
    const sells = reusable ? salesOf(reusable.sells) : [];
    this.rebuild(row, dec, balance, sells, sells.reduce((a, s) => a + s.quoteOut, 0n), 'orphan');
    this.alert(
      'orphan_position_recovered',
      { token: ev.token, curve: ev.curve, balance: balance.toString(), snipedBlock: ev.block, tx: ev.txHash, previousRow: prev?.id ?? null, previousStatus: prev?.status ?? null, costBasis: '0', holdsSlot: false },
      'error',
    );
  }

  private async markRow(row: ActiveSnipe, status: 'failed' | 'closed', note: string, realizedPnlEth?: number): Promise<void> {
    await this.o.store.updateSnipe(row.id, {
      status,
      notes: note,
      ...(status === 'closed' ? { closedAt: new Date(), realizedPnlEth: realizedPnlEth ?? null } : {}),
    });
  }

  private async reconcileRow(row: ActiveSnipe): Promise<void> {
    const dec = decisionOf(row);
    const token = row.token.toLowerCase() as Address;
    const curve = row.curve.toLowerCase() as Address;
    const sells = salesOf(row.sells);
    const realized = sells.reduce((a, s) => a + s.quoteOut, 0n);
    const cost = row.quoteIn ?? 0n;
    if (this.o.mode === 'paper') {
      if (row.status === 'open' && row.tokensOut && token && curve && dec) {
        const sold = sells.reduce((a, s) => a + s.tokensIn, 0n);
        this.rebuild(row, dec, row.tokensOut > sold ? row.tokensOut - sold : 0n, sells, realized);
      } else {
        await this.markRow(row, 'failed', 'paper run interrupted by a restart');
        this.alert('stale_snipe_failed', { snipeId: row.id, mode: 'paper', status: row.status });
      }
      return;
    }
    if (!token || !curve || !this.o.sniperContract) {
      await this.markRow(row, 'failed', 'stale pending row without token/curve (launch never confirmed)');
      this.alert('stale_snipe_failed', { snipeId: row.id, reason: 'no token' });
      return;
    }
    // NEW-3 / R4-2: "no buy" is final only for a read pinned past the deadline (block or ts); the head
    // read before is only the fallback for a chain client that does not report its read block
    const headBefore = dec && dec.deadlineBlock > 0 ? await this.o.chain.getBlockNumber() : null;
    const h = await this.o.chain.readSniper(this.o.sniperContract, token); // throws → unresolved, retried
    if (h.balance > 0n) {
      if (!dec) throw new Error(`row ${row.id}: decision JSON unreadable`);
      this.rebuild(row, dec, h.balance, sells, realized);
      return;
    }
    if (h.bought) {
      const pnl = (Number(realized) - Number(cost)) / 1e18;
      await this.markRow(row, 'closed', `reconciled at startup: contract balance 0 (sold or swept outside the bot); realized from recorded sells only`, pnl);
      if (this.statsLoaded) this.risk.bookRealized(pnl); // before the load the DB aggregate contains it
      this.alert('position_closed_externally', { snipeId: row.id, token, realizedEth: pnl }, 'error');
      return;
    }
    // N12 / NEW-3 / R4-2: members of an unfinished burst may still land up to the deadline
    if (dec && dec.deadlineBlock > 0) {
      const at = h.block ?? headBefore;
      const dts = dec.deadlineTs > 0 ? dec.deadlineTs : dec.ts > 0 ? dec.ts + SNIPE_DEADLINE_SECONDS : 0;
      const final = (at !== null && at > dec.deadlineBlock) || (h.blockTs !== undefined && dts > 0 && h.blockTs > dts);
      if (!final) throw new NotFinalYet(`read at block ${at} (ts ${h.blockTs ?? '?'}) not past the burst deadline (block ${dec.deadlineBlock}, ts ${dts})`);
    }
    await this.markRow(row, 'failed', `reconciled at startup: chain shows no buy (bought=false) — stale ${row.status} row`);
    this.alert('stale_snipe_failed', { snipeId: row.id, token, status: row.status });
  }

  /** Re-create the run + position of a row from chain state (tokens held = `balance`). */
  private rebuild(row: ActiveSnipe, dec: StoredDecision, balance: bigint, sells: SaleRecord[], realized: bigint, how: 'startup' | 'orphan' = 'startup'): void {
    const token = row.token.toLowerCase() as Address;
    const curve = row.curve.toLowerCase() as Address;
    const play = parsePlay({ id: row.playId, name: dec.playName, enabled: true, trigger: {}, preset: dec.preset });
    const preset = play.preset;
    const event: LaunchEvent = { ...dec.event, token, curve };
    const launch: DetectedLaunch = {
      event,
      block: dec.block,
      ts: dec.ts,
      receivedAt: 0,
      txHash: dec.txHash,
      token,
      curve,
      addressSource: 'receipt',
      source: 'feed',
    };
    const quoteIn = row.quoteIn ?? parseEther(String(preset.buyEth));
    const tokensOut = row.tokensOut ?? balance;
    const run: SnipeRun = {
      id: row.id,
      key: row.id > 0 ? `restored:${row.id}` : `orphan:${token}`,
      mode: this.o.mode,
      playId: row.playId,
      launch,
      decision: { play, preset, reasons: dec.reasons },
      status: 'open',
      decidedAt: row.decidedAt.getTime(),
      quoteIn,
      minTokensOut: 0n,
      maxTaxBps: Math.min(MAX_TAX_BPS, preset.maxTaxBps),
      deadlineBlock: dec.block + (this.o.deadlineBlocks ?? 40),
      burst: [],
      notes: [
        how === 'orphan'
          ? `orphan recovered by the sweep (balance ${balance}; previous row status ${row.id > 0 ? row.status : 'none'}; cost basis 0, no slot, PnL not booked to the daily loss) (NEW-3, R4-1)`
          : `rebuilt at startup from chain state (balance ${balance})`,
      ],
      confirmed: true,
      slot: how !== 'orphan',
      ...(how === 'orphan' ? { orphan: true } : {}),
    };
    const fill: Fill = {
      block: row.buyBlock ?? dec.block + 1,
      ts: dec.ts + 1,
      quoteIn,
      tokensOut,
      taxBps: worstTaxBps(run.maxTaxBps),
      taxPaid: 0n,
      entryPrice: row.entryPrice ?? Number(quoteIn) / Number(tokensOut),
      ...(row.tokensOut === null ? { recovered: true } : {}),
    };
    run.fill = fill;
    this.curveTax.set(curve, event.creatorTaxBps);
    if (row.id > 0) this.recorder.adopt(run); // no row (orphan): the first write inserts one
    this.runs.set(run.key, run);
    this.risk.adoptPosition(run.playId, token, event.deployer, how !== 'orphan');
    this.paperBank?.commit(run.key, quoteIn);
    const pos = this.positions.openPosition(run, fill, preset, event.exemptions, {
      tokensHeld: balance,
      realizedQuote: realized,
      sales: sells,
      openedAtMs: row.decidedAt.getTime(),
      tpHit: sells.filter((s) => /^tp\d+$/.test(s.reason)).length,
    });
    this.counters.positions_rebuilt!++;
    this.recorder.snipe(run, pos, how === 'orphan' ? 'snipe_recovered' : 'snipe_update');
    if (how === 'startup') this.alert('position_rebuilt', { snipeId: row.id, token, balance: balance.toString(), previousStatus: row.status }, row.status === 'pending' ? 'error' : 'warn');
    this.seedReserves(pos, undefined);
  }

  // ------------------------------------------------------------------ introspection
  get activeRuns(): SnipeRun[] {
    return [...this.runs.values()];
  }

  /** The launch-second ledger of a launch tx (while it is kept, ~10 s after the launch second). */
  ledger(launchTxHash: string): LaunchSecondLedger | undefined {
    return this.ledgers.get(launchTxHash.toLowerCase());
  }

  health(feed: HealthState['feed']): HealthState {
    const positions = this.positions.open.map((p: PositionEntry) => ({
      key: p.key,
      token: p.token,
      pnlPct: p.lastPnlPct,
      tokensHeld: p.state.tokensHeld.toString(),
      phase: p.phase,
    }));
    return {
      mode: this.o.backend.label ?? this.o.mode,
      startedAt: this.startedAt,
      now: this.o.scheduler.now(),
      feed,
      clock: this.o.clock.snapshot(),
      rttMs: this.o.rttMs(),
      counters: {
        ...this.counters,
        decide_us_last: Math.round(this.lastDecideUs),
        rule_evaluations: this.rules.stats.evaluations,
        ledgers_open: this.ledgers.size,
        ...this.race.counters,
        ...((): Record<string, number> => {
          const b = this.bankrollWei();
          return b === null ? {} : { bankroll_eth: Number(b) / 1e18, daily_loss_limit_eth: this.risk.dailyLossLimitEth };
        })(),
      },
      positions,
      lastError: this.lastError,
      nonce: this.o.nonce?.() ?? null,
      plays: this.rules.playCount,
      armed: this.rules.armedCount,
    };
  }
}

function statusOf(run: SnipeRun): SnipeRun['status'] {
  return run.status;
}

function tryParse<T>(s: string): Partial<T> | null {
  try {
    return JSON.parse(s) as Partial<T>;
  } catch {
    return null;
  }
}

/** The parts of a stored `snipes.decision` (see recorder.snipeRecord) a rebuild needs. */
interface StoredDecision {
  playName: string;
  preset: unknown;
  reasons: string[];
  event: LaunchEvent;
  block: number;
  ts: number;
  txHash: Hex;
  /** the burst's deadline block (0 = unknown) */
  deadlineBlock: number;
  /** the burst's wall-clock deadline (0 = unknown: launch ts + 3) */
  deadlineTs: number;
}

/** A row whose outcome is not final on chain yet (burst deadline not reached): retry, no alert. */
class NotFinalYet extends Error {}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const big = (v: unknown): bigint => {
  try {
    return typeof v === 'bigint' ? v : typeof v === 'number' || typeof v === 'string' ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
};
const LAUNCH_KINDS: readonly LaunchKind[] = ['launchToken', 'launchAndBuy', 'launchTokenFor'];
const ZERO = '0x0000000000000000000000000000000000000000';

function decisionOf(row: ActiveSnipe): StoredDecision | null {
  const d = rec(row.decision);
  const launch = rec(d.launch);
  const ev = rec(launch.event);
  const deployer = str(ev.deployer).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(deployer)) return null;
  const kind = str(ev.launchKind) as LaunchKind;
  const event: LaunchEvent = {
    deployer: deployer as Address,
    name: str(ev.name),
    symbol: str(ev.symbol),
    launchKind: LAUNCH_KINDS.includes(kind) ? kind : 'launchToken',
    exemptions: (Array.isArray(ev.exemptions) ? ev.exemptions : []).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase() as Address),
    creatorFeeRecipient: str(ev.creatorFeeRecipient, ZERO).toLowerCase() as Address,
    creatorTaxBps: Number(ev.creatorTaxBps ?? 0) || 0,
    devBuyQuoteIn: big(ev.devBuyQuoteIn),
    pairToken: str(ev.pairToken, ZERO).toLowerCase() as Address,
    launchConfigId: big(ev.launchConfigId),
  };
  let preset: unknown = d.preset;
  try {
    parsePreset(preset);
  } catch {
    preset = {};
  }
  return {
    playName: str(rec(d.play).name),
    preset,
    reasons: (Array.isArray(d.reasons) ? d.reasons : []).filter((x): x is string => typeof x === 'string'),
    event,
    block: Number(launch.block ?? 0) || 0,
    ts: Number(launch.ts ?? 0) || 0,
    txHash: str(launch.txHash, '0x') as Hex,
    deadlineBlock: Number(d.deadlineBlock ?? 0) || 0,
    deadlineTs: Number(d.deadlineTs ?? 0) || 0,
  };
}

function salesOf(v: unknown): SaleRecord[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const s = rec(x);
    return {
      reason: str(s.reason, 'unknown'),
      tokensIn: big(s.tokensIn),
      quoteOut: big(s.quoteOut),
      at: Number(s.at ?? 0) || 0,
      ...(typeof s.txHash === 'string' ? { txHash: s.txHash as Hex } : {}),
      ...(typeof s.block === 'number' ? { block: s.block } : {}),
      ...(s.estimated === true ? { estimated: true } : {}),
    };
  });
}
