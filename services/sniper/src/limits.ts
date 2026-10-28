/**
 * Contract caps the decide path respects (memory only, NEW-4 / NEW-6):
 *  - `maxQuoteIn`: PonsSniper's per-snipe cap (QuoteTooLarge on chain);
 *  - the decaying spend budget (SpendLimitExceeded on chain): a level that drains at
 *    `maxSpend / window` per second and must stay ≤ `maxSpend` after a buy.
 *
 * Live: set from the live gate's chain read and refreshed every GATE_REFRESH_MS (NEW-8); our own
 * fills are charged locally in between, so a burst the contract would refuse is not even signed.
 * Paper: the same model from PAPER_MAX_QUOTE_IN_ETH / PAPER_MAX_SPEND_PER_WINDOW_ETH /
 * PAPER_SPEND_WINDOW_SEC (defaults = the deploy defaults), so paper refuses what live would.
 *
 * The local decay uses the wall clock (the sequencer stamps blocks with its own clock, within a
 * second or two); it lags the chain by `CLOCK_MARGIN_S` so the estimate never runs ahead of it.
 */
import type { SpendBudgetState } from './chain.js';

const CLOCK_MARGIN_S = 2;

export class ContractLimits {
  /** per-snipe cap; null = unknown (not read yet) */
  maxQuoteIn: bigint | null = null;
  private spend: SpendBudgetState | null = null;

  constructor(init: { maxQuoteIn?: bigint | null; spend?: SpendBudgetState | null } = {}) {
    this.set(init);
  }

  /** Replace with a fresh read (the chain is the truth: local charges are dropped). */
  set(l: { maxQuoteIn?: bigint | null; spend?: SpendBudgetState | null }): void {
    if (l.maxQuoteIn !== undefined) this.maxQuoteIn = l.maxQuoteIn;
    if (l.spend !== undefined) this.spend = l.spend ? { ...l.spend } : null;
  }

  get budget(): Readonly<SpendBudgetState> | null {
    return this.spend;
  }

  /** the budget is known and switched off on chain (`disableSpendLimit`) */
  get budgetOff(): boolean {
    return this.spend !== null && this.spend.window === 0;
  }

  private level(nowSec: number): bigint {
    const s = this.spend!;
    const elapsed = Math.max(0, Math.floor(nowSec) - CLOCK_MARGIN_S - s.updatedAt);
    const leak = (s.maxSpend * BigInt(elapsed)) / BigInt(s.window);
    return s.level > leak ? s.level - leak : 0n;
  }

  /** What a snipe may still spend now; null = unknown or no budget (off). */
  available(nowSec = Date.now() / 1000): bigint | null {
    const s = this.spend;
    if (!s || s.window === 0) return null;
    const lvl = this.level(nowSec);
    return lvl >= s.maxSpend ? 0n : s.maxSpend - lvl;
  }

  /** Our own buy landed (live fill, or a paper fill): charge it like `_spend` does on chain. */
  charge(quoteIn: bigint, nowSec = Date.now() / 1000): void {
    const s = this.spend;
    if (!s || s.window === 0) return;
    const lvl = this.level(nowSec);
    this.spend = { ...s, level: lvl + quoteIn, updatedAt: Math.max(s.updatedAt, Math.floor(nowSec) - CLOCK_MARGIN_S) };
  }

  /** The largest size a snipe can have right now: min(maxQuoteIn, available budget); null = unbounded/unknown. */
  cap(nowSec = Date.now() / 1000): bigint | null {
    const a = this.available(nowSec);
    const m = this.maxQuoteIn;
    if (a === null) return m;
    if (m === null) return a;
    return a < m ? a : m;
  }
}
