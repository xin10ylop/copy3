import { TOPICS, decodedTxFromRpc, parsePreset, quoteSell, type Preset, type Reserves } from '@hood/core';
import { encodeFunctionData, parseAbi, parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ExecutionBackend, ExitOrder, ExitResult } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { evaluatePosition, newPositionState, applySale } from '../src/position-logic.js';
import { Positions } from '../src/positions.js';
import type { Fill, SnipeRun } from '../src/types.js';
import { FakeChain, curveTradeLog, transferLog } from './helpers/fakes.js';
import { LAUNCH, emptyBlock, launchFixture, play } from './helpers/fixtures.js';

const E = 1e-9; // entry price ETH/token
const T = 1_000_000n;
const preset = (o: Record<string, unknown> = {}): Preset => parsePreset({ takeProfits: [], trailing: undefined, ...o });

describe('evaluatePosition (state machine)', () => {
  it('take profit at +150 % sells everything', () => {
    const s = newPositionState(E, T, 0);
    const p = preset({ takeProfits: [{ pct: 150, sellPct: 100 }] });
    expect(evaluatePosition(s, E * 2.4, 1000, p)).toBeNull();
    const sig = evaluatePosition(s, E * 2.5, 1000, p)!;
    expect(sig).toMatchObject({ reason: 'tp1', sellTokens: T, all: true });
    expect(sig.pnlPct).toBeCloseTo(150, 6);
  });

  it('TP ladder: 100-125 % half, 200 % rest', () => {
    const s = newPositionState(E, T, 0);
    const p = preset({ takeProfits: [{ pct: 200, sellPct: 100 }, { pct: 110, sellPct: 50 }] });
    const a = evaluatePosition(s, E * 2.15, 1, p)!;
    expect(a).toMatchObject({ reason: 'tp1', sellTokens: T / 2n, all: false });
    applySale(s, a, a.sellTokens);
    expect(evaluatePosition(s, E * 2.2, 2, p)).toBeNull();
    const b = evaluatePosition(s, E * 3.0, 3, p)!;
    expect(b).toMatchObject({ reason: 'tp2', sellTokens: T / 2n, all: true });
    applySale(s, b, b.sellTokens);
    expect(s.tokensHeld).toBe(0n);
    expect(evaluatePosition(s, E * 5, 4, p)).toBeNull();
  });

  it('trailing stop: arms at +100 %, exits on a 25 % pullback from the peak', () => {
    const s = newPositionState(E, T, 0);
    const p = preset({ trailing: { activatePct: 100, dropPct: 25 } });
    expect(evaluatePosition(s, E * 1.9, 1, p)).toBeNull();
    expect(s.trailingArmed).toBe(false);
    expect(evaluatePosition(s, E * 1.5, 2, p)).toBeNull(); // pullback before activation: nothing
    expect(evaluatePosition(s, E * 2.0, 3, p)).toBeNull();
    expect(s.trailingArmed).toBe(true);
    expect(evaluatePosition(s, E * 4.0, 4, p)).toBeNull(); // new peak +300 %
    expect(evaluatePosition(s, E * 3.01, 5, p)).toBeNull(); // −24.75 %
    const sig = evaluatePosition(s, E * 3.0, 6, p)!; // −25 % from 4.0
    expect(sig).toMatchObject({ reason: 'trailing', all: true, sellTokens: T });
    expect(sig.pnlPct).toBeCloseTo(200, 6);
  });

  it('stop loss at −40 %', () => {
    const s = newPositionState(E, T, 0);
    const p = preset({ stopLossPct: 40 });
    expect(evaluatePosition(s, E * 0.61, 1, p)).toBeNull();
    expect(evaluatePosition(s, E * 0.6, 2, p)).toMatchObject({ reason: 'stop_loss', all: true });
  });

  it('timeout', () => {
    const s = newPositionState(E, T, 10_000);
    const p = preset({ timeoutSec: 30 });
    expect(evaluatePosition(s, E, 39_999, p)).toBeNull();
    expect(evaluatePosition(s, E, 40_000, p)).toMatchObject({ reason: 'timeout', all: true });
  });

  it('operator dump (exempt outflow ≥ threshold) beats everything', () => {
    const s = newPositionState(E, T, 0);
    const p = preset({ exitIfExemptSellsPct: 5, takeProfits: [{ pct: 150, sellPct: 100 }] });
    s.exemptOutflowPct = 4;
    expect(evaluatePosition(s, E * 1.4, 1, p)).toBeNull();
    s.exemptOutflowPct = 7.7; // one of 13 AMLIL batches
    expect(evaluatePosition(s, E * 3, 1, p)).toMatchObject({ reason: 'exempt_dump', all: true });
  });
});

class RecordingBackend implements ExecutionBackend {
  readonly mode = 'paper' as const;
  exits: ExitOrder[] = [];
  failFirst = 0;
  async execute(): Promise<Fill | null> {
    return null;
  }
  abort(): number {
    return 0;
  }
  onFeedBlock(): void {}
  async exit(o: ExitOrder): Promise<ExitResult> {
    this.exits.push(o);
    if (this.failFirst-- > 0) return { ok: false, tokensIn: o.tokensIn, quoteOut: 0n, error: 'reverted' };
    return { ok: true, tokensIn: o.tokensIn, quoteOut: (o.minQuoteOut * 100n) / 85n };
  }
}

function openRun(
  p: Positions,
  presetOver: Record<string, unknown>,
  o: { preset?: Preset; reserves?: Reserves; reservesBlock?: number } = {},
): { run: SnipeRun; fill: Fill } {
  const pl = play({ id: 1, trigger: { deployerIn: [LAUNCH.deployer] }, preset: presetOver });
  if (o.preset) pl.preset = o.preset;
  const run = {
    id: 1,
    key: 'pos1',
    mode: 'paper',
    playId: 1,
    launch: {
      event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [LAUNCH.deployer, LAUNCH.creatorFeeRecipient], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 200, devBuyQuoteIn: 0n, pairToken: '0x0000000000000000000000000000000000000000', launchConfigId: 0n },
      block: LAUNCH.block,
      ts: LAUNCH.ts,
      receivedAt: 0,
      txHash: LAUNCH.txHash,
      token: LAUNCH.token,
      curve: LAUNCH.curve,
      source: 'feed',
    },
    decision: { play: pl, preset: pl.preset, reasons: [] },
    status: 'open',
    decidedAt: 0,
    quoteIn: parseEther('0.07'),
    minTokensOut: 0n,
    maxTaxBps: 1000,
    deadlineBlock: 0,
    burst: [],
    notes: [],
  } satisfies SnipeRun;
  // AMLIL state after the team buys: Q = 2.0488 ETH, T = 8.2e26
  const reserves = o.reserves ?? { quote: 2_048_780_487_804_878_047n, token: 820_000_000n * 10n ** 18n };
  const fill: Fill = {
    block: LAUNCH.block + 9,
    ts: LAUNCH.ts + 1,
    quoteIn: parseEther('0.07'),
    tokensOut: 25_000_000n * 10n ** 18n,
    taxBps: 618,
    taxPaid: 0n,
    entryPrice: 0.07 / 25_000_000,
    reserves,
    ...(o.reservesBlock !== undefined ? { reservesBlock: o.reservesBlock } : {}),
  };
  p.openPosition(run, fill, pl.preset, run.launch.event.exemptions);
  return { run, fill };
}

describe('Positions manager', () => {
  it('exits on the first exempt Transfer to a dump wallet (AMLIL pattern), via node logs', async () => {
    const chain = new FakeChain();
    chain.balances.set(LAUNCH.creatorFeeRecipient, 180_000_000n * 10n ** 18n);
    const be = new RecordingBackend();
    let closed = 0;
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0, onClosed: () => closed++ });
    openRun(p, { exitIfExemptSellsPct: 1, takeProfits: [{ pct: 1000, sellPct: 100 }] });
    await new Promise((r) => setTimeout(r, 1)); // baseline balances
    // exempt → exempt is not a dump
    chain.emitTokenLog(transferLog({ token: LAUNCH.token, from: LAUNCH.creatorFeeRecipient, to: LAUNCH.deployer, value: 10n ** 24n, block: 1, txHash: '0xaa', logIndex: 0 }));
    expect(be.exits).toHaveLength(0);
    // first of 13 batches: 13.8M of 180M (7.7 %) to the dump wallet
    chain.emitTokenLog(transferLog({ token: LAUNCH.token, from: LAUNCH.creatorFeeRecipient, to: '0xa98da960d6000000000000000000000000000000', value: 13_846_153n * 10n ** 18n, block: 2, txHash: '0xbb', logIndex: 0 }));
    await new Promise((r) => setTimeout(r, 1));
    expect(be.exits).toHaveLength(1);
    expect(be.exits[0]).toMatchObject({ reason: 'exempt_dump', tokensIn: 25_000_000n * 10n ** 18n, token: LAUNCH.token, curve: LAUNCH.curve });
    expect(closed).toBe(1);
    expect(p.open).toHaveLength(0);
  });

  it('exits on an exempt `transfer` call seen in the feed (before the log arrives) and retries failed exits', async () => {
    const chain = new FakeChain();
    const be = new RecordingBackend();
    be.failFirst = 1;
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0 });
    openRun(p, { exitIfExemptSellsPct: 1, takeProfits: [{ pct: 1000, sellPct: 100 }] });
    const data = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: ['0xa98da960d6000000000000000000000000000000' as Address, 10n ** 24n] });
    const tx = decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'77'.repeat(32)}`, from: LAUNCH.deployer, to: LAUNCH.token, input: data, value: 0n });
    await p.onFeedBlock(emptyBlock(LAUNCH.block + 60, LAUNCH.ts + 6, 0, [tx]));
    await new Promise((r) => setTimeout(r, 1));
    expect(be.exits.map((e) => e.reason)).toEqual(['exempt_dump', 'exempt_dump']);
    // retry widens slippage: 15 % then 40 % below the expected quote
    const [first, second] = be.exits.map((e) => Number(e.minQuoteOut));
    expect(second! / first!).toBeCloseTo(0.6 / 0.85, 6);
    // the same tx's Transfer log is not double counted
    chain.emitTokenLog(transferLog({ token: LAUNCH.token, from: LAUNCH.deployer, to: '0xa98da960d6000000000000000000000000000000', value: 10n ** 24n, block: 3, txHash: tx.hash, logIndex: 0 }));
    expect(be.exits).toHaveLength(2);
  });

  it('prices from CurveBuy logs and takes profit; timeout closes a flat position', async () => {
    const chain = new FakeChain();
    const be = new RecordingBackend();
    let now = 0;
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => now });
    openRun(p, { takeProfits: [{ pct: 100, sellPct: 100 }], timeoutSec: 60 });
    // big buys push the price ~ +150 %
    p.onReserves(LAUNCH.curve, { quote: 5_000_000_000_000_000_000n, token: 336_000_000n * 10n ** 18n });
    await new Promise((r) => setTimeout(r, 1));
    expect(be.exits.map((e) => e.reason)).toEqual(['tp1']);

    const chain2 = new FakeChain();
    const be2 = new RecordingBackend();
    const p2 = new Positions({ backend: be2, chain: chain2, logger: silentLogger, now: () => now });
    now = 0;
    openRun(p2, { takeProfits: [{ pct: 500, sellPct: 100 }], timeoutSec: 30 });
    now = 29_999;
    p2.tick();
    expect(be2.exits).toHaveLength(0);
    now = 30_000;
    p2.tick();
    await new Promise((r) => setTimeout(r, 1));
    expect(be2.exits.map((e) => e.reason)).toEqual(['timeout']);
  });
});

// ---------------------------------------------------------------------------------- review fixes
class ScriptedExitBackend implements ExecutionBackend {
  readonly mode: 'live' | 'paper';
  exits: ExitOrder[] = [];
  /** default: the exit is mined and reverts on chain (a verdict, counts toward `stuck`) */
  result: (o: ExitOrder) => ExitResult = (o) => ({ ok: false, tokensIn: o.tokensIn, quoteOut: 0n, error: 'exit reverted', reverted: true });
  constructor(mode: 'live' | 'paper' = 'live') {
    this.mode = mode;
  }
  async execute(): Promise<Fill | null> {
    return null;
  }
  abort(): number {
    return 0;
  }
  onFeedBlock(): void {}
  async exit(o: ExitOrder): Promise<ExitResult> {
    this.exits.push(o);
    return this.result(o);
  }
}

const SNIPER = '0x5151515151515151515151515151515151515151' as Address;
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe('H4: exits are capped, back off, read the chain, and stop on graduation', () => {
  it('PoC1: a permanently failing exit sends one round (3 txs), backs off 3 s / 6 s, then is stuck after 3 rounds — never retried forever', async () => {
    const chain = new FakeChain();
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 25_000_000n * 10n ** 18n });
    const be = new ScriptedExitBackend();
    let now = 0;
    const alerts: string[] = [];
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => now, sniper: SNIPER, onAlert: (_p, t) => alerts.push(t) });
    const { run } = openRun(p, { timeoutSec: 1 });
    now = 5_000;
    for (let i = 0; i < 20; i++) {
      p.tick();
      await flush();
    }
    expect(be.exits).toHaveLength(3); // the reviewer saw 60 txs in 20 ticks
    expect(p.get(run.key)!.exitRounds).toBe(1);
    expect(p.get(run.key)!.nextExitAt).toBe(8_000);
    now = 7_999;
    p.tick();
    await flush();
    expect(be.exits).toHaveLength(3);
    now = 8_000;
    p.tick();
    await flush();
    expect(be.exits).toHaveLength(6);
    expect(p.get(run.key)!.nextExitAt).toBe(8_000 + 6_000);
    now = 14_000;
    p.tick();
    await flush();
    expect(be.exits).toHaveLength(9);
    expect(p.get(run.key)!.phase).toBe('stuck');
    expect(alerts).toEqual(['position_stuck']);
    now = 1e9;
    for (let i = 0; i < 10; i++) p.tick();
    await flush();
    expect(be.exits).toHaveLength(9);
    expect(p.open).toHaveLength(1); // still holds tokens (needs manual action), not closed
  });

  it('a receipt-less exit that actually sold is booked from balanceOf(sniper) (no second sell stacked on top)', async () => {
    const chain = new FakeChain();
    const be = new ScriptedExitBackend();
    be.result = (o) => {
      chain.holdings.set(LAUNCH.token, { bought: true, balance: 0n }); // it did land
      return { ok: false, tokensIn: o.tokensIn, quoteOut: 0n, error: 'exit receipt timeout', unknown: true };
    };
    const alerts: string[] = [];
    let closedPnl: number | null = null;
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0, sniper: SNIPER, onAlert: (_p, t) => alerts.push(t), onClosed: (_p, pnl) => (closedPnl = pnl) });
    const { run } = openRun(p, { takeProfits: [{ pct: 50, sellPct: 100 }] });
    p.onReserves(LAUNCH.curve, { quote: 5_000_000_000_000_000_000n, token: 336_000_000n * 10n ** 18n });
    await flush();
    expect(be.exits).toHaveLength(1);
    expect(alerts).toEqual(['sale_from_chain']);
    expect(p.get(run.key)).toBeUndefined();
    expect(closedPnl).not.toBeNull();
  });

  it('graduation: an AlreadyGraduated / graduated() curve moves the position to the terminal graduated phase (alert + hook), no retries', async () => {
    const chain = new FakeChain();
    chain.graduated.add(LAUNCH.curve);
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 25_000_000n * 10n ** 18n });
    const be = new ScriptedExitBackend();
    const alerts: { type: string; detail: Record<string, unknown> }[] = [];
    const hooked: string[] = [];
    let now = 0;
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => now, sniper: SNIPER, onAlert: (_p, type, detail) => alerts.push({ type, detail }), onGraduated: (x) => hooked.push(x.key) });
    const { run } = openRun(p, { timeoutSec: 1 });
    now = 2_000;
    p.tick();
    await flush();
    expect(be.exits).toHaveLength(3);
    const pos = p.get(run.key)!;
    expect(pos.phase).toBe('graduated');
    expect(alerts.map((a) => a.type)).toEqual(['position_graduated']);
    expect(String(alerts[0]!.detail.action)).toMatch(/sweepToken.*Uniswap v4/);
    expect(hooked).toEqual([run.key]);
    now = 1e9;
    p.tick();
    await flush();
    expect(be.exits).toHaveLength(3);
    // swept + sold manually: the periodic re-check closes it from chain state
    chain.holdings.set(LAUNCH.token, { bought: true, balance: 0n });
    await p.recheck();
    expect(p.get(run.key)).toBeUndefined();
  });

  it('a CurveCompleted log marks the position graduated before any exit is attempted', async () => {
    const chain = new FakeChain();
    const be = new ScriptedExitBackend();
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0, sniper: SNIPER });
    const { run } = openRun(p, {});
    p.onLog({ address: LAUNCH.curve, topics: [TOPICS.CurveCompleted], data: `0x${'0'.repeat(192)}`, blockNumber: 10, transactionHash: '0xcc', logIndex: 0 });
    expect(p.get(run.key)!.phase).toBe('graduated');
    expect(be.exits).toHaveLength(0);
  });
});

describe('M5: reserves at an explicit block, logs at or below it ignored', () => {
  it('a snapshot that already contains a sell is never combined with that sell again (no phantom stop loss)', async () => {
    const chain = new FakeChain();
    const be = new RecordingBackend();
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0 });
    const pl = play({ id: 1, trigger: { deployerIn: [LAUNCH.deployer] }, preset: { stopLossPct: 40, trailing: null, timeoutSec: 3600 } });
    const r0 = { quote: 2_048_780_487_804_878_047n, token: 820_000_000n * 10n ** 18n };
    const { run } = openRun(p, {}, { preset: pl.preset, reserves: r0, reservesBlock: 100 });
    const pos = p.get(run.key)!;
    // a big sell at block 101: mark −35 % once, −48 % if it were counted twice
    const sellTokens = 110_000_000n * 10n ** 18n;
    const gross = (r0.quote * sellTokens) / (r0.token + sellTokens);
    const sellLog = curveTradeLog({ curve: LAUNCH.curve, side: 'sell', trader: LAUNCH.deployer, recipient: LAUNCH.deployer, quote: gross - gross / 100n, tokens: sellTokens, fee: gross / 100n, tax: 0n, block: 101, txHash: '0x5e11', logIndex: 0 });
    const after = { quote: r0.quote - gross, token: r0.token + sellTokens };
    // the poll's snapshot read AT block 101 arrives first (node ahead of the ws log) …
    p.onReserves(LAUNCH.curve, after, 101);
    // … then the log of the same sell: already contained → ignored
    p.onLog(sellLog);
    expect(pos.reserves).toEqual(after);
    expect(p.stats.staleLogs).toBe(1);
    // an older snapshot (another endpoint lagging) cannot roll the book back
    p.onReserves(LAUNCH.curve, r0, 100);
    expect(pos.reserves).toEqual(after);
    expect(pos.lastPnlPct!).toBeGreaterThan(-40);
    const twice = { quote: after.quote - gross, token: after.token + sellTokens };
    const held = pos.state.tokensHeld;
    expect((Number(quoteSell(twice, held, 100, 200)) / Number(held) / pos.state.entryPrice - 1) * 100).toBeLessThan(-40);
    await flush();
    expect(be.exits).toHaveLength(0); // the old code applied the sell twice: −51 % → phantom stop loss
    // a later trade (block 102) is a delta on top of the 101 snapshot, and the 102 snapshot replaces it exactly
    const buy = curveTradeLog({ curve: LAUNCH.curve, side: 'buy', trader: LAUNCH.deployer, recipient: LAUNCH.deployer, quote: 10n ** 17n, tokens: 30_000_000n * 10n ** 18n, fee: 10n ** 15n, tax: 0n, block: 102, txHash: '0xb0b', logIndex: 0 });
    p.onLog(buy);
    const withBuy = { quote: after.quote + 10n ** 17n - 10n ** 15n, token: after.token - 30_000_000n * 10n ** 18n };
    expect(pos.reserves).toEqual(withBuy);
    p.onReserves(LAUNCH.curve, withBuy, 102);
    expect(pos.reserves).toEqual(withBuy);
    expect(pos.book.deltas.size).toBe(0);
  });
});

describe('L1: zero-size take-profit levels', () => {
  it('a level whose share rounds to 0 tokens is consumed without an order; the next level still fires', () => {
    const s = newPositionState(E, 3n, 0);
    const p = preset({ takeProfits: [{ pct: 10, sellPct: 1 }, { pct: 20, sellPct: 100 }] });
    expect(evaluatePosition(s, E * 1.15, 1, p)).toBeNull(); // 1 % of 3 wei = 0
    expect(s.tpHit).toBe(1);
    expect(evaluatePosition(s, E * 1.25, 2, p)).toMatchObject({ reason: 'tp2', sellTokens: 3n, all: true });
  });

  it('the position manager never sends a zero-size exit', async () => {
    const chain = new FakeChain();
    const be = new RecordingBackend();
    const p = new Positions({ backend: be, chain, logger: silentLogger, now: () => 0 });
    openRun(p, { takeProfits: [{ pct: 10, sellPct: 0 }] });
    p.onReserves(LAUNCH.curve, { quote: 5_000_000_000_000_000_000n, token: 336_000_000n * 10n ** 18n });
    await flush();
    expect(be.exits).toHaveLength(0);
  });
});
