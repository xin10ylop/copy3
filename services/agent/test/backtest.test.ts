import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  backtestPlay,
  derivePresetFromPeaks,
  gridSearch,
  simulateSnipe,
  type BacktestItem,
  type BacktestLaunch,
  type BacktestTrade,
  type BacktestTransfer,
  type SimPreset,
} from '../src/backtest.js';

const T0 = 1_792_758_495;
const TEAM = '0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a';

const base: SimPreset = {
  buyEth: 0.07,
  maxTaxBps: 1000,
  takeProfits: [{ pct: 150, sellPct: 100 }],
  stopLossPct: 40,
  abortIfExemptSellInLaunchBlock: false,
};

let blk = 1000;
function path(points: Array<[sec: number, price: number, opts?: Partial<BacktestTrade>]>): BacktestTrade[] {
  return points.map(([sec, price, opts]) => ({
    ts: T0 + sec,
    block: blk++,
    logIndex: 0,
    side: 'buy' as const,
    priceAfter: price,
    quoteEth: 0.05,
    tokens: 1e7,
    exempt: false,
    wallet: `0x${(blk % 997).toString(16).padStart(40, '0')}`,
    ...opts,
  }));
}

const launch = (token: string, extra: Partial<BacktestLaunch> = {}): BacktestLaunch => ({
  token,
  ts: T0,
  startPrice: 1.68e-9,
  creatorTaxBps: 0,
  ...extra,
});

// The video: team buys at +0 s take the curve to ~12k USD (3 ETH at 4000 USD/ETH);
// first taxed entry, +100 % at 2 s, +250 % at 5 s, then a retrace.
const teamBuy = (price: number): [number, number, Partial<BacktestTrade>] => [0, price, { exempt: true, wallet: TEAM, tokens: 1e8 }];
const videoPath = (): BacktestTrade[] =>
  path([teamBuy(3e-9), [1, 3.1e-9], [2, 6e-9], [3, 8e-9], [5, 10.5e-9], [10, 9e-9], [20, 6e-9], [30, 4.5e-9], [60, 3e-9]]);
const rugPath = (): BacktestTrade[] =>
  path([teamBuy(3e-9), [1, 3.1e-9], [2, 3.6e-9], [3, 1.2e-9, { side: 'sell', exempt: true, wallet: TEAM, tokens: 1e8 }], [4, 1.0e-9]]);
const slowCook = (): BacktestTrade[] => {
  const pts: Array<[number, number, Partial<BacktestTrade>?]> = [teamBuy(3e-9), [1, 3.1e-9]];
  for (let s = 2; s <= 300; s += 2) pts.push([s, 3.1e-9 * 1.01 ** (s / 2)]);
  return path(pts);
};

describe('simulateSnipe', () => {
  it('enters at +1 s paying 6.18 % on top, and takes profit on the video pump', () => {
    const r = simulateSnipe(launch('0xa'), videoPath(), base);
    expect(r.entered).toBe(true);
    expect(r.taxBps).toBe(618);
    expect(r.entryTs).toBe(T0 + 1);
    expect(r.entryMarketPrice).toBeCloseTo(3e-9, 15);
    // 6.18 % snipe tax + 1 % fee + ~2.9 % own impact on a 2.245 ETH virtual reserve
    expect(r.entryPrice!).toBeGreaterThan(3.25e-9);
    expect(r.entryPrice!).toBeLessThan(3.4e-9);
    expect(r.exitReason).toBe('tp');
    expect(r.holdSec).toBe(4); // +5 s is the first mark >= +150 %
    expect(r.pnlPct).toBeGreaterThan(150);
    expect(r.pnlPct).toBeLessThan(230);
  });

  it('rides a trailing stop and exits on the 25 % pullback from the peak', () => {
    const r = simulateSnipe(launch('0xa'), videoPath(), { ...base, takeProfits: [], trailing: { activatePct: 100, dropPct: 25 } });
    expect(r.exitReason).toBe('trailing');
    expect(r.fills[0]!.ts).toBe(T0 + 20);
    expect(r.peakPct).toBeGreaterThan(200);
    expect(r.pnlPct).toBeGreaterThan(60);
    expect(r.pnlPct).toBeLessThan(85);
  });

  it('stops out on a rug', () => {
    const r = simulateSnipe(launch('0xb'), rugPath(), base);
    expect(r.exitReason).toBe('sl');
    expect(r.pnlPct).toBeLessThan(-55);
  });

  it('exits on an exempt transfer-out one block before the dump (team pattern)', () => {
    const trades = rugPath();
    const dump = trades[3]!;
    const transfers: BacktestTransfer[] = [
      { ts: dump.ts, block: dump.block - 1, logIndex: 0, from: TEAM, to: '0xa98da960d6', tokens: 6e7 },
    ];
    const r = simulateSnipe(launch('0xb'), trades, { ...base, exitIfExemptSellsPct: 50 }, transfers);
    expect(r.exitReason).toBe('exempt_transfer');
    expect(r.fills[0]!.marketPrice).toBeCloseTo(3.6e-9, 15);
    expect(r.pnlPct).toBeGreaterThan(0);
  });

  it('exits on an exempt curve sell when no transfer precedes it', () => {
    const r = simulateSnipe(launch('0xb'), rugPath(), { ...base, exitIfExemptSellsPct: 50 });
    expect(r.exitReason).toBe('exempt_sell');
  });

  it('times out a slow cook', () => {
    const r = simulateSnipe(launch('0xc'), slowCook(), { ...base, timeoutSec: 120 });
    expect(r.exitReason).toBe('timeout');
    expect(r.holdSec).toBe(120);
    expect(r.pnlPct).toBeGreaterThan(40);
    expect(r.pnlPct).toBeLessThan(90);
  });

  it('aborts when an exempt wallet sells in the launch second', () => {
    const trades = path([teamBuy(3e-9), [0, 2.5e-9, { side: 'sell', exempt: true, wallet: TEAM, tokens: 5e7 }], [1, 2.6e-9]]);
    const r = simulateSnipe(launch('0xd'), trades, { ...base, abortIfExemptSellInLaunchBlock: true });
    expect(r.entered).toBe(false);
    expect(r.exitReason).toBe('aborted_exempt_sell');
  });

  it('skips when the entry mcap is above the cap and when tax tolerance is too low for +1 s', () => {
    expect(simulateSnipe(launch('0xe'), videoPath(), { ...base, maxEntryMcapEth: 2 }).exitReason).toBe('skipped_mcap');
    const late = simulateSnipe(launch('0xe'), videoPath(), { ...base, maxTaxBps: 100 });
    expect(late.taxBps).toBe(19);
    expect(late.entryTs).toBe(T0 + 2);
  });
});

// ---------------------------------------------------------------------------
// Real data: the video's "Amlo" coin (docs/EXAMPLES.md)
// ---------------------------------------------------------------------------

interface AmlilTrade {
  blk: number;
  side: 'buy' | 'sell';
  actor: string;
  recipient: string;
  q: number;
  tok: number;
  fee: number;
  tax: number;
  snipe_tax: number;
  ts: number;
  tx: string;
}
interface AmlilFixture {
  trades: AmlilTrade[];
  meta: { token: string; launchedAt: number; exempt: string[]; dumpWallet: string };
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../packages/core/test/fixtures/amlil-trades.json', import.meta.url), 'utf8'),
) as AmlilFixture;

/** Replays the fixture through constant product (Q0 1.68 ETH, T0 1e9) to get price_after. */
function amlilItem(): BacktestItem & { raw: AmlilTrade[] } {
  const exempt = new Set(fixture.meta.exempt.map((a) => a.toLowerCase()));
  let Q = 1.68;
  let T = 1e9;
  const trades: BacktestTrade[] = fixture.trades.map((t, i) => {
    const q = t.q / 1e18;
    const tok = t.tok / 1e18;
    if (t.side === 'buy') {
      Q += q - t.fee / 1e18 - t.tax / 1e18;
      T -= tok;
    } else {
      Q -= q + t.fee / 1e18 + t.tax / 1e18;
      T += tok;
    }
    const wallet = (t.side === 'buy' ? t.recipient : t.actor).toLowerCase();
    return { ts: t.ts, block: t.blk, logIndex: i, side: t.side, priceAfter: Q / T, quoteEth: q, tokens: tok, exempt: exempt.has(wallet), wallet };
  });
  return {
    launch: { token: fixture.meta.token, ts: fixture.meta.launchedAt, startPrice: 1.68e-9, creatorTaxBps: 200 },
    trades,
    raw: fixture.trades,
  };
}

describe('Amlil fixture', () => {
  const item = amlilItem();
  const t0 = fixture.meta.launchedAt;

  it('first taxed buyer paid exactly 6.18 % at +1 s and peaks match the worked example', () => {
    const firstTaxed = item.raw.find((t) => t.side === 'buy' && t.snipe_tax > 0)!;
    expect(firstTaxed.ts - t0).toBe(1);
    expect(firstTaxed.snipe_tax / firstTaxed.q).toBeCloseTo(0.0618, 4);
    const entry = firstTaxed.q / firstTaxed.tok;
    expect(entry).toBeCloseTo(2.794e-9, 11);
    const peak = (w: number): number =>
      Math.max(...item.raw.filter((t) => t.ts >= firstTaxed.ts && t.ts <= firstTaxed.ts + w).map((t) => t.q / t.tok)) / entry * 100 - 100;
    expect(peak(2)).toBeCloseTo(44, 0);
    expect(peak(5)).toBeCloseTo(222, -1);
    expect(peak(30)).toBeCloseTo(377, -1);
  });

  it('a snipe in front of the first taxed buyer fills near its price and takes profit', () => {
    const r = simulateSnipe(item.launch, item.trades, { ...base, takeProfits: [{ pct: 100, sellPct: 100 }] });
    expect(r.entered).toBe(true);
    expect(r.taxBps).toBe(618);
    expect(r.entryPrice!).toBeGreaterThan(2.7e-9);
    expect(r.entryPrice!).toBeLessThan(2.95e-9);
    expect(r.exitReason).toBe('tp');
    expect(r.pnlPct).toBeGreaterThan(80);
  });

  it('exits on the team transfer-out at +6 s (dump starts) with the pump captured', () => {
    const dumpPrefix = fixture.meta.dumpWallet.toLowerCase();
    const firstDump = item.raw.find((t) => t.side === 'sell' && t.actor.toLowerCase().startsWith(dumpPrefix))!;
    expect(firstDump.ts - t0).toBe(6);
    const transfers: BacktestTransfer[] = Array.from({ length: 13 }, (_, i) => ({
      ts: firstDump.ts + Math.floor(i / 3),
      block: firstDump.blk - 1 + i,
      logIndex: 0,
      from: i % 2 ? fixture.meta.exempt[1]! : fixture.meta.exempt[2]!,
      to: firstDump.actor,
      tokens: 180e6 / 13,
    }));
    const r = simulateSnipe(item.launch, item.trades, { ...base, takeProfits: [{ pct: 500, sellPct: 100 }], exitIfExemptSellsPct: 10 }, transfers);
    expect(r.exitReason).toBe('exempt_transfer');
    expect(r.fills[0]!.ts - t0).toBe(6);
    expect(r.pnlPct).toBeGreaterThan(100);
  });
});

describe('backtestPlay + gridSearch', () => {
  const items: BacktestItem[] = [
    { launch: launch('0x1', { ts: T0 }), trades: videoPath() },
    { launch: launch('0x2', { ts: T0 }), trades: videoPath() },
    { launch: launch('0x3', { ts: T0 }), trades: rugPath() },
    { launch: launch('0x4', { ts: T0 }), trades: slowCook() },
    { launch: launch('0x5', { ts: T0 }), trades: videoPath() },
  ];

  it('aggregates win rate, pnl and drawdown', () => {
    const rep = backtestPlay(items, { ...base, timeoutSec: 120 });
    expect(rep.n).toBe(5);
    expect(rep.winRate).toBeCloseTo(0.8, 5);
    expect(rep.pnlSum).toBeCloseTo(rep.perToken.reduce((s, r) => s + r.pnlEth, 0), 12);
    expect(rep.maxDD).toBeGreaterThan(0);
    expect(rep.exitReasons.sl).toBe(1);
    expect(rep.medianPnlPct).toBeGreaterThan(100);
  });

  it('ranks presets by expectancy and enforces the minimum-n guard', () => {
    const grid = { tp: [80, 150, 300, null], trailing: [null, { activatePct: 100, dropPct: 25 }], sl: [25, 40], timeoutSec: [60] };
    const res = gridSearch(items, base, grid, { minN: 5, top: 3 });
    expect(res.insufficient).toBe(false);
    expect(res.evaluated).toBe(16);
    expect(res.results).toHaveLength(3);
    const e = res.results.map((r) => r.summary.expectancyEth);
    expect(e[0]!).toBeGreaterThanOrEqual(e[1]!);
    expect(e[1]!).toBeGreaterThanOrEqual(e[2]!);
    const guarded = gridSearch(items, base, grid, { minN: 10 });
    expect(guarded.insufficient).toBe(true);
    expect(guarded.results).toHaveLength(0);
  });
});

describe('derivePresetFromPeaks', () => {
  it('puts TP where 70 % of coins reached within 5 s and trailing at the 30 s median', () => {
    const peaks5 = [50, 80, 100, 120, 150, 180, 200, 250, 300, 400];
    const metrics = peaks5.map((p, i) => ({
      peak2Pct: p / 2,
      peak5Pct: p,
      peak10Pct: p,
      peak30Pct: p * 1.5,
      peak60Pct: p,
      lowAfterEntryPct: -10 - i,
    }));
    const d = derivePresetFromPeaks(metrics, { entryCostPct: 8 })!;
    // 30th percentile of peak5 = 114 % -> mark (2.14 / 1.08 - 1) = 98 % -> 95
    expect(d.takeProfits[0]!.pct).toBe(95);
    expect(d.trailing!.activatePct).toBeGreaterThan(d.takeProfits[0]!.pct);
    expect(d.stopLossPct).toBe(25); // median low -14.5 -> ceil5 15 + 10
    expect(d.justification.join(' ')).toContain('70 %');
    expect(d.stats.windows.find((w) => w.window === 5)!.shareGe100).toBeCloseTo(0.8, 5);
  });

  it('returns null without 5 s peaks', () => {
    expect(derivePresetFromPeaks([{ peak2Pct: null, peak5Pct: null, peak10Pct: null, peak30Pct: null, peak60Pct: null, lowAfterEntryPct: null }])).toBeNull();
  });
});
