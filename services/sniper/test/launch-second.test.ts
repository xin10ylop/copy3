/**
 * The always-on launch-second fingerprint (trigger.launchSecond): synthetic feed blocks of the
 * launch second update the per-launch ledger, the rules are re-run as it grows, and a match
 * schedules the burst for the T+1 boundary. Team buys must be confirmed by a CurveBuy receipt log
 * before anything is signed (live), and the play is re-checked right before the first send.
 */
import { CURVE_FEE_BPS, QUOTE_TOKENS, SequencerClock, TOPICS, curveAbi, decodedTxFromRpc, quoteBuy, snipeTaxWeiFor, tokenAbi, type DecodedTx, type FeedBlock, type Reserves } from '@hood/core';
import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReceiptLite } from '../src/chain.js';
import { LaunchDetector } from '../src/detector.js';
import type { ExecutionBackend, ExitOrder, ExitResult, SnipeOrder } from '../src/executor.js';
import { LaunchSecondLedger } from '../src/ledger.js';
import { silentLogger } from '../src/log.js';
import { PaperExecutor } from '../src/paper.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper } from '../src/sniper.js';
import { MemoryStore } from '../src/store.js';
import type { Fill } from '../src/types.js';
import { FakeChain, curveTradeLog } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchBlock, launchFixture, launchReceipt, play } from './helpers/fixtures.js';

const T = LAUNCH.ts;
const OFFSET = 45;
const RTT = 6;
const INITIAL: Reserves = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n };
const TEAM = LAUNCH.creatorFeeRecipient; // exempt (SnipeTaxExempted in the launch receipt), not the deployer
const STRANGER = '0x000000000000000000000000000000000000beef' as Address;
const FRESH = '0x000000000000000000000000000000000000f2e5' as Address;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await sleep(2);
  }
}

/** Live backend whose fill the test resolves by hand. */
class ScriptedBackend implements ExecutionBackend {
  readonly mode = 'live' as const;
  orders: SnipeOrder[] = [];
  resolveFill: ((f: Fill | null) => void) | null = null;
  balance: bigint | null = null;
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
  bankrollWei(): bigint | null {
    return this.balance;
  }
}

let n = 0;
/** A direct `curve.buy(quoteIn, 0, recipient)` from the recipient, as the feed shows it. */
function curveBuyTx(eth: number, recipient: Address = TEAM): DecodedTx {
  const q = parseEther(String(eth));
  return decodedTxFromRpc({
    ...launchFixture.tx,
    hash: `0x${(++n).toString(16).padStart(4, '0').repeat(16)}` as Hex,
    from: recipient,
    to: LAUNCH.curve,
    value: q,
    nonce: n,
    input: encodeFunctionData({ abi: curveAbi, functionName: 'buy', args: [q, 0n, recipient] }),
  });
}

/** `token.transfer(to, amount)` from an exempt wallet: the team moving tokens out (dump signal). */
function transferTx(from: Address, to: Address): DecodedTx {
  return decodedTxFromRpc({
    ...launchFixture.tx,
    hash: `0x${(++n).toString(16).padStart(4, '0').repeat(16)}` as Hex,
    from,
    to: LAUNCH.token,
    value: 0n,
    nonce: n,
    input: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, 10n ** 24n] }),
  });
}

/** Receipt of a hinted buy with the EXACT CurveBuy numbers the curve would emit from `before` (untaxed). */
function exactBuyReceipt(tx: DecodedTx, block: number, before: Reserves, creatorTaxBps: number): ReceiptLite {
  const recipient = `0x${tx.input.slice(-40)}`;
  const tokens = quoteBuy(before, tx.value, CURVE_FEE_BPS, creatorTaxBps, 0n);
  const fee = (tx.value * BigInt(CURVE_FEE_BPS)) / 10_000n;
  const tax = (tx.value * BigInt(creatorTaxBps)) / 10_000n;
  return {
    transactionHash: tx.hash,
    status: 'success',
    blockNumber: block,
    gasUsed: 120_000n,
    logs: [curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: recipient, recipient, quote: tx.value, tokens, fee, tax, block, txHash: tx.hash, logIndex: 0 })],
  };
}

/** Receipt of a hinted buy: success with its CurveBuy log, or reverted (no log). */
function buyReceipt(tx: DecodedTx, block: number, status: 'success' | 'reverted' = 'success'): ReceiptLite {
  const recipient = `0x${tx.input.slice(-40)}`;
  return {
    transactionHash: tx.hash,
    status,
    blockNumber: block,
    gasUsed: 120_000n,
    logs:
      status === 'success'
        ? [curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: recipient, recipient, quote: tx.value, tokens: 10n ** 26n, fee: tx.value / 100n, tax: 0n, block, txHash: tx.hash, logIndex: 0 })]
        : [],
  };
}

const refs: Sniper[] = [];
afterEach(async () => {
  for (const s of refs.splice(0)) await s.stop();
});

const TEAM_BUY_PLAY = { id: 21, name: 'team-buy-0.1', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, preset: { stopAfter: 1000, firstBuyOnly: false } };

function harness(o: { mode?: 'live' | 'paper'; plays?: Parameters<typeof play>[0][]; paperBankrollEth?: number } = {}) {
  const mode = o.mode ?? 'live';
  const store = new MemoryStore({ plays: (o.plays ?? [TEAM_BUY_PLAY]).map((p) => play(p)) });
  const chain = new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  chain.atBlock = (_c, b) => (b > LAUNCH.block + 8 ? undefined : INITIAL); // post-fill blocks: unknown → exits price on the book
  chain.strictBlocks = true;
  chain.receipts.set(LAUNCH.txHash, launchReceipt());
  const sched = new ManualScheduler((T - 31) * 1000);
  // eslint-disable-next-line prefer-const
  let sniper: Sniper;
  const backend =
    mode === 'live'
      ? new ScriptedBackend()
      : new PaperExecutor({ chain, logger: silentLogger, book: (c) => sniper.positions.book(c), creatorTaxBps: (c) => sniper.creatorTaxBps(c), exitRetryMs: 1 });
  sniper = new Sniper({
    mode,
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
    ...(o.paperBankrollEth !== undefined ? { paperBankrollEth: o.paperBankrollEth } : {}),
    ...(mode === 'live' ? { sniperContract: '0x5151515151515151515151515151515151515151' as Address } : {}),
  });
  refs.push(sniper);
  const feed = (b: FeedBlock): void => {
    sched.t = b.receivedAt;
    sniper.onFeedBlock(b);
  };
  const warm = (): void => {
    for (let s = 10; s >= 1; s--) for (let k = 0; k < 10; k++) feed(emptyBlock(LAUNCH.block - 2 - s * 10 + k, T - s, (T - s) * 1000 + OFFSET + k * 100));
  };
  /** blocks k = from..to of second T on the 100 ms grid; the launch is block k = 2 (T + 200 ms) */
  const launchSecond = (extra: Map<number, DecodedTx[]> = new Map(), from = 0, to = 9): void => {
    for (let k = from; k <= to; k++) {
      const at = T * 1000 + OFFSET + k * 100;
      const blk = LAUNCH.block - 2 + k;
      feed(blk === LAUNCH.block ? launchBlock(at, extra.get(k) ?? []) : emptyBlock(blk, T, at, extra.get(k) ?? []));
    }
  };
  const blockAt = (k: number): number => LAUNCH.block - 2 + k;
  return { store, chain, sched, sniper, backend, feed, warm, launchSecond, blockAt, scripted: backend instanceof ScriptedBackend ? backend : null };
}

describe('launch-second fingerprint: ledger → rules → burst at T+1', () => {
  it('launch at T, a 0.19 ETH team buy in the block at T+300 ms → the burst is planned for the T+1 boundary', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const buy = curveBuyTx(0.19);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3)));
    h.launchSecond(new Map([[3, [buy]]]), 0, 4); // the decision is taken inside the launch second
    await waitFor(() => h.scripted!.orders.length === 1);
    const order = h.scripted!.orders[0]!;
    const run = order.run;
    expect(run.playId).toBe(21);
    expect(run.decision.reasons.join()).toMatch(/launchSecond: team 0\.19 ETH by 1 wallet\(s\), dev 0 ETH \(seen\)/);
    // the T+1 boundary: first block of second T+1 arrives OFFSET ms after the tick
    expect(run.plan!.boundaryMs).toBeCloseTo((T + 1) * 1000 + OFFSET, 6);
    expect(order.times).toHaveLength(10);
    expect(order.times[0]).toBeCloseTo((T + 1) * 1000 + OFFSET - RTT - 120, 6);
    expect(order.times[9]! - order.times[0]!).toBeCloseTo(9 * 15, 6);
    // H1: the team buy was proven by its receipt's CurveBuy before signing
    expect(run.notes.join()).toMatch(/launch-second confirmed: launchSecond: team 0\.19 ETH .*\(confirmed\)/);
    expect(h.chain.calls).toContain(`getReceipt:${buy.hash.slice(0, 10)}`);
    expect(run.notes.join()).toMatch(/reserves: launch config \+ 1 launch-second buy\(s\) from the ledger/);
    expect(h.sniper.counters.ledger_matches).toBe(1);
    expect(order.guard!()).toBeNull(); // the last-moment re-check holds
    await h.sniper.recorder.idle();
    const row = [...h.store.snipes.values()][0]!;
    const rec = row.decision as { launchSecond: { confirmed: { teamBuyEth: number }; buys: { kind: string }[] } };
    expect(rec.launchSecond.confirmed.teamBuyEth).toBeCloseTo(0.19, 9);
    expect(rec.launchSecond.buys.map((b) => b.kind)).toEqual(['team']);
    h.scripted!.resolveFill!(null);
  });

  it('re-runs the rules as the ledger grows: 0.06 + 0.05 ETH from the team crosses 0.1 at the second buy', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const a = curveBuyTx(0.06);
    const b = curveBuyTx(0.05);
    h.chain.receipts.set(a.hash, buyReceipt(a, h.blockAt(3)));
    h.chain.receipts.set(b.hash, buyReceipt(b, h.blockAt(6)));
    h.launchSecond(new Map([[3, [a]]]), 0, 5);
    await waitFor(() => (h.sniper.ledger(LAUNCH.txHash)?.stats().seen.teamBuyEth ?? 0) > 0);
    await sleep(10);
    expect(h.scripted!.orders).toHaveLength(0);
    h.launchSecond(new Map([[6, [b]]]), 6, 7);
    await waitFor(() => h.scripted!.orders.length === 1);
    expect(h.scripted!.orders[0]!.run.decision.reasons.join()).toMatch(/team 0\.11 ETH/);
    h.scripted!.resolveFill!(null);
  });

  it('a team buy routed through a contract (invisible to the feed decoder) fires from the node CurveBuy log', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    h.launchSecond(new Map(), 0, 4);
    await waitFor(() => h.chain.tokenWatchers.size > 0); // the ledger subscribed once the receipt named the curve
    expect(h.scripted!.orders).toHaveLength(0);
    // the operator's contract bought for TEAM in the block at T+300 ms; only the node log shows it
    h.chain.emitTokenLog(
      curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: STRANGER, recipient: TEAM, quote: parseEther('0.2'), tokens: 10n ** 26n, fee: parseEther('0.002'), tax: 0n, block: h.blockAt(3), txHash: `0x${'5c'.repeat(32)}`, logIndex: 1 }),
    );
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    expect(run.decision.reasons.join()).toMatch(/team 0\.2 ETH by 1 wallet/);
    expect(run.notes.join()).toMatch(/launch-second confirmed/); // a log is proof: no receipt needed
    // a log from a block after the launch second is ignored
    const lg = h.sniper.ledger(LAUNCH.txHash)!;
    h.feed(emptyBlock(h.blockAt(10), T + 1, (T + 1) * 1000 + OFFSET));
    h.chain.emitTokenLog(
      curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: TEAM, recipient: TEAM, quote: parseEther('5'), tokens: 10n ** 26n, fee: 0n, tax: 0n, block: h.blockAt(10), txHash: `0x${'5d'.repeat(32)}`, logIndex: 0 }),
    );
    expect(lg.stats().seen.teamBuyEth).toBeCloseTo(0.2, 12);
    h.scripted!.resolveFill!(null);
  });

  it('a team buy below the threshold (0.05 ETH) never fires', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const buy = curveBuyTx(0.05);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3)));
    h.launchSecond(new Map([[3, [buy]]]));
    for (let k = 0; k < 10; k++) h.feed(emptyBlock(h.blockAt(10 + k), T + 1, (T + 1) * 1000 + OFFSET + k * 100));
    await waitFor(() => (h.sniper.ledger(LAUNCH.txHash)?.stats().seen.teamBuyEth ?? 0) > 0);
    await sleep(20);
    expect(h.sniper.ledger(LAUNCH.txHash)!.stats().seen).toEqual({ teamBuyEth: 0.05, teamBuyers: 1, devBuyEth: 0 });
    expect(h.sniper.counters.decisions).toBe(0);
    expect(h.scripted!.orders).toHaveLength(0);
  });

  it('a big buy by a non-exempt wallet in the launch second is not a team buy', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const buy = curveBuyTx(0.5, STRANGER);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3)));
    h.launchSecond(new Map([[3, [buy]]]));
    await waitFor(() => h.sniper.ledger(LAUNCH.txHash)?.curve !== null && h.sniper.ledger(LAUNCH.txHash) !== undefined);
    await sleep(20);
    expect(h.sniper.ledger(LAUNCH.txHash)!.stats().seen.teamBuyEth).toBe(0);
    expect(h.scripted!.orders).toHaveLength(0);
  });

  it('H1: a team buy that reverts (feed hint without a CurveBuy) is refused before signing', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const buy = curveBuyTx(0.19);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3), 'reverted'));
    h.launchSecond(new Map([[3, [buy]]]), 0, 4);
    await waitFor(() => h.sniper.counters.launch_second_unconfirmed === 1);
    expect(h.scripted!.orders).toHaveLength(0); // nothing signed
    expect(h.sniper.counters.decisions).toBe(1); // the feed hint did schedule it
    expect(h.sniper.risk.open).toBe(0);
    expect(h.sniper.risk.hasPlayedDeployer(21, LAUNCH.deployer)).toBe(false);
    await h.sniper.recorder.idle();
    const row = [...h.store.snipes.values()][0]!;
    expect(row.status).toBe('aborted');
    expect(row.notes).toMatch(/launch-second fingerprint not confirmed: launchSecond: team buy 0 ETH < min 0\.1 \(confirmed\)/);
  });

  it('R4-8: a reverting fake team-buy hint no longer uses up the launch — a real confirmed team buy later in the second still fires', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const fake = curveBuyTx(0.19); // feed-visible, reverts on chain (gas only)
    h.chain.receipts.set(fake.hash, buyReceipt(fake, h.blockAt(3), 'reverted'));
    h.launchSecond(new Map([[3, [fake]]]), 0, 4);
    await waitFor(() => h.sniper.counters.launch_second_unconfirmed === 1);
    expect(h.scripted!.orders).toHaveLength(0);
    expect(h.sniper.ledger(LAUNCH.txHash)!.decided).toBe(false); // re-opened after the refutation
    const real = curveBuyTx(0.15);
    h.chain.receipts.set(real.hash, buyReceipt(real, h.blockAt(5)));
    h.launchSecond(new Map([[5, [real]]]), 5, 6);
    await waitFor(() => h.scripted!.orders.length === 1);
    const run = h.scripted!.orders[0]!.run;
    expect(run.decision.reasons.join()).toMatch(/team 0\.15 ETH/);
    expect(run.notes.join()).toMatch(/launch-second confirmed/);
    h.scripted!.resolveFill!(null);
  });

  it('blacklist: deployerNotIn keeps a blacklisted operator out even with a team buy', async () => {
    const h = harness({ plays: [{ ...TEAM_BUY_PLAY, trigger: { launchSecond: { minTeamBuyEth: 0.1 }, deployerNotIn: [LAUNCH.deployer] } }] });
    await h.sniper.start();
    h.warm();
    const buy = curveBuyTx(0.19);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3)));
    h.launchSecond(new Map([[3, [buy]]]));
    await waitFor(() => (h.sniper.ledger(LAUNCH.txHash)?.stats().seen.teamBuyEth ?? 0) > 0.1);
    await sleep(20);
    expect(h.sniper.counters.decisions).toBe(0);
    expect(h.scripted!.orders).toHaveLength(0);
    expect(h.sniper.rules.explain(h.sniper.ledger(LAUNCH.txHash)!.launch.event, Date.now(), h.sniper.ledger(LAUNCH.txHash)!.stats())[0]!.reasons.join()).toMatch(
      /deployerNotIn: 0x81eb.* is blacklisted/,
    );
  });

  it('an exempt transfer-out seen in the launch second before the team buy refuses the match', async () => {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const dump = transferTx(LAUNCH.deployer, FRESH);
    const buy = curveBuyTx(0.19);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(4)));
    h.launchSecond(new Map([[3, [dump]], [4, [buy]]]));
    await waitFor(() => (h.sniper.ledger(LAUNCH.txHash)?.stats().seen.teamBuyEth ?? 0) > 0.1);
    await sleep(20);
    const lg = h.sniper.ledger(LAUNCH.txHash)!;
    expect(lg.stats().exemptOut).toBe(1);
    expect(lg.outflows[0]).toMatchObject({ from: LAUNCH.deployer, kind: 'transfer' });
    expect(lg.decided).toBe(true);
    expect(h.sniper.counters.decisions).toBe(0);
  });

  it('no launch-second play enabled → no ledgers at all (the hot path is unchanged)', async () => {
    const h = harness({ plays: [{ id: 3, trigger: { deployerIn: ['0x0000000000000000000000000000000000000001'] } }] });
    await h.sniper.start();
    h.warm();
    h.launchSecond(new Map([[3, [curveBuyTx(0.19)]]]));
    await sleep(10);
    expect(h.sniper.counters.ledger_launches).toBe(0);
    expect(h.sniper.ledger(LAUNCH.txHash)).toBeUndefined();
  });

  it('paper + bankroll sizing: size = bankroll × fraction / maxConcurrent, fills at T+1, PnL flows back into the bankroll', async () => {
    const h = harness({
      mode: 'paper',
      paperBankrollEth: 0.6,
      plays: [{ ...TEAM_BUY_PLAY, preset: { ...TEAM_BUY_PLAY.preset, sizing: { mode: 'bankroll', fraction: 0.25, minEth: 0.01, maxEth: 0.3 } } }],
    });
    await h.sniper.start();
    h.warm();
    const buy = curveBuyTx(0.19);
    h.chain.receipts.set(buy.hash, buyReceipt(buy, h.blockAt(3)));
    h.launchSecond(new Map([[3, [buy]]]));
    await waitFor(() => h.sniper.activeRuns[0]?.plan !== undefined);
    const run = h.sniper.activeRuns[0]!;
    expect(run.quoteIn).toBe(parseEther('0.05')); // 0.6 × 0.25 / 3
    expect(run.sizing).toMatchObject({ mode: 'bankroll', bankrollEth: 0.6, clamped: null });
    expect(h.sniper.paperBank!.balanceWei()).toBe(parseEther('0.55')); // 0.05 committed
    // first block of T+1: the paper fill
    h.feed(emptyBlock(h.blockAt(10), T + 1, (T + 1) * 1000 + OFFSET));
    await waitFor(() => run.status === 'open');
    expect(run.fill!.quoteIn).toBe(parseEther('0.05'));
    // the price doubles, then the position is closed: realised profit goes back to the bankroll
    const r = h.sniper.positions.book(LAUNCH.curve)!;
    h.sniper.positions.onReserves(LAUNCH.curve, { quote: r.quote * 2n, token: r.token / 2n }, h.blockAt(30));
    h.sniper.positions.forceExit(run.key, 'timeout');
    await waitFor(() => run.status === 'closed');
    await h.sniper.recorder.idle();
    const row = [...h.store.snipes.values()][0]!;
    expect(row.quoteIn).toBe(parseEther('0.05'));
    expect((row.decision as { sizing: { mode: string } }).sizing.mode).toBe('bankroll');
    const pnl = row.realizedPnlEth!;
    expect(pnl).toBeGreaterThan(0);
    expect(Number(h.sniper.paperBank!.balanceWei()) / 1e18).toBeCloseTo(0.6 + pnl, 9);
    expect(h.sniper.paperBank!.realizedEth).toBeCloseTo(pnl, 9);
  });
});

describe('LaunchSecondLedger (unit)', () => {
  const detected = (over: { devBuyQuoteIn?: bigint } = {}) => ({
    event: {
      deployer: LAUNCH.deployer,
      name: 'S',
      symbol: 'S',
      launchKind: over.devBuyQuoteIn ? ('launchAndBuy' as const) : ('launchToken' as const),
      exemptions: [LAUNCH.deployer, TEAM],
      creatorFeeRecipient: TEAM,
      creatorTaxBps: 0,
      devBuyQuoteIn: over.devBuyQuoteIn ?? 0n,
      pairToken: QUOTE_TOKENS.eth,
      launchConfigId: 0n,
    },
    block: LAUNCH.block,
    ts: T,
    receivedAt: 0,
    txHash: LAUNCH.txHash,
    source: 'feed' as const,
  });

  it('classifies team / dev / taxed buys, de-duplicates hint and log, refutes reverted hints', () => {
    const lg = new LaunchSecondLedger(detected());
    expect(lg.ingestTx(curveBuyTx(0.2), LAUNCH.block + 1)).toBeNull(); // curve unknown yet
    lg.setAddresses(LAUNCH.token, LAUNCH.curve);
    const team = curveBuyTx(0.2);
    const dev = curveBuyTx(0.1, LAUNCH.deployer);
    const taxed = curveBuyTx(0.3, STRANGER);
    for (const tx of [team, dev, taxed]) expect(lg.ingestTx(tx, LAUNCH.block + 1)).toBe('buy');
    expect(lg.ingestTx(team, LAUNCH.block + 1)).toBeNull(); // idempotent per tx
    expect(lg.stats()).toEqual({
      seen: { teamBuyEth: 0.2, teamBuyers: 1, devBuyEth: 0.1 },
      confirmed: { teamBuyEth: 0, teamBuyers: 0, devBuyEth: 0 },
      exemptOut: 0,
      pending: 2, // the taxed buy does not need confirming
    });
    // the CurveBuy log (node ws) replaces the hint of the same tx
    expect(lg.ingestLog(buyReceipt(team, LAUNCH.block + 1).logs[0]!)).toBe(true);
    expect(lg.ingestLog(buyReceipt(team, LAUNCH.block + 1).logs[0]!)).toBe(false);
    expect(lg.stats().confirmed.teamBuyEth).toBeCloseTo(0.2, 12);
    expect(lg.stats().seen.teamBuyEth).toBeCloseTo(0.2, 12);
    // the dev buy reverted
    expect(lg.applyReceipt(buyReceipt(dev, LAUNCH.block + 1, 'reverted'))).toBe(true);
    expect(lg.stats().seen.devBuyEth).toBe(0);
    expect(lg.pendingHints()).toEqual([]);
  });

  it('a buy whose msg.value differs from quoteIn is ignored (it would revert)', () => {
    const lg = new LaunchSecondLedger(detected());
    lg.setAddresses(LAUNCH.token, LAUNCH.curve);
    const tx = curveBuyTx(0.2);
    const bad = decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'ab'.repeat(32)}`, from: TEAM, to: LAUNCH.curve, value: 1n, nonce: 1, input: tx.input });
    expect(lg.ingestTx(bad, LAUNCH.block + 1)).toBeNull();
    expect(lg.stats().seen.teamBuyEth).toBe(0);
  });

  it('launchAndBuy: the calldata dev buy is a hint until the launch receipt shows its CurveBuy', () => {
    const lg = new LaunchSecondLedger(detected({ devBuyQuoteIn: parseEther('0.3') }));
    expect(lg.stats().seen.devBuyEth).toBeCloseTo(0.3, 12);
    expect(lg.stats().confirmed.devBuyEth).toBe(0);
    lg.setAddresses(LAUNCH.token, LAUNCH.curve);
    const devLog = curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: '0xe33e9e479df8802cb0866d5d05258bec4cf62948', recipient: FRESH, quote: parseEther('0.3'), tokens: 10n ** 26n, fee: 0n, tax: 0n, block: LAUNCH.block, txHash: LAUNCH.txHash, logIndex: 9 });
    lg.applyReceipt({ transactionHash: LAUNCH.txHash, status: 'success', blockNumber: LAUNCH.block, gasUsed: 1n, logs: [devLog] });
    // the receipt re-attributes the launch tx's buy by recipient: FRESH is neither the deployer
    // nor exempt → neither dev nor team (the backtest's definition)
    expect(lg.stats().confirmed).toEqual({ teamBuyEth: 0, teamBuyers: 0, devBuyEth: 0 });
  });

  it("the launch tx's own buy is classified by recipient: deployer → dev, another exempt wallet → TEAM (the 0x6319… launcher pattern)", () => {
    const launchBuy = (recipient: Address) =>
      curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: '0x6319141dcc29e7dceaab6c4563cca1fb58e8cce2', recipient, quote: parseEther('0.5'), tokens: 10n ** 26n, fee: 0n, tax: 0n, block: LAUNCH.block, txHash: LAUNCH.txHash, logIndex: 9 });
    // launcher bundle: the factory names a fresh deployer, the exempted tx sender buys 0.5 ETH in the launch tx
    const team = new LaunchSecondLedger({ ...detected({ devBuyQuoteIn: parseEther('0.5') }), event: { ...detected().event, devBuyQuoteIn: parseEther('0.5'), devBuyRecipient: TEAM } });
    expect(team.stats().seen).toEqual({ teamBuyEth: 0.5, teamBuyers: 1, devBuyEth: 0 }); // the hint already carries the recipient
    team.setAddresses(LAUNCH.token, LAUNCH.curve);
    team.applyReceipt({ transactionHash: LAUNCH.txHash, status: 'success', blockNumber: LAUNCH.block, gasUsed: 1n, logs: [launchBuy(TEAM)] });
    expect(team.stats().confirmed).toEqual({ teamBuyEth: 0.5, teamBuyers: 1, devBuyEth: 0 });
    expect(team.stats().seen).toEqual({ teamBuyEth: 0.5, teamBuyers: 1, devBuyEth: 0 });
    // plain launchAndBuy: recipient = deployer → dev, as before
    const dev = new LaunchSecondLedger(detected({ devBuyQuoteIn: parseEther('0.5') }));
    dev.setAddresses(LAUNCH.token, LAUNCH.curve);
    dev.applyReceipt({ transactionHash: LAUNCH.txHash, status: 'success', blockNumber: LAUNCH.block, gasUsed: 1n, logs: [launchBuy(LAUNCH.deployer)] });
    expect(dev.stats().confirmed).toEqual({ teamBuyEth: 0, teamBuyers: 0, devBuyEth: 0.5 });
    // a calldata hint naming the deployer is corrected by the receipt (the log is the truth)
    const corrected = new LaunchSecondLedger(detected({ devBuyQuoteIn: parseEther('0.5') }));
    expect(corrected.stats().seen.devBuyEth).toBeCloseTo(0.5, 12);
    corrected.setAddresses(LAUNCH.token, LAUNCH.curve);
    corrected.applyReceipt({ transactionHash: LAUNCH.txHash, status: 'success', blockNumber: LAUNCH.block, gasUsed: 1n, logs: [launchBuy(TEAM)] });
    expect(corrected.stats().seen).toEqual({ teamBuyEth: 0.5, teamBuyers: 1, devBuyEth: 0 });
  });

  it('reservesAfter applies the confirmed launch-second buys (team untaxed) to the post-launch reserves', () => {
    const lg = new LaunchSecondLedger(detected());
    lg.setAddresses(LAUNCH.token, LAUNCH.curve);
    const tx = curveBuyTx(0.38);
    lg.ingestTx(tx, LAUNCH.block + 1);
    lg.applyReceipt(exactBuyReceipt(tx, LAUNCH.block + 1, INITIAL, 200));
    const r = lg.reservesAfter(INITIAL, 200);
    expect(r.quote).toBe(INITIAL.quote + parseEther('0.38') - parseEther('0.0038') - parseEther('0.0076'));
    expect(r.token).toBe(INITIAL.token - quoteBuy(INITIAL, parseEther('0.38'), CURVE_FEE_BPS, 200, 0n));
    const priceUp = (Number(r.quote) / Number(r.token)) / (Number(INITIAL.quote) / Number(INITIAL.token)) - 1;
    expect(priceUp).toBeGreaterThan(0.4); // AMLIL-like +45 %: minTokensOut must be computed after it
  });

  it('NEW-1: a pending feed hint never prices — reservesAfter / priceMovingBuys use confirmed CurveBuy logs only', () => {
    const lg = new LaunchSecondLedger(detected());
    lg.setAddresses(LAUNCH.token, LAUNCH.curve);
    // the deployer's fake: a feed-visible 3 ETH "team buy" with minOut = max (reverts, costs gas only)
    const fake = curveBuyTx(3);
    expect(lg.ingestTx(fake, LAUNCH.block + 1)).toBe('buy');
    expect(lg.stats().seen.teamBuyEth).toBe(3); // the µs hint stage may still match on it …
    expect(lg.priceMovingBuys).toBe(0); // … but it never moves the price
    expect(lg.reservesAfter(INITIAL, 0)).toEqual(INITIAL);
    // a real, confirmed team buy prices with its exact CurveBuy numbers
    const real = curveBuyTx(0.15);
    lg.ingestTx(real, LAUNCH.block + 1);
    lg.applyReceipt(exactBuyReceipt(real, LAUNCH.block + 1, INITIAL, 0));
    expect(lg.priceMovingBuys).toBe(1);
    expect(lg.reservesAfter(INITIAL, 0).quote).toBe(INITIAL.quote + parseEther('0.15') - parseEther('0.0015'));
    // the fake's receipt shows the revert: refuted, still nothing from it
    lg.applyReceipt(buyReceipt(fake, LAUNCH.block + 2, 'reverted'));
    expect(lg.stats().seen.teamBuyEth).toBeCloseTo(0.15, 12);
    expect(lg.priceMovingBuys).toBe(1);
  });

  it('NEW-1: a buy that paid the 99 % launch-second tax is not a team buy when the wallet is exempted later in the second (CurveBuy.fee, else log order)', () => {
    for (const withFee of [true, false]) {
      const lg = new LaunchSecondLedger(detected());
      lg.setAddresses(LAUNCH.token, LAUNCH.curve);
      const W = '0x0000000000000000000000000000000000000a11';
      const q = parseEther('0.2');
      // block +1: W buys while NOT exempt → fee = 1 % + 99 % snipe tax (net into the pool ≈ 0)
      const taxed = curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: W, recipient: W, quote: q, tokens: 10n ** 20n, fee: q / 100n + (q * 9900n) / 10_000n, tax: 0n, block: LAUNCH.block + 1, txHash: `0x${'b1'.repeat(32)}`, logIndex: 1 });
      lg.ingestLog(withFee ? taxed : { ...taxed, data: taxed.data.slice(0, 2 + 64) }); // a log without the fee word: order decides
      // block +2: the deployer exempts W (exemptFromSnipeTax) — after the buy
      lg.ingestLog({ address: LAUNCH.curve, topics: [TOPICS.SnipeTaxExempted, `0x${'0'.repeat(24)}${W.slice(2)}`], data: '0x', blockNumber: LAUNCH.block + 2, transactionHash: `0x${'e1'.repeat(32)}`, logIndex: 0 });
      expect(lg.isExempt(W)).toBe(true); // later buys of W are team buys …
      expect(lg.stats().confirmed.teamBuyEth).toBe(0); // … this one paid the tax
      expect(lg.snapshot().buys).toEqual([expect.objectContaining({ kind: 'other', status: 'confirmed' })]);
      // and it moved the price by its real net (≈ 0), not as an untaxed 0.2 ETH buy
      const r = lg.reservesAfter(INITIAL, 0);
      expect(Number(r.quote - INITIAL.quote) / 1e18).toBeLessThan(0.0021);
      // a buy by W AFTER the exemption is a team buy
      const after = curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: W, recipient: W, quote: q, tokens: 10n ** 25n, fee: q / 100n, tax: 0n, block: LAUNCH.block + 3, txHash: `0x${'b2'.repeat(32)}`, logIndex: 0 });
      lg.ingestLog(withFee ? after : { ...after, data: after.data.slice(0, 2 + 64) });
      expect(lg.stats().confirmed.teamBuyEth).toBeCloseTo(0.2, 12);
    }
  });
});

describe('NEW-1: launch-second minTokensOut is priced on confirmed buys only (reviewer PoC A)', () => {
  /** decision with or without a pending, reverting 3 ETH fake "team buy" next to the real 0.15 ETH one */
  async function decide(withFake: boolean): Promise<SnipeOrder> {
    const h = harness();
    await h.sniper.start();
    h.warm();
    const real = curveBuyTx(0.15);
    h.chain.receipts.set(real.hash, exactBuyReceipt(real, h.blockAt(3), INITIAL, 0));
    const fake = curveBuyTx(3); // minOut = max on chain: reverts; its receipt is not there yet
    h.launchSecond(new Map([[3, [real]], ...(withFake ? ([[4, [fake]]] as [number, DecodedTx[]][]) : [])]), 0, 4);
    await waitFor(() => h.scripted!.orders.length === 1);
    const o = h.scripted!.orders[0]!;
    if (withFake) expect(h.sniper.ledger(LAUNCH.txHash)!.stats().pending).toBe(1); // still pending when we signed
    h.chain.receipts.set(fake.hash, buyReceipt(fake, h.blockAt(5), 'reverted'));
    h.scripted!.resolveFill!(null);
    return o;
  }

  it('a reverting feed-visible fake buy pending at signing time cannot loosen minTokensOut (30 % stays 30 %)', async () => {
    const honest = await decide(false);
    const attacked = await decide(true);
    expect(attacked.run.minTokensOut).toBe(honest.run.minTokensOut);
    expect(attacked.run.notes.join()).toMatch(/reserves: launch config \+ 1 launch-second buy\(s\) from the ledger/);
    // the tolerated slippage against the true post-second price is the preset's 3000 bps
    const realR = { quote: INITIAL.quote + parseEther('0.15') - parseEther('0.0015'), token: INITIAL.token - quoteBuy(INITIAL, parseEther('0.15'), CURVE_FEE_BPS, 0, 0n) };
    const expected = quoteBuy(realR, attacked.run.quoteIn, CURVE_FEE_BPS, 0, snipeTaxWeiFor(attacked.run.quoteIn, 618));
    expect(1 - Number(attacked.run.minTokensOut) / Number(expected)).toBeCloseTo(0.3, 6);
  });
});
