/**
 * Orchestrator: feed → clock + LaunchDetector → Rules → Risk → (addresses, one getReserves)
 * → ExecutionBackend (live burst / paper) → Positions → Recorder. Everything on the decide
 * path is memory; config arrives via NOTIFY into memory.
 */
import {
  PONS_V2,
  TOPICS,
  parseTokenLaunchedLog,
  type ArmedCandidate,
  type FeedBlock,
  type RawLog,
  type SequencerClock,
} from '@hood/core';
import { decodedTxFromRpc, launchEventFromCall, parseLaunchCall } from '@hood/core';
import { parseEther, type Address, type Hex } from 'viem';
import type { ChainClient } from './chain.js';
import { LaunchDetector } from './detector.js';
import type { ExecutionBackend } from './executor.js';
import type { HealthState } from './health.js';
import type { Logger } from './log.js';
import { Positions, type PositionEntry } from './positions.js';
import { planMinOut } from './pricing.js';
import { Recorder } from './recorder.js';
import { Risk } from './risk.js';
import { Rules } from './rules.js';
import type { Scheduler } from './scheduler.js';
import type { ChangeChannel, SniperStore } from './store.js';
import type { Decision, DetectedLaunch, SnipeRun } from './types.js';

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
  dailyLossLimitEth?: number;
  maxGasPriceGwei?: number;
  deadlineBlocks?: number;
  addressTimeoutMs?: number;
  receiptPollMs?: number;
  reservesPollMs?: number;
  gasPollMs?: number;
  /** launches whose TokenLaunched log arrives without a feed tx after this long go the fallback path */
  fallbackDelayMs?: number;
  recordFeedBlocks?: boolean;
  nonce?: () => number | null;
}

const SEL_SELL = '0xd04c6983';
const SEL_TRANSFER = '0xa9059cbb';
const SEL_TRANSFER_FROM = '0x23b872dd';

export class Sniper {
  readonly rules = new Rules();
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
    closed: 0,
    fallback_launches: 0,
    errors: 0,
  };
  lastError: string | null = null;
  lastDecideUs = 0;
  private readonly runs = new Map<string, SnipeRun>();
  private readonly blockTs = new Map<number, number>();
  private readonly curveTax = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private unsubs: (() => void | Promise<void>)[] = [];
  private seq = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly o: SniperOptions) {
    this.risk = new Risk({
      mode: o.mode,
      maxConcurrent: o.maxConcurrent ?? 3,
      dailyLossLimitEth: o.dailyLossLimitEth ?? 0.5,
      maxGasPriceGwei: o.maxGasPriceGwei ?? 1,
    });
    this.detector = o.detector ?? new LaunchDetector();
    this.recorder = new Recorder(o.store, o.logger, { recordFeedBlocks: o.recordFeedBlocks ?? true });
    this.positions = new Positions({
      backend: o.backend,
      chain: o.chain,
      logger: o.logger,
      now: () => o.scheduler.now(),
      onSale: (p, s) => {
        this.recorder.snipe(p.run, p, 'snipe_sell');
        o.logger.info({ key: p.key, reason: s.reason, tokensIn: s.tokensIn.toString(), quoteOut: s.quoteOut.toString() }, 'sold');
      },
      onClosed: (p, pnl) => {
        p.run.status = 'closed';
        this.counters.closed!++;
        this.risk.onPositionClosed(pnl);
        this.runs.delete(p.key);
        this.recorder.snipe(p.run, p, 'snipe_closed');
        o.logger.info({ key: p.key, pnlEth: pnl }, 'position closed');
      },
      onExitFailed: (p, err) => this.error(`exit failed for ${p.token}: ${err}`),
    });
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

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    const { store } = this.o;
    const [plays, armed, settings, stats] = await Promise.all([
      store.loadPlays(),
      store.loadArmed(),
      store.loadSettings(),
      store.loadSnipeStats(new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000)),
    ]);
    this.rules.setPlays(plays);
    this.rules.setArmed(armed);
    this.risk.setSettings(settings);
    this.risk.seed(stats);
    this.o.logger.info({ plays: plays.length, armed: armed.length, open: stats.openCount }, 'state loaded');
    const off = await store.onChange((c, p) => void this.onChange(c, p));
    this.unsubs.push(off);
    if (this.detector.predictionMode === 'nonce') {
      try {
        this.detector.seedNonce(await this.o.chain.getTransactionCount(this.detector.launchDeployer as Address, 'latest'));
      } catch (e) {
        this.error('nonce seed failed', e);
      }
    }
    const unwatch = this.o.chain.watchLaunches?.((l) => this.onTokenLaunchedLog(l));
    if (unwatch) this.unsubs.push(unwatch);
    this.recorder.start();
    const every = (ms: number, fn: () => void): void => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.o.gasPollMs ?? 5000, () => {
      this.o.chain.getGasPrice().then(
        (g) => (this.risk.gasPriceWei = g),
        () => undefined,
      );
    });
    every(this.o.reservesPollMs ?? 500, () => void this.pollReserves());
    every(250, () => this.positions.tick());
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const u of this.unsubs) await u();
    await this.recorder.stop();
  }

  private async onChange(channel: ChangeChannel, payload: string): Promise<void> {
    try {
      if (channel === 'plays_changed') this.rules.setPlays(await this.o.store.loadPlays());
      else if (channel === 'armed_changed') {
        // payload may carry the candidate; reload is simple and cheap (off the hot path)
        // @hood/db trigger payload: {op, id, play_id, wallet, status}
        const n = tryParse<{ play_id: number; playId: number; wallet: string; status: ArmedCandidate['status'] }>(payload);
        const playId = n?.play_id ?? n?.playId;
        if (n && playId !== undefined && n.wallet && n.status && n.status !== 'armed') {
          this.rules.removeArmed(playId, n.wallet);
        } else this.rules.setArmed(await this.o.store.loadArmed());
      } else if (channel === 'settings_changed') this.risk.setSettings(await this.o.store.loadSettings());
      this.o.logger.info({ channel, plays: this.rules.playCount, armed: this.rules.armedCount }, 'config refreshed');
    } catch (e) {
      this.error(`refresh on ${channel} failed`, e);
    }
  }

  // ------------------------------------------------------------------ feed path
  onFeedBlock(b: FeedBlock): void {
    this.o.clock.ingest(b.timestamp, b.receivedAt, b.block);
    this.blockTs.set(b.block, b.timestamp);
    if (this.blockTs.size > 4096) this.blockTs.delete(this.blockTs.keys().next().value!);
    this.recorder.feedBlock(b);
    this.o.backend.onFeedBlock(b);
    void this.positions.onFeedBlock(b).catch((e: unknown) => this.error('positions feed', e));
    if (this.runs.size) void this.checkLaunchSecondDumps(b);
    let launchy = false;
    for (const tx of b.txs) {
      if (this.detector.isCandidate(tx)) {
        launchy = true;
        break;
      }
    }
    if (launchy) {
      void this.detector.detect(b).then(
        (ls) => {
          for (const l of ls) void this.handleLaunch(l).catch((e: unknown) => this.error('handleLaunch', e));
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
        const from = await tx.recoverFrom();
        if (!exempt.has(from)) continue;
        this.abortRun(run, `exempt wallet ${from} ${tx.selector === SEL_SELL ? 'sold' : 'moved tokens'} in the launch second (${tx.hash})`);
        break;
      }
    }
  }

  private abortRun(run: SnipeRun, why: string): void {
    if (run.status !== 'pending') return;
    run.status = 'aborted';
    run.notes.push(why);
    const cancelled = this.o.backend.abort(run.key);
    this.counters.aborted!++;
    this.risk.onSnipeEnded(run.playId, false);
    this.runs.delete(run.key);
    this.recorder.snipe(run, undefined, 'snipe_aborted');
    this.o.logger.warn({ key: run.key, why, cancelled }, 'snipe aborted');
  }

  // ------------------------------------------------------------------ node logs
  onTokenLaunchedLog(log: RawLog): void {
    if (log.topics[0] !== TOPICS.TokenLaunched) return;
    let parsed: ReturnType<typeof parseTokenLaunchedLog>;
    try {
      parsed = parseTokenLaunchedLog(log);
    } catch {
      return;
    }
    if (!parsed.txHash) return;
    const known = this.detector.resolve(parsed.txHash, { token: parsed.token, curve: parsed.curve, source: 'log' });
    if (known) return;
    // the feed has not shown this launch (yet): fallback after a short grace period
    const hash = parsed.txHash;
    const t = setTimeout(() => {
      if (!this.detector.get(hash)) void this.fallbackLaunch(hash, parsed.block, parsed.token, parsed.curve);
    }, this.o.fallbackDelayMs ?? 150);
    t.unref?.();
  }

  /** Feed missed a launch: rebuild it from the node (RPC is acceptable on this degraded path). */
  async fallbackLaunch(txHash: Hex, block: number | undefined, token: Address, curve: Address): Promise<SnipeRun | null> {
    const tx = await this.o.chain.getTransaction(txHash);
    if (!tx) return null;
    const dtx = decodedTxFromRpc(tx);
    const call = parseLaunchCall({ to: dtx.to, input: dtx.input, value: dtx.value });
    if (!call) return null;
    const blk = block ?? 0;
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

  private async resolveViaReceipt(l: DetectedLaunch, until: number): Promise<void> {
    const poll = this.o.receiptPollMs ?? 20;
    while (this.o.scheduler.now() < until && !(l.token && l.curve && (l.addressSource === 'log' || l.addressSource === 'receipt'))) {
      const r = await this.o.chain.getReceipt(l.txHash).catch(() => null);
      if (r) {
        const lg = r.logs.find((x) => x.topics[0] === TOPICS.TokenLaunched && x.address.toLowerCase() === PONS_V2.factory);
        if (lg) {
          const p = parseTokenLaunchedLog(lg);
          this.detector.resolve(l.txHash, { token: p.token, curve: p.curve, source: 'receipt' });
        }
        return;
      }
      await new Promise((res) => setTimeout(res, poll));
    }
  }

  // ------------------------------------------------------------------ decide + execute
  private newRun(l: DetectedLaunch, d: Decision): SnipeRun {
    const quoteIn = parseEther(String(d.preset.buyEth));
    return {
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
      maxTaxBps: Math.min(65_535, d.preset.maxTaxBps),
      deadlineBlock: l.block + (this.o.deadlineBlocks ?? 40),
      burst: [],
      notes: [],
    };
  }

  /** Decide on a detected launch and, if it matches, run the snipe to a fill (or not). */
  async handleLaunch(l: DetectedLaunch): Promise<SnipeRun | null> {
    const t0 = performance.now();
    this.counters.launches_seen!++;
    const decisions = this.rules.evaluate(l.event, Date.now());
    if (decisions.length === 0) {
      this.lastDecideUs = (performance.now() - t0) * 1000;
      this.o.logger.debug({ tx: l.txHash, name: l.event.name, deployer: l.event.deployer }, 'launch: no play');
      return null;
    }
    const d = decisions[0]!;
    const run = this.newRun(l, d);
    const verdict = this.risk.preCheck(d, l);
    this.lastDecideUs = (performance.now() - t0) * 1000;
    this.counters.decisions!++;
    this.o.logger.info(
      { key: run.key, play: d.play.id, name: l.event.name, symbol: l.event.symbol, reasons: d.reasons, risk: verdict.reasons, decideUs: Math.round(this.lastDecideUs) },
      'launch matched',
    );
    if (!verdict.ok) {
      run.status = 'aborted';
      run.notes.push(...verdict.reasons.map((r) => `risk: ${r}`));
      this.counters.aborted!++;
      this.recorder.snipe(run, undefined, 'snipe_aborted');
      return run;
    }
    this.risk.onSnipeStarted(run.playId, l.token, l.event.deployer);
    this.runs.set(run.key, run);
    this.recorder.snipe(run, undefined, 'snipe_decided');
    try {
      return await this.execute(run);
    } catch (e) {
      this.error(`snipe ${run.key} crashed`, e);
      if (run.status === 'pending') this.failRun(run, `error: ${(e as Error).message}`);
      return run;
    }
  }

  private failRun(run: SnipeRun, why: string, status: 'failed' | 'aborted' = 'failed'): SnipeRun {
    if (run.status !== 'pending') return run;
    run.status = status;
    run.notes.push(why);
    this.counters[status === 'failed' ? 'failed' : 'aborted']!++;
    this.risk.onSnipeEnded(run.playId, status === 'failed' && run.burst.some((m) => m.status === 'mined' || m.status === 'reverted'));
    this.runs.delete(run.key);
    this.recorder.snipe(run, undefined, status === 'failed' ? 'snipe_failed' : 'snipe_aborted');
    this.o.logger.warn({ key: run.key, why }, `snipe ${status}`);
    return run;
  }

  private async execute(run: SnipeRun): Promise<SnipeRun> {
    const { clock, scheduler, chain } = this.o;
    const l = run.launch;
    const p = run.decision.preset;
    const rttMs = this.o.rttMs();
    let plan = clock.planBurst({ launchTs: l.ts, now: scheduler.now(), burst: p.burst, rttMs });
    if (plan.times.length === 0) return this.failRun(run, 'too late: past boundary(T+2) − rtt', 'aborted');

    // 1) token/curve — TokenLaunched log (ws) or receipt polling, whichever is first
    const waitMs = Math.max(0, Math.min(this.o.addressTimeoutMs ?? 1500, plan.latestMs - scheduler.now()));
    if (!(l.token && l.curve && l.addressSource && l.addressSource !== 'nonce')) {
      void this.resolveViaReceipt(l, scheduler.now() + waitMs);
    }
    const addrs = await this.detector.waitAddresses(l, waitMs);
    if (run.status !== 'pending') return run;
    if (!addrs) return this.failRun(run, 'token/curve not resolved in time', 'aborted');
    const token = addrs.token;
    const curve = addrs.curve;
    l.token = token;
    l.curve = curve;
    this.curveTax.set(curve, l.event.creatorTaxBps);
    const tc = this.risk.tokenCheck(token);
    if (!tc.ok && this.o.mode === 'live') return this.failRun(run, tc.reasons.join('; '), 'aborted');
    this.risk.onTokenKnown(token);

    // 2) the single eth_call on the decide path: getReserves (node may lag the feed by a block)
    let reserves = null;
    for (let i = 0; i < 5 && !reserves; i++) {
      reserves = await chain.getReserves(curve).catch(() => null);
      if (!reserves) await new Promise((r) => setTimeout(r, 15));
    }
    if (run.status !== 'pending') return run;
    if (!reserves) return this.failRun(run, 'getReserves failed', 'aborted');
    const rc = this.risk.reserveCheck(p, reserves);
    if (!rc.ok) return this.failRun(run, rc.reasons.join('; '), 'aborted');
    const mo = planMinOut(p, reserves, run.quoteIn, l.event.creatorTaxBps);
    run.minTokensOut = mo.minTokensOut;
    run.notes.push(`minOut basis ${mo.basis}, expected ${mo.expectedOut} @${mo.taxBps}bps`);

    // 3) re-plan with the current time, then sign + fire (live) or arm the simulation (paper)
    plan = clock.planBurst({ launchTs: l.ts, now: scheduler.now(), burst: p.burst, rttMs });
    run.plan = { ...plan, rttMs };
    if (plan.times.length === 0) return this.failRun(run, 'too late after resolving addresses', 'aborted');
    this.recorder.snipe(run, undefined, 'snipe_armed');
    const fill = await this.o.backend.execute({
      run,
      token,
      curve,
      times: plan.times,
      gasLimit: p.gasLimit,
      maxFeeGwei: this.risk.maxFeeGwei(p),
      priorityFeeGwei: p.priorityFeeGwei,
    });
    if (run.status !== 'pending') return run;
    if (!fill) return this.failRun(run, 'no burst member bought');
    run.fill = fill;
    run.status = 'open';
    this.counters.fills!++;
    const pos = this.positions.openPosition(run, fill, p, l.event.exemptions);
    this.recorder.snipe(run, pos, 'snipe_filled');
    this.o.logger.info(
      { key: run.key, token, block: fill.block, taxBps: fill.taxBps, tokensOut: fill.tokensOut.toString(), entryPrice: fill.entryPrice },
      'filled',
    );
    return run;
  }

  private async pollReserves(): Promise<void> {
    const curves = new Set(this.positions.open.map((p) => p.curve));
    await Promise.all(
      [...curves].map((c) =>
        this.o.chain.getReserves(c).then(
          (r) => this.positions.onReserves(c, r),
          () => undefined,
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ introspection
  get activeRuns(): SnipeRun[] {
    return [...this.runs.values()];
  }

  health(feed: HealthState['feed']): HealthState {
    const positions = this.positions.open.map((p: PositionEntry) => ({
      key: p.key,
      token: p.token,
      pnlPct: p.lastPnlPct,
      tokensHeld: p.state.tokensHeld.toString(),
    }));
    return {
      mode: this.o.mode,
      startedAt: this.startedAt,
      now: this.o.scheduler.now(),
      feed,
      clock: this.o.clock.snapshot(),
      rttMs: this.o.rttMs(),
      counters: { ...this.counters, decide_us_last: Math.round(this.lastDecideUs), rule_evaluations: this.rules.stats.evaluations },
      positions,
      lastError: this.lastError,
      nonce: this.o.nonce?.() ?? null,
      plays: this.rules.playCount,
      armed: this.rules.armedCount,
    };
  }
}

function tryParse<T>(s: string): Partial<T> | null {
  try {
    return JSON.parse(s) as Partial<T>;
  } catch {
    return null;
  }
}
