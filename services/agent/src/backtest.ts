/**
 * Pure backtester (no DB, no network).
 *
 * Model of one snipe:
 *  - The curve is constant product over virtual reserves. Its invariant k = Q0*T0 is
 *    reconstructed from the launch start price and an assumed initial token reserve
 *    (default 1e9 tokens, overridable per launch). Any market price p maps back to
 *    reserves Q = sqrt(k*p), T = sqrt(k/p).
 *  - Entry: we land first in the first block whose timestamp is >= launch_ts + s, where
 *    s is the smallest second in 1..3 whose snipe tax is <= preset.maxTaxBps (s = 1
 *    -> 618 bps for the default 10 % tax protection). The pre-trade state is the
 *    market price after the last trade before that second (the launch-second
 *    tax-free buys), i.e. we stand in front of the first taxed buyer.
 *  - Fee accounting (core's curve math; the Amlil fixture, docs/EXAMPLES.md, replays
 *    exactly through constant product with Q0 = 1.68 ETH, T0 = 1e9 tokens):
 *      buy : quoteIn = what the buyer sends; fee (100 bps), the creator tax and the
 *            snipe tax (SnipeTaxCharged = quoteIn * snipeBps) are all taken from it,
 *            tokens = CP(quoteIn - fee - creatorTax - snipeTax). CurveBuy.fee includes
 *            the snipe tax; CurveBuy.tax is the creator tax.
 *      sell: fee + creator tax are taken from the gross constant-product proceeds.
 *    The fill uses core's `quoteBuy(r, B, 100, creatorTaxBps, snipeTaxWeiFor(B, snipeBps))`
 *    and `quoteSell(r, tokens, 100, creatorTaxBps)`, so our own price impact is included
 *    on both sides.
 *  - Exit: walk the historical event sequence (curve trades + token transfers out of
 *    exempt wallets). Position value is tokens x market price; mark % = value / cost - 1.
 *    Rules are evaluated after each event in this order: exempt disposal (curve sell or
 *    transfer-out; the "team" pattern dumps via a transfer to a fresh wallet ~1 block
 *    before the sells), stop loss, take-profit ladder, trailing. A timeout closes the
 *    position at the last price before the deadline. Sells are priced against the
 *    historical curve state - we ignore the small upward shift our own buy would have
 *    caused, which is conservative.
 */
import { quoteBuy, quoteSell, snipeTaxBps, snipeTaxWeiFor, TOKEN_SUPPLY, type Preset, type TakeProfit } from './deps.js';

export const CURVE_FEE_BPS = 100;
/** Assumed virtual token reserve at launch (tokens). Override per launch when known. */
export const DEFAULT_TOKEN_RESERVE0 = 1_000_000_000;
/** Fallback launch price (ETH/token) when the launch row has no start_price: Q0 = 1.68 ETH over 1e9 tokens. */
export const DEFAULT_START_PRICE = 1.68 / 1_000_000_000;

const WEI = 1e18;

export interface BacktestLaunch {
  token: string;
  /** unix seconds of the launch block */
  ts: number;
  /** launches.creator_tax_bps (charged on buys and sells) */
  creatorTaxBps?: number | null;
  /** ETH per token before any buy */
  startPrice?: number | null;
  /** tokens; defaults to DEFAULT_TOKEN_RESERVE0 */
  tokenReserve0?: number | null;
  name?: string | null;
  symbol?: string | null;
  deployer?: string | null;
}

export interface BacktestTrade {
  ts: number;
  block: number;
  logIndex: number;
  side: 'buy' | 'sell';
  /** ETH per token after this trade */
  priceAfter: number;
  /** gross quote amount, ETH */
  quoteEth: number;
  /** whole tokens */
  tokens: number;
  /** trader is the deployer, creator fee recipient or an explicit exemption */
  exempt: boolean;
  /** recipient for buys, seller for sells (falls back to tx.from) */
  wallet?: string | null;
}

/** ERC-20 Transfer of the launched token out of an exempt (team) wallet to a non-curve address. */
export interface BacktestTransfer {
  ts: number;
  block: number;
  logIndex: number;
  from: string;
  to: string;
  /** whole tokens */
  tokens: number;
}

export interface BacktestItem {
  launch: BacktestLaunch;
  trades: BacktestTrade[];
  /** exempt-wallet transfer-outs (the team's dump signal); optional */
  transfers?: BacktestTransfer[];
}

/** The subset of a Preset that affects simulated PnL. */
export type SimPreset = Pick<Preset, 'buyEth' | 'maxTaxBps' | 'takeProfits' | 'stopLossPct' | 'abortIfExemptSellInLaunchBlock'> &
  Partial<Pick<Preset, 'trailing' | 'timeoutSec' | 'minQuoteReserveEth' | 'maxEntryMcapEth' | 'exitIfExemptSellsPct'>>;

export type ExitReason =
  | 'tp'
  | 'trailing'
  | 'sl'
  | 'timeout'
  | 'exempt_sell'
  | 'exempt_transfer'
  | 'end_of_data'
  | 'skipped_tax'
  | 'skipped_mcap'
  | 'skipped_reserve'
  | 'aborted_exempt_sell'
  | 'no_data';

export interface Fill {
  ts: number;
  reason: ExitReason;
  tokens: number;
  marketPrice: number;
  quoteOutEth: number;
}

export interface SnipeResult {
  token: string;
  launchTs: number;
  entered: boolean;
  entryTs: number | null;
  taxBps: number;
  /** effective ETH per token paid (fee + tax + impact included) */
  entryPrice: number | null;
  entryMarketPrice: number | null;
  entryMcapEth: number | null;
  /** effective ETH per token received, volume weighted */
  exitPrice: number | null;
  pnlEth: number;
  pnlPct: number;
  holdSec: number;
  exitReason: ExitReason;
  /** best mark % seen while holding */
  peakPct: number;
  fills: Fill[];
}

interface Reserves {
  q: number;
  t: number;
}

function curveK(launch: BacktestLaunch): { k: number; q0: number } {
  const t0 = launch.tokenReserve0 && launch.tokenReserve0 > 0 ? launch.tokenReserve0 : DEFAULT_TOKEN_RESERVE0;
  const p0 = launch.startPrice && launch.startPrice > 0 ? launch.startPrice : DEFAULT_START_PRICE;
  const q0 = p0 * t0;
  return { k: q0 * t0, q0 };
}

function reservesAt(k: number, price: number): Reserves {
  return { q: Math.sqrt(k * price), t: Math.sqrt(k / price) };
}

function toBig(units: number): bigint {
  if (!Number.isFinite(units) || units <= 0) return 0n;
  return BigInt(Math.floor(units * WEI));
}

function fromBig(v: bigint): number {
  return Number(v) / WEI;
}

/** Tokens for a total spend `spendEth` (fee, creator tax and snipe tax all taken from it). */
export function buyTokens(r: { q: number; t: number }, spendEth: number, snipeTaxBps: number, creatorTaxBps: number): number {
  const quoteIn = toBig(spendEth);
  return fromBig(quoteBuy({ quote: toBig(r.q), token: toBig(r.t) }, quoteIn, CURVE_FEE_BPS, creatorTaxBps, snipeTaxWeiFor(quoteIn, snipeTaxBps)));
}

/** Net ETH for selling `tokens`: fee + creator tax taken from the gross proceeds. */
export function sellQuote(r: { q: number; t: number }, tokens: number, creatorTaxBps: number): number {
  return fromBig(quoteSell({ quote: toBig(r.q), token: toBig(r.t) }, toBig(tokens), CURVE_FEE_BPS, creatorTaxBps));
}

type PathEvent = { kind: 'trade'; ev: BacktestTrade } | { kind: 'transfer'; ev: BacktestTransfer };

function mergeEvents(trades: readonly BacktestTrade[], transfers: readonly BacktestTransfer[]): PathEvent[] {
  const all: PathEvent[] = [
    ...trades.map((ev): PathEvent => ({ kind: 'trade', ev })),
    ...transfers.map((ev): PathEvent => ({ kind: 'transfer', ev })),
  ];
  return all.sort((a, b) => a.ev.ts - b.ev.ts || a.ev.block - b.ev.block || a.ev.logIndex - b.ev.logIndex);
}

function skipped(launch: BacktestLaunch, reason: ExitReason, taxBps = 0): SnipeResult {
  return {
    token: launch.token,
    launchTs: launch.ts,
    entered: false,
    entryTs: null,
    taxBps,
    entryPrice: null,
    entryMarketPrice: null,
    entryMcapEth: null,
    exitPrice: null,
    pnlEth: 0,
    pnlPct: 0,
    holdSec: 0,
    exitReason: reason,
    peakPct: 0,
    fills: [],
  };
}

/** Earliest second offset (1..3) whose snipe tax fits the preset, or null. */
export function entrySecond(maxTaxBps: number): { offset: number; taxBps: number } | null {
  for (let s = 1; s <= 3; s++) {
    const tax = snipeTaxBps(s);
    if (tax <= maxTaxBps) return { offset: s, taxBps: tax };
  }
  return null;
}

export function simulateSnipe(
  launch: BacktestLaunch,
  tradesIn: readonly BacktestTrade[],
  preset: SimPreset,
  transfersIn: readonly BacktestTransfer[] = [],
): SnipeResult {
  if (tradesIn.length === 0) return skipped(launch, 'no_data');
  const events = mergeEvents(tradesIn, transfersIn);
  const entry = entrySecond(preset.maxTaxBps);
  if (!entry) return skipped(launch, 'skipped_tax', snipeTaxBps(3));
  const entryTs = launch.ts + entry.offset;
  const creatorTaxBps = launch.creatorTaxBps ?? 0;
  const { k, q0 } = curveK(launch);

  // Exempt-wallet holdings from the launch onward. Disposal = cumulative share of the
  // wallet's peak holding that left via curve sells or transfers (batched dumps add up).
  const held = new Map<string, { now: number; peak: number }>();
  const disposal = (wallet: string | null | undefined, tokens: number, side: 'in' | 'out'): number => {
    const key = (wallet ?? '').toLowerCase();
    const h = held.get(key) ?? { now: 0, peak: 0 };
    if (side === 'in') {
      h.now += tokens;
      h.peak = Math.max(h.peak, h.now);
      held.set(key, h);
      return 0;
    }
    h.now = Math.max(0, h.now - tokens);
    held.set(key, h);
    return h.peak > 0 ? ((h.peak - h.now) / h.peak) * 100 : 100;
  };
  /** % disposed by the exempt actor of this event, or -1 when the event is not an exempt disposal */
  const exemptDisposalPct = (e: PathEvent): number => {
    if (e.kind === 'transfer') return disposal(e.ev.from, e.ev.tokens, 'out');
    if (!e.ev.exempt) return -1;
    if (e.ev.side === 'buy') return disposal(e.ev.wallet, e.ev.tokens, 'in') - 1;
    return disposal(e.ev.wallet, e.ev.tokens, 'out');
  };

  let marketPrice = launch.startPrice && launch.startPrice > 0 ? launch.startPrice : DEFAULT_START_PRICE;
  let i = 0;
  let sawTrade = false;
  for (; i < events.length; i++) {
    const e = events[i]!;
    if (e.ev.ts >= entryTs) break;
    const pct = exemptDisposalPct(e);
    if (preset.abortIfExemptSellInLaunchBlock && pct >= 0) {
      return skipped(launch, 'aborted_exempt_sell', entry.taxBps);
    }
    if (e.kind === 'trade') {
      marketPrice = e.ev.priceAfter;
      sawTrade = true;
    }
  }
  if (i >= events.length && !sawTrade) return skipped(launch, 'no_data', entry.taxBps);
  if (!events.slice(i).some((e) => e.kind === 'trade') && !sawTrade) return skipped(launch, 'no_data', entry.taxBps);

  const entryMcapEth = marketPrice * TOKEN_SUPPLY;
  if (preset.maxEntryMcapEth !== undefined && entryMcapEth > preset.maxEntryMcapEth) {
    return skipped(launch, 'skipped_mcap', entry.taxBps);
  }
  const entryReserves = reservesAt(k, marketPrice);
  if (preset.minQuoteReserveEth !== undefined && entryReserves.q - q0 < preset.minQuoteReserveEth) {
    return skipped(launch, 'skipped_reserve', entry.taxBps);
  }

  const tokensBought = buyTokens(entryReserves, preset.buyEth, entry.taxBps, creatorTaxBps);
  if (tokensBought <= 0) return skipped(launch, 'no_data', entry.taxBps);
  const cost = preset.buyEth;
  const entryPrice = cost / tokensBought;
  const entryMarketPrice = marketPrice;

  const ladder: TakeProfit[] = [...preset.takeProfits].sort((a, b) => a.pct - b.pct);
  const tpHit = new Array<boolean>(ladder.length).fill(false);
  const fills: Fill[] = [];
  let remaining = tokensBought;
  let proceeds = 0;
  let peakValue = tokensBought * marketPrice;
  let peakPct = (peakValue / cost) * 100 - 100;
  let trailingActive = false;
  let lastTs = entryTs;
  const deadline = preset.timeoutSec != null ? entryTs + preset.timeoutSec : Number.POSITIVE_INFINITY;

  const sell = (ts: number, tokens: number, price: number, reason: ExitReason): void => {
    const amount = Math.min(tokens, remaining);
    if (amount <= 0) return;
    const quoteOutEth = sellQuote(reservesAt(k, price), amount, creatorTaxBps);
    fills.push({ ts, reason, tokens: amount, marketPrice: price, quoteOutEth });
    proceeds += quoteOutEth;
    remaining -= amount;
    if (remaining <= tokensBought * 1e-9) remaining = 0;
  };

  for (; i < events.length && remaining > 0; i++) {
    const e = events[i]!;
    if (e.ev.ts >= deadline) {
      sell(deadline, remaining, marketPrice, 'timeout');
      lastTs = deadline;
      break;
    }
    const disposedPct = exemptDisposalPct(e);
    lastTs = e.ev.ts;
    if (preset.exitIfExemptSellsPct != null && disposedPct >= preset.exitIfExemptSellsPct) {
      // A transfer-out is seen ~1 block before the dump wallet sells: exit at the current
      // price. An exempt curve sell has already moved the price: exit after it.
      if (e.kind === 'trade') marketPrice = e.ev.priceAfter;
      sell(e.ev.ts, remaining, marketPrice, e.kind === 'transfer' ? 'exempt_transfer' : 'exempt_sell');
      break;
    }
    if (e.kind === 'transfer') continue;
    marketPrice = e.ev.priceAfter;

    const value = remaining * marketPrice + proceeds;
    const markPct = (value / cost) * 100 - 100;
    if (markPct > peakPct) peakPct = markPct;
    if (value > peakValue) peakValue = value;

    if (markPct <= -preset.stopLossPct) {
      sell(e.ev.ts, remaining, marketPrice, 'sl');
      break;
    }

    for (let j = 0; j < ladder.length && remaining > 0; j++) {
      const tp = ladder[j]!;
      if (tpHit[j] || markPct < tp.pct) continue;
      tpHit[j] = true;
      const qty = tp.sellPct >= 100 ? remaining : (tokensBought * tp.sellPct) / 100;
      sell(e.ev.ts, qty, marketPrice, 'tp');
    }
    if (remaining <= 0) break;

    if (preset.trailing) {
      if (!trailingActive && peakPct >= preset.trailing.activatePct) trailingActive = true;
      if (trailingActive && value <= peakValue * (1 - preset.trailing.dropPct / 100)) {
        sell(e.ev.ts, remaining, marketPrice, 'trailing');
        break;
      }
    }
  }

  if (remaining > 0) {
    if (preset.timeoutSec != null) {
      sell(deadline, remaining, marketPrice, 'timeout');
      lastTs = deadline;
    } else {
      sell(lastTs, remaining, marketPrice, 'end_of_data');
    }
  }

  const soldTokens = fills.reduce((s, f) => s + f.tokens, 0);
  const last = fills[fills.length - 1];
  const pnlEth = proceeds - cost;
  return {
    token: launch.token,
    launchTs: launch.ts,
    entered: true,
    entryTs,
    taxBps: entry.taxBps,
    entryPrice,
    entryMarketPrice,
    entryMcapEth,
    exitPrice: soldTokens > 0 ? proceeds / soldTokens : null,
    pnlEth,
    pnlPct: (pnlEth / cost) * 100,
    holdSec: Math.max(0, (last?.ts ?? lastTs) - entryTs),
    exitReason: last?.reason ?? 'end_of_data',
    peakPct,
    fills,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface BacktestSummary {
  /** snipes actually entered */
  n: number;
  nSkipped: number;
  /** 0..1 */
  winRate: number;
  avgPnlEth: number;
  avgPnlPct: number;
  medianPnlPct: number;
  pnlSum: number;
  /** max peak-to-trough drop of cumulative PnL (ETH, >= 0), snipes ordered by launch time */
  maxDD: number;
  /** expected ETH per entered snipe (= avgPnlEth) */
  expectancyEth: number;
  exitReasons: Partial<Record<ExitReason, number>>;
  firstLaunchTs: number | null;
  lastLaunchTs: number | null;
}

export interface BacktestReport extends BacktestSummary {
  perToken: SnipeResult[];
}

export function quantile(values: readonly number[], q: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0]!;
  const pos = (xs.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

export function summarize(results: readonly SnipeResult[]): BacktestSummary {
  const ordered = [...results].sort((a, b) => a.launchTs - b.launchTs);
  const entered = ordered.filter((r) => r.entered);
  const exitReasons: Partial<Record<ExitReason, number>> = {};
  for (const r of ordered) exitReasons[r.exitReason] = (exitReasons[r.exitReason] ?? 0) + 1;
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of entered) {
    cum += r.pnlEth;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
  }
  const n = entered.length;
  const pnlSum = entered.reduce((s, r) => s + r.pnlEth, 0);
  const avgPnlEth = n ? pnlSum / n : 0;
  return {
    n,
    nSkipped: ordered.length - n,
    winRate: n ? entered.filter((r) => r.pnlEth > 0).length / n : 0,
    avgPnlEth,
    avgPnlPct: n ? entered.reduce((s, r) => s + r.pnlPct, 0) / n : 0,
    medianPnlPct: quantile(entered.map((r) => r.pnlPct), 0.5) ?? 0,
    pnlSum,
    maxDD,
    expectancyEth: avgPnlEth,
    exitReasons,
    firstLaunchTs: ordered[0]?.launchTs ?? null,
    lastLaunchTs: ordered[ordered.length - 1]?.launchTs ?? null,
  };
}

export function backtestPlay(items: readonly BacktestItem[], preset: SimPreset): BacktestReport {
  const perToken = items.map((it) => simulateSnipe(it.launch, it.trades, preset, it.transfers));
  return { ...summarize(perToken), perToken };
}

// ---------------------------------------------------------------------------
// Grid search
// ---------------------------------------------------------------------------

export interface GridSpec {
  /** a number means "sell 100 % at +pct"; an array is a full ladder; null means no TP */
  tp: Array<number | TakeProfit[] | null>;
  trailing: Array<{ activatePct: number; dropPct: number } | null>;
  sl: number[];
  timeoutSec?: Array<number | null>;
}

export interface GridResult {
  preset: SimPreset;
  summary: BacktestSummary;
}

export interface GridSearchResult {
  evaluated: number;
  n: number;
  minN: number;
  insufficient: boolean;
  results: GridResult[];
}

export function gridSearch(
  items: readonly BacktestItem[],
  base: SimPreset,
  grid: GridSpec,
  opts: { minN?: number; top?: number } = {},
): GridSearchResult {
  const minN = opts.minN ?? 5;
  const top = opts.top ?? 5;
  const timeouts: Array<number | null> = grid.timeoutSec && grid.timeoutSec.length > 0 ? grid.timeoutSec : [base.timeoutSec ?? null];
  const results: GridResult[] = [];
  let n = 0;
  for (const tp of grid.tp.length ? grid.tp : [null]) {
    const takeProfits: TakeProfit[] = tp === null ? [] : typeof tp === 'number' ? [{ pct: tp, sellPct: 100 }] : tp;
    for (const trailing of grid.trailing.length ? grid.trailing : [null]) {
      for (const sl of grid.sl.length ? grid.sl : [base.stopLossPct]) {
        for (const timeout of timeouts) {
          if (takeProfits.length === 0 && trailing === null && timeout === null) continue; // no exit rule but SL
          const preset: SimPreset = {
            ...base,
            takeProfits,
            stopLossPct: sl,
            ...(trailing ? { trailing } : { trailing: undefined }),
            timeoutSec: timeout,
          };
          const summary = summarize(items.map((it) => simulateSnipe(it.launch, it.trades, preset, it.transfers)));
          n = summary.n;
          results.push({ preset, summary });
        }
      }
    }
  }
  const insufficient = n < minN;
  results.sort(
    (a, b) =>
      b.summary.expectancyEth - a.summary.expectancyEth ||
      b.summary.winRate - a.summary.winRate ||
      a.summary.maxDD - b.summary.maxDD,
  );
  return { evaluated: results.length, n, minN, insufficient, results: insufficient ? [] : results.slice(0, top) };
}

// ---------------------------------------------------------------------------
// Peak distribution -> preset derivation (prompt step 9)
// ---------------------------------------------------------------------------

export interface PeakMetrics {
  token?: string;
  peak2Pct: number | null;
  peak5Pct: number | null;
  peak10Pct: number | null;
  peak30Pct: number | null;
  peak60Pct: number | null;
  /** most negative % vs first taxed entry within 60 s (e.g. -35) */
  lowAfterEntryPct: number | null;
}

export const PEAK_WINDOWS = [2, 5, 10, 30, 60] as const;
export type PeakWindow = (typeof PEAK_WINDOWS)[number];

export interface WindowStats {
  window: PeakWindow;
  count: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
  /** share of coins (0..1) whose peak in the window reached +100 % */
  shareGe100: number;
}

export interface PeakStats {
  coins: number;
  windows: WindowStats[];
  low: { count: number; p25: number | null; median: number | null; p75: number | null };
}

function peakOf(m: PeakMetrics, w: PeakWindow): number | null {
  switch (w) {
    case 2:
      return m.peak2Pct;
    case 5:
      return m.peak5Pct;
    case 10:
      return m.peak10Pct;
    case 30:
      return m.peak30Pct;
    case 60:
      return m.peak60Pct;
  }
}

function present(xs: ReadonlyArray<number | null>): number[] {
  return xs.filter((x): x is number => x !== null && Number.isFinite(x));
}

export function peakStats(metrics: readonly PeakMetrics[]): PeakStats {
  const windows = PEAK_WINDOWS.map((w): WindowStats => {
    const xs = present(metrics.map((m) => peakOf(m, w)));
    return {
      window: w,
      count: xs.length,
      p25: quantile(xs, 0.25),
      median: quantile(xs, 0.5),
      p75: quantile(xs, 0.75),
      shareGe100: xs.length ? xs.filter((x) => x >= 100).length / xs.length : 0,
    };
  });
  const lows = present(metrics.map((m) => m.lowAfterEntryPct));
  return {
    coins: metrics.length,
    windows,
    low: { count: lows.length, p25: quantile(lows, 0.25), median: quantile(lows, 0.5), p75: quantile(lows, 0.75) },
  };
}

export interface DerivedPreset {
  takeProfits: TakeProfit[];
  trailing?: { activatePct: number; dropPct: number };
  stopLossPct: number;
  justification: string[];
  stats: PeakStats;
}

/** Converts a peak measured from the first taxed buyer's fill into our position mark (our fill also pays snipe tax, fee, creator tax and impact). */
export function peakToMark(peakPct: number, entryCostPct: number): number {
  return ((1 + peakPct / 100) / (1 + entryCostPct / 100) - 1) * 100;
}

const floor5 = (x: number): number => Math.floor(x / 5) * 5;
const ceil5 = (x: number): number => Math.ceil(x / 5) * 5;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Step 9 of the hunting method:
 *  - TP where >= 70 % of coins reached within 5 s (30th percentile of peak5),
 *  - trailing activation at the median 30 s peak, drop kept at `dropPct`,
 *  - stop loss just beyond the median low-after-entry (+10 pt margin), clamped 15-60 %.
 * Peaks are converted to position marks with `entryCostPct` (6.18 % snipe tax + 1 % fee + creator tax + impact).
 */
export function derivePresetFromPeaks(
  metrics: readonly PeakMetrics[],
  opts: { entryCostPct?: number; creatorTaxBps?: number; dropPct?: number; fallbackStopLossPct?: number } = {},
): DerivedPreset | null {
  // 6.18 % snipe tax + 1 % fee + creator tax + ~1 % own impact
  const entryCostPct = opts.entryCostPct ?? 6.18 + 1 + (opts.creatorTaxBps ?? 0) / 100 + 1;
  const stats = peakStats(metrics);
  const p5 = present(metrics.map((m) => m.peak5Pct));
  if (p5.length === 0) return null;
  const reached70 = quantile(p5, 0.3)!;
  const tpPct = clamp(floor5(peakToMark(reached70, entryCostPct)), 10, 1000);
  const justification: string[] = [
    `${p5.length} coins with a 5 s peak; 70 % of them reached at least +${reached70.toFixed(0)} % from the first taxed buyer's entry within 5 s` +
      ` -> TP at +${tpPct} % position mark (after ~${entryCostPct.toFixed(1)} % entry cost).`,
  ];
  const p30 = present(metrics.map((m) => m.peak30Pct));
  const med30 = quantile(p30, 0.5);
  let trailing: DerivedPreset['trailing'];
  if (med30 !== null && med30 > 0) {
    const act = clamp(floor5(peakToMark(med30, entryCostPct)), 10, 1000);
    trailing = { activatePct: act, dropPct: opts.dropPct ?? 25 };
    justification.push(`median 30 s peak +${med30.toFixed(0)} % -> trailing activates at +${act} %, exits on a ${trailing.dropPct} % pullback.`);
  }
  const lows = present(metrics.map((m) => m.lowAfterEntryPct));
  const medLow = quantile(lows, 0.5);
  let stopLossPct = opts.fallbackStopLossPct ?? 40;
  if (medLow !== null) {
    stopLossPct = clamp(ceil5(Math.abs(Math.min(0, medLow))) + 10, 15, 60);
    justification.push(`median low after entry ${medLow.toFixed(0)} % -> stop loss ${stopLossPct} % (10 pt beyond the typical dip, clamped 15-60).`);
  } else {
    justification.push(`no low_after_entry data -> default stop loss ${stopLossPct} %.`);
  }
  // A second rung keeps exposure to the 10-30 s leg when the median run continues past the TP.
  const takeProfits: TakeProfit[] =
    trailing && trailing.activatePct > tpPct ? [{ pct: tpPct, sellPct: 60 }] : [{ pct: tpPct, sellPct: 100 }];
  if (takeProfits[0]!.sellPct < 100) justification.push(`TP sells 60 % so the remainder rides the trailing stop.`);
  return { takeProfits, ...(trailing ? { trailing } : {}), stopLossPct, justification, stats };
}
