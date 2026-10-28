/**
 * Regression tests for the second review pass (docs/REVIEW.md N1–N16; the reviewer's PoCs live in
 * the scratchpad as poc2/*.mts). N4 is in contracts/test, N9 in packages/core/test/feed-client,
 * N14 in launch-and-buy.test.ts, N5's config check in review-fixes.test.ts.
 */
import {
  PONS_V2,
  QUOTE_TOKENS,
  SequencerClock,
  TOPICS,
  curveAbi,
  decodedTxFromRpc,
  factoryAbi,
  type DecodedTx,
  type FeedBlock,
  type RawLog,
  type Reserves,
} from '@hood/core';
import { privateKeyToAccount } from 'viem/accounts';
import { custom, encodeAbiParameters, encodeFunctionData, encodeEventTopics, parseEther, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { ViemChain } from '../src/chain.js';
import { LaunchDetector } from '../src/detector.js';
import { LiveExecutor, type ExecutionBackend, type ExitOrder, type ExitResult, type SnipeOrder } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { PaperExecutor } from '../src/paper.js';
import { Positions } from '../src/positions.js';
import { LiveGate, liveStartupChecks, type StartupCheckResult } from '../src/preflight.js';
import { Risk } from '../src/risk.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper } from '../src/sniper.js';
import { MemoryStore, type SnipeRecord } from '../src/store.js';
import type { Fill, SnipeRun } from '../src/types.js';
import { FakeChain, FakeSender, curveTradeLog } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchBlock, launchFixture, launchReceipt, launchTx, play, tokenLaunchedLog } from './helpers/fixtures.js';

const T = LAUNCH.ts;
const OFFSET = 45;
const INITIAL: Reserves = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n };
const SNIPER = '0x5151515151515151515151515151515151515151' as Address;
const ATTACKER = '0x000000000000000000000000000000000000beef' as Address;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(2);
  }
}
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Live backend whose fill the test resolves by hand (members "in flight"). */
class ScriptedBackend implements ExecutionBackend {
  readonly mode = 'live' as const;
  orders: SnipeOrder[] = [];
  exits: ExitOrder[] = [];
  resolveFill: ((f: Fill | null) => void) | null = null;
  aborts = 0;
  execute(o: SnipeOrder): Promise<Fill | null> {
    this.orders.push(o);
    o.run.burst = [{ index: 0, nonce: 1, hash: `0x${'ee'.repeat(32)}` as Hex, raw: '0x' as Hex, scheduledAt: o.times[0]!, sends: [], status: 'sent' }];
    return new Promise((r) => (this.resolveFill = r));
  }
  abort(): number {
    this.aborts++;
    return 7;
  }
  onFeedBlock(): void {}
  async exit(o: ExitOrder): Promise<ExitResult> {
    this.exits.push(o);
    return { ok: true, tokensIn: o.tokensIn, quoteOut: parseEther('0.05') };
  }
}

const refs: Sniper[] = [];
afterEach(async () => {
  for (const s of refs.splice(0)) await s.stop();
});

function harness(o: { store?: MemoryStore; chain?: FakeChain; backend?: ExecutionBackend; sched?: ManualScheduler; maxConcurrent?: number; reconcileMs?: number; reservesPollMs?: number; receipt?: boolean; mode?: 'live' | 'paper' } = {}) {
  const mode = o.mode ?? 'live';
  const store = o.store ?? new MemoryStore({ plays: [play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4 } })] });
  const chain = o.chain ?? new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  chain.atBlock = () => INITIAL;
  if (o.receipt !== false && !chain.receipts.has(LAUNCH.txHash)) chain.receipts.set(LAUNCH.txHash, launchReceipt());
  const sched = o.sched ?? new ManualScheduler((T - 31) * 1000);
  const backend = o.backend ?? new ScriptedBackend();
  const sniper = new Sniper({
    mode,
    store,
    chain,
    backend,
    clock: new SequencerClock(),
    scheduler: sched,
    logger: silentLogger,
    detector: new LaunchDetector(),
    rttMs: () => 6,
    reservesPollMs: o.reservesPollMs ?? 1e9,
    gasPollMs: 1e9,
    receiptPollMs: 1,
    reconcileMs: o.reconcileMs ?? 1e9,
    ...(o.maxConcurrent !== undefined ? { maxConcurrent: o.maxConcurrent } : {}),
    ...(mode === 'live' ? { sniperContract: SNIPER } : {}),
  });
  refs.push(sniper);
  const feed = (b: FeedBlock): void => {
    sched.t = b.receivedAt;
    sniper.onFeedBlock(b);
  };
  const warm = (): void => {
    for (let s = 10; s >= 1; s--) for (let k = 0; k < 10; k++) feed(emptyBlock(LAUNCH.block - 2 - s * 10 + k, T - s, (T - s) * 1000 + OFFSET + k * 100));
  };
  const launchSecond = (upTo = 3): void => {
    for (let k = 0; k <= upTo; k++) {
      const at = T * 1000 + OFFSET + k * 100;
      feed(LAUNCH.block - 2 + k === LAUNCH.block ? launchBlock(at) : emptyBlock(LAUNCH.block - 2 + k, T, at));
    }
  };
  return { store, chain, sched, sniper, backend, feed, warm, launchSecond, scripted: backend instanceof ScriptedBackend ? backend : null };
}

const exemptSell = (hashByte: string): DecodedTx =>
  decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${hashByte.repeat(32)}`, from: LAUNCH.creatorFeeRecipient, to: LAUNCH.curve, value: 0n, input: `0xd04c6983${'0'.repeat(63)}1${'0'.repeat(128)}` });

function mkRun(mode: 'live' | 'paper', preset: Record<string, unknown> = {}): SnipeRun {
  const p = play({ id: 1, trigger: { deployerIn: [LAUNCH.deployer] }, preset });
  return {
    id: 0,
    key: 'k',
    mode,
    playId: 1,
    launch: {
      event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 0, devBuyQuoteIn: 0n, pairToken: QUOTE_TOKENS.eth, launchConfigId: 0n },
      block: 1,
      ts: 1,
      receivedAt: 0,
      txHash: LAUNCH.txHash,
      token: LAUNCH.token,
      curve: LAUNCH.curve,
      source: 'feed',
    },
    decision: { play: p, preset: p.preset, reasons: [] },
    status: 'open',
    decidedAt: 0,
    quoteIn: 10n ** 16n,
    minTokensOut: 0n,
    maxTaxBps: 1000,
    deadlineBlock: 40,
    burst: [],
    notes: [],
  };
}
const FILL: Fill = { block: 1, ts: 1, quoteIn: 10n ** 16n, tokensOut: 10n ** 22n, taxBps: 618, taxPaid: 0n, entryPrice: 1e-6 };

// ----------------------------------------------------------------------------------- N1
describe('N1: live gate after startup, blocks only new entries', () => {
  const EXIT_KEY = '0x00000000000000000000000000000000000e0001' as Address;
  const BURST_KEY = '0x00000000000000000000000000000000000b0001' as Address;
  const tok = (n: number): Address => `0x${String(n).repeat(40)}` as Address;

  it('PoC A: the estimate skips our own buy, a launch still in its taxed second and a graduated curve', async () => {
    const c = new FakeChain();
    c.blockNumber = 1_000;
    c.blockTs.set(1_000, T + 100);
    c.recents = [
      { token: tok(1), curve: tok(2), block: 999 }, // in its launch second (tax 9900)
      { token: tok(3), curve: tok(4), block: 990 }, // bought by us (restart right after a snipe)
      { token: tok(5), curve: tok(6), block: 980 }, // graduated
      { token: tok(7), curve: tok(8), block: 970 }, // the one to use
    ];
    c.blockTs.set(999, T + 99);
    for (const b of [990, 980, 970]) c.blockTs.set(b, T);
    c.holdings.set(tok(3), { bought: true, balance: 10n ** 24n });
    c.graduated.add(tok(6));
    c.sniperConfig = { owner: '0x00000000000000000000000000000000000c01d0', factory: PONS_V2.factory as Address, maxQuoteIn: parseEther('0.2'), operators: [true, true] };
    const r = await liveStartupChecks({ chain: c, sniper: SNIPER, keys: [EXIT_KEY, BURST_KEY], estimateFrom: BURST_KEY, exitFrom: EXIT_KEY, gasLimit: 300_000 });
    expect(r.ok).toBe(true);
    expect(r.estimatedOn).toMatchObject({ curve: tok(8) });
    expect(c.estimates.map((e) => e.from)).toEqual([BURST_KEY, EXIT_KEY]); // one snipe estimate, one exit estimate
  });

  it('a failing gate keeps new entries blocked (retried) while positions are managed; passing unblocks', async () => {
    const results: StartupCheckResult[] = [
      { ok: false, errors: ['L6: no curve'], warnings: [], gasEstimate: null, exitGasEstimate: null, maxQuoteIn: null, estimatedOn: null },
      { ok: true, errors: [], warnings: [], gasEstimate: 180_000n, exitGasEstimate: 100_000n, maxQuoteIn: parseEther('0.2'), estimatedOn: null },
    ];
    const risk = new Risk({ mode: 'live', maxConcurrent: 3, dailyLossLimitEth: 1, maxGasPriceGwei: 1 });
    risk.blockEntries('live startup checks have not passed yet');
    let calls = 0;
    const gate = new LiveGate({
      logger: silentLogger,
      retryMs: 10,
      check: async () => results[Math.min(calls++, 1)]!,
      onResult: (r) => risk.blockEntries(r.ok ? null : r.errors.join('; ')),
    });
    const first = await gate.run();
    expect(first.ok).toBe(false);
    expect(risk.sendCheck().reasons).toEqual([expect.stringMatching(/new entries blocked: L6: no curve/)]);
    await waitFor(() => calls >= 2);
    await flush();
    expect(risk.entriesBlocked).toBeNull();
    gate.stop();
    // positions are not affected by an entry block
    const be = new ScriptedBackend();
    const pos = new Positions({ backend: be, chain: new FakeChain(), logger: silentLogger, now: () => 0 });
    risk.blockEntries('gate failing');
    const e = pos.openPosition(mkRun('live', { takeProfits: [{ pct: 10, sellPct: 100 }] }), FILL, mkRun('live', { takeProfits: [{ pct: 10, sellPct: 100 }] }).decision.preset, []);
    pos.onReserves(LAUNCH.curve, { quote: 3n * 10n ** 18n, token: 10n ** 24n }, 5);
    await flush();
    expect(be.exits).toHaveLength(1);
    expect(e.closed).toBe(true);
  });

  it('a Sniper with blocked entries refuses the launch at decide time', async () => {
    const h = harness();
    h.sniper.risk.blockEntries('live gate: L6: no curve');
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.sniper.counters.aborted === 1);
    expect(h.scripted!.orders).toHaveLength(0);
    await h.sniper.recorder.idle();
    expect([...h.store.snipes.values()][0]!.notes).toMatch(/new entries blocked: live gate/);
  });
});

// ----------------------------------------------------------------------------------- N2
describe('N2: transient exit failures never make a position stuck', () => {
  it('PoC B: a 12 s endpoint outage is retried with a capped backoff and the exit lands after recovery', async () => {
    let t = 0;
    const down = 12_000;
    const attempts: number[] = [];
    const be: ExecutionBackend = {
      mode: 'live',
      execute: async () => null,
      abort: () => 0,
      onFeedBlock: () => undefined,
      exit: async (o) => {
        attempts.push(t);
        return t < down ? { ok: false, tokensIn: o.tokensIn, quoteOut: 0n, error: 'HTTP 502; HTTP 502' } : { ok: true, tokensIn: o.tokensIn, quoteOut: 10n ** 15n };
      },
    };
    const chain = new FakeChain();
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 10n ** 22n });
    const alerts: string[] = [];
    const pos = new Positions({ backend: be, chain, logger: silentLogger, now: () => t, sniper: SNIPER, maxExitBackoffMs: 8_000, onAlert: (_p, type) => alerts.push(type) });
    const run = mkRun('live', { timeoutSec: 60 });
    const e = pos.openPosition(run, FILL, run.decision.preset, []);
    pos.onReserves(LAUNCH.curve, { quote: 4n * 10n ** 17n, token: 10n ** 24n }, 5); // −60 % → stop loss
    for (t = 0; t <= 60_000; t += 250) {
      pos.tick();
      await flush(3);
    }
    expect(e.phase).toBe('closed');
    expect(alerts).toContain('exit_retrying');
    expect(alerts).not.toContain('position_stuck');
    const gaps = attempts.filter((x, i) => i % 3 === 0).map((x, i, a) => (i ? x - a[i - 1]! : 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(8_000 + 250); // capped backoff
    expect(attempts.some((x) => x >= down)).toBe(true);
  });

  it('only on-chain reverts at minQuoteOut = 0 lead to stuck; recheck re-arms a stuck position that still holds tokens', async () => {
    let t = 0;
    let revert = true;
    const be: ExecutionBackend = {
      mode: 'live',
      execute: async () => null,
      abort: () => 0,
      onFeedBlock: () => undefined,
      exit: async (o) => (revert ? { ok: false, tokensIn: o.tokensIn, quoteOut: 0n, error: 'exit reverted', reverted: true } : { ok: true, tokensIn: o.tokensIn, quoteOut: 10n ** 15n }),
    };
    const chain = new FakeChain();
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 10n ** 22n });
    const alerts: string[] = [];
    const pos = new Positions({ backend: be, chain, logger: silentLogger, now: () => t, sniper: SNIPER, stuckRearmMs: 60_000, onAlert: (_p, type) => alerts.push(type) });
    const run = mkRun('live', { timeoutSec: 1 });
    const e = pos.openPosition(run, FILL, run.decision.preset, []);
    for (t = 2_000; t <= 30_000; t += 250) {
      pos.tick();
      await flush(3);
    }
    expect(e.phase).toBe('stuck');
    await pos.recheck(); // too early: cooldown
    expect(e.phase).toBe('stuck');
    t = e.stuckAt + 60_000;
    revert = false;
    await pos.recheck();
    await flush();
    expect(alerts).toEqual(['position_stuck', 'position_rearmed']);
    expect(e.phase).toBe('closed');
  });
});

// ----------------------------------------------------------------------------------- N3
describe('N3: a run aborted with members in flight is reconciled after a restart', () => {
  it('PoC C: the row stays pending until the run ends; a restart rebuilds the position the in-flight member bought', async () => {
    const store = new MemoryStore({ plays: [play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4 } })] });
    const chain = new FakeChain();
    const h = harness({ store, chain });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    h.feed(emptyBlock(LAUNCH.block + 2, T, T * 1000 + OFFSET + 400, [exemptSell('ab')]));
    await waitFor(() => run.status === 'aborted');
    await h.sniper.recorder.idle();
    const row = [...store.snipes.values()][0]!;
    expect(row.status).toBe('pending');
    expect(row.notes).toMatch(/exempt wallet .* sold in the launch second/);
    // crash before the in-flight member reports; it bought at +1 s
    await h.sniper.stop();
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 4n * 10n ** 25n });
    const h2 = harness({ store, chain });
    await h2.sniper.start();
    expect(h2.sniper.positions.open.map((p) => p.state.tokensHeld)).toEqual([4n * 10n ** 25n]);
    expect(h2.sniper.counters.positions_rebuilt).toBe(1);
  });

  it('legacy rows written as aborted while a member was still `sent` are loaded too', async () => {
    const store = new MemoryStore();
    const base: SnipeRecord = { playId: 9, token: LAUNCH.token, curve: LAUNCH.curve, decidedAt: new Date(), decision: {}, mode: 'live', burst: [], status: 'aborted', sells: [] };
    await store.insertSnipe({ ...base, burst: [{ nonce: 1, status: 'reverted' }] });
    const inflight = await store.insertSnipe({ ...base, burst: [{ nonce: 1, status: 'sent' }] });
    expect((await store.loadActiveSnipes('live')).map((r) => r.id)).toEqual([inflight]);
  });
});

// ----------------------------------------------------------------------------------- N6
describe('N6: a successful exit is booked even if the phase changed while it was in flight', () => {
  it('PoC H: CurveCompleted arrives before our exit receipt → the sale is booked, PnL is right', async () => {
    let release!: (r: ExitResult) => void;
    const be: ExecutionBackend = { mode: 'live', execute: async () => null, abort: () => 0, onFeedBlock: () => undefined, exit: () => new Promise((r) => (release = r)) };
    const chain = new FakeChain();
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 10n ** 22n });
    let pnl: number | null = null;
    const pos = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0, sniper: SNIPER, onClosed: (_p, x) => (pnl = x) });
    const run = mkRun('live', { takeProfits: [{ pct: 100, sellPct: 100 }], trailing: null });
    const e = pos.openPosition(run, FILL, run.decision.preset, []);
    pos.onReserves(LAUNCH.curve, { quote: 3n * 10n ** 18n, token: 10n ** 24n }, 5);
    await flush();
    pos.onLog({ address: LAUNCH.curve, topics: [TOPICS.CurveCompleted], data: `0x${'00'.repeat(96)}`, blockNumber: 7, transactionHash: `0x${'22'.repeat(32)}`, logIndex: 0 });
    expect(e.phase).toBe('graduated');
    release({ ok: true, tokensIn: 10n ** 22n, quoteOut: 3n * 10n ** 16n, txHash: `0x${'33'.repeat(32)}` as Hex, block: 6 });
    await flush();
    expect(e.sales.map((s) => [s.reason, s.quoteOut])).toEqual([['tp1', 3n * 10n ** 16n]]);
    expect(e.closed).toBe(true);
    expect(pnl).toBeCloseTo(0.02, 12);
  });
});

// ----------------------------------------------------------------------------------- N7
describe('N7: the executor onFinal never inserts a second row', () => {
  it('PoC D2: a dropped member keeps the burst open past endRun; onFinal updates the one row', async () => {
    const EXIT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const BURST = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
    const store = new MemoryStore({ plays: [play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4, burst: { startMs: -120, spacingMs: 15, count: 3 } } })] });
    const chain = new FakeChain();
    chain.nonces.set(BURST.address.toLowerCase(), 100);
    const sched = new ManualScheduler((T - 31) * 1000);
    let sniper: Sniper | undefined;
    const finals: string[] = [];
    const ex = new LiveExecutor({
      accounts: [EXIT, BURST],
      sniper: SNIPER,
      chainId: 4663,
      senders: [new FakeSender('http://a', () => sched.now())],
      chain,
      scheduler: sched,
      logger: silentLogger,
      receiptPollMs: 1,
      reconcileTimeoutMs: 300,
      settleTimeoutMs: 30,
      // both the old wiring (snipe) and the new one (update) must be safe
      onFinal: (run) => {
        finals.push(run.key);
        sniper?.recorder.snipe(run, sniper.positions.get(run.key), 'burst_final');
        sniper?.recorder.update(run, sniper.positions.get(run.key), 'burst_final');
      },
    });
    await ex.init();
    const h = harness({ store, chain, backend: ex, sched });
    sniper = h.sniper;
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.sniper.activeRuns[0]?.burst.length === 3);
    const run = h.sniper.activeRuns[0]!;
    h.sched.advance((T + 2) * 1000);
    await waitFor(() => run.burst.every((m) => m.status !== 'planned')).catch((e: unknown) => {
      throw new Error(`${(e as Error).message}: ${run.burst.map((m) => m.status).join(',')} ${run.notes.join(' | ')}`);
    });
    expect(run.burst.map((m) => m.status)).toEqual(['sent', 'sent', 'sent']);
    for (const m of run.burst.slice(0, 2)) chain.receipts.set(m.hash.toLowerCase(), { transactionHash: m.hash, status: 'reverted', blockNumber: LAUNCH.block + 1, gasUsed: 37_000n, logs: [] });
    chain.nonces.set(BURST.address.toLowerCase(), 102); // the third member was dropped: settle fills nonce 102
    await waitFor(() => finals.length === 1 && !ex.burstKeys[0]!.inBurst, 5000);
    await sleep(10);
    await h.sniper.recorder.idle();
    expect([...store.snipes.values()].map((r) => r.status)).toEqual(['failed']);
  });
});

// ----------------------------------------------------------------------------------- N8
describe('N8: paper graduation does not leak MAX_CONCURRENT slots', () => {
  it('PoC E: recheck closes a graduated paper position with a simulated sale and frees its slot', async () => {
    const chain = new FakeChain();
    const risk = new Risk({ mode: 'paper', maxConcurrent: 1, dailyLossLimitEth: 0.5, maxGasPriceGwei: 1 });
    const be = new PaperExecutor({ chain, logger: silentLogger, creatorTaxBps: () => 0 });
    const pos = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0, onClosed: (_p, pnl) => risk.onPositionClosed(pnl) });
    const run = mkRun('paper', { timeoutSec: 60 });
    risk.reserve();
    const e = pos.openPosition(run, { ...FILL, reserves: { quote: 2n * 10n ** 18n, token: 10n ** 24n }, reservesBlock: 1 }, run.decision.preset, []);
    pos.onLog({ address: LAUNCH.curve, topics: [TOPICS.CurveCompleted], data: `0x${'00'.repeat(96)}`, blockNumber: 5, transactionHash: `0x${'11'.repeat(32)}`, logIndex: 0 });
    expect(e.phase).toBe('graduated');
    await pos.recheck();
    expect(e.closed).toBe(true);
    expect(e.sales[0]).toMatchObject({ reason: 'graduated(paper)', estimated: true });
    expect(e.sales[0]!.quoteOut).toBeGreaterThan(0n);
    expect(risk.open).toBe(0);
  });
});

// ----------------------------------------------------------------------------------- N10
describe('N10: spoofs to the real factory do not hold concurrency slots', () => {
  it('PoC J: reverted launchTokenFor spoofs ahead of the real launch in the same block do not block it', async () => {
    const params = { name: 'x', symbol: 'x', logo: '', description: '', socials: { x: '', telegram: '', website: '', discord: '', farcaster: '' }, creatorFeeRecipient: ATTACKER, creatorTaxBps: 0, buybackEnabled: false, salt1: `0x${'00'.repeat(32)}`, salt2: `0x${'00'.repeat(32)}` } as const;
    const spoof = (b: string): DecodedTx =>
      decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${b.repeat(32)}`, from: ATTACKER, to: PONS_V2.factory, value: 0n, input: encodeFunctionData({ abi: factoryAbi, functionName: 'launchTokenFor', args: [params, 0n, QUOTE_TOKENS.eth, LAUNCH.deployer, []] }) });
    const chain = new FakeChain();
    const spoofs = ['a1', 'a2'].map(spoof);
    for (const s of spoofs) chain.receipts.set(s.hash, { transactionHash: s.hash, status: 'reverted', blockNumber: LAUNCH.block, gasUsed: 30_000n, logs: [] });
    const h = harness({ chain, maxConcurrent: 1 });
    await h.sniper.start();
    h.warm();
    h.feed(emptyBlock(LAUNCH.block, T, T * 1000 + OFFSET + 200, [...spoofs, launchTx()]));
    await waitFor(() => h.scripted!.orders.length === 1);
    expect(h.scripted!.orders[0]!.run.launch.txHash).toBe(LAUNCH.txHash);
    expect(h.sniper.risk.open).toBe(1);
    h.scripted!.resolveFill!(null);
  });
});

// ----------------------------------------------------------------------------------- N11
describe('N11: readSniper pins bought() and balanceOf() to one block', () => {
  it('both eth_calls carry the same block number', async () => {
    const calls: { method: string; params: unknown[] }[] = [];
    const transport = custom({
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        calls.push({ method, params });
        if (method === 'eth_blockNumber') return '0x5f5e100';
        if (method === 'eth_call') {
          const data = (params[0] as { data: string }).data;
          return data.startsWith('0x667022fd') ? encodeAbiParameters([{ type: 'bool' }], [true]) : encodeAbiParameters([{ type: 'uint256' }], [123n]);
        }
        if (method === 'eth_chainId') return '0x1237';
        throw new Error(`unexpected ${method}`);
      },
    });
    const vc = new ViemChain({ httpUrl: 'http://unused', transport });
    expect(await vc.readSniper(SNIPER, LAUNCH.token)).toEqual({ bought: true, balance: 123n });
    const tags = calls.filter((c) => c.method === 'eth_call').map((c) => c.params[1]);
    expect(tags).toEqual(['0x5f5e100', '0x5f5e100']);
  });
});

// ----------------------------------------------------------------------------------- N12
describe('N12: a pending row is not declared "no buy" before the burst deadline', () => {
  it('row stays pending while the head is below deadlineBlock; failed once it passed', async () => {
    const store = new MemoryStore({ plays: [play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] } })] });
    const id = await store.insertSnipe({
      playId: 9,
      token: LAUNCH.token,
      curve: LAUNCH.curve,
      decidedAt: new Date(),
      decision: { confirmed: true, deadlineBlock: LAUNCH.block + 40, launch: { event: { deployer: LAUNCH.deployer }, block: LAUNCH.block, ts: T } },
      mode: 'live',
      burst: [{ nonce: 1, status: 'sent' }],
      status: 'pending',
      sells: [],
    });
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 10; // members can still land
    const h = harness({ store, chain, reconcileMs: 20 });
    await h.sniper.start();
    expect(store.snipes.get(id)!.status).toBe('pending');
    expect(store.events.map((e) => e.type)).not.toContain('stale_snipe_failed');
    chain.blockNumber = LAUNCH.block + 41;
    await waitFor(() => store.snipes.get(id)!.status === 'failed', 3000);
  });
});

// ----------------------------------------------------------------------------------- N13
describe('N13: no unpinned reserves snapshot', () => {
  it('pollReserves skips the tick when the block number cannot be read', async () => {
    const h = harness({ reservesPollMs: 10 });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    h.scripted!.resolveFill!({ block: LAUNCH.block + 8, ts: T + 1, quoteIn: parseEther('0.07'), tokensOut: 4n * 10n ** 25n, taxBps: 618, taxPaid: 0n, entryPrice: 1.75e-9 });
    await waitFor(() => h.sniper.positions.open.length === 1);
    h.chain.blockNumberFails = true;
    const before = h.chain.calls.length;
    await sleep(60);
    const after = h.chain.calls.slice(before);
    expect(after).toContain('getBlockNumber');
    expect(after.filter((c) => c.startsWith('getReserves'))).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------- N15
describe('N15: presets above maxQuoteIn are refused; exits are estimated', () => {
  it('a preset buying more than the contract maxQuoteIn is refused at decide time', async () => {
    const store = new MemoryStore({ plays: [play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.3, maxEntryMcapEth: 4 } })] });
    const h = harness({ store });
    h.sniper.setContractLimits({ maxQuoteIn: parseEther('0.2') });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.sniper.counters.aborted === 1);
    expect(h.scripted!.orders).toHaveLength(0);
    await h.sniper.recorder.idle();
    expect([...store.snipes.values()][0]!.notes).toMatch(/preset buys up to 0\.3 ETH > contract maxQuoteIn 0\.2 ETH/);
  });

  it('the gate estimates exitAll with a balance override; an exit above the gas limit fails the gate', async () => {
    const c = new FakeChain();
    c.blockNumber = 1_000;
    c.blockTs.set(1_000, T + 100);
    c.blockTs.set(970, T);
    c.recents = [{ token: LAUNCH.token, curve: LAUNCH.curve, block: 970 }];
    c.sniperConfig = { owner: '0x00000000000000000000000000000000000c01d0', factory: PONS_V2.factory as Address, maxQuoteIn: parseEther('0.2'), operators: [true, true] };
    c.estimateFn = async (tx) => (tx.stateOverride ? 320_000n : 190_000n);
    const r = await liveStartupChecks({ chain: c, sniper: SNIPER, keys: ['0x00000000000000000000000000000000000e0001', '0x00000000000000000000000000000000000b0001'], estimateFrom: '0x00000000000000000000000000000000000b0001', gasLimit: 300_000 });
    expect(r.errors).toEqual([expect.stringMatching(/N15: exitAll\(\) estimate 320000 gas > preset gas limit 300000/)]);
    const ov = c.estimates[1]!.stateOverride!;
    expect(ov[0]!.address).toBe(LAUNCH.token);
    expect(ov[0]!.stateDiff).toHaveLength(2); // balance + allowance to the curve
    c.estimateFn = async (tx) => (tx.stateOverride ? 260_000n : 190_000n);
    const near = await liveStartupChecks({ chain: c, sniper: SNIPER, keys: ['0x00000000000000000000000000000000000e0001', '0x00000000000000000000000000000000000b0001'], estimateFrom: '0x00000000000000000000000000000000000b0001', gasLimit: 300_000 });
    expect(near.ok).toBe(true);
    expect(near.warnings).toEqual([expect.stringMatching(/treasury allowance/)]);
  });
});

// ----------------------------------------------------------------------------------- N16
describe('N16: the TokenLaunched ws log confirms a launch as soon as it arrives', () => {
  it('fires before any receipt exists; the receipt is still verified in the background (contradiction → abort)', async () => {
    const h = harness({ receipt: false });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await sleep(10);
    expect(h.scripted!.orders).toHaveLength(0); // neither log nor receipt yet
    h.chain.launchWatcher!(tokenLaunchedLog);
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    expect(run.notes.join()).toMatch(/confirmed by the TokenLaunched ws log/);
    expect(run.launch.addressSource).toBe('log');
    // the receipt shows a revert: the run is aborted (an in-flight fill would exit at once)
    h.chain.receipts.set(LAUNCH.txHash, launchReceipt({ status: 'reverted', logs: [] }));
    await waitFor(() => run.status === 'aborted', 3000);
    expect(h.store.events.map((e) => e.type)).toContain('launch_receipt_mismatch');
    expect(h.scripted!.aborts).toBe(1);
    h.scripted!.resolveFill!(null);
  });

  it('two TokenLaunched logs for our deployer in one tx (ambiguous) wait for the receipt', async () => {
    const h = harness({ receipt: false });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    const second: RawLog = {
      ...tokenLaunchedLog,
      topics: encodeEventTopics({ abi: factoryAbi, eventName: 'TokenLaunched', args: { token: `0x${'cd'.repeat(20)}`, curve: `0x${'ef'.repeat(20)}`, deployer: LAUNCH.deployer } }) as string[],
    };
    h.chain.launchWatcher!(tokenLaunchedLog);
    h.chain.launchWatcher!(second);
    await sleep(30);
    expect(h.scripted!.orders).toHaveLength(0);
    h.chain.receipts.set(LAUNCH.txHash, launchReceipt());
    await waitFor(() => h.scripted!.orders.length === 1);
    expect(h.scripted!.orders[0]!.run.notes.join()).not.toMatch(/ws log/);
    h.scripted!.resolveFill!(null);
  });

  it('ledger: an exemption granted during the launch second (SnipeTaxExempted log) makes that wallet team; a log wakes the confirmation', async () => {
    const { LaunchSecondLedger } = await import('../src/ledger.js');
    const det = new LaunchDetector();
    const [l] = await det.detect(launchBlock(T * 1000 + 50));
    const lg = new LaunchSecondLedger(l!);
    lg.setAddresses(LAUNCH.token, LAUNCH.curve);
    const NEWTEAM = '0x0000000000000000000000000000000000000a11';
    const buyLog = curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: NEWTEAM, recipient: NEWTEAM, quote: parseEther('0.2'), tokens: 10n ** 26n, fee: 0n, tax: 0n, block: LAUNCH.block + 2, txHash: `0x${'b1'.repeat(32)}`, logIndex: 1 });
    expect(lg.ingestLog(buyLog)).toBe(true);
    expect(lg.stats().confirmed.teamBuyEth).toBe(0); // not exempt (yet): a taxed buy
    const woke = lg.changed(5_000).then(() => 'woke');
    const exempted: RawLog = { address: LAUNCH.curve, topics: [TOPICS.SnipeTaxExempted, `0x${'0'.repeat(24)}${NEWTEAM.slice(2)}`], data: '0x', blockNumber: LAUNCH.block + 1, transactionHash: `0x${'e1'.repeat(32)}`, logIndex: 0 };
    expect(lg.ingestLog(exempted)).toBe(true);
    lg.wake();
    expect(await woke).toBe('woke');
    expect(lg.stats().confirmed.teamBuyEth).toBeCloseTo(0.2, 12);
    expect(lg.exemptions).toContain(NEWTEAM);
    // the launch receipt's set (applied later) keeps the late exemption
    lg.setExemptions([LAUNCH.deployer, LAUNCH.creatorFeeRecipient]);
    expect(lg.isExempt(NEWTEAM)).toBe(true);
    expect(curveAbi.length).toBeGreaterThan(0);
  });
});
