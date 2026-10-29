/**
 * Race measurement: EXECUTION_MODE=probe (paper fills + one real 0-value self-transfer at the
 * burst's first slot) and the same record on live buys / lost live bursts. Paper e2e harness:
 * FakeChain + ManualScheduler on the SHIBA launch fixture (launch = 3rd block of second T, first
 * T+1 block = LAUNCH.block + 8).
 */
import { CHAIN_ID, SequencerClock, type FeedBlock, type Reserves } from '@hood/core';
import { parseEther, parseGwei, parseTransaction, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LaunchDetector } from '../src/detector.js';
import type { ExecutionBackend, ExitOrder, ExitResult, SnipeOrder } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { PaperExecutor } from '../src/paper.js';
import { probeStartupChecks } from '../src/preflight.js';
import { ProbeExecutor } from '../src/probe.js';
import { RaceTracker } from '../src/race.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper } from '../src/sniper.js';
import { MemoryStore } from '../src/store.js';
import type { BurstMember, Fill } from '../src/types.js';
import { FakeChain, FakeSender } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchBlock, launchReceipt, play } from './helpers/fixtures.js';

const T = LAUNCH.ts;
const OFFSET = 45;
const RTT = 6;
const INITIAL: Reserves = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n };
/** a throwaway test key (never funded anywhere) */
const PROBE_KEY = `0x${'11'.repeat(32)}` as Hex;
const PROBE_ADDR = privateKeyToAccount(PROBE_KEY).address.toLowerCase() as Address;
const TARGET = LAUNCH.block + 8; // first block of second T+1
const SLOT = (T + 1) * 1000 + OFFSET - RTT - 120; // boundary − rtt − 120 ms = T·1000 + 919 (inside second T)
const PRESET = { buyEth: 0.07, maxEntryMcapEth: 4, slippageBps: 9000 };

const refs: Sniper[] = [];
afterEach(async () => {
  for (const s of refs.splice(0)) await s.stop();
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** live: fills are scripted by the test (members + receipts on the FakeChain) */
class ScriptedBackend implements ExecutionBackend {
  readonly mode = 'live' as const;
  orders: SnipeOrder[] = [];
  resolveFill: ((f: Fill | null) => void) | null = null;
  execute(o: SnipeOrder): Promise<Fill | null> {
    this.orders.push(o);
    return new Promise((r) => (this.resolveFill = r));
  }
  abort(): number {
    return 0;
  }
  onFeedBlock(): void {}
  async exit(o: ExitOrder): Promise<ExitResult> {
    return { ok: true, tokensIn: o.tokensIn, quoteOut: 0n };
  }
}

function harness(mode: 'probe' | 'live') {
  const store = new MemoryStore({ plays: [play({ id: 9, name: 'shib-dev', trigger: { deployerIn: [LAUNCH.deployer] }, preset: PRESET })] });
  const chain = new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  chain.atBlock = () => INITIAL;
  chain.receipts.set(LAUNCH.txHash, launchReceipt());
  const sched = new ManualScheduler((T - 31) * 1000);
  const race = new RaceTracker({ chain, logger: silentLogger, feedWaitMs: 2000 });
  const sender = new FakeSender('http://seq', () => sched.now());
  // eslint-disable-next-line prefer-const
  let sniper: Sniper;
  const probed: string[] = [];
  let probe: ProbeExecutor | null = null;
  let scripted: ScriptedBackend | null = null;
  let backend: ExecutionBackend;
  if (mode === 'probe') {
    const paper = new PaperExecutor({ chain, logger: silentLogger, book: (c) => sniper.positions.book(c), creatorTaxBps: (c) => sniper.creatorTaxBps(c) });
    probe = new ProbeExecutor({
      paper,
      accounts: [privateKeyToAccount(PROBE_KEY)],
      chainId: CHAIN_ID,
      senders: [sender],
      chain,
      scheduler: sched,
      logger: silentLogger,
      race,
      receiptPollMs: 1,
      onProbe: (run) => {
        probed.push(run.race!.status);
        sniper.recorder.update(run, sniper.positions.get(run.key), 'probe_final');
      },
    });
    backend = probe;
  } else backend = scripted = new ScriptedBackend();
  sniper = new Sniper({
    mode: mode === 'live' ? 'live' : 'paper',
    race,
    store,
    chain,
    backend,
    clock: new SequencerClock(),
    scheduler: sched,
    logger: silentLogger,
    detector: new LaunchDetector(),
    rttMs: () => RTT,
    reservesPollMs: 1e9,
    gasPollMs: 1e9,
    receiptPollMs: 1,
    reconcileMs: 1e9,
    ...(mode === 'live' ? { sniperContract: '0x5151515151515151515151515151515151515151' as Address } : {}),
  });
  refs.push(sniper);
  const feed = (b: FeedBlock): void => {
    sched.advance(b.receivedAt);
    sniper.onFeedBlock(b);
  };
  const second = (ts: number, firstBlock: number, launchAt = -1, from = 0, to = 10): void => {
    for (let k = from; k < to; k++) {
      const at = ts * 1000 + OFFSET + k * 100;
      feed(firstBlock + k === LAUNCH.block && k === launchAt ? launchBlock(at) : emptyBlock(firstBlock + k, ts, at));
    }
  };
  /** warm the clock, then the launch second up to the launch block; resolves once the burst is planned */
  const toPlan = async (): Promise<void> => {
    await sniper.start();
    for (let s = 30; s >= 1; s--) second(T - s, LAUNCH.block - 2 - s * 10);
    second(T, LAUNCH.block - 2, 2, 0, 3);
    await waitFor(() => sniper.activeRuns[0]?.plan !== undefined && (mode === 'live' ? scripted!.orders.length === 1 : true));
  };
  /** the rest of second T: the first slot (boundary − rtt − 120 ms = T + 919 ms) passes in it */
  const restOfSecond = (): void => second(T, LAUNCH.block - 2, 2, 3, 10);
  const upToBurst = async (): Promise<void> => {
    await toPlan();
    restOfSecond();
  };
  return { store, chain, sched, sniper, probe, scripted: scripted!, sender, race, feed, second, toPlan, restOfSecond, upToBurst, probed };
}

const buy = (block: number, txIndex: number): { block: number; txIndex: number; logIndex: number; txHash: Hex } => ({ block, txIndex, logIndex: 0, txHash: `0x${String(txIndex).padStart(64, '0')}` as Hex });

describe('EXECUTION_MODE=probe: paper fills + one real self-transfer per planned burst', () => {
  it('sends the probe at the first burst slot; mined in the first T+1 block at index 2 behind 1 buy → offset 0, buysAhead 1; paper fill still happens', async () => {
    const h = harness('probe');
    await h.probe!.init();
    await h.toPlan();
    const run = h.sniper.activeRuns[0]!;
    expect(run.burst).toHaveLength(10);
    expect(run.burst.every((m) => m.status === 'skipped')).toBe(true); // the paper burst is untouched
    await waitFor(() => h.sched.pending > 0 && run.race?.hash !== undefined); // pre-signed, scheduled
    expect(run.race).toMatchObject({ source: 'probe', status: 'planned', key: PROBE_ADDR, nonce: 0 });
    h.chain.receipts.set(run.race!.hash!.toLowerCase(), { transactionHash: run.race!.hash!, status: 'success', blockNumber: TARGET, gasUsed: 21_000n, logs: [], transactionIndex: 2 });
    h.chain.curveBuys.set(LAUNCH.curve, [buy(TARGET, 1), buy(TARGET, 7), buy(TARGET + 1, 0)]);
    expect(h.sender.sent).toHaveLength(0);
    h.restOfSecond();
    expect(h.sender.sent).toHaveLength(1);
    expect(h.sender.sent[0]!.at).toBeCloseTo(SLOT, 6);
    // a plain 0-value self-transfer, 21k gas: never a contract call
    const tx = parseTransaction(h.sender.sent[0]!.raw);
    expect(tx.to?.toLowerCase()).toBe(PROBE_ADDR);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.gas).toBe(21_000n);
    expect(tx.maxFeePerGas! <= parseGwei('1')).toBe(true); // the live gas settings: clamped to MAX_GAS_PRICE_GWEI
    expect(tx.chainId).toBe(CHAIN_ID);
    expect(tx.data ?? '0x').toBe('0x');
    h.second(T + 1, TARGET);
    await waitFor(() => run.race?.status === 'mined' && run.status === 'open');
    expect(run.fill).toMatchObject({ block: TARGET, ts: T + 1, taxBps: 618 }); // the paper fill, as in paper mode
    expect(run.race).toMatchObject({
      block: TARGET,
      targetBlock: TARGET,
      blockOffset: 0,
      txIndex: 2,
      buysAhead: 1,
      buysAfter: 1,
      buysInBlock: 2,
      sendVsBoundaryMs: -126,
      landedArrivalMs: (T + 1) * 1000 + OFFSET,
      landedArrivalVsBoundaryMs: 0,
    });
    expect(h.race.counters).toMatchObject({ race_planned: 1, race_sent: 1, race_mined: 1, race_target_block: 1, race_first_in_block: 0, race_early: 0, race_late: 0 });
    const health = h.sniper.health({ blocks: 0 } as never);
    expect(health.mode).toBe('probe');
    expect(health.counters).toMatchObject({ race_sent: 1, race_mined: 1, race_target_block: 1 });
    expect(run.notes.join()).toMatch(/probe: block \+0 vs the first T\+1 block \d+, txIndex 2, 1 buy\(s\) ahead, 1 after, 2 buy\(s\) in the T\+1 block, sent -126 ms vs boundary/);
    await h.sniper.recorder.idle();
    await new Promise((r) => setTimeout(r, 5));
    const rec = [...h.store.snipes.values()][0]!;
    expect(rec.mode).toBe('paper');
    expect((rec.decision as { race: unknown }).race).toMatchObject({ source: 'probe', blockOffset: 0, txIndex: 2, buysAhead: 1 });
  });

  it('mined one block late → race_late; first in its block does not count as a win', async () => {
    const h = harness('probe');
    await h.probe!.init();
    await h.toPlan();
    const run = h.sniper.activeRuns[0]!;
    await waitFor(() => h.sched.pending > 0 && run.race?.hash !== undefined);
    h.chain.receipts.set(run.race!.hash!.toLowerCase(), { transactionHash: run.race!.hash!, status: 'success', blockNumber: TARGET + 1, gasUsed: 21_000n, logs: [], transactionIndex: 0 });
    h.chain.curveBuys.set(LAUNCH.curve, [buy(TARGET, 1), buy(TARGET, 2)]);
    h.restOfSecond();
    h.second(T + 1, TARGET);
    await waitFor(() => run.race?.status === 'mined');
    expect(run.race).toMatchObject({ blockOffset: 1, txIndex: 0, buysAhead: 0, buysAfter: 0, buysInBlock: 2 });
    expect(h.race.counters).toMatchObject({ race_sent: 1, race_mined: 1, race_late: 1, race_target_block: 0, race_first_in_block: 0, race_early: 0 });
  });

  it('kill switch on at the slot → no probe sent (blocked), and the paper run is refused too', async () => {
    const h = harness('probe');
    await h.probe!.init();
    await h.toPlan();
    const run = h.sniper.activeRuns[0]!;
    await waitFor(() => h.sched.pending > 0 && run.race?.hash !== undefined);
    h.sniper.risk.setSettings({ kill_switch: { on: true } });
    h.restOfSecond();
    await waitFor(() => run.race?.status === 'blocked');
    expect(h.sender.sent).toHaveLength(0);
    expect(h.race.counters).toMatchObject({ race_sent: 0, race_skipped: 1 });
    h.second(T + 1, TARGET);
    await waitFor(() => run.status !== 'pending');
    expect(run.fill).toBeUndefined();
    expect(run.notes.join()).toMatch(/kill switch/i);
  });
});

describe('race measurement on live bursts', () => {
  const member = (i: number, hash: Hex, status: BurstMember['status']): BurstMember => ({ index: i, nonce: i, hash, raw: '0x', scheduledAt: SLOT + i * 15, sentAt: SLOT + i * 15, sends: [], status });

  it('the buy (member 1) is measured from its receipt: first in the T+1 block', async () => {
    const h = harness('live');
    await h.upToBurst();
    const order = h.scripted.orders[0]!;
    const run = order.run;
    const BUY = `0x${'b1'.repeat(32)}` as Hex;
    run.burst = [member(0, `0x${'a0'.repeat(32)}` as Hex, 'reverted'), member(1, BUY, 'mined')];
    h.chain.receipts.set(BUY, { transactionHash: BUY, status: 'success', blockNumber: TARGET, gasUsed: 150_000n, logs: [], transactionIndex: 0 });
    h.chain.curveBuys.set(LAUNCH.curve, [buy(TARGET, 0), buy(TARGET, 3)]); // ours + one after
    h.second(T + 1, TARGET);
    h.scripted.resolveFill!({ block: TARGET, ts: T + 1, quoteIn: parseEther('0.07'), tokensOut: 10n ** 25n, taxBps: 618, taxPaid: 0n, entryPrice: 1e-8, txHash: BUY });
    await waitFor(() => run.race !== undefined);
    expect(run.race).toMatchObject({ source: 'live', status: 'mined', member: 1, bought: true, blockOffset: 0, txIndex: 0, buysAhead: 0, buysAfter: 1, buysInBlock: 2, sendVsBoundaryMs: -111 });
    expect(h.race.counters).toMatchObject({ race_sent: 1, race_mined: 1, race_target_block: 1, race_first_in_block: 1 });
    expect(run.notes.join()).toMatch(/race \(member 1, the buy\): block \+0/);
  });

  it('no member bought: the first landed member tells where it landed and why it reverted (early → TaxTooHigh)', async () => {
    const h = harness('live');
    await h.upToBurst();
    const run = h.scripted.orders[0]!.run;
    const M0 = `0x${'c0'.repeat(32)}` as Hex;
    run.burst = [member(0, M0, 'reverted'), member(1, `0x${'c1'.repeat(32)}` as Hex, 'reverted')];
    h.chain.receipts.set(M0, { transactionHash: M0, status: 'reverted', blockNumber: TARGET - 1, gasUsed: 50_000n, logs: [], transactionIndex: 4 });
    h.chain.revertReasons.set(M0, 'TaxTooHigh(9900, 1000)');
    h.chain.curveBuys.set(LAUNCH.curve, [buy(TARGET - 1, 1), buy(TARGET, 0), buy(TARGET, 1), buy(TARGET, 2)]);
    h.second(T + 1, TARGET);
    h.scripted.resolveFill!(null);
    await waitFor(() => run.race !== undefined);
    expect(run.race).toMatchObject({ source: 'live', status: 'reverted', member: 0, bought: false, blockOffset: -1, txIndex: 4, buysAhead: 1, buysAfter: 0, buysInBlock: 3, revertReason: 'TaxTooHigh(9900, 1000)' });
    expect(h.race.counters).toMatchObject({ race_sent: 1, race_reverted: 1, race_early: 1, race_target_block: 0 });
  });
});

describe('probe mode config and gate', () => {
  it('starts without SNIPER_CONTRACT (one gas key is enough) but refuses without a key', () => {
    const cfg = loadConfig({ EXECUTION_MODE: 'probe', EXECUTOR_PRIVATE_KEYS: PROBE_KEY });
    expect(cfg.EXECUTION_MODE).toBe('probe');
    expect(cfg.SNIPER_CONTRACT).toBe('');
    expect(cfg.PROBE_RECEIPT_TIMEOUT_MS).toBe(5000);
    expect(() => loadConfig({ EXECUTION_MODE: 'probe' })).toThrow(/probe mode needs at least one/);
    expect(() => loadConfig({ EXECUTION_MODE: 'probe', EXECUTOR_PRIVATE_KEYS: '0x1234' })).toThrow(/probe mode needs/);
    expect(() => loadConfig({ EXECUTION_MODE: 'live', EXECUTOR_PRIVATE_KEYS: PROBE_KEY })).toThrow(/SNIPER_CONTRACT/); // live still does
  });

  it('the probe gate needs a funded key and never reads a contract', async () => {
    const chain = new FakeChain();
    chain.ethBalances.set(PROBE_ADDR, parseEther('0.0005'));
    const low = await probeStartupChecks({ chain, keys: [PROBE_ADDR], minBalanceWei: parseEther('0.001') });
    expect(low.ok).toBe(false);
    expect(low.errors.join()).toMatch(/0\.0005 ETH < MIN_GAS_BALANCE_ETH/);
    chain.ethBalances.set(PROBE_ADDR, parseEther('0.002'));
    expect((await probeStartupChecks({ chain, keys: [PROBE_ADDR], minBalanceWei: parseEther('0.001') })).ok).toBe(true);
    expect((await probeStartupChecks({ chain, keys: [], minBalanceWei: 1n })).ok).toBe(false);
  });

  it('a failing gate skips the probe (nothing sent) while the paper run goes on', async () => {
    const h = harness('probe');
    await h.probe!.init();
    h.probe!.setGate('probe key unfunded');
    await h.upToBurst();
    const run = h.sniper.activeRuns[0]!;
    expect(run.race).toMatchObject({ status: 'skipped', reason: 'probe gate: probe key unfunded' });
    h.second(T + 1, TARGET);
    await waitFor(() => run.status === 'open');
    expect(h.sender.sent).toHaveLength(0);
    expect(h.race.counters).toMatchObject({ race_planned: 1, race_skipped: 1, race_sent: 0 });
  });
});
