/**
 * Regression tests for the third review pass (docs/REVIEW.md NEW-1 … NEW-9; the reviewer's PoCs
 * live in the scratchpad as poc3/*.mts). NEW-1 is in launch-second.test.ts / pricing.test.ts and
 * packages/db/test/seed.test.ts, NEW-3's and NEW-5's contract parts in contracts/test.
 */
import { SequencerClock, type FeedBlock, type Reserves } from '@hood/core';
import { parseEther, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchDetector } from '../src/detector.js';
import type { ExecutionBackend, ExitOrder, ExitResult, SnipeOrder } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper, type SniperOptions } from '../src/sniper.js';
import { MemoryStore } from '../src/store.js';
import type { Fill } from '../src/types.js';
import { FakeChain } from './helpers/fakes.js';
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
    expect(run.deadlineTs).toBe(T + 3); // NEW-3: the wall-clock deadline passed to snipe()
    h.scripted!.resolveFill!(null); // receipts timed out: no fill seen, bought() still false
    await sleep(100); // several reconcile ticks
    expect(run.status).toBe('pending');
    expect(run.ended).not.toBe(true);
    expect(h.sniper.risk.open).toBe(1); // slot held
    expect(run.notes.join()).toMatch(/has not passed the deadline block/);
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
    expect(h.sniper.risk.open).toBe(2); // both hold a MAX_CONCURRENT slot
    expect(store.snipes.get(failed)!.status).toBe('open'); // the failed row is reused …
    expect(store.snipes.get(failed)!.notes).toMatch(/orphan recovered by the startup sweep/);
    const fresh = [...store.snipes.entries()].find(([, r]) => r.token === OTHER.token)!;
    expect(fresh[1]).toMatchObject({ status: 'open', mode: 'live', quoteIn: parseEther('0.07') }); // … a row is written for the other
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
