/**
 * Contract caps the decide path respects (memory only, NEW-4 / NEW-6 / R4-6):
 *  - `maxQuoteIn`: PonsSniper's per-snipe cap (QuoteTooLarge on chain);
 *  - the decaying spend budget (SpendLimitExceeded on chain): a level that drains at
 *    `maxSpend / window` per second and must stay ≤ `maxSpend` after a buy.
 *
 * Live: set from the live gate's chain read and refreshed every GATE_REFRESH_MS (NEW-8). Our own
 * fills are charged locally with their block time; a chain read keeps the local charges NEWER
 * than the chain's last spend (`spendUpdatedAt`), which it cannot contain yet (R4-6). Runs that
 * were decided but have not filled yet RESERVE their quoteIn, so concurrent runs cannot all count
 * on the same remaining budget; the reservation is released when the run ends without a fill.
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
  /** the chain's (or paper's) budget snapshot */
  private spend: SpendBudgetState | null = null;
  /** our own buys not (yet) contained in `spend`: block time (unix s) + amount */
  private charges: { ts: number; amount: bigint }[] = [];
  /** quoteIn of decided runs that have not filled / ended yet */
  private readonly reserved = new Map<string, bigint>();

  constructor(init: { maxQuoteIn?: bigint | null; spend?: SpendBudgetState | null } = {}) {
    this.set(init);
  }

  /** A fresh read. R4-6: local charges newer than the chain's last spend survive it. */
  set(l: { maxQuoteIn?: bigint | null; spend?: SpendBudgetState | null }): void {
    if (l.maxQuoteIn !== undefined) this.maxQuoteIn = l.maxQuoteIn;
    if (l.spend !== undefined) {
      this.spend = l.spend ? { ...l.spend } : null;
      const since = this.spend?.updatedAt ?? Infinity;
      this.charges = this.charges.filter((c) => c.ts > since);
    }
  }

  get budget(): Readonly<SpendBudgetState> | null {
    return this.spend;
  }

  /** the budget is known and switched off on chain (`disableSpendLimit`) */
  get budgetOff(): boolean {
    return this.spend !== null && this.spend.window === 0;
  }

  get reservedWei(): bigint {
    let n = 0n;
    for (const v of this.reserved.values()) n += v;
    return n;
  }

  /** the level now: the snapshot, then each local charge in time order, drained like `_spend` does */
  private level(nowSec: number): bigint {
    const s = this.spend!;
    const drain = (lvl: bigint, from: number, to: number): bigint => {
      const leak = (s.maxSpend * BigInt(Math.max(0, Math.floor(to) - Math.floor(from)))) / BigInt(s.window);
      return lvl > leak ? lvl - leak : 0n;
    };
    let lvl = s.level;
    let at = s.updatedAt;
    for (const c of [...this.charges].sort((a, b) => a.ts - b.ts)) {
      const t = Math.max(at, c.ts);
      lvl = drain(lvl, at, t) + c.amount;
      at = t;
    }
    return drain(lvl, at, Math.max(at, Math.floor(nowSec) - CLOCK_MARGIN_S));
  }

  /** What a NEW snipe may still spend now (reservations of runs in flight deducted); null = unknown or off. */
  available(nowSec = Date.now() / 1000): bigint | null {
    const s = this.spend;
    if (!s || s.window === 0) return null;
    const used = this.level(nowSec) + this.reservedWei;
    return used >= s.maxSpend ? 0n : s.maxSpend - used;
  }

  /** R4-6: a decided run holds its quoteIn until it fills (→ `charge`) or ends (→ `release`). */
  reserve(key: string, quoteIn: bigint): void {
    this.reserved.set(key, quoteIn);
  }

  release(key: string): void {
    this.reserved.delete(key);
  }

  /** Our own buy landed (live fill, or a paper fill) at block time `tsSec`: charge it like `_spend`. */
  charge(quoteIn: bigint, tsSec = Date.now() / 1000): void {
    const s = this.spend;
    if (!s || s.window === 0) return;
    const ts = Math.floor(tsSec);
    if (ts <= s.updatedAt) return; // the chain snapshot already contains a spend at/after that block time
    this.charges.push({ ts, amount: quoteIn });
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
