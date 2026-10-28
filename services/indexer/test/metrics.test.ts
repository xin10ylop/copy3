import { describe, expect, it } from 'vitest';
import { computeTokenMetrics } from '../src/metrics.js';
import type { Address, Hex, LaunchRow, TokenTransferRow, TradeRow } from '../src/types.js';
import { AMLIL_DUMP_WALLET, amlilFixture, amlilLaunch, amlilTrades } from './helpers/fixtures.js';

const E = 10n ** 18n;
const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const CURVE = '0x00000000000000000000000000000000000000cc' as Address;
const DEPLOYER = '0x00000000000000000000000000000000000000d0' as Address;
const TEAM1 = '0x00000000000000000000000000000000000000e1' as Address;
const TEAM2 = '0x00000000000000000000000000000000000000e2' as Address;
const T0 = 1_800_000_000;

const launch: LaunchRow = {
  token: TOKEN,
  curve: CURVE,
  deployer: DEPLOYER,
  launcher: null,
  launchKind: 'launchToken',
  creatorFeeRecipient: TEAM1,
  creatorTaxBps: 0,
  name: 'X',
  symbol: 'X',
  logo: null,
  pairToken: '0x0000000000000000000000000000000000000000',
  launchConfigId: 0n,
  graduationThreshold: 0n,
  exemptions: [TEAM2],
  devBuyQuote: null,
  block: 100,
  ts: T0,
  txHash: '0x01',
  txFrom: DEPLOYER,
  startPrice: 1e-9,
  startMcapEth: 1,
  graduated: false,
};

let li = 0;
/** trade at `dt` seconds after launch with execution price `price` (quote = price * tokens) */
function trade(dt: number, side: 'buy' | 'sell', who: string, price: number, opts: { snipeTax?: bigint; block?: number } = {}): TradeRow {
  const tokens = 1_000_000n * E;
  const quote = BigInt(Math.round(price * 1e6 * 1e9)) * 10n ** 9n; // price * 1e6 tokens, in wei
  return {
    token: TOKEN,
    curve: CURVE,
    block: opts.block ?? 100 + dt * 10,
    ts: T0 + dt,
    txHash: `0x${(++li).toString(16).padStart(64, '0')}` as Hex,
    logIndex: li,
    side,
    trader: who as Address,
    recipient: who as Address,
    txFrom: who as Address,
    quote,
    tokens,
    fee: 0n,
    tax: 0n,
    snipeTax: opts.snipeTax ?? 0n,
    priceAfter: price,
    secondsSinceLaunch: dt,
    exempt: [DEPLOYER, TEAM1, TEAM2].includes(who as Address),
  };
}

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b1';
const C = '0x00000000000000000000000000000000000000c1';

describe('computeTokenMetrics (synthetic, video semantics)', () => {
  const trades = [
    trade(0, 'buy', TEAM1, 1.0e-9), // exempt team buys in the launch second: ignored for entry
    trade(0, 'buy', TEAM2, 1.5e-9),
    trade(1, 'buy', A, 2.0e-9, { snipeTax: 6n * 10n ** 15n }), // first taxed buyer at +1 s
    trade(2, 'buy', B, 2.6e-9, { snipeTax: 10n ** 13n }),
    trade(3, 'buy', C, 4.0e-9), // +100 % at +2 s after entry
    trade(5, 'sell', A, 1.8e-9), // -10 % dip
    trade(7, 'buy', B, 6.0e-9), // +200 % at +6 s
    trade(20, 'buy', C, 9.0e-9), // +350 % at +19 s
    trade(45, 'sell', B, 5.0e-9),
    trade(90, 'buy', A, 12.0e-9), // outside every window, but the ATH
  ];

  it('picks the first buy carrying a snipe tax as entry, not the exempt launch-second buys', () => {
    const m = computeTokenMetrics(launch, trades);
    expect(m.firstTaxedBuyer).toBe(A);
    expect(m.firstTaxedTs).toBe(T0 + 1);
    expect(m.firstTaxedPrice).toBeCloseTo(2e-9, 15);
    expect(m.firstTaxedMcapEth).toBeCloseTo(2, 9);
  });

  it('computes peaks per window measured from the first taxed buy, and mcap at each', () => {
    const m = computeTokenMetrics(launch, trades);
    expect(m.peak2Pct).toBeCloseTo(100, 6); // window [+1, +3]: 4.0e-9
    expect(m.peak5Pct).toBeCloseTo(100, 6); // [+1, +6]: dip only
    expect(m.peak10Pct).toBeCloseTo(200, 6); // [+1, +11]: 6.0e-9 at +7
    expect(m.peak30Pct).toBeCloseTo(350, 6);
    expect(m.peak60Pct).toBeCloseTo(350, 6); // +90 is outside
    expect(m.mcap2).toBeCloseTo(4, 6);
    expect(m.mcap30).toBeCloseTo(9, 6);
  });

  it('reports the drawdown below entry within 60 s and the all-time high', () => {
    const m = computeTokenMetrics(launch, trades);
    expect(m.lowAfterEntryPct).toBeCloseTo(-10, 6);
    expect(m.athPrice).toBeCloseTo(12e-9, 15);
    expect(m.athTs).toBe(T0 + 90);
    expect(m.athMcapEth).toBeCloseTo(12, 6);
  });

  it('counts tax-free buys in the snipe-tax window and 60 s activity', () => {
    const m = computeTokenMetrics(launch, trades);
    expect(m.taxFreeBuyCount).toBe(2);
    expect(m.taxFreeQuote).toBe(trades[0]!.quote + trades[1]!.quote);
    expect(m.nBuys60s).toBe(7);
    expect(m.nSells60s).toBe(2);
    expect(m.exemptSoldWithinSec).toBeNull();
    expect(m.dumpWallets).toEqual([]);
  });

  it('is order independent (sorts by block, logIndex)', () => {
    const a = computeTokenMetrics(launch, trades);
    const b = computeTokenMetrics(launch, [...trades].reverse());
    expect(b).toEqual(a);
  });

  it('falls back to the first non-exempt buy when no buy paid snipe tax', () => {
    const late = [trade(0, 'buy', TEAM1, 1e-9), trade(4, 'buy', B, 3e-9), trade(6, 'buy', C, 6e-9)];
    const m = computeTokenMetrics(launch, late);
    expect(m.firstTaxedBuyer).toBe(B);
    expect(m.peak2Pct).toBeCloseTo(100, 6);
  });

  it('has null entry metrics without any non-exempt buy', () => {
    const m = computeTokenMetrics(launch, [trade(0, 'buy', TEAM1, 1e-9)]);
    expect(m.firstTaxedBuyer).toBeNull();
    expect(m.peak2Pct).toBeNull();
    expect(m.lowAfterEntryPct).toBeNull();
    expect(m.athPrice).toBeCloseTo(1e-9, 15);
  });

  it('detects an exempt CurveSell as the exempt exit', () => {
    const m = computeTokenMetrics(launch, [...trades, trade(8, 'sell', TEAM2, 5e-9)]);
    expect(m.exemptSoldWithinSec).toBe(8);
    expect(m.operatorSellEth).toBeCloseTo(0.005, 9);
  });

  it('detects an exempt Transfer to a fresh wallet as the exit and attributes its sells to the operator', () => {
    const DUMP = '0x00000000000000000000000000000000000000f9' as Address;
    const xfer = (dt: number, from: Address, to: Address, logIndex: number): TokenTransferRow => ({
      token: TOKEN,
      block: 100 + dt * 10,
      ts: T0 + dt,
      txHash: `0x${'9'.repeat(63)}${logIndex}` as Hex,
      logIndex,
      from,
      to,
      value: 10n ** 24n,
    });
    const transfers = [
      xfer(4, TEAM1, TEAM2, 900), // team-internal move: not an exit
      xfer(5, TEAM1, CURVE, 901), // to the curve: not a dump wallet
      xfer(6, TEAM2, DUMP, 902), // the dump
    ];
    const withDump = [...trades, trade(7, 'sell', DUMP, 5e-9), trade(8, 'sell', DUMP, 4e-9)];
    const m = computeTokenMetrics(launch, withDump, transfers);
    expect(m.exemptSoldWithinSec).toBe(6);
    expect(m.dumpWallets).toEqual([DUMP]);
    expect(m.operatorSellEth).toBeCloseTo(0.009, 9);
  });
});

describe('computeTokenMetrics on the real Amlil play (docs/EXAMPLES.md)', () => {
  const f = amlilFixture();
  const L = amlilLaunch(f);
  const trades = amlilTrades(f);

  it('finds the first taxed buyer at +1 s and the retail entry price', () => {
    const m = computeTokenMetrics(L, trades);
    expect(m.firstTaxedBuyer).toBe('0xc54d3914f91f984d61b63d491f38934c4e706b79');
    expect(m.firstTaxedTs! - L.ts).toBe(1);
    expect(m.firstTaxedBlock).toBe(95_940_704);
    expect(m.firstTaxedPrice!).toBeCloseTo(2.7937e-9, 12);
    expect(m.firstTaxedMcapEth!).toBeCloseTo(2.794, 3);
  });

  it('reproduces the avg-price peaks +44 % @2 s, +222 % @5/10 s, +377 % @30/60 s', () => {
    const m = computeTokenMetrics(L, trades);
    expect(m.peak2Pct!).toBeCloseTo(43.91, 2);
    expect(m.peak5Pct!).toBeCloseTo(222.07, 2);
    expect(m.peak10Pct!).toBeCloseTo(222.07, 2);
    expect(m.peak30Pct!).toBeCloseTo(376.59, 2);
    expect(m.peak60Pct!).toBeCloseTo(376.59, 2);
    expect(m.mcap30!).toBeCloseTo(13.315, 3);
    expect(m.lowAfterEntryPct!).toBeCloseTo(-4.599, 3);
    expect(m.athPrice!).toBeCloseTo(1.3315e-8, 11);
    expect(m.athTs! - L.ts).toBe(13);
  });

  it('counts the two tax-free team buys (0.38 ETH) and the first-minute activity', () => {
    const m = computeTokenMetrics(L, trades);
    expect(m.taxFreeBuyCount).toBe(2);
    expect(m.taxFreeQuote).toBe(380_186_069_901_936_130n);
    expect(m.nBuys60s).toBe(111);
    expect(m.nSells60s).toBe(66);
  });

  it('spot basis (price_after from reserves) gives the reserve-price peaks', () => {
    const m = computeTokenMetrics(L, trades, [], { priceBasis: 'spot' });
    expect(m.firstTaxedPrice!).toBeCloseTo(2.5766e-9, 12);
    expect(m.peak2Pct!).toBeCloseTo(51.45, 2);
    expect(m.peak5Pct!).toBeCloseTo(238.74, 2);
    expect(m.peak30Pct!).toBeCloseTo(406.35, 2);
  });

  it('misses the exit without token transfers (the team never CurveSells) ...', () => {
    const m = computeTokenMetrics(L, trades);
    expect(m.exemptSoldWithinSec).toBeNull();
    expect(m.dumpWallets).toEqual([]);
  });

  it('... and catches it at +6 s from the exempt -> dump-wallet transfers', () => {
    // 13 batches: one Transfer from a team wallet to the dump wallet in the block before each dump sell
    const dumpSells = trades.filter((t) => t.side === 'sell' && t.trader === AMLIL_DUMP_WALLET);
    expect(dumpSells).toHaveLength(13);
    const team = f.meta.exempt.filter((a) => a !== f.meta.deployer);
    const transfers: TokenTransferRow[] = dumpSells.map((s, i) => ({
      token: L.token,
      block: s.block - 1,
      ts: s.ts,
      txHash: `0x${(i + 1).toString(16).padStart(64, 'd')}` as Hex,
      logIndex: 0,
      from: team[i % team.length]!,
      to: AMLIL_DUMP_WALLET,
      value: s.tokens,
    }));
    const m = computeTokenMetrics(L, trades, transfers);
    expect(m.exemptSoldWithinSec).toBe(6);
    expect(m.dumpWallets).toEqual([AMLIL_DUMP_WALLET]);
    expect(m.operatorSellEth).toBeCloseTo(1.31444, 5);
  });
});
