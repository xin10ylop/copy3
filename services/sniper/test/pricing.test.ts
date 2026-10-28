import { mcapFromReserves, parsePreset, quoteBuy, snipeTaxWeiFor } from '@hood/core';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAUNCH_RESERVES, launchReserves, planMinOut, worstTaxBps } from '../src/pricing.js';

const START = DEFAULT_LAUNCH_RESERVES['0']!;

describe('pricing', () => {
  it('worst tax a member can pay is the largest schedule step ≤ maxTaxBps', () => {
    expect(worstTaxBps(1000)).toBe(618);
    expect(worstTaxBps(618)).toBe(618);
    expect(worstTaxBps(617)).toBe(19);
    expect(worstTaxBps(10)).toBe(0);
    expect(worstTaxBps(9900)).toBe(9900);
  });

  it('maxEntryMcapEth turns into an on-chain minTokensOut: above the cap the buy reverts', () => {
    const p = parsePreset({ buyEth: 0.07, maxEntryMcapEth: 4 });
    const q = parseEther('0.07');
    const plan = planMinOut(p, START, q, 200);
    expect(plan.basis).toBe('maxEntryMcap');
    const k = Number(START.quote) * Number(START.token);
    const at = (mcap: number) => {
      const Q = BigInt(Math.floor(Math.sqrt((k * mcap) / 1e9)));
      return { quote: Q, token: BigInt(Math.floor(k / Number(Q))) };
    };
    const out = (r: { quote: bigint; token: bigint }) => quoteBuy(r, q, 100, 200, snipeTaxWeiFor(q, 618));
    expect(mcapFromReserves(at(3.9))).toBeCloseTo(3.9, 6);
    expect(out(at(3.9))).toBeGreaterThan(plan.minTokensOut);
    expect(out(at(4.1))).toBeLessThan(plan.minTokensOut);
    expect(plan.expectedOut).toBeGreaterThan(plan.minTokensOut);
  });

  it('slippage basis: minOut = expected·(1 − slippage) at the worst allowed tax', () => {
    const p = parsePreset({ buyEth: 0.07, slippageBps: 3000 });
    const q = parseEther('0.07');
    const plan = planMinOut(p, START, q, 0);
    expect(plan).toMatchObject({ basis: 'slippage', taxBps: 618 });
    expect(plan.minTokensOut).toBe((plan.expectedOut * 7000n) / 10_000n);
  });

  it('launch reserves: config start, plus the exact untaxed dev buy for launchAndBuy', () => {
    expect(launchReserves(START, 0n, 200)).toBe(START);
    const r = launchReserves(START, parseEther('0.5'), 200);
    const out = quoteBuy(START, parseEther('0.5'), 100, 200, 0n);
    expect(r.token).toBe(START.token - out);
    expect(r.quote).toBe(START.quote + parseEther('0.5') - parseEther('0.005') - parseEther('0.01'));
    expect(mcapFromReserves(START)).toBeCloseTo(1.68, 9);
  });
});
