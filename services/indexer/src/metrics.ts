/**
 * computeTokenMetrics - PURE per-token metrics (docs/SPEC.md §2 token_metrics,
 * docs/ARCHITECTURE.md §1, docs/EXAMPLES.md).
 *
 * Semantics:
 * - Exempt set S = deployer ∪ creatorFeeRecipient ∪ launch exemptions.
 * - First taxed buyer = first CurveBuy (ordered by block, logIndex) whose tx carried a
 *   SnipeTaxCharged (`snipeTax > 0`); fallback: first buy whose recipient ∉ S.
 *   Exempt "team" buys in the launch second are therefore never the entry.
 * - Prices: `priceBasis: 'avg'` (default) uses each trade's execution price
 *   quote/tokens (what GMGN-style charts and the video show; buys include fee +
 *   taxes); `'spot'` uses `priceAfter` (reserve price after the trade).
 * - Entry = first taxed buy's price. peakN = max price among trades from the entry
 *   trade on with `ts - entryTs <= N`, as % over entry; mcapN = that max * 1e9.
 * - low_after_entry_pct = min price within 60 s of entry, as % vs entry (<= 0).
 * - tax-free buys = buys with snipeTax == 0 while the snipe tax was active
 *   (elapsed < snipeTaxSeconds) - i.e. exempt team buys.
 * - n_buys_60s / n_sells_60s count trades with ts - launchTs <= 60.
 * - exempt_sold_within_sec = seconds after launch of the FIRST of: a CurveSell
 *   involving an exempt wallet, or an ERC-20 Transfer out of an exempt wallet to an
 *   address that is not the curve, the token, zero or another exempt wallet.
 *   Recipients of such transfers (except routers / pool manager) are the
 *   operator's `dumpWallets`; sells by S ∪ dumpWallets sum into operatorSellEth.
 */
import { VENUE_ADDRESSES, exemptSetForLaunch } from './pons.js';
import type { Address, LaunchRow, TokenMetricsRow, TokenTransferRow, TradeRow } from './types.js';
import { weiToEth } from './hex.js';

export type PriceBasis = 'avg' | 'spot';

export interface MetricsOptions {
  priceBasis?: PriceBasis;
  /** seconds the snipe tax is active (factory snipeTaxSeconds, default 3) */
  snipeTaxSeconds?: number;
}

export type MetricsLaunch = Pick<
  LaunchRow,
  'token' | 'curve' | 'ts' | 'deployer' | 'creatorFeeRecipient' | 'exemptions' | 'startPrice'
>;

export const PEAK_WINDOWS = [2, 5, 10, 30, 60] as const;
const SUPPLY_TOKENS = 1e9;

export function tradePrice(t: Pick<TradeRow, 'quote' | 'tokens' | 'priceAfter'>, basis: PriceBasis): number | null {
  if (basis === 'spot' && t.priceAfter !== null && Number.isFinite(t.priceAfter)) return t.priceAfter;
  if (t.tokens === 0n) return t.priceAfter;
  return Number(t.quote) / Number(t.tokens);
}

const byPos = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) =>
  a.block - b.block || a.logIndex - b.logIndex;

const pct = (p: number, entry: number) => (p / entry - 1) * 100;

export function computeTokenMetrics(
  launch: MetricsLaunch,
  trades: readonly TradeRow[],
  tokenTransfers: readonly TokenTransferRow[] = [],
  opts: MetricsOptions = {},
): TokenMetricsRow {
  const basis = opts.priceBasis ?? 'avg';
  const taxSeconds = opts.snipeTaxSeconds ?? 3;
  const S = exemptSetForLaunch(launch);
  const curve = launch.curve.toLowerCase();
  const token = launch.token.toLowerCase();
  const sorted = [...trades].sort(byPos);
  const elapsed = (ts: number) => ts - launch.ts;

  // ---- first taxed buyer -------------------------------------------------------
  let entryIdx = sorted.findIndex((t) => t.side === 'buy' && t.snipeTax > 0n);
  if (entryIdx < 0) entryIdx = sorted.findIndex((t) => t.side === 'buy' && !S.has(t.recipient));
  const entry = entryIdx >= 0 ? sorted[entryIdx] : undefined;
  const entryPrice = entry ? tradePrice(entry, basis) : null;

  // ---- peaks / low -------------------------------------------------------------
  const peaks = new Map<number, { pct: number; mcap: number }>();
  let lowAfterEntryPct: number | null = null;
  if (entry && entryPrice !== null && entryPrice > 0) {
    const maxW = new Map<number, number>();
    let low = entryPrice;
    for (let i = entryIdx; i < sorted.length; i++) {
      const t = sorted[i]!;
      const dt = t.ts - entry.ts;
      if (dt > PEAK_WINDOWS[PEAK_WINDOWS.length - 1]!) break;
      const p = tradePrice(t, basis);
      if (p === null) continue;
      for (const w of PEAK_WINDOWS) if (dt <= w && p > (maxW.get(w) ?? -Infinity)) maxW.set(w, p);
      if (dt <= 60 && p < low) low = p;
    }
    for (const w of PEAK_WINDOWS) {
      const m = maxW.get(w) ?? entryPrice;
      peaks.set(w, { pct: pct(m, entryPrice), mcap: m * SUPPLY_TOKENS });
    }
    lowAfterEntryPct = Math.min(0, pct(low, entryPrice));
  }

  // ---- ATH -----------------------------------------------------------------------
  let athPrice: number | null = null;
  let athTs: number | null = null;
  for (const t of sorted) {
    const p = tradePrice(t, basis);
    if (p !== null && (athPrice === null || p > athPrice)) {
      athPrice = p;
      athTs = t.ts;
    }
  }
  if (athPrice === null && launch.startPrice !== null) {
    athPrice = launch.startPrice;
    athTs = launch.ts;
  }

  // ---- counts ------------------------------------------------------------------
  let taxFreeBuyCount = 0;
  let taxFreeQuote = 0n;
  let nBuys60s = 0;
  let nSells60s = 0;
  for (const t of sorted) {
    const e = elapsed(t.ts);
    if (t.side === 'buy' && t.snipeTax === 0n && e < taxSeconds) {
      taxFreeBuyCount++;
      taxFreeQuote += t.quote;
    }
    if (e <= 60) {
      if (t.side === 'buy') nBuys60s++;
      else nSells60s++;
    }
  }

  // ---- operator exit -----------------------------------------------------------
  type ExitEv = { block: number; logIndex: number; ts: number };
  let firstExit: ExitEv | null = null;
  const consider = (ev: ExitEv) => {
    if (!firstExit || byPos(ev, firstExit) < 0) firstExit = ev;
  };
  const dump = new Set<Address>();
  for (const tr of [...tokenTransfers].sort(byPos)) {
    if (!S.has(tr.from)) continue;
    const to = tr.to.toLowerCase();
    if (to === curve || to === token || S.has(to) || to === '0x0000000000000000000000000000000000000000') continue;
    consider(tr);
    if (!VENUE_ADDRESSES.has(to)) dump.add(to as Address);
  }
  const isParticipant = (t: TradeRow, set: ReadonlySet<string>) =>
    set.has(t.trader) || set.has(t.recipient) || (t.txFrom !== null && set.has(t.txFrom));
  const operatorSet = new Set<string>([...S, ...dump]);
  let operatorSellWei = 0n;
  for (const t of sorted) {
    if (t.side !== 'sell') continue;
    if (isParticipant(t, S)) consider(t);
    if (isParticipant(t, operatorSet)) operatorSellWei += t.quote;
  }
  const exitEv = firstExit as ExitEv | null;

  const pk = (w: number) => peaks.get(w) ?? null;
  return {
    token: launch.token,
    firstTaxedBuyer: entry ? entry.recipient : null,
    firstTaxedTs: entry ? entry.ts : null,
    firstTaxedBlock: entry ? entry.block : null,
    firstTaxedPrice: entryPrice,
    firstTaxedMcapEth: entryPrice !== null ? entryPrice * SUPPLY_TOKENS : null,
    taxFreeBuyCount,
    taxFreeQuote,
    athPrice,
    athTs,
    athMcapEth: athPrice !== null ? athPrice * SUPPLY_TOKENS : null,
    peak2Pct: pk(2)?.pct ?? null,
    peak5Pct: pk(5)?.pct ?? null,
    peak10Pct: pk(10)?.pct ?? null,
    peak30Pct: pk(30)?.pct ?? null,
    peak60Pct: pk(60)?.pct ?? null,
    mcap2: pk(2)?.mcap ?? null,
    mcap5: pk(5)?.mcap ?? null,
    mcap10: pk(10)?.mcap ?? null,
    mcap30: pk(30)?.mcap ?? null,
    mcap60: pk(60)?.mcap ?? null,
    lowAfterEntryPct,
    nBuys60s,
    nSells60s,
    exemptSoldWithinSec: exitEv ? elapsed(exitEv.ts) : null,
    dumpWallets: [...dump].sort(),
    operatorSellEth: weiToEth(operatorSellWei),
  };
}
