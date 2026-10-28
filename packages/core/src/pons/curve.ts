/**
 * Pure bigint bonding-curve math for Pons V2 curves (SPEC §1).
 *
 * The curve is constant-product with a virtual ("phantom") quote reserve:
 *   quoteReserve = phantomQuote + realQuoteReserve
 *   k            = quoteReserve * tokenReserve
 * `getReserves()` returns (quoteReserve, tokenReserve) already including the
 * phantom offset, so these functions take those effective reserves directly.
 *
 * FEE / TAX ORDER (verified against the live AMLIL CurveBuy/CurveSell sequence,
 * test/live/curve-replay.live.test.ts, and the offline amlil-trades fixture —
 * all 204 trades reproduce exactly):
 *
 *   BUY:  net   = quoteIn  − fee − snipeTax − creatorTax           (all on quoteIn)
 *         fee        = quoteIn * feeBps      / 10000
 *         creatorTax = quoteIn * creatorBps  / 10000
 *         snipeTax   = the SnipeTaxCharged amount (separate log; 0 if exempt)
 *         tokensOut  = floor(tokenReserve * net / (quoteReserve + net))
 *
 *   SELL: gross = floor(quoteReserve * tokensIn / (tokenReserve + tokensIn))
 *         fee        = gross * feeBps     / 10000
 *         creatorTax = gross * creatorBps / 10000   (sells pay no snipe tax)
 *         quoteOut   = gross − fee − creatorTax
 *
 * Note: `CurveBuy.tax` / `CurveSell.tax` is the CREATOR tax, not the snipe tax.
 */

export const BPS_DENOM = 10_000n;
/** Launch supply in whole tokens (1e9) for mcap. */
export const LAUNCH_SUPPLY_WHOLE = 1_000_000_000n;
/** Launch supply in wei (1e9 * 1e18). */
export const LAUNCH_SUPPLY_WEI = 1_000_000_000n * 10n ** 18n;

export interface Reserves {
  /** effective quote reserve (phantom + real), wei. */
  quote: bigint;
  /** token reserve held by the curve, wei. */
  token: bigint;
}

/** Spot price = quote per token, as a float in ETH-per-whole-token units. */
export function priceFromReserves(r: Reserves): number {
  if (r.token === 0n) return 0;
  // (quoteWei / tokenWei) is ETH-per-token in whole units because both are 1e18-scaled.
  return Number(r.quote) / Number(r.token);
}

/** Market cap in ETH = price * supply(1e9 whole tokens). */
export function mcapFromReserves(r: Reserves, supplyWhole = LAUNCH_SUPPLY_WHOLE): number {
  return priceFromReserves(r) * Number(supplyWhole);
}

/**
 * Snipe tax in bps for a given elapsed time since launch.
 *   shift       = floor(elapsed * 14 / seconds)
 *   snipeTaxBps = startBps >> shift        (0 once shift ≥ ~14)
 * Verified table: 0→9900, 1→618, 2→19, 3→0, 5→0 (startBps=9900, seconds=3).
 */
export function snipeTaxBps(elapsedSec: number, startBps = 9900, seconds = 3): number {
  if (elapsedSec < 0) throw new RangeError('elapsedSec must be ≥ 0');
  if (seconds <= 0) return 0;
  const shift = Math.floor((elapsedSec * 14) / seconds);
  if (shift >= 64) return 0;
  const result = BigInt(Math.trunc(startBps)) >> BigInt(shift);
  return Number(result);
}

/**
 * Tokens out for a quote-in buy. `feeBps` and `creatorTaxBps` are applied to
 * the gross quote-in; `snipeTaxWei` is the already-computed SnipeTaxCharged
 * amount (0 when the buyer is exempt). Pass `snipeTaxWei` from
 * `snipeTaxWeiFor(quoteIn, taxBps)` when simulating.
 */
export function quoteBuy(
  r: Reserves,
  quoteIn: bigint,
  feeBps: number,
  creatorTaxBps: number,
  snipeTaxWei = 0n,
): bigint {
  if (quoteIn <= 0n) return 0n;
  const fee = (quoteIn * BigInt(feeBps)) / BPS_DENOM;
  const creatorTax = (quoteIn * BigInt(creatorTaxBps)) / BPS_DENOM;
  const net = quoteIn - fee - creatorTax - snipeTaxWei;
  if (net <= 0n) return 0n;
  return (r.token * net) / (r.quote + net);
}

/** Snipe-tax wei charged on a quote-in at a given bps (tax on the gross quote-in). */
export function snipeTaxWeiFor(quoteIn: bigint, taxBps: number): bigint {
  return (quoteIn * BigInt(taxBps)) / BPS_DENOM;
}

/** Quote out for a token-in sell (fee + creator tax taken from the gross quote). */
export function quoteSell(r: Reserves, tokensIn: bigint, feeBps: number, creatorTaxBps = 0): bigint {
  if (tokensIn <= 0n) return 0n;
  const gross = (r.quote * tokensIn) / (r.token + tokensIn);
  const fee = (gross * BigInt(feeBps)) / BPS_DENOM;
  const creatorTax = (gross * BigInt(creatorTaxBps)) / BPS_DENOM;
  return gross - fee - creatorTax;
}

/** Apply a slippage tolerance (bps) to an expected amount to get a minOut floor. */
export function minOutWithSlippage(expectedOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0) throw new RangeError('slippageBps must be ≥ 0');
  const keep = BPS_DENOM - BigInt(Math.trunc(slippageBps));
  if (keep <= 0n) return 0n;
  return (expectedOut * keep) / BPS_DENOM;
}

/**
 * Price impact of a buy in bps: how much the spot price rises from before to
 * after the trade. Uses the same net/fee model as `quoteBuy`.
 */
export function priceImpactBps(
  r: Reserves,
  quoteIn: bigint,
  feeBps: number,
  creatorTaxBps: number,
  snipeTaxWei = 0n,
): number {
  if (quoteIn <= 0n || r.token === 0n) return 0;
  const fee = (quoteIn * BigInt(feeBps)) / BPS_DENOM;
  const creatorTax = (quoteIn * BigInt(creatorTaxBps)) / BPS_DENOM;
  const net = quoteIn - fee - creatorTax - snipeTaxWei;
  if (net <= 0n) return 0;
  const out = (r.token * net) / (r.quote + net);
  if (out >= r.token) return Number.POSITIVE_INFINITY;
  const before = Number(r.quote) / Number(r.token);
  const after = Number(r.quote + net) / Number(r.token - out);
  if (before === 0) return 0;
  return Math.round((after / before - 1) * Number(BPS_DENOM));
}
