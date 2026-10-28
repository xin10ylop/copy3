/**
 * Paper execution: same pipeline as live, but no tx is sent. The planned burst is recorded
 * (members marked `skipped`); the fill is simulated at the first block of launch+1 s seen on
 * the feed, using the curve state right before that block (eth_call at block−1) and the real
 * fee model: snipe tax for that second (618 bps at +1 s) + 1 % curve fee + creator tax.
 * Sells are simulated with `quoteSell` on the latest known reserves.
 */
import { CURVE_FEE_BPS, quoteBuy, quoteSell, snipeTaxBps, snipeTaxWeiFor, type FeedBlock, type Reserves } from '@hood/core';
import type { Address } from 'viem';
import type { ChainClient } from './chain.js';
import type { ExecutionBackend, ExitOrder, ExitResult, SnipeOrder } from './executor.js';
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
      if (tax > run.maxTaxBps || b.block > run.deadlineBlock) {
        if (elapsed >= 3 || b.block > run.deadlineBlock) {
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
    let reserves: Reserves | null = null;
    try {
      reserves = await this.o.chain.getReserves(curve, b.block - 1); // state right before the +1 s block
    } catch {
      reserves = this.o.book?.(curve) ?? null;
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
    };
  }

  async exit(order: ExitOrder): Promise<ExitResult> {
    this.stats.exits++;
    let r = this.o.book?.(order.curve) ?? null;
    if (!r) r = await this.o.chain.getReserves(order.curve).catch(() => null);
    if (!r) return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, error: 'paper: no reserves' };
    const quoteOut = quoteSell(r, order.tokensIn, this.o.feeBps ?? CURVE_FEE_BPS, this.o.creatorTaxBps(order.curve));
    if (quoteOut < order.minQuoteOut) return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, error: 'paper: slippage' };
    return { ok: true, tokensIn: order.tokensIn, quoteOut };
  }
}
