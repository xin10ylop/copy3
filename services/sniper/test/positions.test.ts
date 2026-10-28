import { decodedTxFromRpc, parsePreset, type Preset } from '@hood/core';
import { encodeFunctionData, parseAbi, parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ExecutionBackend, ExitOrder, ExitResult } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { evaluatePosition, newPositionState, applySale } from '../src/position-logic.js';
import { Positions } from '../src/positions.js';
import type { Fill, SnipeRun } from '../src/types.js';
import { FakeChain, transferLog } from './helpers/fakes.js';
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

function openRun(p: Positions, presetOver: Record<string, unknown>): { run: SnipeRun; fill: Fill } {
  const pl = play({ id: 1, trigger: { deployerIn: [LAUNCH.deployer] }, preset: presetOver });
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
  const reserves = { quote: 2_048_780_487_804_878_047n, token: 820_000_000n * 10n ** 18n };
  const fill: Fill = { block: LAUNCH.block + 9, ts: LAUNCH.ts + 1, quoteIn: parseEther('0.07'), tokensOut: 25_000_000n * 10n ** 18n, taxBps: 618, taxPaid: 0n, entryPrice: 0.07 / 25_000_000, reserves };
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
