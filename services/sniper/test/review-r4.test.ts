/**
 * Regression tests for the fourth review pass (docs/REVIEW.md R4-1 … R4-8; reviewer PoCs in the
 * scratchpad as poc4/*.mts). R4-3 is in pricing.test.ts, the R4-8 ledger re-open in
 * launch-second.test.ts and the feed_blocks index in packages/db/test/migrations.test.ts.
 */
import { PONS_V2, SequencerClock, factoryAbi, type FeedBlock, type Reserves } from '@hood/core';
import { custom, encodeAbiParameters, encodeEventTopics, parseEther, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_LOG_CHUNK_BLOCKS, ViemChain, scanChunks, type SpendBudgetState } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { LaunchDetector } from '../src/detector.js';
import { LiveExecutor, type ExecutionBackend, type ExitOrder, type ExitResult, type SnipeOrder } from '../src/executor.js';
import { ContractLimits } from '../src/limits.js';
import { silentLogger } from '../src/log.js';
import { Positions } from '../src/positions.js';
import { liveStartupChecks } from '../src/preflight.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper, type SniperOptions } from '../src/sniper.js';
import { MemoryStore, type SnipeRecord } from '../src/store.js';
import type { Fill, SnipeRun } from '../src/types.js';
import { FakeChain, FakeSender } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchBlock, launchReceipt, play } from './helpers/fixtures.js';

const T = LAUNCH.ts;
const OFFSET = 45;
const INITIAL: Reserves = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n };
const SNIPER = '0x5151515151515151515151515151515151515151' as Address;
const CURSOR = `sniped_sweep:${SNIPER}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(2);
  }
}

class ScriptedBackend implements ExecutionBackend {
  readonly mode = 'live' as const;
  orders: SnipeOrder[] = [];
  exits: ExitOrder[] = [];
  resolveFill: ((f: Fill | null) => void) | null = null;
  exitResult: (o: ExitOrder) => ExitResult = (o) => ({ ok: true, tokensIn: o.tokensIn, quoteOut: parseEther('0.05') });
  execute(o: SnipeOrder): Promise<Fill | null> {
    this.orders.push(o);
    o.run.burst = [{ index: 0, nonce: 1, hash: `0x${'ee'.repeat(32)}` as Hex, raw: '0x' as Hex, scheduledAt: o.times[0]!, sends: [], status: 'sent' }];
    return new Promise((r) => (this.resolveFill = r));
  }
  abort(): number {
    return 1;
  }
  onFeedBlock(): void {}
  async exit(o: ExitOrder): Promise<ExitResult> {
    this.exits.push(o);
    return this.exitResult(o);
  }
}

const refs: Sniper[] = [];
afterEach(async () => {
  for (const s of refs.splice(0)) await s.stop();
});

const DEPLOYER_PLAY = { id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4 } };

function harness(o: { store?: MemoryStore; chain?: FakeChain; backend?: ScriptedBackend; opts?: Partial<SniperOptions> } = {}) {
  const store = o.store ?? new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
  const chain = o.chain ?? new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  chain.atBlock = () => INITIAL;
  if (!chain.receipts.has(LAUNCH.txHash)) chain.receipts.set(LAUNCH.txHash, launchReceipt());
  const sched = new ManualScheduler((T - 31) * 1000);
  const backend = o.backend ?? new ScriptedBackend();
  const sniper = new Sniper({
    mode: 'live',
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
    sniperContract: SNIPER,
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
  const launchSecond = (): void => {
    for (let k = 0; k <= 3; k++) {
      const at = T * 1000 + OFFSET + k * 100;
      feed(LAUNCH.block - 2 + k === LAUNCH.block ? launchBlock(at) : emptyBlock(LAUNCH.block - 2 + k, T, at));
    }
  };
  return { store, chain, sched, sniper, backend, warm, launchSecond };
}

const DECISION = {
  play: { id: 9, name: 'p' },
  reasons: [],
  preset: { buyEth: 0.07 },
  confirmed: true,
  deadlineBlock: LAUNCH.block + 40,
  launch: { event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 0, devBuyQuoteIn: '0', pairToken: '0x0000000000000000000000000000000000000000', launchConfigId: '0' }, block: LAUNCH.block, ts: T, txHash: LAUNCH.txHash },
};
const row = (o: Partial<SnipeRecord>): SnipeRecord => ({ playId: 9, token: LAUNCH.token, curve: LAUNCH.curve, decidedAt: new Date(), decision: DECISION, mode: 'live', burst: [], status: 'closed', sells: [], quoteIn: parseEther('0.07'), tokensOut: 4n * 10n ** 25n, ...o });
const SNIPED = { token: LAUNCH.token as Address, curve: LAUNCH.curve as Address, quoteIn: parseEther('0.07'), tokensOut: 4n * 10n ** 25n, taxBps: 618, block: LAUNCH.block + 9, txHash: `0x${'5e'.repeat(32)}` as Hex };

// ----------------------------------------------------------------------------------- R4-1
describe('R4-1: the orphan sweep never re-books a closed trade and ignores dust', () => {
  it('PoC A/C: 1 token-wei sent to the contract after a closed trade is dust — not adopted, no row, no slot, no exit, no daily-loss booking', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    await store.insertSnipe(row({ status: 'closed', realizedPnlEth: 0.02, closedAt: new Date() }));
    store.cursors.set(CURSOR, LAUNCH.block - 1);
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 5000;
    chain.sniped = [SNIPED];
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 1n });
    const backend = new ScriptedBackend();
    backend.exitResult = (o) => ({ ok: false, tokensIn: o.tokensIn, quoteOut: 0n, reverted: true, error: 'ZeroAmount()' });
    const h = harness({ store, chain, backend });
    await h.sniper.start();
    expect(await h.sniper.sweeping).toBe(0);
    expect(h.sniper.positions.open).toHaveLength(0);
    expect(h.sniper.risk.open).toBe(0);
    expect(h.sniper.risk.realizedToday).toBeCloseTo(0.02, 12); // the original trade, booked once (the PoC showed −0.05)
    expect(store.snipes.size).toBe(1);
    expect(backend.exits).toHaveLength(0);
    const ev = store.events.find((e) => e.type === 'orphan_dust_ignored')!;
    expect(ev.level).toBe('info');
    expect(store.events.map((e) => e.type)).not.toContain('orphan_position_recovered');
  });

  it('a real balance on a token whose newest row is CLOSED is alerted only (its PnL is booked already)', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    await store.insertSnipe(row({ status: 'closed', realizedPnlEth: 0.02, closedAt: new Date() }));
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 5000;
    chain.sniped = [SNIPED];
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 2n * 10n ** 25n });
    const h = harness({ store, chain });
    await h.sniper.start();
    expect(await h.sniper.sweeping).toBe(0);
    expect(h.sniper.positions.open).toHaveLength(0);
    expect(store.snipes.size).toBe(1);
    const ev = store.events.find((e) => e.type === 'orphan_balance_on_closed_row')!;
    expect(ev.payload).toMatchObject({ previousStatus: 'closed', balance: (2n * 10n ** 25n).toString() });
  });

  it('a balance worth less than the exit gas is dust even above 0.5 % of the tokens bought', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 5000;
    chain.sniped = [SNIPED];
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 10n ** 24n }); // 2.5 % of the buy …
    const h = harness({ store, chain });
    chain.latest.set(LAUNCH.curve, { quote: 10n ** 9n, token: 10n ** 27n }); // … on a curve where it is worth ~1e6 wei
    await h.sniper.start();
    expect(await h.sniper.sweeping).toBe(0);
    expect(store.events.find((e) => e.type === 'orphan_dust_ignored')!.payload).toMatchObject({ why: expect.stringMatching(/< exit gas/) });
  });

  it('a real orphan (failed row) is adopted at cost 0: no slot, and its close books nothing to the daily loss', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    const failed = await store.insertSnipe(row({ status: 'failed', notes: 'no burst member bought' }));
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 5000;
    chain.sniped = [SNIPED];
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 4n * 10n ** 25n });
    const h = harness({ store, chain });
    await h.sniper.start();
    expect(await h.sniper.sweeping).toBe(1);
    const p = h.sniper.positions.open[0]!;
    expect(p.costBasis).toBe(0n);
    expect(p.state.entryPrice).toBeCloseTo(0.07e18 / 4e25, 20); // exit rules still price from the real entry
    expect(h.sniper.risk.open).toBe(0);
    h.sniper.positions.forceExit(p.key, 'timeout');
    await waitFor(() => p.closed);
    await h.sniper.recorder.idle();
    expect(h.sniper.risk.realizedToday).toBe(0);
    expect(h.sniper.risk.open).toBe(0);
    expect(store.snipes.get(failed)).toMatchObject({ status: 'closed', quoteIn: 0n });
    expect(store.events.find((e) => e.type === 'orphan_position_recovered')!.payload).toMatchObject({ costBasis: '0', holdsSlot: false });
  });
});

// ----------------------------------------------------------------------------------- R4-2
describe('R4-2: "no buy" is judged on the block bought()/balanceOf() were read at (and deadlineTs)', () => {
  async function pendingRun(h: ReturnType<typeof harness>) {
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.backend.orders.length === 1);
    const run = h.backend.orders[0]!.run;
    h.backend.resolveFill!(null);
    return run;
  }

  it('a load-balanced RPC whose head is past the deadline but whose read came from a lagging backend keeps the run pending', async () => {
    const h = harness({ opts: { reconcileMs: 20 } });
    h.chain.blockNumber = LAUNCH.block + 100; // the head (another backend) is far past the deadline …
    h.chain.readSniperBlock = LAUNCH.block + 5; // … but bought()/balanceOf() were served at an old block
    const run = await pendingRun(h);
    await sleep(80);
    expect(run.status).toBe('pending'); // the old code ended it as "no buy" here
    expect(h.sniper.risk.open).toBe(1);
    h.chain.holdings.set(LAUNCH.token, { bought: true, balance: 4n * 10n ** 25n }); // the buy was real
    await waitFor(() => run.status === 'open');
  });

  it('a read whose block timestamp is past deadlineTs is final even below deadlineBlock (snipe() reverts Expired there)', async () => {
    const h = harness({ opts: { reconcileMs: 20 } });
    h.chain.blockNumber = LAUNCH.block + 5;
    h.chain.blockTs.set(LAUNCH.block + 5, T + 60);
    const run = await pendingRun(h);
    await waitFor(() => run.status === 'failed');
    expect(h.sniper.risk.open).toBe(0);
  });

  it('a run unresolved for more than 2 min raises snipe_unresolved_long (stale NODE_HTTP: slot held forever otherwise)', async () => {
    const h = harness({ opts: { reconcileMs: 20 } });
    h.chain.blockNumber = LAUNCH.block + 5; // never advances
    const run = await pendingRun(h);
    await sleep(40);
    expect(h.store.events.map((e) => e.type)).not.toContain('snipe_unresolved_long');
    run.unresolvedSince = Date.now() - 121_000;
    await waitFor(() => h.store.events.some((e) => e.type === 'snipe_unresolved_long'));
    expect(h.store.events.filter((e) => e.type === 'snipe_unresolved_long')).toHaveLength(1);
  });

  it('the orphan sweep also runs periodically from its checkpoint (a runtime write-off is caught without a restart)', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    const chain = new FakeChain();
    chain.blockNumber = LAUNCH.block + 100;
    const h = harness({ store, chain, opts: { sweepIntervalMs: 15 } });
    await h.sniper.start();
    await h.sniper.sweeping;
    expect(h.sniper.positions.open).toHaveLength(0);
    chain.blockNumber = LAUNCH.block + 200;
    chain.sniped = [{ ...SNIPED, block: LAUNCH.block + 150 }];
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 4n * 10n ** 25n });
    await waitFor(() => h.sniper.positions.open.length === 1, 2000);
    expect(store.cursors.get(CURSOR)).toBe(LAUNCH.block + 200);
  });
});

// ----------------------------------------------------------------------------------- R4-4
describe('R4-4: an exit without a receipt is re-sent as the same tx (key, nonce), never re-signed', () => {
  const EXIT_A = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const EXIT_B = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
  const BURST = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
  const order: ExitOrder = { key: 'pos-1', curve: LAUNCH.curve, token: LAUNCH.token, tokensIn: 10n ** 24n, all: false, minQuoteOut: 0n, reason: 'tp1', gasLimit: 300_000, maxFeeGwei: 1 };

  it('the retry re-sends the identical raw tx on the same key even with another exit key free; the late landing is reported once', async () => {
    const sched = new ManualScheduler(1_000_000);
    const chain = new FakeChain();
    chain.nonces.set(EXIT_A.address.toLowerCase(), 7);
    const sender = new FakeSender('http://a', () => sched.now());
    const ex = new LiveExecutor({ accounts: [EXIT_A, EXIT_B, BURST], exitKeys: 2, sniper: SNIPER, chainId: 4663, senders: [sender], chain, scheduler: sched, logger: silentLogger, receiptPollMs: 1, exitReceiptTimeoutMs: 30, settleTimeoutMs: 5 });
    await ex.init();
    const first = await ex.exit(order);
    expect(first).toMatchObject({ ok: false, unknown: true });
    const raw0 = sender.sent[0]!.raw;
    expect(await recoverTransactionAddress({ serializedTransaction: raw0 as `0x02${string}` })).toBe(EXIT_A.address);
    // no filler replaced the pending nonce, and the key stays reserved for it
    expect(new Set(sender.sent.map((s) => s.raw))).toEqual(new Set([raw0]));
    const second = await ex.exit({ ...order, minQuoteOut: 1n }); // a wider/narrower retry must NOT re-sign
    expect(second).toMatchObject({ ok: false, unknown: true });
    expect(new Set(sender.sent.map((s) => s.raw))).toEqual(new Set([raw0])); // only the same tx, re-sent
    // the original lands late: the next call reports IT, once
    chain.receipts.set(first.txHash!.toLowerCase(), { transactionHash: first.txHash!, status: 'success', blockNumber: 500, gasUsed: 90_000n, logs: [] });
    const third = await ex.exit(order);
    expect(third).toMatchObject({ ok: true, replayed: true, txHash: first.txHash, all: false });
    expect(ex.pendingExits.size).toBe(0);
    const fourth = await ex.exit(order); // a new exit now signs a new tx
    expect(fourth.txHash).not.toBe(first.txHash);
  });

  it('if the pending nonce went to another tx, nothing was sold by it and a fresh exit follows', async () => {
    const sched = new ManualScheduler(1_000_000);
    const chain = new FakeChain();
    chain.nonces.set(EXIT_A.address.toLowerCase(), 7);
    const sender = new FakeSender('http://a', () => sched.now());
    const ex = new LiveExecutor({ accounts: [EXIT_A, BURST], sniper: SNIPER, chainId: 4663, senders: [sender], chain, scheduler: sched, logger: silentLogger, receiptPollMs: 1, exitReceiptTimeoutMs: 20, settleTimeoutMs: 5 });
    await ex.init();
    const first = await ex.exit(order);
    expect(first.unknown).toBe(true);
    chain.nonces.set(EXIT_A.address.toLowerCase(), 8); // nonce 7 consumed, not by our exit
    const second = await ex.exit(order);
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/dropped/) });
    expect(second.unknown).toBeUndefined();
    expect(ex.pendingExits.size).toBe(0);
  });

  it('positions: a replayed result for tokens the chain re-read already booked corrects that sale instead of booking it twice', async () => {
    const chain = new FakeChain();
    const results: ExitResult[] = [
      { ok: false, tokensIn: 10n ** 24n, quoteOut: 0n, error: 'exit receipt timeout', unknown: true, txHash: `0x${'a1'.repeat(32)}` as Hex },
      { ok: true, tokensIn: 10n ** 24n, quoteOut: parseEther('0.03'), txHash: `0x${'a1'.repeat(32)}` as Hex, block: 9, replayed: true, all: false },
    ];
    const backend: ExecutionBackend = { mode: 'live', execute: async () => null, abort: () => 0, onFeedBlock() {}, exit: async () => results.shift() ?? { ok: false, tokensIn: 0n, quoteOut: 0n, error: 'done' } };
    let now = 0;
    const pos = new Positions({ backend, chain, logger: silentLogger, now: () => now, sniper: SNIPER, exitBackoffMs: 1 });
    const run = { key: 'k', playId: 1, launch: { token: LAUNCH.token, curve: LAUNCH.curve, event: { creatorTaxBps: 0 } }, notes: [] } as unknown as SnipeRun;
    const p = pos.openPosition(run, { block: 1, ts: 1, quoteIn: parseEther('0.07'), tokensOut: 4n * 10n ** 24n, taxBps: 618, taxPaid: 0n, entryPrice: 1e-8, reserves: INITIAL, reservesBlock: 1 }, play({ preset: { takeProfits: [{ pct: -100, sellPct: 25 }], trailing: null, timeoutSec: 1e6 } }).preset, []);
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 3n * 10n ** 24n }); // the chain shows the 1e24 sold
    pos.tick();
    await waitFor(() => p.sales.length === 1 && !p.exiting);
    expect(p.sales[0]).toMatchObject({ estimated: true, tokensIn: 10n ** 24n });
    now = 1_000;
    pos.forceExit('k', 'timeout'); // the next attempt: the executor replays the landed tx
    await waitFor(() => results.length === 0 && !p.exiting);
    expect(p.sales).toHaveLength(1); // corrected, not booked again
    expect(p.sales[0]).toMatchObject({ quoteOut: parseEther('0.03'), txHash: `0x${'a1'.repeat(32)}` });
    expect(p.sales[0]!.estimated).toBeUndefined();
    expect(p.realizedQuote).toBe(parseEther('0.03'));
    expect(p.state.tokensHeld).toBe(3n * 10n ** 24n);
  });
});

// ----------------------------------------------------------------------------------- R4-5
describe('R4-5: an older config load never overwrites a newer one', () => {
  it('a slow periodic settings read that started before a kill-switch NOTIFY does not turn the kill switch off again', async () => {
    class SlowStore extends MemoryStore {
      delays: number[] = [];
      override async loadSettings(): Promise<Record<string, unknown>> {
        const snap = { ...this.settings }; // what the DB returned at query time
        await sleep(this.delays.shift() ?? 0);
        return snap;
      }
    }
    const store = new SlowStore({ plays: [play(DEPLOYER_PLAY)], settings: { kill_switch: { on: false } } });
    const h = harness({ store });
    await h.sniper.start();
    await sleep(5);
    store.delays = [60, 0]; // the periodic read is slow, the NOTIFY-driven one fast
    const periodic = h.sniper.reloadConfig('settings', 'periodic'); // reads "off"
    store.settings.kill_switch = { on: true, by: 'hoodctl' };
    store.emitChange('settings_changed'); // reads "on", applies first
    await waitFor(() => h.sniper.risk.killSwitch);
    await periodic; // the older "off" result arrives last …
    expect(h.sniper.risk.killSwitch).toBe(true); // … and is dropped
  });
});

// ----------------------------------------------------------------------------------- R4-6
describe('R4-6: the spend budget is reserved across concurrent runs and survives a chain read', () => {
  const budget = (o: Partial<SpendBudgetState> = {}): SpendBudgetState => ({ maxSpend: parseEther('0.1'), window: 3600, level: 0n, updatedAt: Math.floor(Date.now() / 1000) - 100, ...o });

  it('a decided run reserves its quoteIn (a second concurrent 0.07 buy no longer fits); a no-fill releases it', async () => {
    const lim = new ContractLimits({ maxQuoteIn: parseEther('0.2'), spend: budget() });
    lim.reserve('run-1', parseEther('0.07'));
    expect(lim.available()).toBe(parseEther('0.03'));
    lim.release('run-1');
    expect(lim.available()).toBe(parseEther('0.1'));
    // orchestrator: the reservation is held from decide until the run ends
    const h = harness({ opts: { reconcileMs: 20 } });
    h.sniper.setContractLimits({ maxQuoteIn: parseEther('0.2'), spend: budget() });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.backend.orders.length === 1);
    const run = h.backend.orders[0]!.run;
    expect(h.sniper.limits.reservedWei).toBe(parseEther('0.07'));
    expect(h.sniper.limits.available()).toBe(parseEther('0.03'));
    h.chain.blockNumber = run.deadlineBlock + 1;
    h.backend.resolveFill!(null);
    await waitFor(() => run.status === 'failed');
    expect(h.sniper.limits.reservedWei).toBe(0n);
  });

  it('a gate refresh keeps local charges newer than the chain\'s last spend (it cannot contain them yet)', () => {
    const t = Math.floor(Date.now() / 1000);
    const lim = new ContractLimits({ maxQuoteIn: parseEther('0.2'), spend: budget({ updatedAt: t - 100 }) });
    lim.charge(parseEther('0.07'), t - 10); // our fill, 10 s ago
    expect(lim.available(t)).toBeLessThan(parseEther('0.031'));
    lim.set({ spend: budget({ updatedAt: t - 100 }) }); // a refresh read BEFORE the fill was mined
    expect(lim.available(t)).toBeLessThan(parseEther('0.031')); // the charge survives
    lim.set({ spend: budget({ updatedAt: t - 10, level: parseEther('0.07') }) }); // a read that contains it
    expect(lim.available(t)! > parseEther('0.029') && lim.available(t)! < parseEther('0.031')).toBe(true); // counted once
  });
});

// ----------------------------------------------------------------------------------- R4-7
describe('R4-7: log scans halve the chunk on a range error and the sweep checkpoints per chunk', () => {
  it('an RPC capping eth_getLogs at 2 000 blocks: recentLaunches halves 10 000 → 1 250 and succeeds; removed logs are dropped', async () => {
    const head = 1_000_000;
    const ranges: [number, number][] = [];
    const launchAt = [head - 1_000, head - 3_000];
    const transport = custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === 'eth_blockNumber') return `0x${head.toString(16)}`;
        if (method === 'eth_getLogs') {
          const f = (params as [{ fromBlock: Hex; toBlock: Hex }])[0];
          const [a, b] = [Number(f.fromBlock), Number(f.toBlock)];
          if (b - a + 1 > 2_000) throw new Error('query exceeds max block range 2000');
          ranges.push([a, b]);
          return [...launchAt, head - 500]
            .filter((n) => n >= a && n <= b)
            .map((n) => ({
              address: PONS_V2.factory,
              topics: encodeEventTopics({ abi: factoryAbi, eventName: 'TokenLaunched', args: { token: `0x${n.toString(16).padStart(40, '0')}` as Address, curve: `0x${(n + 1).toString(16).padStart(40, '0')}` as Address, deployer: LAUNCH.deployer } }),
              data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], ['0x0000000000000000000000000000000000000000', 0n, 4_200_000_000_000_000_000n]),
              blockNumber: `0x${n.toString(16)}`,
              transactionHash: `0x${n.toString(16).padStart(64, '0')}`,
              transactionIndex: '0x0',
              blockHash: `0x${'11'.repeat(32)}`,
              logIndex: '0x0',
              removed: n === head - 500, // reorged away
            }));
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const chain = new ViemChain({ httpUrl: 'http://unused', transport });
    const got = await chain.recentLaunches(36_000, 2);
    expect(got.map((l) => l.block)).toEqual(launchAt);
    expect(chain.logChunk.chunk).toBe(1_250);
    expect(ranges.every(([a, b]) => b - a + 1 <= 2_000)).toBe(true);
  });

  it('scanChunks stops halving at the 500-block floor and rethrows other errors untouched', async () => {
    const state = { chunk: 10_000 };
    await expect(scanChunks(0, 100_000, 'asc', async () => { throw new Error('block range too large'); }, () => true, state)).rejects.toThrow(/block range/);
    expect(state.chunk).toBe(MIN_LOG_CHUNK_BLOCKS);
    const st2 = { chunk: 10_000 };
    await expect(scanChunks(0, 100_000, 'asc', async () => { throw new Error('HTTP 429 rate limited'); }, () => true, st2)).rejects.toThrow(/429/);
    expect(st2.chunk).toBe(10_000); // a rate limit is not a range error
  });

  it('the sweep advances its checkpoint after every good chunk: a later failing chunk does not lose the earlier ones', async () => {
    const store = new MemoryStore({ plays: [play(DEPLOYER_PLAY)] });
    store.cursors.set(CURSOR, 0);
    const chain = new FakeChain();
    chain.blockNumber = 10_000;
    chain.snipedChunk = 1_000;
    chain.snipedFailFrom = 6_500; // the RPC fails from the chunk [6001, 7000] on
    const h = harness({ store, chain });
    await h.sniper.start();
    await h.sniper.sweeping;
    expect(store.cursors.get(CURSOR)).toBe(6_000);
    expect(store.events.map((e) => e.type)).toContain('orphan_sweep_failed');
    chain.snipedFailFrom = null;
    await h.sniper.sweepOrphans(); // resumes at 6001
    expect(chain.snipedRanges.at(-1)).toEqual([6_001, 10_000]);
    expect(store.cursors.get(CURSOR)).toBe(10_000);
  });
});

// ----------------------------------------------------------------------------------- R4-8
describe('R4-8: config minimums and the gate budget check', () => {
  it('SETTINGS_RELOAD_MS < 1 s and PLAYS_RELOAD_MS < 5 s are refused (0 was a tight loop)', () => {
    expect(() => loadConfig({ SETTINGS_RELOAD_MS: '0' })).toThrow();
    expect(() => loadConfig({ PLAYS_RELOAD_MS: '1000' })).toThrow();
    expect(() => loadConfig({ SWEEP_INTERVAL_MS: '0' })).toThrow();
    expect(loadConfig({ SETTINGS_RELOAD_MS: '1000', PLAYS_RELOAD_MS: '5000' })).toMatchObject({ SETTINGS_RELOAD_MS: 1000, PLAYS_RELOAD_MS: 5000, SWEEP_INTERVAL_MS: 300_000 });
  });

  it('the budget check ignores a fixed preset above maxQuoteIn (refused at decide time anyway)', async () => {
    const c = new FakeChain();
    c.sniperConfig = { owner: '0x00000000000000000000000000000000000c01d0', factory: PONS_V2.factory as Address, maxQuoteIn: parseEther('0.2'), operators: [true, true], spend: { maxSpend: parseEther('0.15'), window: 3600, level: 0n, updatedAt: 0 } };
    const keys = ['0x00000000000000000000000000000000000e0001', '0x00000000000000000000000000000000000b0001'] as Address[];
    const r = await liveStartupChecks({ chain: c, sniper: SNIPER, keys, estimateFrom: keys[1]!, gasLimit: 300_000, gasCheck: false, maxBuyEth: 0.5, fixedBuysEth: [0.5, 0.1] });
    expect(r.ok).toBe(true); // the 0.5 preset never buys; the largest real buy is 0.1 ≤ 0.15
    expect(r.warnings).toEqual([expect.stringMatching(/refused at decide time/)]);
    const r2 = await liveStartupChecks({ chain: c, sniper: SNIPER, keys, estimateFrom: keys[1]!, gasLimit: 300_000, gasCheck: false, maxBuyEth: 0.18, fixedBuysEth: [0.18] });
    expect(r2.errors).toEqual([expect.stringMatching(/below the largest preset buy 0\.18 ETH/)]);
  });
});
