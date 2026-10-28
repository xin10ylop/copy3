/**
 * Orchestrator-level regression tests for the money-path review (docs/REVIEW.md):
 * H1 spoofed launches, H2 fill after abort, H3 chain reconciliation, M2 crash paths,
 * M3 tax cap, L2 kill switch, L4 paper fill model, L6 startup gas gate, L8 balance pre-checks.
 */
import { EventEmitter } from 'node:events';
import {
  PONS_V2,
  QUOTE_TOKENS,
  SequencerClock,
  decodedTxFromRpc,
  factoryAbi,
  type DecodedTx,
  type FeedBlock,
  type Reserves,
} from '@hood/core';
import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, executorKeys } from '../src/config.js';
import { LaunchDetector } from '../src/detector.js';
import type { ExecutionBackend, ExitOrder, ExitResult, SnipeOrder } from '../src/executor.js';
import { installCrashGuards } from '../src/guards.js';
import { silentLogger } from '../src/log.js';
import { PaperExecutor } from '../src/paper.js';
import { liveStartupChecks } from '../src/preflight.js';
import { killSwitchOn } from '../src/risk.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper } from '../src/sniper.js';
import { MemoryStore, type SnipeRecord } from '../src/store.js';
import type { Fill, SnipeRun } from '../src/types.js';
import { FakeChain } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchBlock, launchFixture, launchReceipt, play, tokenLaunchedLog } from './helpers/fixtures.js';

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

/** Live-mode backend whose fill the test resolves by hand (members "in flight"). */
class ScriptedBackend implements ExecutionBackend {
  readonly mode = 'live' as const;
  orders: SnipeOrder[] = [];
  exits: ExitOrder[] = [];
  resolveFill: ((f: Fill | null) => void) | null = null;
  aborts = 0;
  preflightReasons: string[] = [];
  exitQuoteOut = parseEther('0.05');
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
  preflight(): string[] {
    return this.preflightReasons;
  }
  async exit(o: ExitOrder): Promise<ExitResult> {
    this.exits.push(o);
    return { ok: true, tokensIn: o.tokensIn, quoteOut: this.exitQuoteOut };
  }
}

const refs: Sniper[] = [];
afterEach(async () => {
  for (const s of refs.splice(0)) await s.stop();
});

function harness(o: { mode?: 'live' | 'paper'; preset?: Record<string, unknown>; chain?: FakeChain; store?: MemoryStore; reconcileMs?: number; backend?: ExecutionBackend } = {}) {
  const mode = o.mode ?? 'live';
  const store = o.store ?? new MemoryStore({ plays: [play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4, ...o.preset } })] });
  const chain = o.chain ?? new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  chain.atBlock = () => INITIAL;
  if (!chain.receipts.has(LAUNCH.txHash)) chain.receipts.set(LAUNCH.txHash, launchReceipt());
  const sched = new ManualScheduler((T - 31) * 1000);
  // eslint-disable-next-line prefer-const
  let sniper: Sniper;
  const backend =
    o.backend ?? (mode === 'live' ? new ScriptedBackend() : new PaperExecutor({ chain, logger: silentLogger, book: (c) => sniper.positions.book(c), creatorTaxBps: (c) => sniper.creatorTaxBps(c) }));
  sniper = new Sniper({
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
    fallbackDelayMs: 1,
    reconcileMs: o.reconcileMs ?? 1e9,
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
  /** launch second T up to (and including) the block at index `upTo`; the real launch is block index 2 */
  const launchSecond = (extra: Map<number, DecodedTx[]> = new Map(), upTo = 3, withLaunch = true): void => {
    for (let k = 0; k <= upTo; k++) {
      const at = T * 1000 + OFFSET + k * 100;
      const n = LAUNCH.block - 2 + k;
      feed(withLaunch && n === LAUNCH.block ? launchBlock(at, extra.get(k) ?? []) : emptyBlock(n, T, at, extra.get(k) ?? []));
    }
  };
  return { store, chain, sched, sniper, backend, feed, warm, launchSecond, scripted: backend instanceof ScriptedBackend ? backend : null };
}

const spoofParams = {
  name: 'SHIBA INU',
  symbol: 'SHIB',
  logo: '',
  description: '',
  socials: { x: '', telegram: '', website: '', discord: '', farcaster: '' },
  creatorFeeRecipient: ATTACKER,
  creatorTaxBps: 0,
  buybackEnabled: false,
  salt1: `0x${'00'.repeat(32)}`,
  salt2: `0x${'00'.repeat(32)}`,
} as const;
const spoofTx = (to: string, hashByte: string): DecodedTx =>
  decodedTxFromRpc({
    ...launchFixture.tx,
    hash: `0x${hashByte.repeat(32)}`,
    from: ATTACKER,
    to: to as Address,
    value: 0n,
    input: encodeFunctionData({ abi: factoryAbi, functionName: 'launchTokenFor', args: [spoofParams, 0n, QUOTE_TOKENS.eth, LAUNCH.deployer, []] }),
  });
const exemptSell = (hashByte: string): DecodedTx =>
  decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${hashByte.repeat(32)}`, from: LAUNCH.creatorFeeRecipient, to: LAUNCH.curve, value: 0n, input: `0xd04c6983${'0'.repeat(63)}1${'0'.repeat(128)}` });

describe('H1: spoofed launches never sign and never burn play state', () => {
  it('a spoof to the attacker contract is ignored; a reverted launchTokenFor to the factory is rejected by its receipt; the real launch still fires', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    // (a) launch calldata to the attacker's own contract: not even a decision
    h.feed(emptyBlock(LAUNCH.block - 2, T, T * 1000 + OFFSET, [spoofTx(ATTACKER, 'a7')]));
    await sleep(5);
    expect(h.sniper.counters.decisions).toBe(0);
    // (b) launchTokenFor (deployer = the followed wallet) to the factory from a non-whitelisted
    //     sender: the sequencer includes it, the factory reverts it
    const spoof = spoofTx(PONS_V2.factory, 'b8');
    h.chain.receipts.set(spoof.hash, launchReceipt({ transactionHash: spoof.hash, status: 'reverted', blockNumber: LAUNCH.block - 1, logs: [] }));
    h.feed(emptyBlock(LAUNCH.block - 1, T, T * 1000 + OFFSET + 100, [spoof]));
    await waitFor(() => h.sniper.counters.spoof_rejected === 1);
    expect(h.sniper.counters.decisions).toBe(1);
    expect(h.scripted!.orders).toHaveLength(0); // nothing signed
    expect(h.sniper.risk.open).toBe(0);
    expect(h.sniper.risk.playCount(9)).toBe(0);
    expect(h.sniper.risk.hasPlayedDeployer(9, LAUNCH.deployer)).toBe(false); // firstBuyOnly not burned
    await h.sniper.recorder.idle();
    const spoofRow = [...h.store.snipes.values()][0]!;
    expect(spoofRow.status).toBe('aborted');
    expect(spoofRow.notes).toMatch(/launch rejected: launch tx .* reverted/);
    expect(h.store.events.map((e) => e.type)).toContain('launch_rejected');
    // (c) the real launch by the same deployer, one block later: confirmed → signed
    h.feed(launchBlock(T * 1000 + OFFSET + 200));
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    expect(run.confirmed).toBe(true);
    expect(run.launch.event.exemptions.sort()).toEqual([LAUNCH.deployer, LAUNCH.creatorFeeRecipient].sort()); // from the receipt
    expect(h.sniper.risk.playCount(9)).toBe(1);
    expect(h.sniper.risk.hasPlayedDeployer(9, LAUNCH.deployer)).toBe(true);
    h.scripted!.resolveFill!(null);
    await waitFor(() => run.status === 'failed');
    expect(h.sniper.risk.playCount(9)).toBe(0); // confirmed but never filled: un-counted for stopAfter …
    expect(h.sniper.risk.hasPlayedDeployer(9, LAUNCH.deployer)).toBe(true); // … but the deployer's launch was played
  });

  it('a receipt whose TokenLaunched names another deployer is refused before signing', async () => {
    const chain = new FakeChain();
    const other = { ...tokenLaunchedLog, topics: [...tokenLaunchedLog.topics.slice(0, 3), `0x${'0'.repeat(24)}${'be'.repeat(20)}`] };
    chain.receipts.set(LAUNCH.txHash, launchReceipt({ logs: [other] }));
    const h = harness({ chain });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.sniper.counters.spoof_rejected === 1);
    expect(h.scripted!.orders).toHaveLength(0);
    expect(h.sniper.activeRuns).toHaveLength(0);
  });
});

describe('H2: a fill after an "exempt wallet sold" abort', () => {
  it('opens a position, exits immediately (exempt_dump) and the loss counts toward the daily limit', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    h.feed(emptyBlock(LAUNCH.block + 2, T, T * 1000 + OFFSET + 400, [exemptSell('ab')]));
    await waitFor(() => run.status === 'aborted');
    expect(h.scripted!.aborts).toBe(1);
    expect(h.sniper.risk.open).toBe(1); // members in flight: the slot is still held
    // one member that was already sent lands in the first +1 s block and buys
    h.scripted!.resolveFill!({ block: LAUNCH.block + 8, ts: T + 1, quoteIn: parseEther('0.07'), tokensOut: 4n * 10n ** 25n, taxBps: 618, taxPaid: 0n, entryPrice: 1.75e-9, txHash: `0x${'f1'.repeat(32)}` as Hex });
    await waitFor(() => run.status === 'closed');
    expect(h.scripted!.exits).toHaveLength(1);
    expect(h.scripted!.exits[0]).toMatchObject({ reason: 'exempt_dump', all: true, tokensIn: 4n * 10n ** 25n });
    expect(h.sniper.counters.fills_after_abort).toBe(1);
    expect(h.sniper.risk.realizedToday).toBeCloseTo(-0.02, 9); // 0.05 back on 0.07
    expect(h.sniper.risk.open).toBe(0);
    await h.sniper.recorder.idle();
    const row = [...h.store.snipes.values()][0]!;
    expect(row).toMatchObject({ status: 'closed', buyBlock: LAUNCH.block + 8 });
    expect(row.realizedPnlEth).toBeCloseTo(-0.02, 9);
    expect(h.store.events.map((e) => e.type)).toContain('fill_after_abort');
  });
});

describe('H3: chain reconciliation', () => {
  it('a "no fill" while the contract holds the token (receipts missed) is recovered from bought()/balanceOf()', async () => {
    const h = harness();
    h.chain.receiptFails = false;
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    h.chain.holdings.set(LAUNCH.token, { bought: true, balance: 39_600_000n * 10n ** 18n });
    h.scripted!.resolveFill!(null);
    await waitFor(() => run.status === 'open');
    expect(run.fill).toMatchObject({ recovered: true, tokensOut: 39_600_000n * 10n ** 18n, quoteIn: parseEther('0.07') });
    expect(h.sniper.positions.get(run.key)!.state.tokensHeld).toBe(39_600_000n * 10n ** 18n);
    expect(h.sniper.counters.fills_recovered).toBe(1);
    expect(h.store.events.map((e) => e.type)).toContain('fill_recovered_from_chain');
  });

  it('when the chain cannot be read the run stays unresolved (slot held) and is settled by the reconcile timer', async () => {
    const h = harness({ reconcileMs: 30 });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    h.chain.readSniperFails = true;
    h.scripted!.resolveFill!(null);
    await waitFor(() => h.store.events.some((e) => e.type === 'snipe_unresolved'), 4000);
    expect(run.status).toBe('pending');
    expect(h.sniper.risk.open).toBe(1);
    h.chain.readSniperFails = false; // chain says: never bought
    await waitFor(() => run.status === 'failed', 4000);
    expect(h.sniper.risk.open).toBe(0);
  });

  it('startup: rebuilds positions from chain state, closes / fails stale rows of THIS mode only, and alerts', async () => {
    const store = new MemoryStore({ plays: [play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] } })] });
    const tok = (n: number): Address => `0x${String(n).repeat(40)}` as Address;
    const decision = {
      play: { id: 9, name: 'p' },
      reasons: ['deployerIn'],
      preset: { buyEth: 0.07, timeoutSec: 600 },
      confirmed: true,
      launch: { event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [LAUNCH.deployer], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 100, devBuyQuoteIn: '0', pairToken: QUOTE_TOKENS.eth, launchConfigId: '0' }, block: 10, ts: T, txHash: `0x${'12'.repeat(32)}` },
    };
    const row = (o: Partial<SnipeRecord>): SnipeRecord => ({ playId: 9, token: '', curve: '', decidedAt: new Date(), decision, mode: 'live', burst: [], status: 'pending', sells: [], quoteIn: parseEther('0.07'), ...o });
    const open = await store.insertSnipe(row({ token: tok(1), curve: tok(2), status: 'open', tokensOut: 5n * 10n ** 25n, entryPrice: 1.4e-9, buyBlock: 11, sells: [{ reason: 'tp1', tokensIn: '10000000000000000000000000', quoteOut: '50000000000000000', at: 1 }] }));
    const crashed = await store.insertSnipe(row({ token: tok(3), curve: tok(4), status: 'pending' })); // crashed mid-burst, bought
    const noToken = await store.insertSnipe(row({ status: 'pending' }));
    const neverBought = await store.insertSnipe(row({ token: tok(5), curve: tok(6), status: 'pending' }));
    const swept = await store.insertSnipe(row({ token: tok(7), curve: tok(8), status: 'open', tokensOut: 10n ** 25n }));
    const paperRow = await store.insertSnipe(row({ token: tok(9), curve: tok(1), status: 'pending', mode: 'paper' }));
    const chain = new FakeChain();
    chain.holdings.set(tok(1), { bought: true, balance: 4n * 10n ** 25n });
    chain.holdings.set(tok(3), { bought: true, balance: 3n * 10n ** 25n });
    chain.holdings.set(tok(7), { bought: true, balance: 0n });
    const h = harness({ store, chain });
    const rowsBefore = store.snipes.size;
    await h.sniper.start();
    await h.sniper.recorder.idle();
    expect(h.sniper.positions.open.map((p) => [p.token, p.state.tokensHeld])).toEqual([
      [tok(1), 4n * 10n ** 25n],
      [tok(3), 3n * 10n ** 25n],
    ]);
    const p1 = h.sniper.positions.open[0]!;
    expect(p1.realizedQuote).toBe(5n * 10n ** 16n); // recorded sale kept
    expect(p1.state.tpHit).toBe(1);
    expect(h.sniper.risk.open).toBe(2); // the stale paper row is not counted (mode filter)
    expect(store.snipes.size).toBe(rowsBefore); // rebuilt runs update their rows, never insert
    expect(store.snipes.get(open)!.status).toBe('open');
    expect(store.snipes.get(crashed)!.status).toBe('open');
    expect(store.snipes.get(noToken)!.status).toBe('failed');
    expect(store.snipes.get(neverBought)!).toMatchObject({ status: 'failed', notes: expect.stringMatching(/bought=false/) });
    expect(store.snipes.get(swept)!).toMatchObject({ status: 'closed', notes: expect.stringMatching(/balance 0/) });
    expect(store.snipes.get(paperRow)!.status).toBe('pending');
    const types = store.events.map((e) => e.type);
    expect(types.filter((t) => t === 'position_rebuilt')).toHaveLength(2);
    expect(types.filter((t) => t === 'stale_snipe_failed')).toHaveLength(2);
    expect(types).toContain('position_closed_externally');
    // rebuilt positions are managed: the exit uses the chain balance
    h.sniper.positions.forceExit(p1.key, 'timeout');
    await waitFor(() => h.scripted!.exits.length === 1);
    expect(h.scripted!.exits[0]).toMatchObject({ token: tok(1), tokensIn: 4n * 10n ** 25n, all: true });
  });
});

describe('M2: crash paths', () => {
  it('PoC4: the fallback path survives an RPC 429 (no unhandled rejection)', async () => {
    class FlakyChain extends FakeChain {
      override async getBlockTimestamp(): Promise<number> {
        throw new Error('HTTP 429 rate limited');
      }
    }
    const chain = new FlakyChain();
    chain.txs.set(LAUNCH.txHash, launchFixture.tx);
    const h = harness({ chain, mode: 'paper' });
    await h.sniper.start();
    h.chain.launchWatcher!(tokenLaunchedLog); // the feed never showed this launch
    await waitFor(() => (h.sniper.counters.errors ?? 0) >= 1);
    expect(h.sniper.lastError).toMatch(/fallback launch .* failed/);
  });

  it('a feed tx with an unrecoverable signature in the launch second does not crash the dump check', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const good = exemptSell('cd');
    const bad: DecodedTx = {
      index: 0,
      hash: good.hash,
      type: good.type,
      chainId: good.chainId,
      to: good.to,
      value: 0n,
      nonce: 0,
      gas: 0n,
      gasPrice: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      input: good.input,
      selector: good.selector,
      raw: '0x',
      from: undefined,
      recoverFrom: () => Promise.reject(new Error('invalid signature')),
    };
    h.feed(emptyBlock(LAUNCH.block + 2, T, T * 1000 + OFFSET + 400, [bad]));
    await sleep(10);
    expect(h.scripted!.orders[0]!.run.status).toBe('pending');
  });

  it('process-level guards log unhandled rejections / exceptions and keep the process alive', () => {
    const proc = new EventEmitter();
    const seen: string[] = [];
    const off = installCrashGuards(silentLogger, (kind) => seen.push(kind), proc as unknown as Parameters<typeof installCrashGuards>[2]);
    proc.emit('unhandledRejection', new Error('429'));
    proc.emit('uncaughtException', new Error('boom'), 'uncaughtException');
    expect(seen).toEqual(['unhandledRejection', 'uncaughtException']);
    off();
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
  });
});

describe('M3: tax cap', () => {
  it('a preset that bypassed zod with maxTaxBps 9900 is clamped to 5000 in the run (the contract refuses ≥ 9900 anyway)', async () => {
    const pl = play({ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4 } });
    pl.preset = { ...pl.preset, maxTaxBps: 9900 };
    const h = harness({ store: new MemoryStore({ plays: [pl] }) });
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    expect(run.maxTaxBps).toBe(5000);
    expect(run.notes.join()).toMatch(/maxTaxBps 9900 clamped to 5000/);
    expect(run.minTokensOut).toBeGreaterThan(0n);
    h.scripted!.resolveFill!(null);
  });
});

describe('L2: kill switch', () => {
  it('accepts every value shape the telegram bot writes', () => {
    for (const v of [true, 'on', 'true', 1, { on: true }, { enabled: true }, { killed: true, reason: 'x', by: 'tg' }]) expect(killSwitchOn(v)).toBe(true);
    for (const v of [false, 'off', 'false', 0, null, undefined, {}, { killed: false }, { on: false }]) expect(killSwitchOn(v)).toBe(false);
  });

  it('a kill switch set after the decision blocks the burst at its first send (live guard)', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.scripted!.orders.length === 1);
    const guard = h.scripted!.orders[0]!.guard!;
    expect(guard()).toBeNull();
    h.store.settings.kill_switch = { killed: true, by: 'telegram' };
    h.store.emitChange('settings_changed');
    await waitFor(() => guard() !== null);
    expect(guard()).toMatch(/kill switch on/);
    h.scripted!.resolveFill!(null);
  });

  it('paper: the same last-moment check blocks the simulated fill', async () => {
    const h = harness({ mode: 'paper' });
    await h.sniper.start();
    h.warm();
    h.launchSecond(new Map(), 9);
    await waitFor(() => h.sniper.activeRuns[0]?.plan !== undefined);
    const run = h.sniper.activeRuns[0]!;
    h.store.settings.kill_switch = 'on';
    h.store.emitChange('settings_changed');
    await sleep(5);
    for (let k = 0; k < 3; k++) h.feed(emptyBlock(LAUNCH.block + 8 + k, T + 1, (T + 1) * 1000 + OFFSET + k * 100));
    await waitFor(() => run.status !== 'pending');
    expect(run.status).toBe('failed');
    expect(run.notes.join()).toMatch(/send blocked before the first member: kill switch on/);
    expect(run.fill).toBeUndefined();
  });
});

describe('L8: balance pre-checks', () => {
  it('a failed preflight aborts before signing and raises a low_balance alert', async () => {
    const h = harness();
    h.scripted!.preflightReasons = ['contract balance 0.01 ETH < quoteIn 0.07 ETH'];
    await h.sniper.start();
    h.warm();
    h.launchSecond();
    await waitFor(() => h.sniper.counters.aborted === 1);
    expect(h.scripted!.orders).toHaveLength(0);
    expect(h.store.events.find((e) => e.type === 'low_balance')).toMatchObject({ level: 'error' });
    expect(h.sniper.risk.open).toBe(0);
  });
});

describe('L4: paper fill model', () => {
  it('PAPER_FILL=first fills at the state before the +1 s block, =last after every buy of that block', async () => {
    const before: Reserves = INITIAL;
    const after: Reserves = { quote: INITIAL.quote + parseEther('0.5'), token: (INITIAL.token * 1680n) / 2180n };
    const fills: Record<string, Fill | null> = {};
    for (const mode of ['first', 'last'] as const) {
      const chain = new FakeChain();
      chain.atBlock = (_c, b) => (b >= LAUNCH.block + 8 ? after : before);
      const px = new PaperExecutor({ chain, logger: silentLogger, creatorTaxBps: () => 0, fill: mode });
      const p = play({ id: 1, trigger: { deployerIn: [LAUNCH.deployer] } });
      const run: SnipeRun = {
        id: 0, key: mode, mode: 'paper', playId: 1,
        launch: { event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 0, devBuyQuoteIn: 0n, pairToken: QUOTE_TOKENS.eth, launchConfigId: 0n }, block: LAUNCH.block, ts: T, receivedAt: 0, txHash: LAUNCH.txHash, token: LAUNCH.token, curve: LAUNCH.curve, source: 'feed' },
        decision: { play: p, preset: p.preset, reasons: [] }, status: 'pending', decidedAt: 0, quoteIn: parseEther('0.07'), minTokensOut: 0n, maxTaxBps: 1000, deadlineBlock: LAUNCH.block + 40, burst: [], notes: [],
      };
      const fp = px.execute({ run, token: LAUNCH.token, curve: LAUNCH.curve, times: [0], gasLimit: 300_000, maxFeeGwei: 1, priorityFeeGwei: 0 });
      px.onFeedBlock(emptyBlock(LAUNCH.block + 8, T + 1, 0));
      fills[mode] = await fp;
    }
    expect(fills.first!.reservesBlock).toBe(LAUNCH.block + 7);
    expect(fills.last!.reservesBlock).toBe(LAUNCH.block + 8);
    expect(fills.first!.reserves).toEqual(before);
    expect(fills.last!.reserves).toEqual(after);
    expect(fills.last!.tokensOut).toBeLessThan(fills.first!.tokensOut); // the pessimistic side of the bracket
    expect(loadConfig({ PAPER_FILL: 'last' }).PAPER_FILL).toBe('last');
    expect(loadConfig({}).PAPER_FILL).toBe('first');
  });
});

describe('L6 / live-mode gate: startup checks', () => {
  const EXIT_KEY = '0x00000000000000000000000000000000000e0001' as Address;
  const BURST_KEY = '0x00000000000000000000000000000000000b0001' as Address;
  const COLD = '0x00000000000000000000000000000000000c01d0' as Address;
  const mk = (over: Partial<NonNullable<FakeChain['sniperConfig']>> = {}): FakeChain => {
    const c = new FakeChain();
    c.recent = { token: LAUNCH.token, curve: LAUNCH.curve };
    c.blockNumber = 100_300_000;
    c.sniperConfig = { owner: COLD, factory: PONS_V2.factory as Address, maxQuoteIn: parseEther('0.2'), operators: [true, true], ...over };
    return c;
  };
  const run = (chain: FakeChain, o: { gasLimit?: number; allowHotOwner?: boolean; gasCheck?: boolean; maxBuyEth?: number } = {}) =>
    liveStartupChecks({ chain, sniper: SNIPER, keys: [EXIT_KEY, BURST_KEY], estimateFrom: BURST_KEY, gasLimit: o.gasLimit ?? 300_000, ...o });

  it('passes with a cold owner, operator keys and an estimate under the limit', async () => {
    const r = await run(mk());
    expect(r).toMatchObject({ ok: true, errors: [], gasEstimate: 180_000n });
  });

  it('refuses to start when snipe() needs more gas than the preset limit, or cannot be estimated', async () => {
    const c = mk();
    c.estimate = 320_000n;
    expect((await run(c)).errors).toEqual([expect.stringMatching(/L6: snipe\(\) estimate 320000 gas > preset gas limit 300000/)]);
    c.estimate = new Error('execution reverted: AlreadyBought()');
    expect((await run(c)).errors).toEqual([expect.stringMatching(/L6: eth_estimateGas of snipe\(\) failed/)]);
    c.recent = null;
    expect((await run(c)).errors).toEqual([expect.stringMatching(/no TokenLaunched/)]);
    expect((await run(c, { gasCheck: false })).ok).toBe(true);
    c.estimate = 250_000n;
    c.recent = { token: LAUNCH.token, curve: LAUNCH.curve };
    const near = await run(c);
    expect(near.ok).toBe(true);
    expect(near.warnings).toEqual([expect.stringMatching(/within 20 %/)]);
  });

  it('refuses a hot owner (M4), a non-operator key and a foreign factory', async () => {
    expect((await run(mk({ owner: EXIT_KEY }))).errors).toEqual([expect.stringMatching(/owner .* is a hot executor key/)]);
    expect((await run(mk({ owner: EXIT_KEY }), { allowHotOwner: true })).ok).toBe(true);
    expect((await run(mk({ operators: [true, false] }))).errors).toEqual([expect.stringMatching(/0x00000000000000000000000000000000000b0001 is not an operator/)]);
    expect((await run(mk({ factory: ATTACKER }))).errors).toEqual([expect.stringMatching(/factory/)]);
    expect((await run(mk(), { maxBuyEth: 0.5 })).warnings).toEqual([expect.stringMatching(/QuoteTooLarge/)]);
  });

  it('config: EXECUTOR_PRIVATE_KEYS (first = exit key), legacy single key, duplicates refused', () => {
    const k = (n: number): string => `0x${String(n).repeat(64)}`;
    const base = { EXECUTION_MODE: 'live', SNIPER_CONTRACT: SNIPER, DATABASE_URL: 'postgres://x', SEND_ENDPOINTS: 'http://a' };
    expect(executorKeys(loadConfig({ ...base, EXECUTOR_PRIVATE_KEYS: `${k(1)}, ${k(2)},${k(3)}` }))).toEqual([k(1), k(2), k(3)]);
    expect(executorKeys(loadConfig({ ...base, EXECUTOR_PRIVATE_KEY: k(4) }))).toEqual([k(4)]);
    expect(() => loadConfig({ ...base, EXECUTOR_PRIVATE_KEYS: `${k(1)},${k(1)}` })).toThrow(/duplicate/);
    expect(() => loadConfig({ ...base, EXECUTOR_PRIVATE_KEYS: '0x12' })).toThrow(/EXECUTOR_PRIVATE_KEYS/);
    expect(() => loadConfig({ LAUNCHERS: 'nope' })).toThrow(/not an address/);
  });
});
