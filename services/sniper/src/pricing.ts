/** Entry pricing helpers: worst-case snipe tax, expected tokens and the on-chain minTokensOut. */
import { CURVE_FEE_BPS, minOutWithSlippage, quoteBuy, snipeTaxWeiFor, type Preset, type Reserves } from '@hood/core';

/** The snipe-tax schedule only takes these values (9900 >> {0,4,9,14}). */
export const SNIPE_TAX_STEPS = [9900, 618, 19, 0] as const;

/** Largest scheduled tax ≤ maxTaxBps: the worst tax a burst member can actually pay. */
export function worstTaxBps(maxTaxBps: number): number {
  return SNIPE_TAX_STEPS.find((s) => s <= maxTaxBps) ?? 0;
}

export interface MinOutPlan {
  expectedOut: bigint;
  minTokensOut: bigint;
  taxBps: number;
  basis: 'maxEntryMcap' | 'slippage';
}

/**
 * minTokensOut for the burst:
 *  - with `maxEntryMcapEth`: tokens a buy would get when the pre-trade price equals the cap
 *    (k = Q·T is invariant on the curve, so Q' = √(k·p), T' = k/Q'). The contract then refuses
 *    any entry above that mcap — enforced at execution time without another RPC.
 *  - otherwise `slippageBps` below the expected output at the current reserves.
 * Both assume the worst tax the preset allows (618 bps for the default maxTaxBps 1000).
 */
export function planMinOut(p: Preset, r: Reserves, quoteIn: bigint, creatorTaxBps: number, feeBps = CURVE_FEE_BPS): MinOutPlan {
  const taxBps = worstTaxBps(p.maxTaxBps);
  const snipeTax = snipeTaxWeiFor(quoteIn, taxBps);
  const expectedOut = quoteBuy(r, quoteIn, feeBps, creatorTaxBps, snipeTax);
  if (p.maxEntryMcapEth !== undefined && p.maxEntryMcapEth > 0) {
    const pMax = p.maxEntryMcapEth / 1e9; // ETH per whole token
    const k = Number(r.quote) * Number(r.token);
    const q = BigInt(Math.floor(Math.sqrt(k * pMax)));
    const t = BigInt(Math.floor(k / Number(q)));
    return { expectedOut, minTokensOut: quoteBuy({ quote: q, token: t }, quoteIn, feeBps, creatorTaxBps, snipeTax), taxBps, basis: 'maxEntryMcap' };
  }
  return { expectedOut, minTokensOut: minOutWithSlippage(expectedOut, p.slippageBps), taxBps, basis: 'slippage' };
}
