/** Entry pricing helpers: worst-case snipe tax, expected tokens and the on-chain minTokensOut. */
import { CURVE_FEE_BPS, minOutWithSlippage, quoteBuy, snipeTaxWeiFor, type Preset, type Reserves } from '@hood/core';

/** The snipe-tax schedule only takes these values (9900 >> {0,4,9,14}). */
export const SNIPE_TAX_STEPS = [9900, 618, 19, 0] as const;

/** Hard ceiling for maxTaxBps (zod caps presets at it; PonsSniper refuses ≥ 9900). M3. */
export const MAX_TAX_BPS = 5000;

/** Largest scheduled tax ≤ maxTaxBps: the worst tax a burst member can actually pay. */
export function worstTaxBps(maxTaxBps: number): number {
  return SNIPE_TAX_STEPS.find((s) => s <= maxTaxBps) ?? 0;
}

export interface MinOutPlan {
  expectedOut: bigint;
  minTokensOut: bigint;
  taxBps: number;
  /** which bound is binding (the larger minTokensOut): the mcap cap or the slippage */
  basis: 'maxEntryMcap' | 'slippage';
  /** both bounds (R4-3): `capOut` only with `maxEntryMcapEth` */
  slippageOut: bigint;
  capOut?: bigint;
}

/**
 * minTokensOut for the burst — the STRICTER (larger) of two bounds (R4-3):
 *  - slippage: `slippageBps` below the expected output at `r` — the reserves the decision priced
 *    on (launch config + CONFIRMED launch-second buys, or getReserves), never feed hints (NEW-1);
 *  - with `maxEntryMcapEth`: the tokens a buy would get with the pre-trade price AT the cap
 *    (k = Q·T is invariant on the curve, so Q' = √(k·p), T' = k/Q'), so the contract refuses any
 *    entry above that mcap whatever the ledger believed — enforced at execution, no extra RPC.
 * The cap alone tolerated 44–55 % fewer tokens at typical entries; now it can only tighten.
 * Both assume the worst tax the preset allows (618 bps for the default maxTaxBps 1000).
 */
export function planMinOut(p: Preset, r: Reserves, quoteIn: bigint, creatorTaxBps: number, feeBps = CURVE_FEE_BPS): MinOutPlan {
  // M3: never price at the 99 % launch-second tax (that would make minTokensOut ≈ 0)
  const taxBps = worstTaxBps(Math.min(p.maxTaxBps, MAX_TAX_BPS));
  const snipeTax = snipeTaxWeiFor(quoteIn, taxBps);
  const expectedOut = quoteBuy(r, quoteIn, feeBps, creatorTaxBps, snipeTax);
  const slippageOut = minOutWithSlippage(expectedOut, p.slippageBps);
  if (p.maxEntryMcapEth !== undefined && p.maxEntryMcapEth > 0) {
    const pMax = p.maxEntryMcapEth / 1e9; // ETH per whole token
    const k = Number(r.quote) * Number(r.token);
    const q = BigInt(Math.floor(Math.sqrt(k * pMax)));
    const t = BigInt(Math.floor(k / Number(q)));
    const capOut = quoteBuy({ quote: q, token: t }, quoteIn, feeBps, creatorTaxBps, snipeTax);
    const capWins = capOut > slippageOut;
    return { expectedOut, minTokensOut: capWins ? capOut : slippageOut, taxBps, basis: capWins ? 'maxEntryMcap' : 'slippage', slippageOut, capOut };
  }
  return { expectedOut, minTokensOut: slippageOut, taxBps, basis: 'slippage', slippageOut };
}

/**
 * Curve reserves right after launch, per launchConfigId (verified: config 0 starts at a 1.68 ETH
 * virtual quote and 1e27 tokens). Lets the executor skip waiting for getReserves.
 */
export const DEFAULT_LAUNCH_RESERVES: Readonly<Record<string, Reserves>> = {
  '0': { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n },
};

/** Reserves after the launch tx: config start + the (exempt, untaxed) dev buy of launchAndBuy. */
export function launchReserves(start: Reserves, devBuyQuoteIn: bigint, creatorTaxBps: number, feeBps = CURVE_FEE_BPS): Reserves {
  if (devBuyQuoteIn <= 0n) return start;
  const out = quoteBuy(start, devBuyQuoteIn, feeBps, creatorTaxBps, 0n);
  const net = devBuyQuoteIn - (devBuyQuoteIn * BigInt(feeBps)) / 10_000n - (devBuyQuoteIn * BigInt(creatorTaxBps)) / 10_000n;
  return { quote: start.quote + net, token: start.token - out };
}
