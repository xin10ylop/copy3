/**
 * Curve reserve accounting + curve_trades row construction (pure).
 *
 * Verified exactly against 216 real trades (curve-logs + amlil fixtures, and the
 * live getReserves() of the fixture curve):
 *   buy : quoteReserve += quoteIn - fee - tax ; tokenReserve -= tokensOut
 *   sell: quoteReserve -= quoteOut + fee + tax ; tokenReserve += tokensIn
 * where `fee` already contains the snipe tax and `tax` is the creator tax.
 * Initial reserves of a curve = (phantomQuote(), launchSupply()) = (1.68 ETH, 1e27)
 * for launch config 0.
 */
import { priceFromReserves, tradeIsExempt } from './pons.js';
import type { Address, Hex, Reserves, TradeRow, TradeSide } from './types.js';

export interface TradeAmounts {
  side: TradeSide;
  quote: bigint;
  tokens: bigint;
  fee: bigint;
  tax: bigint;
}

export function applyTrade(r: Reserves, t: TradeAmounts): Reserves {
  if (t.side === 'buy') return { quote: r.quote + t.quote - t.fee - t.tax, token: r.token - t.tokens };
  return { quote: r.quote - t.quote - t.fee - t.tax, token: r.token + t.tokens };
}

/** Undo `applyTrade` (used to derive pre-block reserves from post-block getReserves). */
export function revertTrade(r: Reserves, t: TradeAmounts): Reserves {
  if (t.side === 'buy') return { quote: r.quote - t.quote + t.fee + t.tax, token: r.token + t.tokens };
  return { quote: r.quote + t.quote + t.fee + t.tax, token: r.token - t.tokens };
}

export interface TradeEventInput extends TradeAmounts {
  curve: Address;
  block: number;
  txHash: Hex;
  logIndex: number;
  trader: Address;
  recipient: Address;
  snipeTax: bigint;
}

export interface TradeContext {
  token: Address;
  ts: number;
  txFrom: Address | null;
  launchTs: number | null;
  exempt: ReadonlySet<string>;
  /** reserves before this trade, null when unknown */
  reserves: Reserves | null;
}

export function buildTradeRow(ev: TradeEventInput, ctx: TradeContext): { row: TradeRow; reserves: Reserves | null } {
  const after = ctx.reserves ? applyTrade(ctx.reserves, ev) : null;
  const sane = after !== null && after.quote > 0n && after.token > 0n;
  const priceAfter = sane
    ? priceFromReserves(after.quote, after.token)
    : ev.tokens > 0n
      ? Number(ev.quote) / Number(ev.tokens)
      : null;
  const txFrom = ctx.txFrom ? (ctx.txFrom.toLowerCase() as Address) : null;
  const row: TradeRow = {
    token: ctx.token,
    curve: ev.curve,
    block: ev.block,
    ts: ctx.ts,
    txHash: ev.txHash,
    logIndex: ev.logIndex,
    side: ev.side,
    trader: ev.trader,
    recipient: ev.recipient,
    txFrom,
    quote: ev.quote,
    tokens: ev.tokens,
    fee: ev.fee,
    tax: ev.tax,
    snipeTax: ev.snipeTax,
    priceAfter,
    secondsSinceLaunch: ctx.launchTs !== null ? ctx.ts - ctx.launchTs : null,
    exempt: tradeIsExempt({ trader: ev.trader, recipient: ev.recipient, txFrom }, ctx.exempt),
  };
  return { row, reserves: sane ? after : null };
}
