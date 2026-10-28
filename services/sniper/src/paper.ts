/**
 * Paper execution: same pipeline as live, but no tx is sent. The planned burst is recorded
 * (members marked `skipped`); the fill is simulated at the first block of launch+1 s seen on
 * the feed with the real fee model: snipe tax for that second (618 bps at +1 s) + 1 % curve
 * fee + creator tax. Two fill models bracket the real outcome (L4, `PAPER_FILL`):
 *  - `first` (optimistic): our buy is first in that block — curve state at block−1;
 *  - `last`  (pessimistic): our buy comes after every other buy of that block — state at block.
 * Paper PnL is therefore a bracket, not a forecast: run both and compare.
 * Sells are simulated with `quoteSell` on the latest known reserves.
 */
import { CURVE_FEE_BPS, quoteBuy, quoteSell, snipeTaxBps, snipeTaxWeiFor, type FeedBlock, type Reserves } from '@hood/core';
import type { Address } from 'viem';
import type { ChainClient } from './chain.js';
import { snipeDeadlineTs, type ExecutionBackend, type ExitOrder, type ExitResult, type SnipeOrder } from './executor.js';
import type { Logger } from './log.js';
import type { Fill } from './types.js';

interface PendingPaper {
  order: SnipeOrder;
  resolve: (f: Fill | null) => void;
  busy: boolean;
}

export interface PaperOptions {
  chain: ChainClient;
  logger: Logger;
  /** latest reserves known to the position manager (fallback when eth_call fails) */
  book?: (curve: Address) => Reserves | null;
  /** creator tax for a curve (from the launch call) */
  creatorTaxBps: (curve: Address) => number;
  feeBps?: number;
  /** L4: fill model, default 'first' */
  fill?: 'first' | 'last';
}

export class PaperExecutor implements ExecutionBackend {
  readonly mode = 'paper' as const;
  private readonly pending = new Map<string, PendingPaper>();
  readonly stats = { bursts: 0, fills: 0, misses: 0, exits: 0 };

  constructor(private readonly o: PaperOptions) {}

  execute(order: SnipeOrder): Promise<Fill | null> {
    this.stats.bursts++;
    order.run.burst = order.times.map((t, i) => ({
      index: i,
      nonce: i,
      hash: '0x' as `0x${string}`,
      raw: '0x' as `0x${string}`,
      scheduledAt: t,
      sends: [],
      status: 'skipped' as const,
    }));
    return new Promise((resolve) => this.pending.set(order.run.key, { order, resolve, busy: false }));
  }

  abort(runKey: string): number {
    const p = this.pending.get(runKey);
    if (!p) return 0;
    this.pending.delete(runKey);
    p.resolve(null);
    return p.order.run.burst.length;
  }

  onFeedBlock(b: FeedBlock): void {
    for (const [key, p] of this.pending) {
      if (p.busy) continue;
      const { run } = p.order;
      const launchTs = run.launch.ts;
      if (b.block <= run.launch.block || b.timestamp < launchTs + 1) continue;
      const elapsed = b.timestamp - launchTs;
      const tax = snipeTaxBps(elapsed);
      if (!run.sendCleared) {
        // L2: the same last-moment kill-switch / daily-loss check the live burst runs
        const why = p.order.guard?.() ?? null;
        if (why) {
          this.pending.delete(key);
          run.notes.push(`send blocked before the first member: ${why}`);
          p.resolve(null);
          continue;
        }
        run.sendCleared = true;
      }
      // NEW-3: the contract also refuses blocks after the wall-clock deadline (launch ts + 3)
      const expired = b.block > run.deadlineBlock || b.timestamp > snipeDeadlineTs(run);
      if (tax > run.maxTaxBps || expired) {
        if (elapsed >= 3 || expired) {
          this.pending.delete(key);
          this.stats.misses++;
          run.notes.push(`paper: no eligible block (tax ${tax} > max ${run.maxTaxBps} or past deadline)`);
          p.resolve(null);
        }
        continue;
      }
      p.busy = true;
      void this.fillAt(p, b, tax).then(
        (f) => {
          this.pending.delete(key);
          if (f) this.stats.fills++;
          else this.stats.misses++;
          p.resolve(f);
        },
        (e: unknown) => {
          this.pending.delete(key);
          run.notes.push(`paper fill error: ${(e as Error).message}`);
          p.resolve(null);
        },
      );
    }
  }

  private async fillAt(p: PendingPaper, b: FeedBlock, taxBps: number): Promise<Fill | null> {
    const { run, curve } = p.order;
    const mode = this.o.fill ?? 'first';
    // first: state right before the +1 s block; last: state after it (behind every other buyer)
    const at = mode === 'last' ? b.block : b.block - 1;
    let reserves: Reserves | null = null;
    let reservesBlock: number | undefined = at;
    try {
      reserves = await this.o.chain.getReserves(curve, at);
    } catch {
      reserves = this.o.book?.(curve) ?? null;
      reservesBlock = undefined;
    }
    if (!reserves) {
      run.notes.push('paper: no reserves for fill');
      return null;
    }
    const creatorTax = this.o.creatorTaxBps(curve);
    const taxPaid = snipeTaxWeiFor(run.quoteIn, taxBps);
    const tokensOut = quoteBuy(reserves, run.quoteIn, this.o.feeBps ?? CURVE_FEE_BPS, creatorTax, taxPaid);
    if (tokensOut < run.minTokensOut) {
      run.notes.push(`paper: slippage (out ${tokensOut} < min ${run.minTokensOut})`);
      return null;
    }
    return {
      block: b.block,
      ts: b.timestamp,
      quoteIn: run.quoteIn,
      tokensOut,
      taxBps,
      taxPaid,
      entryPrice: Number(run.quoteIn) / Number(tokensOut),
      reserves,
      ...(reservesBlock !== undefined ? { reservesBlock } : {}),
    };
  }

  async exit(order: ExitOrder): Promise<ExitResult> {
    this.stats.exits++;
    if (order.tokensIn <= 0n) return { ok: false, tokensIn: 0n, quoteOut: 0n, error: 'zero-size exit refused (L1)' };
    let r = this.o.book?.(order.curve) ?? null;
    if (!r) r = await this.o.chain.getReserves(order.curve).catch(() => null);
    if (!r) return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, error: 'paper: no reserves' };
    const quoteOut = quoteSell(r, order.tokensIn, this.o.feeBps ?? CURVE_FEE_BPS, this.o.creatorTaxBps(order.curve));
    if (quoteOut < order.minQuoteOut) return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, error: 'paper: slippage' };
    return { ok: true, tokensIn: order.tokensIn, quoteOut };
  }
}
