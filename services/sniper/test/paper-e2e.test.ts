import { CURVE_FEE_BPS, SequencerClock, quoteBuy, quoteSell, snipeTaxWeiFor, type FeedBlock, type Reserves } from '@hood/core';
import { parseEther } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchDetector } from '../src/detector.js';
import { silentLogger } from '../src/log.js';
import { PaperExecutor } from '../src/paper.js';
import { ManualScheduler } from '../src/scheduler.js';
import { Sniper } from '../src/sniper.js';
import { MemoryStore } from '../src/store.js';
import { FakeChain, curveTradeLog, transferLog } from './helpers/fakes.js';
import { LAUNCH, amlil, emptyBlock, launchBlock, launchFixture, launchReceipt, play, tokenLaunchedLog } from './helpers/fixtures.js';

const T = LAUNCH.ts;
const OFFSET = 45; // first block of a second arrives 45 ms after the tick
const INITIAL: Reserves = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n }; // AMLIL launch config
const big = (x: number): bigint => BigInt(Math.round(x));

/** AMLIL reserves after the two exempt team buys in the launch second (exact replay). */
function afterTeam(): Reserves {
  let r = INITIAL;
  for (const t of amlil.trades.slice(0, 2)) {
    const net = big(t.q) - big(t.fee) - big(t.tax);
    r = { quote: r.quote + net, token: r.token - big(t.tok) };
  }
  return r;
}

const sniperRefs: Sniper[] = [];
afterEach(async () => {
  for (const s of sniperRefs.splice(0)) await s.stop();
});

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}

function harness(presetOver: Record<string, unknown>, opts: { receipt?: boolean } = {}) {
  const store = new MemoryStore({ plays: [play({ id: 9, name: 'shib-dev', trigger: { deployerIn: [LAUNCH.deployer] }, preset: presetOver })] });
  const chain = new FakeChain();
  chain.latest.set(LAUNCH.curve, INITIAL);
  // post-fill blocks: the fake chain's state IS the position book the replayed trades maintain
  // (deterministic: no retry race between an exit and the next replayed trade)
  chain.atBlock = (_c, b) => (b > LAUNCH.block + 8 ? (sniper.positions.book(LAUNCH.curve) ?? undefined) : b >= LAUNCH.block + 5 ? afterTeam() : INITIAL);
  chain.strictBlocks = true;
  if (opts.receipt !== false) {
    chain.receipts.set(LAUNCH.txHash, launchReceipt());
  }
  const sched = new ManualScheduler((T - 31) * 1000);
  // eslint-disable-next-line prefer-const
  let sniper: Sniper;
  const backend = new PaperExecutor({ chain, logger: silentLogger, book: (c) => sniper.positions.book(c), creatorTaxBps: (c) => sniper.creatorTaxBps(c), exitRetryMs: 1 });
  sniper = new Sniper({
    mode: 'paper',
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
  });
  sniperRefs.push(sniper);
  const feed = (b: FeedBlock): void => {
    sched.t = b.receivedAt;
    sniper.onFeedBlock(b);
  };
  /** 10 blocks per second on a 100 ms grid; the launch is the 3rd block of second T. */
  const second = (ts: number, firstBlock: number, launchAt = -1, from = 0, to = 10): void => {
    for (let k = from; k < to; k++) {
      const at = ts * 1000 + OFFSET + k * 100;
      feed(firstBlock + k === LAUNCH.block && k === launchAt ? launchBlock(at) : emptyBlock(firstBlock + k, ts, at));
    }
  };
  return { store, chain, sched, sniper, backend, feed, second };
}

/** Replay AMLIL's curve trades (after the team buys) as node logs on our curve. */
async function replayTrades(h: ReturnType<typeof harness>, untilSec: number): Promise<void> {
  for (const [i, t] of amlil.trades.slice(2).entries()) {
    const rel = t.ts - amlil.meta.launchedAt;
    if (rel > untilSec) break;
    h.sched.t = (T + rel) * 1000 + 500;
    h.chain.emitTokenLog(
      curveTradeLog({ curve: LAUNCH.curve, side: t.side, trader: t.actor, recipient: t.recipient, quote: big(t.q), tokens: big(t.tok), fee: big(t.fee), tax: big(t.tax), block: LAUNCH.block + 9 + i, txHash: t.tx, logIndex: i }),
    );
    await settle(3); // let a triggered exit complete before the next trade, as on chain
  }
}

describe('paper mode end-to-end (AMLIL timeline on the SHIBA launch fixture)', () => {
  it('detects, plans the burst, fills at the first +1 s block (618 bps), takes profit and records everything', async () => {
    // R4-3: the mcap cap no longer replaces the slippage bound; a deployerIn play prices on the
    // pre-team reserves, so on AMLIL (+49 % in the launch second) it needs the video's 90 % slippage
    const h = harness({ buyEth: 0.07, maxEntryMcapEth: 4, slippageBps: 9000, takeProfits: [{ pct: 150, sellPct: 100 }], trailing: { activatePct: 1000, dropPct: 25 }, stopLossPct: 40 });
    await h.sniper.start();
    for (let s = 30; s >= 1; s--) h.second(T - s, LAUNCH.block - 2 - s * 10);
    h.second(T, LAUNCH.block - 2, 2, 0, 3); // … up to the launch block (3rd block of second T)
    await waitFor(() => h.sniper.activeRuns[0]?.plan !== undefined);
    h.second(T, LAUNCH.block - 2, 2, 3, 10); // rest of the launch second; team buys land in block +5
    const run = h.sniper.activeRuns[0]!;
    expect(run.launch.token).toBe(LAUNCH.token);
    expect(run.launch.addressSource).toBe('receipt');
    expect(run.decision.reasons.join()).toMatch(/deployerIn/);
    // planned burst: 10 members, 15 ms apart, first one 120 ms + rtt before the predicted first +1 s seal
    expect(run.burst).toHaveLength(10);
    expect(run.plan!.boundaryMs).toBeCloseTo((T + 1) * 1000 + OFFSET, 6);
    expect(run.burst[0]!.scheduledAt).toBeCloseTo((T + 1) * 1000 + OFFSET - 6 - 120, 6);
    expect(run.burst.every((m) => m.status === 'skipped')).toBe(true);
    expect(h.chain.calls.filter((c) => c.startsWith('getReserves'))).toEqual([`getReserves:${LAUNCH.curve}:latest`]); // the single decide-path call

    h.second(T + 1, LAUNCH.block + 8); // first +1 s block = LAUNCH.block + 8
    await waitFor(() => run.status === 'open');
    const want = quoteBuy(afterTeam(), parseEther('0.07'), CURVE_FEE_BPS, 0, snipeTaxWeiFor(parseEther('0.07'), 618));
    expect(run.fill).toMatchObject({ block: LAUNCH.block + 8, ts: T + 1, taxBps: 618, tokensOut: want, taxPaid: 4_326_000_000_000_000n });
    expect(h.chain.calls).toContain(`getReserves:${LAUNCH.curve}:${LAUNCH.block + 7}`);
    // the daily-loss base is the whole bankroll (free + the open position's 0.07), not the free balance
    expect(h.sniper.bankrollWei()).toBe(parseEther('0.03'));
    expect(h.sniper.totalBankrollEth()).toBeCloseTo(0.1, 12);
    const pos = h.sniper.positions.get(run.key)!;
    expect(pos).toBeDefined();

    await replayTrades(h, 120);
    await waitFor(() => run.status === 'closed');
    await h.sniper.recorder.idle();
    const rec = [...h.store.snipes.values()][0]!;
    expect(rec).toMatchObject({ playId: 9, mode: 'paper', status: 'closed', token: LAUNCH.token, curve: LAUNCH.curve, buyBlock: LAUNCH.block + 8 });
    expect(rec.realizedPnlEth!).toBeGreaterThan(0.07 * 1.5 * 0.99);
    const sale = (rec.sells as { reason: string; at: number }[])[0]!;
    expect(sale.reason).toBe('tp1');
    const exitAt = (sale.at - T * 1000) / 1000;
    expect(exitAt).toBeGreaterThan(2);
    expect(exitAt).toBeLessThan(60);
    expect((rec.burst as unknown[]).length).toBe(10);
    const types = h.store.notifications.map((n) => (JSON.parse(n) as { type: string }).type);
    expect(types).toEqual(expect.arrayContaining(['snipe_decided', 'snipe_armed', 'snipe_filled', 'snipe_sell', 'snipe_closed']));
    await h.sniper.recorder.flushFeed();
    expect(h.store.feedBlocks.length).toBe(320);
    // eslint-disable-next-line no-console
    console.log(`[paper] AMLIL replay: entry ${run.fill!.entryPrice.toExponential(3)} ETH/token, TP1 at +${exitAt}s, realized ${rec.realizedPnlEth!.toFixed(4)} ETH on 0.07`);
  });

  it('exits on the operator dump signal (exempt Transfer at +6 s) before any TP; TokenLaunched via ws', async () => {
    const h = harness({ buyEth: 0.07, maxEntryMcapEth: 4, slippageBps: 9000, takeProfits: [{ pct: 1000, sellPct: 100 }], exitIfExemptSellsPct: 1 }, { receipt: false });
    await h.sniper.start();
    for (let s = 10; s >= 1; s--) h.second(T - s, LAUNCH.block - 2 - s * 10);
    h.second(T, LAUNCH.block - 2, 2);
    await settle();
    // the node pushes TokenLaunched over ws; the receipt (still required, H1) exists from then on
    h.chain.receipts.set(LAUNCH.txHash, launchReceipt());
    h.chain.launchWatcher!(tokenLaunchedLog);
    await waitFor(() => h.sniper.activeRuns[0]?.plan !== undefined);
    expect(h.sniper.activeRuns[0]!.launch.addressSource).toBe('log');
    h.second(T + 1, LAUNCH.block + 8);
    const run = h.sniper.activeRuns[0]!;
    await waitFor(() => run.status === 'open');
    await replayTrades(h, 5);
    expect(run.status).toBe('open');
    h.chain.emitTokenLog(transferLog({ token: LAUNCH.token, from: LAUNCH.creatorFeeRecipient, to: '0xa98da960d6000000000000000000000000000000', value: 13_846_153n * 10n ** 18n, block: LAUNCH.block + 70, txHash: '0xdd', logIndex: 0 }));
    await waitFor(() => run.status === 'closed');
    const pos = [...h.store.snipes.values()][0]!;
    await h.sniper.recorder.idle();
    expect((([...h.store.snipes.values()][0]!.sells) as { reason: string }[])[0]!.reason).toBe('exempt_dump');
    expect(pos).toBeDefined();
  });

  it('default 30 % slippage vs. pre-team reserves fails on AMLIL (team bought 18 % → +49 % price)', async () => {
    const h = harness({ buyEth: 0.07, slippageBps: 3000 });
    await h.sniper.start();
    for (let s = 10; s >= 1; s--) h.second(T - s, LAUNCH.block - 2 - s * 10);
    h.second(T, LAUNCH.block - 2, 2);
    await waitFor(() => h.sniper.activeRuns[0]?.plan !== undefined);
    const run = h.sniper.activeRuns[0]!;
    h.second(T + 1, LAUNCH.block + 8);
    await waitFor(() => run.status !== 'pending');
    expect(run.status).toBe('failed');
    expect(run.notes.join()).toMatch(/paper: slippage/);
  });

  it('aborts when an exempt wallet sells in the launch second; risk blocks a second snipe of the same deployer', async () => {
    const h = harness({ buyEth: 0.07, maxEntryMcapEth: 4 });
    await h.sniper.start();
    for (let s = 10; s >= 1; s--) h.second(T - s, LAUNCH.block - 2 - s * 10);
    // launch second up to the team block
    for (let k = 0; k < 4; k++) {
      const at = T * 1000 + OFFSET + k * 100;
      h.feed(LAUNCH.block - 2 + k === LAUNCH.block ? launchBlock(at) : emptyBlock(LAUNCH.block - 2 + k, T, at));
    }
    await waitFor(() => h.sniper.activeRuns[0]?.plan !== undefined);
    const run = h.sniper.activeRuns[0]!;
    const { decodedTxFromRpc } = await import('@hood/core');
    const sell = decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'ab'.repeat(32)}`, from: LAUNCH.creatorFeeRecipient, to: LAUNCH.curve, value: 0n, input: `0xd04c6983${'0'.repeat(63)}1${'0'.repeat(128)}` });
    h.feed(emptyBlock(LAUNCH.block + 2, T, T * 1000 + OFFSET + 400, [sell]));
    await waitFor(() => run.status === 'aborted');
    expect(run.notes.join()).toMatch(/sold in the launch second/);
    // same deployer again (firstBuyOnly) → risk abort without touching the chain
    const again = await h.sniper.handleLaunch({ ...run.launch, txHash: `0x${'cd'.repeat(32)}`, token: undefined, curve: undefined, addressSource: undefined });
    expect(again!.status).toBe('aborted');
    expect(again!.notes.join()).toMatch(/firstBuyOnly/);
  });

  it('fallback: a TokenLaunched log the feed never showed is rebuilt from the node and handled', async () => {
    const h = harness({ buyEth: 0.07, maxEntryMcapEth: 4 });
    await h.sniper.start();
    for (let s = 10; s >= 1; s--) h.second(T - s, LAUNCH.block - 2 - s * 10);
    h.chain.txs.set(LAUNCH.txHash, launchFixture.tx);
    h.chain.blockTs.set(LAUNCH.block, T);
    h.sched.t = T * 1000 + 400;
    h.chain.launchWatcher!(tokenLaunchedLog);
    await waitFor(() => h.sniper.activeRuns[0]?.plan !== undefined, 2000);
    const run = h.sniper.activeRuns[0]!;
    expect(run.launch.source).toBe('log');
    expect(run.launch.addressSource).toBe('fallback');
    expect(h.sniper.counters.fallback_launches).toBe(1);
  });
});

describe('paper exit pricing (post-dump reserves)', () => {
  it('prices the exit on the post-state of the trigger block, not on the pre-dump book', async () => {
    const chain = new FakeChain();
    const preDump: Reserves = { quote: 2_000_000_000_000_000_000n, token: 9n * 10n ** 26n };
    const postDump: Reserves = { quote: 1_500_000_000_000_000_000n, token: 12n * 10n ** 26n };
    chain.latest.set(LAUNCH.curve, preDump);
    chain.atBlock = (_c, b) => (b === 777 ? postDump : undefined);
    const paper = new PaperExecutor({ chain, logger: silentLogger, book: () => preDump, creatorTaxBps: () => 0 });
    const tokensIn = 10n ** 24n;
    const order = { key: 'k', curve: LAUNCH.curve, token: LAUNCH.token, tokensIn, all: false, minQuoteOut: 0n, reason: 'exempt_dump', gasLimit: 1, maxFeeGwei: 1 };
    const atTrigger = await paper.exit({ ...order, atBlock: 777 });
    expect(atTrigger.ok).toBe(true);
    expect(atTrigger.quoteOut).toBe(quoteSell(postDump, tokensIn, CURVE_FEE_BPS, 0));
    expect(atTrigger.quoteOut).toBeLessThan(quoteSell(preDump, tokensIn, CURVE_FEE_BPS, 0));
    expect(chain.calls).toContain(`getReserves:${LAUNCH.curve}:777`);
    // no trigger block known (startup rebuild): the book is the fallback, as before
    const fallback = await paper.exit(order);
    expect(fallback.quoteOut).toBe(quoteSell(preDump, tokensIn, CURVE_FEE_BPS, 0));
  });
});
