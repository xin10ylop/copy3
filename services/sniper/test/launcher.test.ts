/**
 * Production finding (live paper box): ~50 % of real Pons launches go through third-party launcher
 * contracts (0x6319…cce2 with the unknown selector 0xf955751f, 0x9dcc…3961). The calldata path
 * (H1: tx.to ∈ {factory, router, LAUNCHERS} + a launch selector) never saw them. Log-originated
 * launches: the factory's own TokenLaunched log in the receipt / node ws is authoritative for
 * deployer, token and curve; the launch then goes through the same ledger → rules → receipt →
 * burst path as a feed launch.
 */
import { SequencerClock, TOPICS, curveAbi, decodedTxFromRpc, type DecodedTx, type FeedBlock, type RawLog, type Reserves } from '@hood/core';
import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReceiptLite } from '../src/chain.js';
import { DEFAULT_LAUNCHERS, loadConfig } from '../src/config.js';
import { LaunchDetector } from '../src/detector.js';
import type { ExecutionBackend, ExitOrder, ExitResult, SnipeOrder } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper } from '../src/sniper.js';
import { MemoryStore } from '../src/store.js';
import type { Fill } from '../src/types.js';
import { FakeChain, curveTradeLog } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchFixture, launchReceipt, play, tokenLaunchedLog } from './helpers/fixtures.js';

const T = LAUNCH.ts;
const OFFSET = 45;
const RTT = 6;
const INITIAL: Reserves = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n };
const LAUNCHER_6319 = '0x6319141dcc29e7dceaab6c4563cca1fb58e8cce2' as Address;
const ATTACKER = '0x000000000000000000000000000000000000beef' as Address;
const TEAM = LAUNCH.creatorFeeRecipient;
const LTX = `0x${'6c'.repeat(32)}` as Hex; // the launcher-contract launch tx

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

const refs: Sniper[] = [];
afterEach(async () => {
  for (const s of refs.splice(0)) await s.stop();
});

/** a tx to the launcher contract with its own (unknown) selector, as the feed shows it */
function launcherTx(to: Address = LAUNCHER_6319, input: Hex = `0xf955751f${'00'.repeat(96)}` as Hex): DecodedTx {
  return decodedTxFromRpc({ ...launchFixture.tx, hash: LTX, to, input, value: 0n });
}
/** its receipt: the factory's TokenLaunched (+ the curve's SnipeTaxExempted logs) from the real launch fixture */
const launcherReceipt = (o: Partial<ReceiptLite> = {}): ReceiptLite => launchReceipt({ transactionHash: LTX, ...o });
const launchLogOf = (o: Partial<RawLog> = {}): RawLog => ({ ...tokenLaunchedLog, transactionHash: LTX, blockNumber: LAUNCH.block, ...o });

let n = 0;
function teamBuyTx(eth: number): DecodedTx {
  const q = parseEther(String(eth));
  return decodedTxFromRpc({
    ...launchFixture.tx,
    hash: `0x${(++n).toString(16).padStart(4, '0').repeat(16)}` as Hex,
    from: TEAM,
    to: LAUNCH.curve,
    value: q,
    nonce: n,
    input: encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [q, 0n, TEAM] }),
  });
}
const buyReceipt = (tx: DecodedTx, block: number): ReceiptLite => ({
  transactionHash: tx.hash,
  status: 'success',
  blockNumber: block,
  gasUsed: 1n,
  logs: [curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: TEAM, recipient: TEAM, quote: tx.value, tokens: 10n ** 26n, fee: tx.value / 100n, tax: 0n, block, txHash: tx.hash, logIndex: 0 })],
});

const TEAM_BUY_PLAY = { id: 21, name: 'team-buy-0.1', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, preset: { stopAfter: 1000, firstBuyOnly: false } };

function harness(plays: Parameters<typeof play>[0][] = [TEAM_BUY_PLAY], launchers: string[] = DEFAULT_LAUNCHERS as string[]) {
  const store = new MemoryStore({ plays: plays.map((p) => play(p)) });
  const chain = new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  chain.atBlock = () => INITIAL;
  chain.receipts.set(LTX, launcherReceipt());
  chain.blockTs.set(LAUNCH.block, T);
  const sched = new ManualScheduler((T - 31) * 1000);
  const backend = new ScriptedBackend();
  const sniper = new Sniper({
    mode: 'live',
    store,
    chain,
    backend,
    clock: new SequencerClock(),
    scheduler: sched,
    logger: silentLogger,
    detector: new LaunchDetector({ launchers }),
    rttMs: () => RTT,
    reservesPollMs: 1e9,
    gasPollMs: 1e9,
    receiptPollMs: 1,
    reconcileMs: 1e9,
    sniperContract: '0x5151515151515151515151515151515151515151' as Address,
  });
  refs.push(sniper);
  const feed = (b: FeedBlock): void => {
    sched.t = b.receivedAt;
    sniper.onFeedBlock(b);
  };
  const warm = (): void => {
    for (let s = 10; s >= 1; s--) for (let k = 0; k < 10; k++) feed(emptyBlock(LAUNCH.block - 2 - s * 10 + k, T - s, (T - s) * 1000 + OFFSET + k * 100));
  };
  const blockAt = (k: number): number => LAUNCH.block - 2 + k;
  /** blocks k = from..to of second T; the launcher tx sits in block k = 2 (the launch block) */
  const second = (extra: Map<number, DecodedTx[]>, from = 0, to = 9): void => {
    for (let k = from; k <= to; k++) feed(emptyBlock(blockAt(k), T, T * 1000 + OFFSET + k * 100, extra.get(k) ?? []));
  };
  return { store, chain, sched, sniper, backend, feed, warm, second, blockAt };
}

describe('log-originated launches (third-party launcher contracts)', () => {
  it('a launcher-contract tx (to = 0x6319…, unknown selector) → launch from the factory log, ledger started, team buy confirmed → burst planned at T+1', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const buy = teamBuyTx(0.19);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3)));
    h.second(new Map([[2, [launcherTx()]], [3, [buy]]]), 0, 4);
    await waitFor(() => h.backend.orders.length === 1);
    const order = h.backend.orders[0]!;
    const run = order.run;
    expect(run.launch.origin).toBe('log');
    expect(run.launch.event.launcher).toBe(LAUNCHER_6319);
    expect(run.launch.event.deployer).toBe(LAUNCH.deployer); // TokenLaunched.deployer, not calldata
    expect(run.launch.token).toBe(LAUNCH.token);
    expect(run.launch.event.exemptions).toEqual(expect.arrayContaining([LAUNCH.deployer, TEAM])); // receipt SnipeTaxExempted
    expect(run.decision.reasons.join()).toMatch(/launchSecond: team 0\.19 ETH/);
    expect(run.notes.join()).toMatch(/launch-second confirmed/);
    expect(run.confirmed).toBe(true);
    expect(run.plan!.boundaryMs).toBeCloseTo((T + 1) * 1000 + OFFSET, 6); // the T+1 boundary is still reached
    expect(order.times[0]).toBeCloseTo((T + 1) * 1000 + OFFSET - RTT - 120, 6);
    expect(h.sniper.counters.log_launches).toBe(1);
    expect(h.sniper.ledger(LTX)).toBeDefined();
    // origin and launcher are persisted in the decision JSON
    await h.sniper.recorder.idle();
    const rec = [...h.store.snipes.values()][0]!.decision as { launch: { origin: string; launcher: string } };
    expect(rec.launch).toMatchObject({ origin: 'log', launcher: LAUNCHER_6319 });
    h.backend.resolveFill!(null);
  });

  it("the observed 0x6319… pattern: the launch tx's own CurveBuy to the exempted sender (≠ TokenLaunched.deployer) is the team buy — no later buy needed", async () => {
    // 29 Oct 2026, Ohio box: 23 of 290 launches in one night had team ≥ 0.1 ETH this way (e.g.
    // tx 0x77b4b169…: deployer 0x1aa78481…, sender 0x8e89f8ec… exempted + buys 0.804 ETH in the
    // launch tx); the sniper matched one, because the launch tx's buy was counted as the dev buy.
    const SENDER = '0x8e89f8ec000000000000000000000000008e89f8' as Address;
    const h = harness();
    const base = launcherReceipt();
    const exemptLog: RawLog = { ...(base.logs.find((l) => l.topics[0] === TOPICS.SnipeTaxExempted) as RawLog), topics: [TOPICS.SnipeTaxExempted, `0x${SENDER.slice(2).padStart(64, '0')}` as Hex], transactionHash: LTX };
    const bundledBuy = curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: LAUNCHER_6319, recipient: SENDER, quote: parseEther('0.804'), tokens: 10n ** 26n, fee: 0n, tax: 0n, block: LAUNCH.block, txHash: LTX, logIndex: 40 });
    h.chain.receipts.set(LTX, { ...base, logs: [...base.logs, exemptLog, bundledBuy] });
    await h.sniper.start();
    h.warm();
    h.second(new Map([[2, [launcherTx(LAUNCHER_6319, `0xf955751f${'00'.repeat(96)}` as Hex)]]]), 0, 4); // no other buy in the second
    await waitFor(() => h.backend.orders.length === 1);
    const run = h.backend.orders[0]!.run;
    expect(run.launch.origin).toBe('log');
    expect(run.launch.event.deployer).toBe(LAUNCH.deployer);
    expect(run.launch.event.devBuyRecipient).toBe(SENDER);
    expect(run.launch.event.exemptions).toEqual(expect.arrayContaining([SENDER]));
    expect(run.decision.reasons.join()).toMatch(/launchSecond: team 0\.804 ETH by 1 wallet\(s\), dev 0 ETH/);
    expect(run.confirmed).toBe(true);
    expect(h.sniper.ledger(LTX)!.stats().confirmed).toEqual({ teamBuyEth: 0.804, teamBuyers: 1, devBuyEth: 0 });
    h.backend.resolveFill!(null);
  });

  it('a launcher the config does not list is caught from the node ws TokenLaunched log (emitter = the factory)', async () => {
    const h = harness([TEAM_BUY_PLAY], []); // no LAUNCHERS at all
    await h.sniper.start();
    h.warm();
    const buy = teamBuyTx(0.19);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3)));
    h.second(new Map([[2, [launcherTx(ATTACKER.replace('beef', 'cafe') as Address)]], [3, [buy]]]), 0, 4);
    await sleep(10);
    expect(h.sniper.counters.log_launches).toBe(0); // the feed alone cannot tell
    h.chain.launchWatcher!(launchLogOf()); // the node pushes the factory's TokenLaunched for that tx
    await waitFor(() => h.backend.orders.length === 1);
    expect(h.backend.orders[0]!.run.launch.origin).toBe('log');
    expect(h.sniper.counters.log_launches).toBe(1);
    h.backend.resolveFill!(null);
  });

  it('a TokenLaunched-shaped log whose emitter is not the factory is ignored (ws and receipt)', async () => {
    const h = harness([TEAM_BUY_PLAY], []);
    await h.sniper.start();
    h.warm();
    h.chain.receipts.set(LTX, launcherReceipt({ logs: launchFixture.receipt.logs.map((l: RawLog) => ({ ...l, address: l.address.toLowerCase() === '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' ? ATTACKER : l.address })) }));
    h.second(new Map([[2, [launcherTx(ATTACKER)]]]), 0, 4);
    h.chain.launchWatcher!(launchLogOf({ address: ATTACKER }));
    await sleep(40);
    expect(h.sniper.counters.log_launches).toBe(0);
    expect(h.sniper.ledger(LTX)).toBeUndefined();
    // even listed as a launcher: its receipt has no factory TokenLaunched → no launch
    const h2 = harness([TEAM_BUY_PLAY], [ATTACKER]);
    h2.chain.receipts.set(LTX, h.chain.receipts.get(LTX)!);
    await h2.sniper.start();
    h2.warm();
    h2.second(new Map([[2, [launcherTx(ATTACKER)]]]), 0, 4);
    await sleep(40);
    expect(h2.sniper.counters.log_launches).toBe(0);
    expect(h2.sniper.counters.decisions).toBe(0);
  });

  it('a launcher launch for a deployerIn play matches via the log deployer — never via calldata naming another deployer', async () => {
    const h = harness([{ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07, maxEntryMcapEth: 4 } }]);
    await h.sniper.start();
    h.warm();
    h.second(new Map([[2, [launcherTx()]]]), 0, 4);
    await waitFor(() => h.backend.orders.length === 1);
    const run = h.backend.orders[0]!.run;
    expect(run.launch.origin).toBe('log');
    expect(run.decision.reasons.join()).toMatch(/deployerIn/);
    expect(run.confirmed).toBe(true);
    h.backend.resolveFill!(null);
    // H1 still holds: launch calldata to a launcher naming a followed wallet, while the factory
    // log names someone else → the play does not match
    const h2 = harness([{ id: 9, trigger: { deployerIn: ['0x0000000000000000000000000000000000000f01'] }, preset: { buyEth: 0.07 } }]);
    await h2.sniper.start();
    h2.warm();
    const spoof = encodeFunctionData({
      abi: (await import('@hood/core')).factoryAbi,
      functionName: 'launchTokenFor',
      args: [
        { name: 'x', symbol: 'X', logo: '', description: '', socials: { twitter: '', telegram: '', website: '', discord: '', farcaster: '' }, creatorFeeRecipient: ATTACKER, creatorTaxBps: 0, buybackEnabled: false, salt1: `0x${'00'.repeat(32)}`, salt2: `0x${'00'.repeat(32)}` },
        0n,
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000f01',
        [],
      ],
    } as never) as Hex;
    h2.second(new Map([[2, [launcherTx(LAUNCHER_6319, spoof)]]]), 0, 4);
    await waitFor(() => h2.sniper.counters.log_launches === 1);
    await sleep(10);
    expect(h2.sniper.counters.decisions).toBe(0);
  });

  it('a log-originated launch older than MAX_LAUNCH_AGE_MS is skipped like a stale feed launch', async () => {
    const h = harness([{ id: 9, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { buyEth: 0.07 } }], []);
    await h.sniper.start();
    h.warm();
    h.second(new Map(), 0, 9);
    h.sched.t = (T + 4) * 1000; // the log arrives 4 s after the launch second
    h.chain.launchWatcher!(launchLogOf());
    await waitFor(() => h.sniper.counters.log_launches_stale === 1);
    expect(h.sniper.counters.decisions).toBe(0);
  });

  it('config: the observed launchers are a documented default; LAUNCHERS extends it', () => {
    expect(DEFAULT_LAUNCHERS).toEqual(['0x6319141dcc29e7dceaab6c4563cca1fb58e8cce2', '0x9dcceb091218cdedbc2875514386615a8ce63961']);
    expect(loadConfig({}).LAUNCHERS).toEqual(DEFAULT_LAUNCHERS);
    expect(loadConfig({ LAUNCHERS: '0x00000000000000000000000000000000000000AA' }).LAUNCHERS).toEqual([...DEFAULT_LAUNCHERS, '0x00000000000000000000000000000000000000aa']);
  });
});
