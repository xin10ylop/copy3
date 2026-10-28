/**
 * Pure exit logic for one position (TradeWiz-style: TP ladder, trailing stop, stop loss,
 * timeout, operator-dump signal). Prices are ETH per whole token; `entryPrice` is the
 * effective entry (quote paid incl. snipe tax/fees ÷ tokens) and `markPrice` the
 * liquidation value per token (quoteSell of the holding ÷ holding), so pnl is what a sale
 * would actually realise.
 */
import type { Preset } from '@hood/core';

export interface PositionState {
  entryPrice: number;
  tokensInitial: bigint;
  tokensHeld: bigint;
  openedAtMs: number;
  /** highest pnl % seen */
  peakPnlPct: number;
  trailingArmed: boolean;
  /** take-profit levels already executed */
  tpHit: number;
  /** cumulative exempt-wallet outflow as % of their holding (transfers out + sells) */
  exemptOutflowPct: number;
}

export type ExitReason = 'exempt_dump' | 'stop_loss' | 'trailing' | 'timeout' | `tp${number}`;

export interface ExitSignal {
  reason: ExitReason;
  sellTokens: bigint;
  pnlPct: number;
  /** true when the whole remaining position is sold */
  all: boolean;
}

export function newPositionState(entryPrice: number, tokens: bigint, openedAtMs: number): PositionState {
  return { entryPrice, tokensInitial: tokens, tokensHeld: tokens, openedAtMs, peakPnlPct: 0, trailingArmed: false, tpHit: 0, exemptOutflowPct: 0 };
}

/** Evaluate one mark. Mutates peak/trailing bookkeeping; returns the exit to perform, if any. */
export function evaluatePosition(s: PositionState, markPrice: number, nowMs: number, p: Preset): ExitSignal | null {
  if (s.tokensHeld <= 0n || s.entryPrice <= 0) return null;
  const pnlPct = (markPrice / s.entryPrice - 1) * 100;
  if (pnlPct > s.peakPnlPct) s.peakPnlPct = pnlPct;
  if (p.trailing && s.peakPnlPct >= p.trailing.activatePct) s.trailingArmed = true;
  const all = (reason: ExitReason): ExitSignal => ({ reason, sellTokens: s.tokensHeld, pnlPct, all: true });

  if (p.exitIfExemptSellsPct != null && s.exemptOutflowPct > 0 && s.exemptOutflowPct >= p.exitIfExemptSellsPct) return all('exempt_dump');
  if (pnlPct <= -p.stopLossPct) return all('stop_loss');
  if (s.trailingArmed && p.trailing) {
    const peakPrice = s.entryPrice * (1 + s.peakPnlPct / 100);
    if (markPrice <= peakPrice * (1 - p.trailing.dropPct / 100)) return all('trailing');
  }
  if (p.timeoutSec != null && nowMs - s.openedAtMs >= p.timeoutSec * 1000) return all('timeout');
  const levels = [...p.takeProfits].sort((a, b) => a.pct - b.pct);
  for (let next = levels[s.tpHit]; next && pnlPct >= next.pct; next = levels[s.tpHit]) {
    const sellAll = next.sellPct >= 100;
    const sellTokens = sellAll ? s.tokensHeld : (s.tokensHeld * BigInt(Math.round(next.sellPct * 100))) / 10_000n;
    // L1: a level whose share rounds to 0 tokens is consumed without an order (an exit of 0
    // tokens is never sent: the contract refuses it, and it used to mean "sell everything")
    if (sellTokens <= 0n) {
      s.tpHit++;
      continue;
    }
    return { reason: `tp${s.tpHit + 1}`, sellTokens, pnlPct, all: sellTokens >= s.tokensHeld };
  }
  return null;
}

/** Book a completed sale into the state. */
export function applySale(s: PositionState, signal: ExitSignal, tokensSold: bigint): void {
  s.tokensHeld = s.tokensHeld > tokensSold ? s.tokensHeld - tokensSold : 0n;
  if (signal.reason.startsWith('tp')) s.tpHit++;
}
