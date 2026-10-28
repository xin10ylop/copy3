import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  snipeTaxBps,
  quoteBuy,
  quoteSell,
  snipeTaxWeiFor,
  minOutWithSlippage,
  priceImpactBps,
  priceFromReserves,
  mcapFromReserves,
  type Reserves,
} from '../src/pons/curve.js';
import { parseCurveTradeLog, type RawLog } from '../src/pons/launch.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

describe('snipeTaxBps', () => {
  it('matches the verified decay table (startBps=9900, seconds=3)', () => {
    expect(snipeTaxBps(0)).toBe(9900);
    expect(snipeTaxBps(1)).toBe(618);
    expect(snipeTaxBps(2)).toBe(19);
    expect(snipeTaxBps(3)).toBe(0);
    expect(snipeTaxBps(5)).toBe(0);
  });
  it('rejects negative elapsed', () => {
    expect(() => snipeTaxBps(-1)).toThrow();
  });
});

describe('price and mcap', () => {
  it('start state: phantom 1.68e18 / supply 1e27 → 1.68 ETH mcap', () => {
    const r: Reserves = { quote: 1_680_000_000_000_000_000n, token: 1_000_000_000_000_000_000_000_000_000n };
    expect(priceFromReserves(r)).toBeCloseTo(1.68e-9, 15);
    expect(mcapFromReserves(r)).toBeCloseTo(1.68, 6);
  });
});

describe('minOutWithSlippage', () => {
  it('applies bps haircut', () => {
    expect(minOutWithSlippage(10_000n, 3000)).toBe(7000n);
    expect(minOutWithSlippage(10_000n, 0)).toBe(10_000n);
    expect(minOutWithSlippage(10_000n, 10_000)).toBe(0n);
  });
});

describe('snipeTaxWeiFor', () => {
  it('6.18 % of 0.035 ETH ≈ 0.002163 ETH', () => {
    expect(snipeTaxWeiFor(35_000_000_000_000_000n, 618)).toBe(2_163_000_000_000_000n);
  });
});

/**
 * Offline confirmation #1 (curve-logs fixture, three 0.0066 ETH buys):
 * derive virtual reserves from the sequence and check quoteBuy reproduces the
 * 2nd and 3rd buys' tokensOut given the 1st.
 */
describe('quoteBuy reproduces the curve-logs buy sequence', () => {
  const logs = JSON.parse(read('./fixtures/curve-logs.json')) as RawLog[];
  const buys = logs
    .filter((l) => l.topics[0] === '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455')
    .map(parseCurveTradeLog);

  it('has three buys', () => expect(buys.length).toBe(3));

  it('reproduces all three from the launch-config start reserves', () => {
    // start reserves = virtual quote 1.68e18, supply 1e27 (no prior trades before these)
    let r: Reserves = { quote: 1_680_000_000_000_000_000n, token: 1_000_000_000_000_000_000_000_000_000n };
    const feeBps = 100;
    for (const [i, b] of buys.entries()) {
      const snipe = 0n; // these buys are ≥3 s after launch → snipe tax 0 (fee/creatorTax from the log)
      const out = quoteBuy(r, b.quote, feeBps, 0, snipe);
      expect(out, `buy ${i + 1}`).toBe(b.tokens);
      // advance reserves exactly as the chain does
      const net = b.quote - b.fee - b.creatorTax - snipe;
      r = { quote: r.quote + net, token: r.token - b.tokens };
    }
  });
});

interface AmlilTrade {
  side: 'buy' | 'sell';
  q: string;
  tok: string;
  fee: string;
  tax: string;
  snipe_tax: string;
}

/** Load the amlil fixture bigint-safely (the raw JSON has >2^53 integer fields). */
function loadAmlil(): { trades: AmlilTrade[] } {
  const raw = read('./fixtures/amlil-trades.json').replace(
    /("(?:q|tok|fee|tax|snipe_tax)"\s*:\s*)(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g,
    '$1"$2"',
  );
  return JSON.parse(raw);
}

/**
 * Offline confirmation #2 (AMLIL, 204 real trades): replaying quoteBuy/quoteSell
 * against the full sequence reproduces every tokensOut / quoteOut exactly. This
 * pins the fee/tax application order (fee + snipe + creator all on the quote-in
 * for buys; fee + creator on the gross quote for sells).
 */
describe('curve math replays the AMLIL trade sequence (204 trades)', () => {
  const { trades } = loadAmlil();
  const feeBps = 100;
  const creatorBps = 200; // AMLIL creator tax 2 %

  it('reproduces every buy tokensOut and sell quoteOut', () => {
    // start reserves for AMLIL: virtual quote 1.68e18, supply 1e27
    let r: Reserves = { quote: 1_680_000_000_000_000_000n, token: 1_000_000_000_000_000_000_000_000_000n };
    let checked = 0;
    for (const t of trades) {
      if (t.side === 'buy') {
        const q = BigInt(t.q);
        const snipe = BigInt(t.snipe_tax);
        const out = quoteBuy(r, q, feeBps, creatorBps, snipe);
        expect(out).toBe(BigInt(t.tok));
        // the log's `fee` = feeBps on q + snipe; `tax` = creator tax
        expect(BigInt(t.fee)).toBe((q * BigInt(feeBps)) / 10_000n + snipe);
        expect(BigInt(t.tax)).toBe((q * BigInt(creatorBps)) / 10_000n);
        const net = q - (q * BigInt(feeBps)) / 10_000n - (q * BigInt(creatorBps)) / 10_000n - snipe;
        r = { quote: r.quote + net, token: r.token - out };
      } else {
        const tin = BigInt(t.tok);
        const out = quoteSell(r, tin, feeBps, creatorBps);
        expect(out).toBe(BigInt(t.q));
        const gross = BigInt(t.q) + BigInt(t.fee) + BigInt(t.tax);
        r = { quote: r.quote - gross, token: r.token + tin };
      }
      checked++;
    }
    expect(checked).toBe(trades.length);
  });
});

describe('priceImpactBps', () => {
  it('a 0.07 ETH buy at start (1 % fee) is ~840 bps of impact', () => {
    const r: Reserves = { quote: 1_680_000_000_000_000_000n, token: 1_000_000_000_000_000_000_000_000_000n };
    const impact = priceImpactBps(r, 70_000_000_000_000_000n, 100, 0, 0n);
    expect(impact).toBeGreaterThan(800);
    expect(impact).toBeLessThan(900);
  });
  it('zero quote-in is zero impact', () => {
    const r: Reserves = { quote: 1_680_000_000_000_000_000n, token: 1_000_000_000_000_000_000_000_000_000n };
    expect(priceImpactBps(r, 0n, 100, 0, 0n)).toBe(0);
  });
});
