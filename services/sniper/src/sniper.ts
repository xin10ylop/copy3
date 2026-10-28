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
  TOPICS,
  decodedTxFromRpc,
  launchEventFromCall,
  parseLaunchCall,
  parsePlay,
  parsePreset,
  parseTokenLaunchedLog,
  type ArmedCandidate,
  type DecodedTx,
  type FeedBlock,
  type LaunchEvent,
  type LaunchKind,
  type RawLog,
  type Reserves,
  type SequencerClock,
} from '@hood/core';
import { parseEther, type Address, type Hex } from 'viem';
import type { ChainClient } from './chain.js';
import { LaunchDetector, verifyLaunchReceipt, type ReceiptVerdict } from './detector.js';
import { decodeSniped, snipeTaxFromLogs, type ExecutionBackend } from './executor.js';
import type { HealthState } from './health.js';
import { LEDGER_SELECTORS, LaunchSecondLedger, SEL_SELL, SEL_TRANSFER, SEL_TRANSFER_FROM, outflowFrom } from './ledger.js';
import type { Logger } from './log.js';
import { Positions, type PositionEntry, type SaleRecord } from './positions.js';
import { DEFAULT_LAUNCH_RESERVES, MAX_TAX_BPS, launchReserves, planMinOut, worstTaxBps } from './pricing.js';
import { Recorder } from './recorder.js';
import { Risk } from './risk.js';
import { Rules } from './rules.js';
import type { Scheduler } from './scheduler.js';
import { PaperBankroll, sizeBuy } from './sizing.js';
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
  /** max wait for getReserves when start reserves are known. Default 5 ms. */
  reservesWaitMs?: number;
  /** live: the PonsSniper contract (chain-truth reconciliation, H3/H4) */
  sniperContract?: Address;
  /** retry unresolved runs / re-check terminal positions. Default 30 s. */
  reconcileMs?: number;
  maxExitRounds?: number;
  exitBackoffMs?: number;
}


const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type RecoverResult = Fill | null | 'unknown';

export class Sniper {
  readonly rules: Rules;
  readonly risk: Risk;
  readonly detector: LaunchDetector;
  readonly positions: Positions;
  readonly recorder: Recorder;
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
  /** block timestamp → feed txs with a ledger selector (buy/sell/transfer), last few seconds */
  private readonly secondTxs = new Map<number, { block: number; tx: DecodedTx }[]>();
  private ledgerSecond = 0;
  private readonly timers: NodeJS.Timeout[] = [];
  private unsubs: (() => void | Promise<void>)[] = [];
  private seq = 0;
  private statsLoaded = false;
  private readonly startedAt = Date.now();

  constructor(private readonly o: SniperOptions) {
    this.rules = new Rules({ mode: o.mode });
    this.risk = new Risk({
      mode: o.mode,
      maxConcurrent: o.maxConcurrent ?? 3,
      dailyLossLimitEth: o.dailyLossLimitEth ?? (o.dailyLossLimitPct === undefined ? 0.5 : undefined),
      dailyLossLimitPct: o.dailyLossLimitPct,
      maxGasPriceGwei: o.maxGasPriceGwei ?? 1,
    });
    this.paperBank = o.mode === 'paper' ? new PaperBankroll(parseEther(String(o.paperBankrollEth ?? 0.1))) : null;
    this.detector = o.detector ?? new LaunchDetector();
    this.recorder = new Recorder(o.store, o.logger, { recordFeedBlocks: o.recordFeedBlocks ?? true });
    this.positions = new Positions({
      backend: o.backend,
      chain: o.chain,
      logger: o.logger,
      now: () => o.scheduler.now(),
      ...(o.mode === 'live' && o.sniperContract ? { sniper: o.sniperContract } : {}),
      ...(o.maxExitRounds !== undefined ? { maxExitRounds: o.maxExitRounds } : {}),
      ...(o.exitBackoffMs !== undefined ? { exitBackoffMs: o.exitBackoffMs } : {}),
      onSale: (p, s) => {
        this.recorder.snipe(p.run, p, 'snipe_sell');
        o.logger.info({ key: p.key, reason: s.reason, tokensIn: s.tokensIn.toString(), quoteOut: s.quoteOut.toString(), estimated: s.estimated }, 'sold');
      },
      onClosed: (p, pnl) => {
        p.run.status = 'closed';
        p.run.ended = true;
        this.counters.closed!++;
        this.risk.onPositionClosed(pnl);
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

  /** Bankroll for sizing: the cached contract ETH balance (live) or the paper bankroll. Memory-only. */
  bankrollWei(): bigint | null {
    return this.paperBank ? this.paperBank.balanceWei() : (this.o.backend.bankrollWei?.() ?? null);
  }

  private feedBankroll(): void {
    const b = this.bankrollWei();
    this.risk.setBankroll(b === null ? null : Number(b) / 1e18);
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
    const off = await store.onChange((c, p) => {
      this.onChange(c, p).catch((e: unknown) => this.error(`refresh on ${c} failed`, e));
    });
    this.unsubs.push(off);
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
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const lg of this.ledgers.values()) lg.unwatch?.();
    this.ledgers.clear();
    for (const u of this.unsubs) await u();
    await this.recorder.stop();
  }

  private async onChange(channel: ChangeChannel, payload: string): Promise<void> {
    if (channel === 'plays_changed') this.rules.setPlays(await this.o.store.loadPlays());
    else if (channel === 'armed_changed') {
      // @hood/db trigger payload: {op, id, play_id, wallet, status}
      const n = tryParse<{ play_id: number; playId: number; wallet: string; status: ArmedCandidate['status'] }>(payload);
      const playId = n?.play_id ?? n?.playId;
      if (n && playId !== undefined && n.wallet && n.status && n.status !== 'armed') {
        this.rules.removeArmed(playId, n.wallet);
      } else this.rules.setArmed(await this.o.store.loadArmed());
    } else if (channel === 'settings_changed') this.risk.setSettings(await this.o.store.loadSettings());
    this.o.logger.info({ channel, plays: this.rules.playCount, armed: this.rules.armedCount }, 'config refreshed');
  }

  // ------------------------------------------------------------------ feed path
  onFeedBlock(b: FeedBlock): void {
    try {
      this.o.clock.ingest(b.timestamp, b.receivedAt, b.block);
      this.blockTs.set(b.block, b.timestamp);
      if (this.blockTs.size > 4096) this.blockTs.delete(this.blockTs.keys().next().value!);
      this.recorder.feedBlock(b);
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
      if (this.detector.isCandidate(tx)) {
        launchy = true;
        break;
      }
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
  private async confirmLaunchSecond(run: SnipeRun, until: number): Promise<{ ok: boolean; reason: string }> {
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
      if (pending.length === 0) return { ok: false, reason: `launch-second fingerprint not confirmed: ${v.reasons.join('; ')}` };
      if (this.o.scheduler.now() >= until || Date.now() >= realUntil) {
        return { ok: false, reason: `launch-second buys not confirmed in time (${pending.length} pending): ${v.reasons.join('; ')}` };
      }
      const receipts = await Promise.all(pending.map((h) => this.o.chain.getReceipt(h).catch(() => null)));
      let progressed = false;
      for (const r of receipts) if (r) progressed = lg.applyReceipt(r) || progressed;
      if (!progressed) await sleep(Math.max(1, Math.min(poll, until - this.o.scheduler.now())));
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
    const known = this.detector.resolve(hash, { token: parsed.token, curve: parsed.curve, source: 'log', deployer: parsed.deployer });
    const lg = this.ledgers.get(hash.toLowerCase());
    if (lg && parsed.deployer.toLowerCase() === lg.launch.event.deployer.toLowerCase() && this.ledgerAddresses(lg, parsed.token, parsed.curve)) {
      this.onLedgerChanged(lg);
    }
    if (known || this.detector.get(hash)) return;
    // the feed has not shown this launch (yet): fallback after a short grace period
    const t = setTimeout(() => {
      if (this.detector.get(hash)) return;
      this.fallbackLaunch(hash, parsed.block, parsed.token, parsed.curve).catch((e: unknown) => this.error(`fallback launch ${hash} failed`, e));
    }, this.o.fallbackDelayMs ?? 150);
    t.unref?.();
  }

  /** Feed missed a launch: rebuild it from the node (RPC is acceptable on this degraded path). */
  async fallbackLaunch(txHash: Hex, block: number | undefined, token: Address, curve: Address): Promise<SnipeRun | null> {
    const tx = await this.o.chain.getTransaction(txHash);
    if (!tx) return null;
    const dtx = decodedTxFromRpc(tx);
    if (!this.detector.isLauncher(dtx.to)) {
      this.counters.spoof_rejected!++;
      return null; // H1: launch calldata sent anywhere but the factory / router / whitelisted launchers
    }
    const call = parseLaunchCall({ to: dtx.to, input: dtx.input, value: dtx.value });
    if (!call) return null;
    let blk = block;
    if (blk === undefined) blk = (await this.o.chain.getReceipt(txHash))?.blockNumber;
    if (blk === undefined) return null;
    const ts = this.blockTs.get(blk) ?? (await this.o.chain.getBlockTimestamp(blk));
    const event = launchEventFromCall(call, { from: dtx.from ?? null, to: dtx.to, hash: txHash, block: blk, ts });
    this.counters.fallback_launches!++;
    return this.handleLaunch({
      event: { ...event, token, curve },
      block: blk,
      ts,
      receivedAt: this.o.scheduler.now(),
      txHash,
      token,
      curve,
      addressSource: 'fallback',
      source: 'log',
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

  // ------------------------------------------------------------------ decide + execute
  private newRun(l: DetectedLaunch, d: Decision): SnipeRun {
    // Preset.sizing: fixed buyEth, or a share of the bankroll (cached balance, memory only)
    const sizing = sizeBuy(d.preset, d.preset.sizing?.mode === 'bankroll' ? this.bankrollWei() : null, this.risk.maxConcurrent);
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
      burst: [],
      notes: [],
      sizing,
    };
    if (maxTaxBps !== d.preset.maxTaxBps) run.notes.push(`maxTaxBps ${d.preset.maxTaxBps} clamped to ${maxTaxBps} (M3)`);
    if (sizing.mode === 'bankroll') run.notes.push(`size: ${sizing.note}`);
    return run;
  }

  /** Decide on a detected launch and, if it matches, run the snipe to a fill (or not). */
  async handleLaunch(l: DetectedLaunch): Promise<SnipeRun | null> {
    const t0 = performance.now();
    this.counters.launches_seen!++;
    if (l.event.launcher && !this.detector.isLauncher(l.event.launcher)) {
      this.counters.spoof_rejected!++;
      return null; // H1 defence in depth (the detector already filters on tx.to)
    }
    // every feed launch gets a ledger while a launch-second play is enabled: later blocks of the
    // launch second can still make it match (onLedgerChanged)
    const ledger = l.source === 'feed' && this.rules.hasLaunchSecondPlays ? this.openLedger(l) : undefined;
    const decisions = this.rules.evaluate(l.event, Date.now(), ledger?.stats());
    if (decisions.length === 0) {
      this.lastDecideUs = (performance.now() - t0) * 1000;
      this.o.logger.debug({ tx: l.txHash, name: l.event.name, deployer: l.event.deployer, ledger: ledger !== undefined }, 'launch: no play');
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
    this.risk.reserve();
    this.paperBank?.commit(run.key, run.quoteIn);
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

  /** A run ends without a position: release its slot exactly once. */
  private endRun(run: SnipeRun, status: 'failed' | 'aborted', why: string): SnipeRun {
    if (run.ended || this.positions.get(run.key)) return run;
    run.ended = true;
    const final = run.status === 'aborted' ? 'aborted' : status;
    run.status = final;
    run.notes.push(why);
    this.counters[final]!++;
    this.risk.release(run.playId, run.confirmed === true);
    this.paperBank?.release(run.key);
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
        return;
      }
    }
    const cc = this.risk.confirmCheck(run.playId, p, c.token, c.deployer);
    if (!cc.ok) {
      this.endRun(run, 'aborted', cc.reasons.join('; '));
      return;
    }
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
    const pf = this.o.backend.preflight?.({ quoteIn: run.quoteIn, gasLimit: p.gasLimit, maxFeeGwei: this.risk.maxFeeGwei(p) }) ?? [];
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
    if (fill) {
      this.onFill(run, fill);
      return;
    }
    if (this.o.mode === 'live' && run.burst.some((m) => m.status !== 'skipped' && m.status !== 'planned')) {
      const rec = await this.recoverFill(run);
      if (rec === 'unknown') {
        run.notes.push('UNRESOLVED: no fill seen and the chain could not be read; retrying');
        this.unresolvedRuns.set(run.key, run);
        this.alert('snipe_unresolved', { key: run.key, token, curve }, 'error');
        return;
      }
      if (rec) {
        this.onFill(run, rec);
        return;
      }
    }
    // (status is mutated by abortRun while we await: read it through a function, not narrowed)
    this.endRun(run, 'failed', statusOf(run) === 'aborted' ? 'no fill after the abort' : 'no burst member bought');
  }

  /** Any fill opens a position; a fill on an aborted run exits at once (H2). */
  private onFill(run: SnipeRun, fill: Fill): void {
    const abortedFor = run.status === 'aborted' ? (run.abortReason ?? 'aborted') : null;
    run.fill = fill;
    run.status = 'open';
    this.unresolvedRuns.delete(run.key);
    this.counters.fills!++;
    if (fill.recovered) this.counters.fills_recovered!++;
    const pos = this.positions.openPosition(run, fill, run.decision.preset, run.launch.event.exemptions);
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
      this.positions.forceExit(run.key, 'exempt_dump');
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
    // M5: one explicit block for every snapshot; logs at or below it are ignored by the book
    const block = await this.o.chain.getBlockNumber().catch(() => undefined);
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
        this.alert('snipe_unresolved', { snipeId: row.id, token: row.token, err: (e as Error).message }, 'error');
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
    for (const run of [...this.unresolvedRuns.values()]) {
      const rec = await this.recoverFill(run);
      if (rec === 'unknown') continue;
      this.unresolvedRuns.delete(run.key);
      if (rec) this.onFill(run, rec);
      else this.endRun(run, 'failed', 'no burst member bought (chain checked)');
    }
    await this.positions.recheck();
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
    await this.markRow(row, 'failed', `reconciled at startup: chain shows no buy (bought=false) — stale ${row.status} row`);
    this.alert('stale_snipe_failed', { snipeId: row.id, token, status: row.status });
  }

  /** Re-create the run + position of a row from chain state (tokens held = `balance`). */
  private rebuild(row: ActiveSnipe, dec: StoredDecision, balance: bigint, sells: SaleRecord[], realized: bigint): void {
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
      key: `restored:${row.id}`,
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
      notes: [`rebuilt at startup from chain state (balance ${balance})`],
      confirmed: true,
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
    this.recorder.adopt(run);
    this.runs.set(run.key, run);
    this.risk.adoptPosition(run.playId, token, event.deployer);
    this.paperBank?.commit(run.key, quoteIn);
    const pos = this.positions.openPosition(run, fill, preset, event.exemptions, {
      tokensHeld: balance,
      realizedQuote: realized,
      sales: sells,
      openedAtMs: row.decidedAt.getTime(),
      tpHit: sells.filter((s) => /^tp\d+$/.test(s.reason)).length,
    });
    this.counters.positions_rebuilt!++;
    this.recorder.snipe(run, pos, 'snipe_update');
    this.alert('position_rebuilt', { snipeId: row.id, token, balance: balance.toString(), previousStatus: row.status }, row.status === 'pending' ? 'error' : 'warn');
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
      mode: this.o.mode,
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
}

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
