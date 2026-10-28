/**
 * The always-on launch-second fingerprint (trigger.launchSecond): synthetic feed blocks of the
 * launch second update the per-launch ledger, the rules are re-run as it grows, and a match
 * schedules the burst for the T+1 boundary. Team buys must be confirmed by a CurveBuy receipt log
 * before anything is signed (live), and the play is re-checked right before the first send.
 */
import { QUOTE_TOKENS, SequencerClock, curveAbi, decodedTxFromRpc, tokenAbi, type DecodedTx, type FeedBlock, type Reserves } from '@hood/core';
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
  chain.atBlock = () => INITIAL;
  chain.receipts.set(LAUNCH.txHash, launchReceipt());
  const sched = new ManualScheduler((T - 31) * 1000);
  // eslint-disable-next-line prefer-const
  let sniper: Sniper;
  const backend =
    mode === 'live'
      ? new ScriptedBackend()
      : new PaperExecutor({ chain, logger: silentLogger, book: (c) => sniper.positions.book(c), creatorTaxBps: (c) => sniper.creatorTaxBps(c) });
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
    // a buy inside the launch tx is the dev buy whoever the recipient is
    expect(lg.stats().confirmed).toEqual({ teamBuyEth: 0, teamBuyers: 0, devBuyEth: 0.3 });
  });

  it('reservesAfter applies the launch-second buys (team untaxed) to the post-launch reserves', () => {
    const lg = new LaunchSecondLedger(detected());
    lg.setAddresses(LAUNCH.token, LAUNCH.curve);
    lg.ingestTx(curveBuyTx(0.38), LAUNCH.block + 1);
    const r = lg.reservesAfter(INITIAL, 200);
    expect(r.quote).toBe(INITIAL.quote + parseEther('0.38') - parseEther('0.0038') - parseEther('0.0076'));
    expect(r.token).toBeLessThan(INITIAL.token);
    const priceUp = (Number(r.quote) / Number(r.token)) / (Number(INITIAL.quote) / Number(INITIAL.token)) - 1;
    expect(priceUp).toBeGreaterThan(0.4); // AMLIL-like +45 %: minTokensOut must be computed after it
  });
});
