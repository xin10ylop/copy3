/**
 * Regression tests for the third review pass (docs/REVIEW.md NEW-1 … NEW-9; the reviewer's PoCs
 * live in the scratchpad as poc3/*.mts). NEW-1 is in launch-second.test.ts / pricing.test.ts and
 * packages/db/test/seed.test.ts, NEW-3's and NEW-5's contract parts in contracts/test.
 */
import { PONS_V2, SequencerClock, factoryAbi, type FeedBlock, type Reserves } from '@hood/core';
import { custom, encodeAbiParameters, encodeEventTopics, parseEther, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_CHUNK_BLOCKS, ViemChain, type SpendBudgetState } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { LaunchDetector } from '../src/detector.js';
import { LiveExecutor, type ExecutionBackend, type ExitOrder, type ExitResult, type SnipeOrder } from '../src/executor.js';
import { ContractLimits } from '../src/limits.js';
import { silentLogger } from '../src/log.js';
import { PaperExecutor } from '../src/paper.js';
import { LiveGate, liveStartupChecks, type StartupCheckResult } from '../src/preflight.js';
import { Risk } from '../src/risk.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper, type SniperOptions } from '../src/sniper.js';
import { MemoryStore } from '../src/store.js';
import type { Fill } from '../src/types.js';
import { FakeChain, FakeSender } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchBlock, launchReceipt, play, tokenLaunchedLog } from './helpers/fixtures.js';

const T = LAUNCH.ts;
const OFFSET = 45;
const INITIAL: Reserves = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n };
const SNIPER = '0x5151515151515151515151515151515151515151' as Address;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(2);
  }
}

/** Live backend whose fill the test resolves by hand (one member "in flight"). */
class ScriptedBackend implements ExecutionBackend {
  readonly mode = 'live' as const;
  orders: SnipeOrder[] = [];
  exits: ExitOrder[] = [];
  resolveFill: ((f: Fill | null) => void) | null = null;
  aborts = 0;
  balance: bigint | null = null;
  execute(o: SnipeOrder): Promise<Fill | null> {
    this.orders.push(o);
    o.run.burst = [{ index: 0, nonce: 1, hash: `0x${'ee'.repeat(32)}` as Hex, raw: '0x' as Hex, scheduledAt: o.times[0]!, sends: [], status: 'sent' }];
    return new Promise((r) => (this.resolveFill = r));
  }
  abort(): number {
    this.aborts++;
    return 1;
  }
  onFeedBlock(): void {}
  async exit(o: ExitOrder): Promise<ExitResult> {
    this.exits.push(o);
    return { ok: true, tokensIn: o.tokensIn, quoteOut: parseEther('0.05') };
  }
  bankrollWei(): bigint | null {
    return this.balance;
  }
}

const refs: Sniper[] = [];
afterEach(async () => {
  for (const s of refs.splice(0)) await s.stop();
});

const DEPLOYER_PLAY = { id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4 } };

function harness(o: { store?: MemoryStore; chain?: FakeChain; backend?: ExecutionBackend; receipt?: boolean; mode?: 'live' | 'paper'; opts?: Partial<SniperOptions> } = {}) {
  const mode = o.mode ?? 'live';
  const store = o.store ?? new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
  const chain = o.chain ?? new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  chain.atBlock = () => INITIAL;
  if (o.receipt !== false && !chain.receipts.has(LAUNCH.txHash)) chain.receipts.set(LAUNCH.txHash, launchReceipt());
  const sched = new ManualScheduler((T - 31) * 1000);
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
    reservesPollMs: 1e9,
    gasPollMs: 1e9,
    receiptPollMs: 1,
    reconcileMs: 1e9,
    ...(mode === 'live' ? { sniperContract: SNIPER } : {}),
    ...o.opts,
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

const fillOf = (quoteIn = parseEther('0.07'), tokensOut = 4n * 10n ** 25n): Fill => ({
  block: LAUNCH.block + 9,
  ts: T + 1,
  quoteIn,
  tokensOut,
  taxBps: 618,
  taxPaid: (quoteIn * 618n) / 10_000n,
  entryPrice: Number(quoteIn) / Number(tokensOut),
  txHash: `0x${'f1'.repeat(32)}` as Hex,
});

// ----------------------------------------------------------------------------------- NEW-7
describe('NEW-7: a launch receipt that contradicts the TokenLaunched log AFTER the fill', () => {
  it('forces the position out (launch_receipt_mismatch) instead of only alerting', async () => {
    const h = harness({ receipt: false });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    h.chain.launchWatcher!(tokenLaunchedLog); // N16: the ws log confirms before any receipt
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    h.scripted!.resolveFill!(fillOf());
    await waitFor(() => run.status === 'open');
    expect(h.scripted!.exits).toHaveLength(0);
    // the background receipt check finds a reverted launch: we hold a token the receipt does not prove
    h.chain.receipts.set(LAUNCH.txHash, launchReceipt({ status: 'reverted', logs: [] }));
    await waitFor(() => h.scripted!.exits.length === 1, 3000);
    expect(h.scripted!.exits[0]).toMatchObject({ reason: 'launch_receipt_mismatch', all: true });
    await waitFor(() => run.status === 'closed');
    const ev = h.store.events.find((e) => e.type === 'launch_receipt_mismatch')!;
    expect(ev.payload).toMatchObject({ filled: true });
    expect(run.notes.join()).toMatch(/contradicts the TokenLaunched log after the fill/);
  });

  it('a member still in flight when the contradiction aborts the run exits with the same reason once it fills', async () => {
    const h = harness({ receipt: false });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    h.chain.launchWatcher!(tokenLaunchedLog);
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    h.chain.receipts.set(LAUNCH.txHash, launchReceipt({ status: 'reverted', logs: [] }));
    await waitFor(() => run.status === 'aborted', 3000);
    h.scripted!.resolveFill!(fillOf()); // the in-flight member landed anyway (H2)
    await waitFor(() => h.scripted!.exits.length === 1);
    expect(h.scripted!.exits[0]!.reason).toBe('launch_receipt_mismatch');
  });
});

// ----------------------------------------------------------------------------------- NEW-3
describe('NEW-3: a runtime "no fill" is final only once the chain head passed the deadline block', () => {
  it('PoC C: a stalled sequencer (head below deadlineBlock) keeps the run unresolved with its slot; the late member fill becomes a position', async () => {
    const h = harness({ opts: { reconcileMs: 20 } });
    h.chain.blockNumber = LAUNCH.block + 5; // stalled: far below the deadline (launch + 40)
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    expect(run.deadlineTs).toBe(T + 1); // NEW-3: the wall-clock deadline passed to snipe() (SNIPE_DEADLINE_SECONDS: the +1 s second only)
    h.scripted!.resolveFill!(null); // receipts timed out: no fill seen, bought() still false
    await sleep(100); // several reconcile ticks
    expect(run.status).toBe('pending');
    expect(run.ended).not.toBe(true);
    expect(h.sniper.risk.open).toBe(1); // slot held
    expect(run.notes.join()).toMatch(/not past the deadline \(block/);
    await h.sniper.recorder.idle();
    expect([...h.store.snipes.values()].map((r) => r.status)).toEqual(['pending']);
    // the queued member lands after the stall
    h.chain.holdings.set(LAUNCH.token, { bought: true, balance: 4n * 10n ** 25n });
    await waitFor(() => run.status === 'open');
    expect(h.sniper.positions.open.map((p) => p.state.tokensHeld)).toEqual([4n * 10n ** 25n]);
    expect(h.store.events.map((e) => e.type)).toContain('fill_recovered_from_chain');
    expect(h.sniper.risk.open).toBe(1);
  });

  it('once the head passed the deadline block with bought() = false the run fails and frees its slot', async () => {
    const h = harness({ opts: { reconcileMs: 20 } });
    h.chain.blockNumber = LAUNCH.block + 5;
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    h.scripted!.resolveFill!(null);
    await sleep(60);
    expect(run.status).toBe('pending');
    h.chain.blockNumber = run.deadlineBlock + 1;
    await waitFor(() => run.status === 'failed');
    expect(h.sniper.risk.open).toBe(0);
    // the head was read BEFORE bought()/balanceOf() in the deciding check
    const calls = h.chain.calls;
    const lastRead = calls.lastIndexOf(`readSniper:${LAUNCH.token}`);
    expect(calls.slice(0, lastRead).lastIndexOf('getBlockNumber')).toBeGreaterThan(calls.slice(0, lastRead).lastIndexOf(`readSniper:${LAUNCH.token}`));
  });
});

describe('NEW-3: startup sweep of Sniped events — bought tokens with a balance but no open row become positions', () => {
  const OTHER = { token: '0x00000000000000000000000000000000000d0c01' as Address, curve: '0x00000000000000000000000000000000000d0c02' as Address };
  const SOLD = { token: '0x00000000000000000000000000000000000e0e01' as Address, curve: '0x00000000000000000000000000000000000e0e02' as Address };
  const sniped = (t: { token: Address; curve: Address }, block: number) => ({ token: t.token, curve: t.curve, quoteIn: parseEther('0.07'), tokensOut: 4n * 10n ** 25n, taxBps: 618, block, txHash: `0x${'5e'.repeat(32)}` as Hex });

  it('reuses the failed row of an orphaned buy, writes a row for one without any, skips sold-out tokens, and advances the checkpoint', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    const decision = {
      play: { id: 9, name: 'p' },
      reasons: ['deployerIn'],
      preset: { buyEth: 0.07, timeoutSec: 600 },
      confirmed: true,
      deadlineBlock: LAUNCH.block + 40,
      launch: { event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [LAUNCH.deployer], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 100, devBuyQuoteIn: '0', pairToken: '0x0000000000000000000000000000000000000000', launchConfigId: '0' }, block: LAUNCH.block, ts: T, txHash: LAUNCH.txHash },
    };
    // the run was written off at runtime (the old behaviour) and a member filled afterwards
    const failed = await store.insertSnipe({ playId: 9, token: LAUNCH.token, curve: LAUNCH.curve, decidedAt: new Date(), decision, mode: 'live', burst: [], status: 'failed', sells: [], quoteIn: parseEther('0.07'), notes: 'no burst member bought' });
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 1_000;
    chain.sniped = [sniped({ token: LAUNCH.token, curve: LAUNCH.curve }, LAUNCH.block + 20), sniped(OTHER, LAUNCH.block + 300), sniped(SOLD, LAUNCH.block + 400)];
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 4n * 10n ** 25n });
    chain.holdings.set(OTHER.token, { bought: true, balance: 3n * 10n ** 25n });
    chain.holdings.set(SOLD.token, { bought: true, balance: 0n });
    const h = harness({ store, chain });
    await h.sniper.start();
    expect(await h.sniper.sweeping).toBe(2);
    await h.sniper.recorder.idle();
    expect(h.sniper.positions.open.map((p) => [p.token, p.state.tokensHeld]).sort()).toEqual(
      [
        [LAUNCH.token, 4n * 10n ** 25n],
        [OTHER.token, 3n * 10n ** 25n],
      ].sort(),
    );
    expect(h.sniper.risk.open).toBe(0); // R4-1: adopted orphans hold no MAX_CONCURRENT slot
    expect(store.snipes.get(failed)!.status).toBe('open'); // the failed row is reused …
    expect(store.snipes.get(failed)!.notes).toMatch(/orphan recovered by the sweep/);
    const fresh = [...store.snipes.entries()].find(([, r]) => r.token === OTHER.token)!;
    expect(fresh[1]).toMatchObject({ status: 'open', mode: 'live', quoteIn: 0n }); // … a row is written for the other (R4-1: cost 0)
    const alerts = store.events.filter((e) => e.type === 'orphan_position_recovered');
    expect(alerts.map((e) => (e.payload as { token: string }).token).sort()).toEqual([LAUNCH.token, OTHER.token].sort());
    expect(alerts.every((e) => e.level === 'error')).toBe(true);
    expect(store.cursors.get(`sniped_sweep:${SNIPER}`)).toBe(LAUNCH.block + 1_000);
    // the recovered positions are managed: an exit sells the chain balance
    const p = h.sniper.positions.open.find((x) => x.token === OTHER.token)!;
    h.sniper.positions.forceExit(p.key, 'timeout');
    await waitFor(() => h.scripted!.exits.some((e) => e.token === OTHER.token));
    expect(h.scripted!.exits.find((e) => e.token === OTHER.token)).toMatchObject({ all: true, tokensIn: 3n * 10n ** 25n });
  });

  it('the next startup scans only past the checkpoint and never adopts a token that a row already manages', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    store.cursors.set(`sniped_sweep:${SNIPER}`, LAUNCH.block + 500);
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 2_000;
    chain.sniped = [sniped(OTHER, LAUNCH.block + 300)]; // before the checkpoint: already handled
    chain.holdings.set(OTHER.token, { bought: true, balance: 3n * 10n ** 25n });
    const h = harness({ store, chain });
    await h.sniper.start();
    expect(await h.sniper.sweeping).toBe(0);
    expect(chain.snipedRanges).toEqual([[LAUNCH.block + 501, LAUNCH.block + 2_000]]);
    expect(store.cursors.get(`sniped_sweep:${SNIPER}`)).toBe(LAUNCH.block + 2_000);
  });
});

// ----------------------------------------------------------------------------------- NEW-2
describe('NEW-2: config survives a lost NOTIFY (LISTEN reconnect)', () => {
  it('PoC D: a kill switch committed while the LISTEN connection was down is applied on the (re)connect', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)], settings: { kill_switch: { on: false } } });
    const h = harness({ store });
    await h.sniper.start();
    expect(h.sniper.risk.killSwitch).toBe(false);
    store.dropNotifications = true; // the LISTEN socket is reconnecting
    store.settings.kill_switch = { on: true, by: 'hoodctl' };
    store.emitChange('settings_changed', '{"op":"UPDATE","key":"kill_switch"}'); // lost
    await sleep(20);
    expect(h.sniper.risk.killSwitch).toBe(false);
    store.dropNotifications = false;
    store.reconnect(); // postgres.js onlisten
    await waitFor(() => h.sniper.risk.killSwitch);
    expect(h.sniper.risk.sendCheck().reasons).toContain('kill switch on');
  });

  it('without any reconnect signal the periodic reload picks up settings (10 s) and plays (60 s)', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)], settings: {} });
    const h = harness({ store, opts: { settingsReloadMs: 15, playsReloadMs: 25 } });
    await h.sniper.start();
    store.dropNotifications = true;
    store.settings.kill_switch = true;
    store.plays.push(play({ id: 10, trigger: { deployerIn: ['0x0000000000000000000000000000000000000001'] } }));
    store.emitChange('settings_changed');
    store.emitChange('plays_changed');
    await waitFor(() => h.sniper.risk.killSwitch, 2000);
    await waitFor(() => h.sniper.rules.playCount === 2, 2000);
  });
});

// ----------------------------------------------------------------------------------- NEW-4 / NEW-6
const nowS = (): number => Math.floor(Date.now() / 1000);
const budget = (maxSpend: string, levelEth: string, window = 3600): SpendBudgetState => ({ maxSpend: parseEther(maxSpend), window, level: parseEther(levelEth), updatedAt: nowS() });

describe('NEW-4: the contract spend budget is read and respected', () => {
  const KEYS = ['0x00000000000000000000000000000000000e0001', '0x00000000000000000000000000000000000b0001'] as Address[];
  const gateChain = (spend: SpendBudgetState): FakeChain => {
    const c = new FakeChain();
    c.sniperConfig = { owner: '0x00000000000000000000000000000000000c01d0', factory: PONS_V2.factory as Address, maxQuoteIn: parseEther('0.2'), operators: [true, true], spend };
    return c;
  };
  const gate = (c: FakeChain, o: { maxBuyEth?: number; maxBankrollEth?: number } = {}) =>
    liveStartupChecks({ chain: c, sniper: SNIPER, keys: KEYS, estimateFrom: KEYS[1]!, gasLimit: 300_000, gasCheck: false, ...o });

  it('the gate fails when the budget cannot cover the largest preset buy and warns when the budget is off', async () => {
    const low = await gate(gateChain(budget('0.1', '0')), { maxBuyEth: 0.15 });
    expect(low.ok).toBe(false);
    expect(low.errors).toEqual([expect.stringMatching(/NEW-4: the contract's spend budget 0\.1 ETH per 3600 s is below the largest preset buy 0\.15 ETH/)]);
    expect(low.spend).toMatchObject({ maxSpend: parseEther('0.1'), window: 3600 });
    // a bankroll preset's largest buy is its maxEth clamped to maxQuoteIn (0.2)
    expect((await gate(gateChain(budget('0.15', '0')), { maxBankrollEth: 0.3 })).errors).toEqual([expect.stringMatching(/below the largest preset buy 0\.2 ETH/)]);
    expect((await gate(gateChain(budget('0.8', '0')), { maxBuyEth: 0.15, maxBankrollEth: 0.3 })).ok).toBe(true);
    const off = await gate(gateChain(budget('0', '0', 0)), { maxBuyEth: 0.15 });
    expect(off.ok).toBe(true);
    expect(off.warnings).toEqual([expect.stringMatching(/spend budget is OFF/)]);
  });

  it('decide time: a remaining budget below quoteIn refuses the snipe with a spend_budget_exhausted alert (no burst member would have bought)', async () => {
    const h = harness();
    h.sniper.setContractLimits({ maxQuoteIn: parseEther('0.2'), spend: budget('1', '0.98') });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.sniper.counters.aborted === 1);
    expect(h.scripted!.orders).toHaveLength(0);
    await h.sniper.recorder.idle();
    expect([...h.store.snipes.values()][0]!.notes).toMatch(/spend budget exhausted: 0\.02 ETH left < quoteIn 0\.07 ETH/);
    const alert = h.store.events.find((e) => e.type === 'spend_budget_exhausted')!;
    expect(alert.level).toBe('error');
    expect(alert.payload).toMatchObject({ quoteInEth: '0.07', maxSpendEth: '1', windowSec: 3600 });
  });

  it('our own fill is charged locally until the next chain read (the next decision sees the smaller budget)', () => {
    const t = nowS();
    const lim = new ContractLimits({ maxQuoteIn: parseEther('0.2'), spend: { ...budget('0.1', '0'), updatedAt: t - 1 } });
    expect(lim.available(t)).toBe(parseEther('0.1'));
    lim.charge(parseEther('0.07'), t);
    expect(lim.available(t)).toBe(parseEther('0.03'));
    expect(lim.cap(t)).toBe(parseEther('0.03'));
    // it refills continuously like the contract (0.1 ETH per 3600 s), lagging the clock by 2 s so it never runs ahead of the chain
    expect(lim.available(t + 1802)).toBe(parseEther('0.08'));
    expect(lim.available(t + 1800)).toBeLessThan(parseEther('0.08'));
    // a fresh chain read that already contains the fill (spendUpdatedAt ≥ its block time) replaces the local charge
    lim.set({ spend: { ...budget('0.1', '0.05'), updatedAt: t } });
    expect(lim.available(t)).toBe(parseEther('0.05'));
    // budget off on chain: no cap from it
    lim.set({ spend: budget('0', '0', 0) });
    expect(lim.available()).toBeNull();
    expect(lim.cap()).toBe(parseEther('0.2'));
  });
});

describe('NEW-6: sizes are clamped to the contract caps; only a FIXED buyEth above maxQuoteIn is refused', () => {
  const BANKROLL_PLAY = { ...DEPLOYER_PLAY, preset: { maxEntryMcapEth: 4, sizing: { mode: 'bankroll', fraction: 0.25, minEth: 0.01, maxEth: 0.3 } } };

  it('a bankroll play (maxEth 0.3 > maxQuoteIn 0.2) buys maxQuoteIn instead of being refused', async () => {
    const backend = new ScriptedBackend();
    backend.balance = parseEther('3'); // 3 × 0.25 / 3 = 0.25 ETH before the caps
    const h = harness({ store: new MemoryStore({ plays: [play(BANKROLL_PLAY)] }), backend });
    h.sniper.setContractLimits({ maxQuoteIn: parseEther('0.2'), spend: budget('0.8', '0') });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => backend.orders.length === 1);
    const run = backend.orders[0]!.run;
    expect(run.quoteIn).toBe(parseEther('0.2'));
    expect(run.sizing).toMatchObject({ mode: 'bankroll', clamped: 'contract' });
    expect(run.notes.join()).toMatch(/clamped to the contract cap 0\.2 ETH/);
    backend.resolveFill!(null);
  });

  it('a bankroll size is clamped to the remaining spend budget; below minEth it is refused with spend_budget_exhausted', async () => {
    const backend = new ScriptedBackend();
    backend.balance = parseEther('3');
    const h = harness({ store: new MemoryStore({ plays: [play(BANKROLL_PLAY)] }), backend });
    h.sniper.setContractLimits({ maxQuoteIn: parseEther('0.2'), spend: budget('0.8', '0.75') });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => backend.orders.length === 1);
    expect(backend.orders[0]!.run.quoteIn).toBe(parseEther('0.05'));
    backend.resolveFill!(null);

    const b2 = new ScriptedBackend();
    b2.balance = parseEther('3');
    const h2 = harness({ store: new MemoryStore({ plays: [play(BANKROLL_PLAY)] }), backend: b2 });
    h2.sniper.setContractLimits({ maxQuoteIn: parseEther('0.2'), spend: budget('0.8', '0.795') });
    await h2.sniper.start();
    h2.warm();
    h2.launchSecond();
    await waitFor(() => h2.sniper.counters.aborted === 1);
    expect(b2.orders).toHaveLength(0);
    await h2.sniper.recorder.idle();
    expect([...h2.store.snipes.values()][0]!.notes).toMatch(/bankroll size clamped to the contract cap 0\.005 ETH < minEth 0\.01/);
    expect(h2.store.events.map((e) => e.type)).toContain('spend_budget_exhausted');
  });

  it('paper applies the same caps: maxQuoteIn clamp, spend budget and the contract balance (L8 twin)', async () => {
    const mk = (o: { plays: Parameters<typeof play>[0][]; paperBankrollEth?: number; paperLimits?: SniperOptions['paperLimits'] }) => {
      const chain = new FakeChain();
      // eslint-disable-next-line prefer-const
      let sniper: Sniper;
      const backend = new PaperExecutor({ chain, logger: silentLogger, book: (c) => sniper.positions.book(c), creatorTaxBps: (c) => sniper.creatorTaxBps(c) });
      const h = harness({
        mode: 'paper',
        chain,
        backend,
        store: new MemoryStore({ plays: o.plays.map((x) => play(x)) }),
        opts: { ...(o.paperBankrollEth !== undefined ? { paperBankrollEth: o.paperBankrollEth } : {}), ...(o.paperLimits ? { paperLimits: o.paperLimits } : {}) },
      });
      sniper = h.sniper;
      return h;
    };
    // (a) maxQuoteIn 0.04 clamps a bankroll size (0.6 × 0.25 / 3 = 0.05)
    const a = mk({ plays: [BANKROLL_PLAY], paperBankrollEth: 0.6, paperLimits: { maxQuoteIn: parseEther('0.04'), maxSpend: parseEther('1'), spendWindow: 3600 } });
    await a.sniper.start();
    a.warm();
    a.launchSecond();
    await waitFor(() => a.sniper.activeRuns[0]?.plan !== undefined);
    expect(a.sniper.activeRuns[0]!.quoteIn).toBe(parseEther('0.04'));
    // (b) a budget below a fixed 0.07 buy refuses at decide time (paper default limits otherwise)
    const b = mk({ plays: [DEPLOYER_PLAY], paperLimits: { maxQuoteIn: parseEther('0.3'), maxSpend: parseEther('0.05'), spendWindow: 3600 } });
    await b.sniper.start();
    b.warm();
    b.launchSecond();
    await waitFor(() => b.sniper.counters.aborted === 1);
    expect(b.store.events.map((e) => e.type)).toContain('spend_budget_exhausted');
    // (c) the simulated contract balance (paper bankroll 0.05) cannot pay a fixed 0.07 buy
    const c = mk({ plays: [DEPLOYER_PLAY], paperBankrollEth: 0.05 });
    await c.sniper.start();
    c.warm();
    c.launchSecond();
    await waitFor(() => c.sniper.counters.aborted === 1);
    await c.sniper.recorder.idle();
    expect([...c.store.snipes.values()][0]!.notes).toMatch(/paper: contract balance 0\.05 ETH < quoteIn 0\.07 ETH/);
    expect(c.store.events.map((e) => e.type)).toContain('low_balance');
  });
});

describe('paper mode accumulates its daily loss at runtime (it stops like live would)', () => {
  it('a paper position closing at a loss counts toward the paper daily loss limit', () => {
    const r = new Risk({ mode: 'paper', maxConcurrent: 3, dailyLossLimitEth: 0.05, maxGasPriceGwei: 1 });
    r.reserve();
    r.onPositionClosed(-0.03);
    expect(r.realizedToday).toBeCloseTo(-0.03, 12);
    expect(r.sendCheck().ok).toBe(true);
    r.bookRealized(-0.03);
    expect(r.sendCheck().reasons).toEqual([expect.stringMatching(/daily loss -0\.0600 ETH ≥ limit 0\.05/)]);
  });
});

// ----------------------------------------------------------------------------------- NEW-8
describe('NEW-8: chunked log reads and a refreshed contract config', () => {
  it('recentLaunches walks back in eth_getLogs ranges of ≤ 10 000 blocks (public RPCs refuse 36 000 at once)', async () => {
    const head = 1_000_000;
    const ranges: [number, number][] = [];
    const launchAt = [head - 2_000, head - 15_000, head - 25_000];
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_blockNumber') return `0x${head.toString(16)}`;
        if (method === 'eth_getLogs') {
          const f = (params as [{ fromBlock: Hex; toBlock: Hex }])[0];
          const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
          if (b - a + 1 > LOG_CHUNK_BLOCKS) throw new Error('query exceeds max block range 10000');
          ranges.push([a, b]);
          return launchAt
            .filter((n) => n >= a && n <= b)
            .map((n, i) => ({
              address: PONS_V2.factory,
              topics: encodeEventTopics({ abi: factoryAbi, eventName: 'TokenLaunched', args: { token: `0x${n.toString(16).padStart(40, '0')}` as Address, curve: `0x${(n + 1).toString(16).padStart(40, '0')}` as Address, deployer: LAUNCH.deployer } }),
              data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], ['0x0000000000000000000000000000000000000000', 0n, 4_200_000_000_000_000_000n]),
              blockNumber: `0x${n.toString(16)}`,
              transactionHash: `0x${n.toString(16).padStart(64, '0')}`,
              transactionIndex: '0x0',
              blockHash: `0x${'11'.repeat(32)}`,
              logIndex: `0x${i.toString(16)}`,
              removed: false,
            }));
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const chain = new ViemChain({ httpUrl: 'http://unused', transport });
    const got = await chain.recentLaunches(36_000, 2);
    expect(got.map((l) => l.block)).toEqual([head - 2_000, head - 15_000]); // newest first, stops at the limit
    expect(ranges.every(([a, b]) => b - a + 1 <= LOG_CHUNK_BLOCKS)).toBe(true);
    // [head − 36 000, head] in 10 000-block chunks, newest first; stops once the limit is reached
    expect(ranges).toEqual([
      [head - 9_999, head],
      [head - 19_999, head - 10_000],
    ]);
    expect((await chain.recentLaunches(36_000, 8)).map((l) => l.block)).toEqual(launchAt);
  });

  it('while the gate passes the contract config is re-read every GATE_REFRESH_MS and the latest limits reach the decide path', async () => {
    const results: StartupCheckResult[] = [];
    let mq = parseEther('0.2');
    let operatorOk = true;
    let readable = true;
    const base: StartupCheckResult = { ok: true, errors: [], warnings: [], gasEstimate: 180_000n, exitGasEstimate: 90_000n, maxQuoteIn: mq, spend: budget('0.8', '0'), estimatedOn: null };
    const h = harness();
    const gate = new LiveGate({
      logger: silentLogger,
      refreshMs: 10,
      retryMs: 10_000,
      check: async () => ({ ...base, maxQuoteIn: mq }),
      refresh: async () =>
        !readable
          ? { ...base, ok: false, errors: ['reading the PonsSniper config failed: HTTP 429'], maxQuoteIn: null, gasEstimate: null, exitGasEstimate: null }
          : operatorOk
            ? { ...base, maxQuoteIn: mq, gasEstimate: null, exitGasEstimate: null }
            : { ...base, ok: false, errors: ['executor key 0xb is not an operator'], maxQuoteIn: mq, gasEstimate: null, exitGasEstimate: null },
      onResult: (r) => {
        results.push(r);
        if (r.maxQuoteIn !== null) h.sniper.setContractLimits({ maxQuoteIn: r.maxQuoteIn, spend: r.spend ?? null });
        h.sniper.risk.blockEntries(r.ok ? null : r.errors.join('; '));
      },
    });
    await gate.run();
    expect(h.sniper.limits.maxQuoteIn).toBe(parseEther('0.2'));
    mq = parseEther('0.1'); // the owner lowered maxQuoteIn
    await waitFor(() => h.sniper.limits.maxQuoteIn === parseEther('0.1'), 2000);
    expect(results.at(-1)!.gasEstimate).toBe(180_000n); // the full check's estimates are kept
    operatorOk = false; // a key was revoked: entries blocked at the next refresh
    await waitFor(() => h.sniper.risk.entriesBlocked !== null, 2000);
    expect(h.sniper.risk.entriesBlocked).toMatch(/not an operator/);
    gate.stop();
    // a refresh that merely could not read keeps the previous state (the contract enforces anyway)
    const g2Results: StartupCheckResult[] = [];
    readable = false;
    operatorOk = true;
    const g2 = new LiveGate({ logger: silentLogger, refreshMs: 5, check: async () => base, refresh: async () => ({ ...base, ok: false, errors: ['reading the PonsSniper config failed'], maxQuoteIn: null }), onResult: (r) => g2Results.push(r) });
    await g2.run();
    await sleep(40);
    g2.stop();
    expect(g2Results).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------------- NEW-9
describe('NEW-9: exit keys (EXIT_KEYS)', () => {
  const EXIT_A = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const EXIT_B = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
  const BURST = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
  const mk = (exitKeys: number) => {
    const sched = new ManualScheduler(1_000_000);
    const chain = new FakeChain();
    const sender = new FakeSender('http://a', () => sched.now());
    const ex = new LiveExecutor({ accounts: [EXIT_A, EXIT_B, BURST], exitKeys, sniper: SNIPER, chainId: 4663, senders: [sender], chain, scheduler: sched, logger: silentLogger, receiptPollMs: 1, exitReceiptTimeoutMs: 80, settleTimeoutMs: 5 });
    return { ex, sender };
  };
  const order = (n: number): ExitOrder => ({ key: `k${n}`, curve: LAUNCH.curve, token: LAUNCH.token, tokensIn: 10n ** 24n, all: true, minQuoteOut: 0n, reason: 'timeout', gasLimit: 300_000, maxFeeGwei: 1 });
  const senders = async (raws: { raw: Hex }[]): Promise<string[]> => Promise.all(raws.map(async (r) => (await recoverTransactionAddress({ serializedTransaction: r.raw as `0x02${string}` })).toLowerCase()));

  it('one exit key serves exits strictly FIFO; with EXIT_KEYS=2 concurrent exits go out at once on different keys', async () => {
    const one = mk(1);
    expect(one.ex.exitKeys.map((k) => k.address)).toEqual([EXIT_A.address.toLowerCase()]);
    expect(one.ex.burstKeys.map((k) => k.address)).toEqual([EXIT_B.address.toLowerCase(), BURST.address.toLowerCase()]);
    const p1 = Promise.all([one.ex.exit(order(1)), one.ex.exit(order(2))]);
    await sleep(30);
    expect(one.sender.sent).toHaveLength(1); // the second exit waits for the first one's receipt / timeout
    await p1;
    expect(new Set(await senders(one.sender.sent.slice(0, 2)))).toEqual(new Set([EXIT_A.address.toLowerCase()]));

    const two = mk(2);
    expect(two.ex.exitKeys.map((k) => k.address)).toEqual([EXIT_A.address.toLowerCase(), EXIT_B.address.toLowerCase()]);
    expect(two.ex.burstKeys.map((k) => k.address)).toEqual([BURST.address.toLowerCase()]);
    const p2 = Promise.all([two.ex.exit(order(1)), two.ex.exit(order(2))]);
    await sleep(30);
    expect(two.sender.sent).toHaveLength(2); // both on the wire before either receipt timeout
    expect(new Set(await senders(two.sender.sent))).toEqual(new Set([EXIT_A.address.toLowerCase(), EXIT_B.address.toLowerCase()]));
    await p2;
    // round-robin afterwards
    expect(two.ex.pickExitKey().address).not.toBe(two.ex.pickExitKey().address);
  });

  it('config: EXIT_KEYS must leave at least one burst key', () => {
    const k = (n: number): string => `0x${String(n).repeat(64)}`;
    const base = { EXECUTION_MODE: 'live', SNIPER_CONTRACT: SNIPER, DATABASE_URL: 'postgres://x', SEND_ENDPOINTS: 'http://a', EXECUTOR_PRIVATE_KEYS: `${k(1)},${k(2)},${k(3)}` };
    expect(loadConfig({ ...base, EXIT_KEYS: '2' }).EXIT_KEYS).toBe(2);
    expect(loadConfig(base).EXIT_KEYS).toBe(1);
    expect(() => loadConfig({ ...base, EXIT_KEYS: '3' })).toThrow(/leaves no burst key/);
  });
});

// ----------------------------------------------------------------------------------- feed_blocks retention
describe('feed_blocks retention (FEED_BLOCKS_RETENTION_DAYS, pruned from the reconcile timer)', () => {
  it('drops rows older than the retention at most hourly', async () => {
    const h = harness({ opts: { feedBlocksRetentionDays: 7 } });
    const now = Date.now();
    await h.store.insertFeedBlocks([
      { block: 1, ts: Math.floor((now - 8 * 86_400_000) / 1000), arrivalMs: 0, nTxs: 0 },
      { block: 2, ts: Math.floor((now - 6 * 86_400_000) / 1000), arrivalMs: 0, nTxs: 0 },
      { block: 3, ts: Math.floor(now / 1000), arrivalMs: 0, nTxs: 0 },
    ]);
    expect(await h.sniper.pruneFeedBlocks(now)).toBe(1);
    expect(h.store.feedBlocks.map((r) => r.block)).toEqual([2, 3]);
    await h.store.insertFeedBlocks([{ block: 4, ts: Math.floor((now - 9 * 86_400_000) / 1000), arrivalMs: 0, nTxs: 0 }]);
    expect(await h.sniper.pruneFeedBlocks(now + 60_000)).toBe(0); // rate-limited to once an hour
    expect(await h.sniper.pruneFeedBlocks(now + 3_600_000)).toBe(1);
  });
});
