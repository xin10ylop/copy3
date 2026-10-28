import { describe, expect, it } from 'vitest';
import { CurveBook, newCurveState } from '../src/book.js';
import { decodePonsLogs, PONS_TOPICS } from '../src/pons.js';
import { processEvents } from '../src/process.js';
import { applyTrade } from '../src/trades.js';
import type { Address, Hex, RpcLog } from '../src/types.js';
import { ROUTER, START_RESERVES, amlilFixture, curveLogsFixture, launchTxFixture } from './helpers/fixtures.js';
import { curveBuyLog, exemptedLog, snipeTaxLog } from './helpers/logs.js';

const CURVE = '0xd30a935fddef5f5855519874ee2f4e7a7ea36821' as Address;
const TOKEN = '0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d' as Address;

describe('curve_trades rows from the curve-logs fixture', () => {
  const logs = curveLogsFixture();
  const lt = launchTxFixture();
  const launchTs = Number(lt.block.timestamp);
  // eth_getLogs returns blockTimestamp 0x0 on Nitro; give each block a plausible ts
  const tsOf = (b: number) => launchTs + Math.floor((b - 100_299_817) / 10);
  const txFrom = (h: string) => `0x${h.slice(-40)}` as Address;

  function run() {
    const book = new CurveBook();
    const launchEvents = decodePonsLogs(lt.receipt.logs);
    processEvents(book, launchEvents, [], {
      tsOf: () => launchTs,
      txOf: () => ({ from: lt.tx.from, to: lt.tx.to, input: lt.tx.input }),
      startReserves: () => START_RESERVES,
    });
    const events = decodePonsLogs(logs);
    const res = processEvents(book, events, [], {
      tsOf,
      txOf: (h) => ({ from: txFrom(h), to: ROUTER, input: '0x' }),
      startReserves: () => null,
    });
    return { book, res };
  }

  it('produces 3 buys and 6 sells with router attribution and no taxes', () => {
    const { res } = run();
    expect(res.trades).toHaveLength(9);
    expect(res.trades.map((t) => t.side)).toEqual(['buy', 'buy', 'buy', 'sell', 'sell', 'sell', 'sell', 'sell', 'sell']);
    const b0 = res.trades[0]!;
    expect(b0).toMatchObject({
      token: TOKEN,
      curve: CURVE,
      block: 100_300_062,
      logIndex: 16,
      trader: ROUTER,
      recipient: '0xb81db28acaade5d04c2c14be798c15844166edda',
      quote: 6_600_000_000_000_000n,
      tokens: 3_874_217_774_441_546_983_339_796n,
      fee: 66_000_000_000_000n,
      tax: 0n,
      snipeTax: 0n,
      exempt: false,
    });
    expect(b0.txFrom).toBe(txFrom(b0.txHash));
    expect(b0.secondsSinceLaunch).toBe(24);
    expect(res.trades[3]!.trader).toBe(ROUTER);
    expect(res.trades[3]!.recipient).toBe(ROUTER);
  });

  it('cumulative reserves end exactly at the live getReserves() of the curve', () => {
    const { book, res } = run();
    // measured 2026-10-28: getReserves() = (0x17508f1956a80003, 1e27)
    expect(book.get(CURVE)?.reserves).toEqual({ quote: 1_680_000_000_000_000_003n, token: 10n ** 27n });
    const first = res.trades[0]!;
    const q = 1_680_000_000_000_000_000n + 6_600_000_000_000_000n - 66_000_000_000_000n;
    const t = 10n ** 27n - 3_874_217_774_441_546_983_339_796n;
    expect(first.priceAfter!).toBeCloseTo(Number(q) / Number(t), 18);
    expect(res.trades.at(-1)!.priceAfter!).toBeCloseTo(1.68e-9, 15);
  });

  it('is idempotent (re-processing yields no new rows) and handles out-of-order inserts', () => {
    const { book } = run();
    const again = processEvents(book, decodePonsLogs(logs), [], { tsOf, txOf: () => undefined, startReserves: () => null });
    expect(again.trades).toHaveLength(0);

    // a fresh book that sees the sells first, then the buys (backfill gap): prices stay exact
    const b2 = new CurveBook();
    b2.put(newCurveState({ curve: CURVE, token: TOKEN, launch: null, launchTs, initialReserves: START_RESERVES }));
    const ev = decodePonsLogs(logs).filter((e) => e.type === 'trade');
    const sells = processEvents(b2, ev.slice(3), [], { tsOf, txOf: () => undefined, startReserves: () => null });
    const buys = processEvents(b2, ev.slice(0, 3), [], { tsOf, txOf: () => undefined, startReserves: () => null });
    expect(sells.trades).toHaveLength(6);
    expect(buys.trades[0]!.priceAfter).toBe(run().res.trades[0]!.priceAfter);
    expect(b2.get(CURVE)?.reserves).toEqual({ quote: 1_680_000_000_000_000_003n, token: 10n ** 27n });
  });
});

describe('Amlil: reserve accounting and snipe-tax join', () => {
  const f = amlilFixture();

  it('constant-product accounting reproduces every one of the 204 real trades exactly', () => {
    let r = START_RESERVES;
    for (const t of f.trades) {
      const q = BigInt(t.q);
      const tok = BigInt(t.tok);
      const fee = BigInt(t.fee);
      const tax = BigInt(t.tax);
      if (t.side === 'buy') {
        const dq = q - fee - tax;
        expect((r.token * dq) / (r.quote + dq)).toBe(tok);
      } else {
        expect((r.quote * tok) / (r.token + tok)).toBe(q + fee + tax);
      }
      r = applyTrade(r, { side: t.side, quote: q, tokens: tok, fee, tax });
    }
  });

  it('CurveBuy.fee includes the snipe tax (6.18 % at +1 s) and tax is the 2 % creator tax', () => {
    const t = f.trades.find((x) => BigInt(x.snipe_tax) > 0n)!;
    const q = BigInt(t.q);
    expect(BigInt(t.snipe_tax)).toBe((q * 618n) / 10_000n);
    expect(BigInt(t.fee)).toBe(q / 100n + BigInt(t.snipe_tax));
    expect(BigInt(t.tax)).toBe((q * 200n) / 10_000n);
  });

  it('joins the real SnipeTaxCharged logs onto the CurveBuy that follows them in the same tx', () => {
    const logs: RpcLog[] = [];
    for (const s of f.snipe) {
      const t = f.trades.find((x) => x.tx === s.transactionHash)!;
      logs.push(s);
      logs.push(
        curveBuyLog(s.address, { block: Number(s.blockNumber), tx: s.transactionHash, logIndex: Number(s.logIndex) + 3 }, {
          buyer: t.actor,
          recipient: t.recipient,
          quoteIn: BigInt(t.q),
          tokensOut: BigInt(t.tok),
          fee: BigInt(t.fee),
          tax: BigInt(t.tax),
        }),
      );
    }
    // the two team buys share one tx and carry no SnipeTaxCharged
    const team = f.trades.filter((x) => x.blk === 95_940_700);
    team.forEach((t, i) =>
      logs.push(curveBuyLog(f.meta.curve, { block: t.blk, tx: t.tx, logIndex: i }, { buyer: t.actor, recipient: t.recipient, quoteIn: BigInt(t.q), tokensOut: BigInt(t.tok), fee: BigInt(t.fee), tax: BigInt(t.tax) })),
    );
    const buys = decodePonsLogs(logs).filter((e) => e.type === 'trade');
    expect(buys).toHaveLength(7);
    for (const b of buys) {
      if (b.type !== 'trade') continue;
      const t = f.trades.find((x) => x.tx === b.txHash && x.recipient === b.recipient)!;
      expect(b.snipeTax).toBe(BigInt(t.snipe_tax));
    }
    expect(f.snipe.every((s) => s.topics[0] === PONS_TOPICS.SnipeTaxCharged)).toBe(true);
  });

  it('pairs charges by recipient when one tx contains several buys', () => {
    const tx = `0x${'ab'.repeat(32)}` as Hex;
    const c = '0x00000000000000000000000000000000000000cc';
    const A = '0x00000000000000000000000000000000000000a1';
    const B = '0x00000000000000000000000000000000000000b1';
    const buy = (r: string, li: number) => curveBuyLog(c, { block: 5, tx, logIndex: li }, { buyer: ROUTER, recipient: r, quoteIn: 10n, tokensOut: 1n, fee: 1n, tax: 0n });
    const ev = decodePonsLogs([snipeTaxLog(c, { block: 5, tx, logIndex: 0 }, B, 7n), buy(A, 1), buy(B, 2), exemptedLog(c, { block: 5, tx, logIndex: 3 }, A)]);
    const trades = ev.filter((e) => e.type === 'trade');
    expect(trades.map((t) => (t.type === 'trade' ? [t.recipient, t.snipeTax] : null))).toEqual([
      [A, 0n],
      [B, 7n],
    ]);
  });
});
