import { sniperAbi } from '@hood/contracts';
import { SequencerClock, TOPICS, parsePreset, type RawLog } from '@hood/core';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseEther, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import type { ReceiptLite } from '../src/chain.js';
import { LiveExecutor, NonceManager, decodeSniped } from '../src/executor.js';
import { silentLogger } from '../src/log.js';
import { ManualScheduler } from '../src/scheduler.js';
import type { SnipeRun } from '../src/types.js';
import { FakeChain, FakeSender } from './helpers/fakes.js';
import { LAUNCH, play } from './helpers/fixtures.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const; // test key, no funds
const SNIPER = '0x5151515151515151515151515151515151515151' as Address;
const account = privateKeyToAccount(PK);

function run(): SnipeRun {
  const p = play({ id: 4, trigger: { deployerIn: [LAUNCH.deployer] } });
  return {
    id: 0,
    key: 'k1',
    mode: 'live',
    playId: 4,
    launch: {
      event: { deployer: LAUNCH.deployer, name: 'SHIBA INU', symbol: 'SHIB', launchKind: 'launchToken', exemptions: [], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 0, devBuyQuoteIn: 0n, pairToken: '0x0000000000000000000000000000000000000000', launchConfigId: 0n },
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
    minTokensOut: 123_456n,
    maxTaxBps: 1000,
    deadlineBlock: LAUNCH.block + 40,
    burst: [],
    notes: [],
  };
}

function snipedLog(tokensOut: bigint, taxBps: bigint): RawLog {
  const topics = encodeEventTopics({ abi: sniperAbi, eventName: 'Sniped', args: { token: LAUNCH.token, curve: LAUNCH.curve } });
  return {
    address: SNIPER,
    topics: topics as string[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [parseEther('0.07'), tokensOut, taxBps]),
    blockNumber: LAUNCH.block + 9,
    transactionHash: '0x',
    logIndex: 3,
  };
}

function setup(): { sched: ManualScheduler; chain: FakeChain; a: FakeSender; b: FakeSender; ex: LiveExecutor; finals: SnipeRun[] } {
  const sched = new ManualScheduler(1_000_000);
  const chain = new FakeChain();
  chain.nonce = 42;
  const a = new FakeSender('http://ohio', () => sched.now());
  const b = new FakeSender('http://node', () => sched.now(), true);
  const finals: SnipeRun[] = [];
  const ex = new LiveExecutor({
    account,
    sniper: SNIPER,
    chainId: 4663,
    senders: [a, b],
    chain,
    scheduler: sched,
    logger: silentLogger,
    blockTs: (n) => (n === LAUNCH.block + 9 ? LAUNCH.ts + 1 : undefined),
    receiptPollMs: 1,
    reconcileTimeoutMs: 300,
    settleTimeoutMs: 20,
    onFinal: (r) => finals.push(r),
  });
  return { sched, chain, a, b, ex, finals };
}

describe('LiveExecutor burst', () => {
  it('plans from the clock, pre-signs consecutive nonces and fires each member at its time to every endpoint', async () => {
    const { sched, chain, a, b, ex, finals } = setup();
    await ex.init();
    expect(ex.nonces.value).toBe(42);
    // calibrated clock: first block of each second arrives 40 ms after the tick
    const clock = new SequencerClock();
    for (let s = 0; s < 20; s++) for (let k = 0; k < 10; k++) clock.ingest(LAUNCH.ts - 20 + s, (LAUNCH.ts - 20 + s) * 1000 + 40 + k * 100, 1000 + s * 10 + k);
    sched.t = LAUNCH.ts * 1000 + 300; // launch seen 300 ms into the second
    const preset = parsePreset({});
    const times = clock.burstSchedule({ launchTs: LAUNCH.ts, now: sched.now(), burst: preset.burst, rttMs: 6 });
    expect(times).toHaveLength(10);
    const r = run();
    const fillP = ex.execute({ run: r, token: LAUNCH.token, curve: LAUNCH.curve, times, gasLimit: 300_000, maxFeeGwei: 1, priorityFeeGwei: 0 });
    await expectEventually(() => r.burst.length === 10); // signing
    expect(r.burst.map((m) => m.nonce)).toEqual([42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
    expect(ex.nonces.value).toBe(52);
    expect(a.sent).toHaveLength(0);

    // members leave exactly at boundary − rtt − 120 + i·15
    const boundary = (LAUNCH.ts + 1) * 1000 + 40;
    sched.advance(boundary + 100);
    await new Promise((res) => setTimeout(res, 1));
    expect(a.sent.map((s) => s.at)).toEqual(times);
    expect(times[0]).toBeCloseTo(boundary - 6 - 120, 6);
    expect(a.sent.map((s) => s.at - a.sent[0]!.at)).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120, 135]);
    expect(b.sent).toHaveLength(10); // fan-out, even though this endpoint errors
    expect(r.burst.every((m) => m.sends.length === 2 && m.sends.some((s) => !s.ok && s.error === 'boom'))).toBe(true);

    // every raw tx: EIP-1559, chain 4663, to the sniper, snipe(curve, token, quoteIn, minOut, maxTax, deadline)
    for (const [i, m] of r.burst.entries()) {
      expect(m.hash).toBe(keccak256(m.raw));
      const tx = parseTransaction(m.raw);
      expect(tx).toMatchObject({ type: 'eip1559', chainId: 4663, nonce: 42 + i, to: SNIPER });
      expect(tx.value ?? 0n).toBe(0n);
      expect(await recoverTransactionAddress({ serializedTransaction: m.raw as `0x02${string}` })).toBe(account.address);
      const call = decodeFunctionData({ abi: sniperAbi, data: tx.data! });
      expect(call.functionName).toBe('snipe');
      expect(call.args).toEqual([expect.stringMatching(new RegExp(LAUNCH.curve, 'i')), expect.stringMatching(new RegExp(LAUNCH.token, 'i')), parseEther('0.07'), 123_456n, 1000, BigInt(LAUNCH.block + 40)]);
    }

    // receipts: members 0-2 landed in T blocks (TaxTooHigh), 3 bought, 4-8 AlreadyBought, 9 dropped
    const rc = (i: number, status: 'success' | 'reverted', logs: RawLog[] = []): void => {
      chain.receipts.set(r.burst[i]!.hash, { transactionHash: r.burst[i]!.hash, status, blockNumber: LAUNCH.block + (i < 3 ? 8 : 9), gasUsed: 30_000n, logs });
    };
    for (let i = 0; i < 9; i++) rc(i, i === 3 ? 'success' : 'reverted', i === 3 ? [snipedLog(25_000_000n * 10n ** 18n, 618n), { address: LAUNCH.curve, topics: [TOPICS.SnipeTaxCharged, `0x${'0'.repeat(64)}`], data: `0x${(4_326_000_000_000_000n).toString(16).padStart(64, '0')}` }] : []);
    chain.nonce = 51; // member 9 never landed
    const fill = await fillP;
    expect(fill).toMatchObject({ block: LAUNCH.block + 9, ts: LAUNCH.ts + 1, taxBps: 618, tokensOut: 25_000_000n * 10n ** 18n, taxPaid: 4_326_000_000_000_000n, quoteIn: parseEther('0.07') });
    expect(fill!.entryPrice).toBeCloseTo(0.07 / 25_000_000, 15);
    await expectEventually(() => finals.length === 1);
    expect(r.burst.map((m) => m.status)).toEqual(['reverted', 'reverted', 'reverted', 'mined', 'reverted', 'reverted', 'reverted', 'reverted', 'reverted', 'dropped']);
    // M1: the dropped member's nonce (51) was broadcast but never consumed → filled with a
    // 0-value self-transfer so it cannot execute later, and the key continues after it
    const filler = parseTransaction(a.sent.at(-1)!.raw);
    expect(filler).toMatchObject({ nonce: 51, gas: 21_000n });
    expect(filler.to?.toLowerCase()).toBe(account.address.toLowerCase());
    expect(filler.value ?? 0n).toBe(0n);
    expect(ex.stats.fillers).toBe(1);
    expect(ex.nonces.value).toBe(52);
  });

  it('reconciliation is idempotent: duplicate receipts never create a second fill', async () => {
    const { ex } = setup();
    const r = run();
    r.burst = [0, 1].map((i) => ({ index: i, nonce: i, hash: `0x${String(i).repeat(64)}` as Hex, raw: '0x' as Hex, scheduledAt: 0, sends: [], status: 'sent' as const }));
    const receipt: ReceiptLite = { transactionHash: r.burst[0]!.hash, status: 'success', blockNumber: LAUNCH.block + 9, gasUsed: 1n, logs: [snipedLog(5n, 618n)] };
    const f1 = await ex.mergeReceipt(r, r.burst[0]!, receipt, LAUNCH.curve);
    const f2 = await ex.mergeReceipt(r, r.burst[0]!, receipt, LAUNCH.curve);
    const f3 = await ex.mergeReceipt(r, r.burst[1]!, { ...receipt, transactionHash: r.burst[1]!.hash }, LAUNCH.curve);
    expect(f1).not.toBeNull();
    expect(f2).toBeNull();
    expect(f3).toBeNull(); // a second "success" cannot overwrite the fill
    expect(r.fill).toBe(f1);
    expect(r.burst.map((m) => m.status)).toEqual(['mined', 'mined']);
    expect(ex.stats.fills).toBe(1);
  });

  it('abort cancels members that have not been sent yet', async () => {
    const { sched, a, ex } = setup();
    await ex.init();
    const r = run();
    const times = [sched.t + 10, sched.t + 25, sched.t + 40];
    void ex.execute({ run: r, token: LAUNCH.token, curve: LAUNCH.curve, times, gasLimit: 300_000, maxFeeGwei: 1, priorityFeeGwei: 0 });
    await new Promise((res) => setTimeout(res, 5));
    sched.advance(sched.t + 12);
    expect(ex.abort('k1')).toBe(3);
    sched.advance(sched.t + 100);
    expect(a.sent).toHaveLength(1);
    expect(r.burst.map((m) => m.status)).toEqual(['sent', 'skipped', 'skipped']);
  });

  it('signing cost of a 10-member burst (the remaining post-receipt latency)', async () => {
    const { ex } = setup();
    await ex.init();
    const r = run();
    await ex.sign({ run: r, token: LAUNCH.token, curve: LAUNCH.curve, times: [0], gasLimit: 300_000, maxFeeGwei: 1, priorityFeeGwei: 0 }); // warm-up
    const t0 = performance.now();
    const m = await ex.sign({ run: r, token: LAUNCH.token, curve: LAUNCH.curve, times: Array.from({ length: 10 }, (_, i) => i), gasLimit: 300_000, maxFeeGwei: 1, priorityFeeGwei: 0 });
    const ms = performance.now() - t0;
    expect(m).toHaveLength(10);
    // eslint-disable-next-line no-console
    console.log(`[executor] signed 10 burst txs in ${ms.toFixed(2)} ms (${(ms / 10).toFixed(2)} ms/tx)`);
  });

  it('NonceManager only resyncs when nothing is in flight', () => {
    const n = new NonceManager();
    n.set(10);
    expect(n.take(3)).toEqual([10, 11, 12]);
    expect(n.resync(11)).toBe(false);
    n.release();
    expect(n.resync(11)).toBe(true);
    expect(n.value).toBe(11);
  });

  it('decodeSniped ignores logs from other contracts', () => {
    expect(decodeSniped([{ ...snipedLog(1n, 0n), address: LAUNCH.curve }], SNIPER)).toBeNull();
    expect(decodeSniped([snipedLog(7n, 19n)], SNIPER)).toMatchObject({ tokensOut: 7n, taxBps: 19 });
  });
});

async function expectEventually(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 2));
  }
}
