/**
 * STUB - stands in for `@hood/core` until packages/core lands (owned by another build task).
 *
 * Every export mirrors a name from docs/SPEC.md §1 (pons/curve.ts) and §4 (types.ts).
 * Replace by re-exporting from '@hood/core' in src/deps.ts; nothing else in the agent
 * imports this file directly.
 *
 * Semantics (verified by replaying the Amlil fixture, docs/EXAMPLES.md, through
 * constant product with Q0 = 1.68 ETH / T0 = 1e9 tokens - every buy matches exactly):
 *  - `CurveReserves` is `{ quote, token }` in wei / token base units (18 dec).
 *  - `quoteBuy(r, quoteIn, feeBps, taxBps)`: `quoteIn` is CurveBuy.quoteIn (what reaches
 *    the curve); fee and the creator tax (`taxBps`) are deducted from it before constant
 *    product. The snipe tax is NOT part of this: it is charged on top of quoteIn
 *    (SnipeTaxCharged = quoteIn * snipeBps), so callers convert a total spend B with
 *    quoteIn = B / (1 + snipeBps/1e4).
 *  - `quoteSell(r, tokensIn, feeBps)`: fee (pass fee + creator tax) is taken from the
 *    gross constant-product proceeds.
 */
import { z } from 'zod';

export const TOKEN_SUPPLY = 1_000_000_000;
export const BPS = 10_000n;

export interface CurveReserves {
  /** virtual + real quote reserve, wei */
  quote: bigint;
  /** token reserve, 18-dec base units */
  token: bigint;
}

/** ETH per whole token. */
export function priceFromReserves(quote: bigint, token: bigint): number {
  if (token === 0n) return Number.POSITIVE_INFINITY;
  return Number(quote) / Number(token);
}

/** Market cap in ETH for the fixed 1e9 supply. */
export function mcapFromReserves(quote: bigint, token: bigint): number {
  return priceFromReserves(quote, token) * TOKEN_SUPPLY;
}

/** RESEARCH §3: snipeTaxBps = startBps >> ((elapsed * 14) / seconds). */
export function snipeTaxBps(elapsedSec: number, startBps = 9900, seconds = 3): number {
  if (elapsedSec < 0) return startBps;
  const shift = Math.floor((Math.floor(elapsedSec) * 14) / seconds);
  if (shift >= 31) return 0;
  return startBps >> shift;
}

/** Tokens out for a gross `quoteIn` (wei), after fee and snipe tax, constant product. */
export function quoteBuy(reserves: CurveReserves, quoteIn: bigint, feeBps: number, taxBps: number): bigint {
  if (quoteIn <= 0n) return 0n;
  const fee = (quoteIn * BigInt(feeBps)) / BPS;
  const tax = (quoteIn * BigInt(taxBps)) / BPS;
  const net = quoteIn - fee - tax;
  if (net <= 0n) return 0n;
  return (reserves.token * net) / (reserves.quote + net);
}

/** Quote out (wei) for selling `tokensIn`, fee on the gross proceeds. */
export function quoteSell(reserves: CurveReserves, tokensIn: bigint, feeBps: number): bigint {
  if (tokensIn <= 0n) return 0n;
  const gross = (reserves.quote * tokensIn) / (reserves.token + tokensIn);
  return gross - (gross * BigInt(feeBps)) / BPS;
}

export function minOutWithSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * (BPS - BigInt(slippageBps))) / BPS;
}

// ---------------------------------------------------------------------------
// SPEC §4 config shapes
// ---------------------------------------------------------------------------

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte hex address')
  .transform((s) => s.toLowerCase());

export const TakeProfitSchema = z.object({
  pct: z.number().positive(),
  sellPct: z.number().positive().max(100),
});

export const PresetSchema = z.object({
  buyEth: z.number().positive().max(10),
  maxTaxBps: z.number().int().min(0).max(9900),
  slippageBps: z.number().int().min(0).max(9900),
  burst: z.object({
    startMs: z.number().int(),
    spacingMs: z.number().int().min(0),
    count: z.number().int().min(1).max(50),
  }),
  gasLimit: z.number().int().positive(),
  maxFeeGwei: z.number().nonnegative(),
  priorityFeeGwei: z.number().nonnegative(),
  stopAfter: z.number().int().min(0),
  firstBuyOnly: z.boolean(),
  tokenCap: z.boolean(),
  takeProfits: z.array(TakeProfitSchema),
  trailing: z.object({ activatePct: z.number().nonnegative(), dropPct: z.number().positive().max(100) }).optional(),
  stopLossPct: z.number().positive().max(100),
  timeoutSec: z.number().int().positive().optional(),
  minQuoteReserveEth: z.number().nonnegative().optional(),
  maxEntryMcapEth: z.number().positive().optional(),
  abortIfExemptSellInLaunchBlock: z.boolean(),
  exitIfExemptSellsPct: z.number().positive().max(100).optional(),
});
export type Preset = z.infer<typeof PresetSchema>;
export type TakeProfit = z.infer<typeof TakeProfitSchema>;

export const PlayTriggerRequireSchema = z.enum(['armedWallet', 'deployerIn', 'teamWalletsAny', 'nameRegex', 'symbolRegex']);

export const PlayTriggerSchema = z.object({
  armedWallet: z
    .object({
      funders: z.array(address).min(1),
      minEth: z.number().nonnegative(),
      maxEth: z.number().positive(),
      freshOnly: z.boolean(),
      maxAgeSec: z.number().int().positive(),
      contractMode: z.boolean(),
    })
    .optional(),
  deployerIn: z.array(address).optional(),
  teamWalletsAny: z.array(address).optional(),
  nameRegex: z.string().optional(),
  symbolRegex: z.string().optional(),
  launchKind: z.enum(['any', 'noDevBuy', 'devBuy']).optional(),
  minDevBuyEth: z.number().nonnegative().optional(),
  maxDevBuyEth: z.number().nonnegative().optional(),
  require: z.array(PlayTriggerRequireSchema),
});
export type PlayTrigger = z.infer<typeof PlayTriggerSchema>;
