/** Reviewer M1 (keys / nonces), L2 (last-moment kill switch), L8 (balances), L1 (zero exits) on the live executor. */
import { sniperAbi } from '@hood/contracts';
import { decodeFunctionData, parseEther, parseTransaction, recoverTransactionAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { LiveExecutor } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { ManualScheduler } from '../src/scheduler.js';
import type { SnipeRun } from '../src/types.js';
import { FakeChain, FakeSender } from './helpers/fakes.js';
import { LAUNCH, play } from './helpers/fixtures.js';

const SNIPER = '0x5151515151515151515151515151515151515151' as Address;
const EXIT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const BURST_A = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const BURST_B = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');

function mkRun(key: string): SnipeRun {
  const p = play({ id: 4, trigger: { deployerIn: [LAUNCH.deployer] } });
  return {
    id: 0,
    key,
    mode: 'live',
    playId: 4,
    launch: {
      event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 0, devBuyQuoteIn: 0n, pairToken: '0x0000000000000000000000000000000000000000', launchConfigId: 0n },
      block: LAUNCH.block,
      ts: LAUNCH.ts,
      receivedAt: 0,
      txHash: LAUNCH.txHash,
      token: LAUNCH.token,
      curve: LAUNCH.curve,
      source: 'feed',
    },
    decision: { play: p, preset: p.preset, reasons: [] },
    status: 'pending',
    decidedAt: 0,
    quoteIn: parseEther('0.07'),
    minTokensOut: 1n,
    maxTaxBps: 1000,
    deadlineBlock: LAUNCH.block + 40,
    burst: [],
    notes: [],
  };
}

function setup(accounts = [EXIT, BURST_A, BURST_B]) {
  const sched = new ManualScheduler(1_000_000);
  const chain = new FakeChain();
  chain.nonces.set(EXIT.address.toLowerCase(), 7);
  chain.nonces.set(BURST_A.address.toLowerCase(), 100);
  chain.nonces.set(BURST_B.address.toLowerCase(), 200);
  const a = new FakeSender('http://ohio', () => sched.now());
  const b = new FakeSender('http://node', () => sched.now());
  const alerts: { type: string; payload: Record<string, unknown> }[] = [];
  const ex = new LiveExecutor({
    accounts,
    sniper: SNIPER,
    chainId: 4663,
    senders: [a, b],
    chain,
    scheduler: sched,
    logger: silentLogger,
    receiptPollMs: 1,
    reconcileTimeoutMs: 60,
    exitReceiptTimeoutMs: 60,
    settleTimeoutMs: 10,
    onAlert: (type, payload) => alerts.push({ type, payload }),
  });
  return { sched, chain, a, b, ex, alerts };
}

const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function eventually(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met');
    await tick();
  }
}
const order = (run: SnipeRun, times: number[], guard?: () => string | null) => ({
  run,
  token: LAUNCH.token,
  curve: LAUNCH.curve,
  times,
  gasLimit: 300_000,
  maxFeeGwei: 1,
  priorityFeeGwei: 0,
  ...(guard ? { guard } : {}),
});

describe('M1: operator keys', () => {
  it('first key exits, the others are burst slots with their own nonce sequences; a third concurrent burst is refused', async () => {
    const { sched, a, ex } = setup();
    await ex.init();
    expect(ex.exitKey.address).toBe(EXIT.address.toLowerCase());
    expect(ex.burstKeys.map((k) => k.address)).toEqual([BURST_A.address.toLowerCase(), BURST_B.address.toLowerCase()]);
    const r1 = mkRun('r1');
    const r2 = mkRun('r2');
    const r3 = mkRun('r3');
    const t = sched.t;
    const f1 = ex.execute(order(r1, [t + 10, t + 20]));
    const f2 = ex.execute(order(r2, [t + 15, t + 25]));
    expect(await ex.execute(order(r3, [t + 30]))).toBeNull();
    expect(r3.notes.join()).toMatch(/no free burst key/);
    expect(ex.preflight({ quoteIn: 1n, gasLimit: 300_000, maxFeeGwei: 1 })).toEqual([expect.stringMatching(/no free burst key/)]);
    await eventually(() => r1.burst.length === 2 && r2.burst.length === 2);
    expect(r1.signer).toBe(BURST_A.address.toLowerCase());
    expect(r2.signer).toBe(BURST_B.address.toLowerCase());
    expect(r1.burst.map((m) => m.nonce)).toEqual([100, 101]);
    expect(r2.burst.map((m) => m.nonce)).toEqual([200, 201]);
    for (const m of [...r1.burst, ...r2.burst]) {
      const from = await recoverTransactionAddress({ serializedTransaction: m.raw as `0x02${string}` });
      expect(from.toLowerCase()).toBe((r1.burst.includes(m) ? BURST_A : BURST_B).address.toLowerCase());
    }
    sched.advance(t + 100);
    // exits never wait for a burst: separate key, separate nonce sequence
    expect(r1.burst.every((m) => m.status === 'sent') && r2.burst.every((m) => m.status === 'sent')).toBe(true); // both bursts in flight
    const before = a.sent.length;
    const res = await ex.exit({ key: 'pos', curve: LAUNCH.curve, token: LAUNCH.token, tokensIn: 5n, all: false, minQuoteOut: 0n, reason: 'tp1', gasLimit: 300_000, maxFeeGwei: 1 });
    expect(res).toMatchObject({ ok: false, unknown: true }); // no receipt in the fake chain → outcome unknown
    const exitRaw = a.sent[before]!.raw;
    const exitTx = parseTransaction(exitRaw);
    expect(exitTx.nonce).toBe(7); // exit key's own sequence, not behind the bursts' 100.. / 200..
    expect((await recoverTransactionAddress({ serializedTransaction: exitRaw as `0x02${string}` })).toLowerCase()).toBe(EXIT.address.toLowerCase());
    expect(decodeFunctionData({ abi: sniperAbi, data: exitTx.data! }).functionName).toBe('exit');
    await Promise.all([f1, f2]);
  });

  it('a member no endpoint accepted is re-sent once (same raw tx, same nonce)', async () => {
    const { sched, a, b, ex } = setup();
    await ex.init();
    a.failNext = 1;
    b.failNext = 1;
    const r = mkRun('rs');
    const t = sched.t;
    const fp = ex.execute(order(r, [t + 5]));
    await eventually(() => r.burst.length === 1);
    sched.advance(t + 10);
    await eventually(() => r.burst[0]!.sends.length === 4);
    expect(a.sent.map((s) => s.raw)).toEqual([r.burst[0]!.raw, r.burst[0]!.raw]);
    expect(r.burst[0]!.sends.filter((s) => s.ok)).toHaveLength(2);
    expect(ex.stats.resends).toBe(1);
    expect(r.burst[0]!.status).toBe('sent');
    await fp;
  });

  it('nonces a burst broadcast but the chain never consumed are filled with 0-value self-transfers; then the key resyncs', async () => {
    const { sched, a, chain, ex, alerts } = setup();
    await ex.init();
    const r = mkRun('gap');
    const t = sched.t;
    const fp = ex.execute(order(r, [t + 5, t + 10, t + 15]));
    await eventually(() => r.burst.length === 3);
    sched.advance(t + 20);
    expect(await fp).toBeNull(); // no receipts, chain nonce stays at 100
    await eventually(() => ex.stats.fillers === 3);
    const fillers = a.sent.slice(-3).map((s) => parseTransaction(s.raw));
    expect(fillers.map((f) => f.nonce)).toEqual([100, 101, 102]);
    expect(fillers.every((f) => f.to?.toLowerCase() === BURST_A.address.toLowerCase() && (f.value ?? 0n) === 0n && f.gas === 21_000n)).toBe(true);
    expect(alerts.some((x) => x.type === 'nonce_gap')).toBe(true);
    await eventually(() => !ex.burstKeys[0]!.inBurst);
    expect(ex.burstKeys[0]!.nonces.value).toBe(103);
    // once the chain caught up there is nothing to fill: the next burst resyncs to the chain
    chain.nonces.set(BURST_A.address.toLowerCase(), 103);
    const r2 = mkRun('next');
    const fp2 = ex.execute(order(r2, [sched.t + 5]));
    await eventually(() => r2.burst.length === 1);
    expect(r2.burst[0]!.nonce).toBe(103);
    chain.nonces.set(BURST_A.address.toLowerCase(), 104); // landed (reverted, say)
    sched.advance(sched.t + 10);
    await fp2;
    await eventually(() => !ex.burstKeys[0]!.inBurst);
    expect(ex.stats.fillers).toBe(3);
    expect(ex.burstKeys[0]!.nonces.value).toBe(104);
  });
});

describe('L2: last-moment kill switch', () => {
  it('a kill switch flipped after signing blocks the first send: nothing leaves, every member is skipped', async () => {
    const { sched, a, b, ex } = setup();
    await ex.init();
    let killed = false;
    const r = mkRun('kill');
    const t = sched.t;
    const fp = ex.execute(order(r, [t + 5, t + 10, t + 15], () => (killed ? 'kill switch on' : null)));
    await eventually(() => r.burst.length === 3);
    killed = true; // NOTIFY settings_changed lands between signing and the first send
    sched.advance(t + 50);
    expect(await fp).toBeNull();
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
    expect(r.burst.map((m) => m.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r.notes.join()).toMatch(/send blocked before the first member: kill switch on/);
    expect(ex.stats.guardBlocked).toBe(1);
  });
});

describe('L8: balance pre-checks', () => {
  it('contract ETH below quoteIn or a key below the gas minimum blocks the burst and alerts low_balance', async () => {
    const { chain, ex, alerts } = setup();
    chain.ethBalances.set(SNIPER, parseEther('0.05'));
    chain.ethBalances.set(BURST_A.address.toLowerCase(), parseEther('0.0001'));
    await ex.init();
    expect(alerts.filter((x) => x.type === 'low_balance').map((x) => x.payload.key)).toEqual([BURST_A.address.toLowerCase()]);
    const reasons = ex.preflight({ quoteIn: parseEther('0.07'), gasLimit: 300_000, maxFeeGwei: 1 });
    expect(reasons).toEqual([expect.stringMatching(/contract balance 0\.05 ETH < quoteIn 0\.07 ETH/), expect.stringMatching(/burst key .* gas balance 0\.0001 ETH < 0\.001 ETH/)]);
    chain.ethBalances.set(SNIPER, parseEther('1'));
    chain.ethBalances.set(BURST_A.address.toLowerCase(), parseEther('0.01'));
    chain.ethBalances.set(EXIT.address.toLowerCase(), 0n);
    await ex.refreshBalances();
    expect(ex.preflight({ quoteIn: parseEther('0.07'), gasLimit: 300_000, maxFeeGwei: 1 })).toEqual([expect.stringMatching(/exit key .*positions could not be exited/)]);
    chain.ethBalances.set(EXIT.address.toLowerCase(), parseEther('0.01'));
    await ex.refreshBalances();
    expect(ex.preflight({ quoteIn: parseEther('0.07'), gasLimit: 300_000, maxFeeGwei: 1 })).toEqual([]);
  });
});

describe('L1: zero-size exits', () => {
  it('exit(tokensIn = 0) is refused without signing; `all` exits use exitAll', async () => {
    const { a, ex } = setup();
    await ex.init();
    const z = await ex.exit({ key: 'p', curve: LAUNCH.curve, token: LAUNCH.token, tokensIn: 0n, all: false, minQuoteOut: 0n, reason: 'tp1', gasLimit: 300_000, maxFeeGwei: 1 });
    expect(z).toMatchObject({ ok: false, error: expect.stringMatching(/zero-size/) });
    expect(a.sent).toHaveLength(0);
    await ex.exit({ key: 'p', curve: LAUNCH.curve, token: LAUNCH.token, tokensIn: 123n, all: true, minQuoteOut: 9n, reason: 'stop_loss', gasLimit: 300_000, maxFeeGwei: 1 });
    const tx = parseTransaction(a.sent[0]!.raw);
    expect(tx.nonce).toBe(7); // exit key sequence
    const call = decodeFunctionData({ abi: sniperAbi, data: tx.data! });
    expect(call.functionName).toBe('exitAll');
    expect(call.args).toEqual([expect.stringMatching(new RegExp(LAUNCH.curve, 'i')), expect.stringMatching(new RegExp(LAUNCH.token, 'i')), 9n]);
  });
});
