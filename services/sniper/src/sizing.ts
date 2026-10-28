/**
 * Position sizing (Preset.sizing) and the paper bankroll.
 *
 *  - `fixed`: every burst buys `buyEth` (the original behaviour).
 *  - `bankroll`: `clamp(bankroll × fraction / maxConcurrent, minEth, maxEth)`, rounded DOWN to
 *    0.001 ETH. The bankroll is the PonsSniper contract's ETH balance that the live executor
 *    already caches for the L8 pre-check (memory only, no RPC on the decide path), or in paper
 *    mode `PAPER_BANKROLL_ETH` + realised paper PnL − ETH tied up in open paper runs, so paper
 *    compounding behaves like the contract balance would.
 *
 * Tax and fees are proportional to the size, so the backtested per-trade edge (+8 % of the buy
 * for team buys ≥ 0.1 ETH) does not depend on it. Gas does not scale: ~0.00004 ETH per burst plus
 * the exit, which at the 0.01 ETH floor is ~6 % of the expected +0.0008 ETH profit — below that
 * gas eats the edge.
 */
import type { Preset } from '@hood/core';
import { formatEther, parseEther } from 'viem';

/** Sizes are rounded down to this step (0.001 ETH). */
export const SIZE_STEP_WEI = 10n ** 15n;
const PPM = 1_000_000n;

export interface SizeDecision {
  quoteIn: bigint;
  mode: 'fixed' | 'bankroll';
  /** bankroll the size was computed from (ETH), null when unknown or in fixed mode */
  bankrollEth: number | null;
  /** 'min' / 'max' when the clamp applied */
  clamped: 'min' | 'max' | null;
  note: string;
}

const eth = (wei: bigint): number => Number(formatEther(wei));

/** Buy size for one burst. Pure; `bankrollWei` null = unknown (bankroll mode then buys `minEth`). */
export function sizeBuy(p: Pick<Preset, 'buyEth' | 'sizing'>, bankrollWei: bigint | null, maxConcurrent: number): SizeDecision {
  const s = p.sizing;
  if (!s || s.mode !== 'bankroll') {
    return { quoteIn: parseEther(String(p.buyEth)), mode: 'fixed', bankrollEth: null, clamped: null, note: `fixed ${p.buyEth} ETH` };
  }
  const minWei = parseEther(String(s.minEth));
  const maxWei = parseEther(String(Math.max(s.minEth, s.maxEth)));
  if (bankrollWei === null) {
    return { quoteIn: minWei, mode: 'bankroll', bankrollEth: null, clamped: 'min', note: `bankroll unknown: min ${s.minEth} ETH` };
  }
  const slots = BigInt(Math.max(1, Math.floor(maxConcurrent)));
  const fracPpm = BigInt(Math.round(Math.min(1, Math.max(0, s.fraction)) * 1e6));
  const raw = (bankrollWei > 0n ? bankrollWei : 0n) * fracPpm / PPM / slots;
  let clamped: SizeDecision['clamped'] = null;
  let q = raw;
  if (q < minWei) {
    q = minWei;
    clamped = 'min';
  } else if (q > maxWei) {
    q = maxWei;
    clamped = 'max';
  }
  const stepped = q - (q % SIZE_STEP_WEI);
  if (stepped > 0n) q = stepped; // a minEth below 0.001 ETH is kept as is
  const bankrollEth = eth(bankrollWei);
  return {
    quoteIn: q,
    mode: 'bankroll',
    bankrollEth,
    clamped,
    note: `bankroll ${bankrollEth} ETH × ${s.fraction} / ${slots}${clamped ? ` → clamped to ${clamped} ` : ' → '}${eth(q)} ETH`,
  };
}

/**
 * Paper bankroll: `start + realised − committed`. A run commits its quoteIn when it is decided,
 * releases it when it ends without a position, and books its PnL when the position closes —
 * the same moments the contract balance would move in live mode (buy out, proceeds back when the
 * treasury is the contract itself).
 */
export class PaperBankroll {
  private realizedWei = 0n;
  private readonly committed = new Map<string, bigint>();

  constructor(readonly startWei: bigint) {}

  /** All-time realised paper PnL from the DB (start-up). */
  seedRealized(pnlEth: number): void {
    this.realizedWei = toWei(pnlEth);
  }

  commit(key: string, quoteIn: bigint): void {
    this.committed.set(key, quoteIn);
  }

  /** The run ended without a position: its ETH is free again. */
  release(key: string): void {
    this.committed.delete(key);
  }

  /** The position closed with `pnlEth` (proceeds − cost): free the cost, book the PnL. */
  close(key: string, pnlEth: number): void {
    this.committed.delete(key);
    this.realizedWei += toWei(pnlEth);
  }

  get realizedEth(): number {
    return eth(this.realizedWei);
  }

  get committedWei(): bigint {
    let n = 0n;
    for (const v of this.committed.values()) n += v;
    return n;
  }

  balanceWei(): bigint {
    const b = this.startWei + this.realizedWei - this.committedWei;
    return b > 0n ? b : 0n;
  }
}

function toWei(x: number): bigint {
  if (!Number.isFinite(x)) return 0n;
  return BigInt(Math.round(x * 1e9)) * 10n ** 9n;
}
