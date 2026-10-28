/**
 * Position manager. Prices come from the node's CurveBuy/CurveSell logs (exact reserve deltas)
 * plus a periodic getReserves resync; the sequencer feed (which carries txs, not logs) is used
 * for the fastest operator-dump signal: an exempt (team) wallet calling `transfer`/
 * `transferFrom` on the token or `sell` on the curve. The same signal also comes from Transfer
 * logs (from ∈ exempt, to ∉ exempt — catches batch-contract transfers the feed can't see).
 * Every exit goes through the backend (`PonsSniper.exit` live, simulated in paper) with retries.
 */
import {
  CURVE_FEE_BPS,
  TOPICS,
  parseCurveTradeLog,
  quoteSell,
  type FeedBlock,
  type Preset,
  type RawLog,
  type Reserves,
} from '@hood/core';
import { decodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { ChainClient } from './chain.js';
import type { ExecutionBackend, ExitResult } from './executor.js';
import type { Logger } from './log.js';
import { applySale, evaluatePosition, newPositionState, type ExitSignal, type PositionState } from './position-logic.js';
import type { Fill, SnipeRun } from './types.js';

const outflowAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
]);
const SEL_TRANSFER = '0xa9059cbb';
const SEL_TRANSFER_FROM = '0x23b872dd';
const SEL_SELL = '0xd04c6983';

export interface SaleRecord {
  reason: string;
  tokensIn: bigint;
  quoteOut: bigint;
  txHash?: Hex;
  block?: number;
  at: number;
}

export interface PositionEntry {
  key: string;
  run: SnipeRun;
  token: Address;
  curve: Address;
  preset: Preset;
  creatorTaxBps: number;
  state: PositionState;
  costBasis: bigint;
  exempt: Set<string>;
  exemptBaseline: bigint | null;
  exemptOutflow: bigint;
  countedOutflowTxs: Set<string>;
  reserves: Reserves | null;
  seenLogs: Set<string>;
  sales: SaleRecord[];
  realizedQuote: bigint;
  exiting: boolean;
  closed: boolean;
  lastMark: number | null;
  lastPnlPct: number | null;
  unwatch?: () => void;
}

export interface PositionsOptions {
  backend: ExecutionBackend;
  chain: ChainClient;
  logger: Logger;
  now: () => number;
  feeBps?: number;
  /** slippage for exits per retry attempt (bps); the last attempt uses 10000 (minOut 0) */
  exitSlippageBps?: number[];
  gasLimit?: number;
  maxFeeGwei?: number;
  onSale?: (p: PositionEntry, s: SaleRecord) => void;
  onClosed?: (p: PositionEntry, pnlEth: number) => void;
  onExitFailed?: (p: PositionEntry, err: string) => void;
}

export class Positions {
  private readonly byKey = new Map<string, PositionEntry>();
  private readonly byCurve = new Map<string, PositionEntry[]>();
  private readonly byToken = new Map<string, PositionEntry[]>();
  readonly stats = { opened: 0, closed: 0, exits: 0, exitFailures: 0, dumpSignals: 0 };

  constructor(private readonly o: PositionsOptions) {}

  get open(): PositionEntry[] {
    return [...this.byKey.values()].filter((p) => !p.closed);
  }

  /** Latest reserves for a curve (paper fills/exits use this as fallback). */
  book(curve: Address): Reserves | null {
    return this.byCurve.get(curve.toLowerCase())?.[0]?.reserves ?? null;
  }

  openPosition(run: SnipeRun, fill: Fill, preset: Preset, exempt: readonly string[]): PositionEntry {
    const token = run.launch.token!;
    const curve = run.launch.curve!;
    const p: PositionEntry = {
      key: run.key,
      run,
      token,
      curve,
      preset,
      creatorTaxBps: run.launch.event.creatorTaxBps,
      state: newPositionState(fill.entryPrice, fill.tokensOut, this.o.now()),
      costBasis: fill.quoteIn,
      exempt: new Set(exempt.map((e) => e.toLowerCase())),
      exemptBaseline: null,
      exemptOutflow: 0n,
      countedOutflowTxs: new Set(),
      reserves: fill.reserves ?? null,
      seenLogs: new Set(),
      sales: [],
      realizedQuote: 0n,
      exiting: false,
      closed: false,
      lastMark: null,
      lastPnlPct: null,
    };
    this.byKey.set(p.key, p);
    for (const [m, k] of [
      [this.byCurve, curve],
      [this.byToken, token],
    ] as const) {
      const l = m.get(k) ?? [];
      l.push(p);
      m.set(k, l);
    }
    this.stats.opened++;
    p.unwatch = this.o.chain.watchToken?.(token, curve, (l) => this.onLog(l));
    // baseline of what the team holds (off the hot path)
    void this.o.chain
      .balancesOf(token, [...p.exempt] as Address[])
      .then((bals) => {
        p.exemptBaseline = bals.reduce((a, b) => a + b, 0n);
        this.updateOutflowPct(p);
      })
      .catch(() => undefined);
    return p;
  }

  get(key: string): PositionEntry | undefined {
    return this.byKey.get(key);
  }

  /** Authoritative reserves (getReserves poll / paper book). */
  onReserves(curve: Address, r: Reserves): void {
    for (const p of this.byCurve.get(curve.toLowerCase()) ?? []) {
      p.reserves = r;
      this.evaluate(p);
    }
  }

  /** Node logs: CurveBuy/CurveSell (curve) and Transfer (token). */
  onLog(l: RawLog): void {
    const addr = l.address.toLowerCase();
    const id = `${l.transactionHash ?? ''}:${String(l.logIndex ?? '')}`;
    if (l.topics[0] === TOPICS.Erc20Transfer) {
      for (const p of this.byToken.get(addr) ?? []) {
        if (p.seenLogs.has(id)) continue;
        p.seenLogs.add(id);
        const from = `0x${(l.topics[1] ?? '').slice(26)}`.toLowerCase();
        const to = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
        if (p.exempt.has(from) && !p.exempt.has(to)) {
          if (l.transactionHash && p.countedOutflowTxs.has(l.transactionHash.toLowerCase())) continue;
          this.addOutflow(p, BigInt(l.data), to === p.curve ? 'sell(log)' : 'transfer(log)');
        }
      }
      return;
    }
    if (l.topics[0] !== TOPICS.CurveBuy && l.topics[0] !== TOPICS.CurveSell) return;
    let t: ReturnType<typeof parseCurveTradeLog>;
    try {
      t = parseCurveTradeLog(l);
    } catch {
      return;
    }
    for (const p of this.byCurve.get(addr) ?? []) {
      if (p.seenLogs.has(id)) continue;
      p.seenLogs.add(id);
      if (p.reserves) {
        // exact deltas (EXAMPLES.md): buy net = quoteIn − fee(incl. snipe tax) − creator tax
        p.reserves =
          t.side === 'buy'
            ? { quote: p.reserves.quote + (t.quote - t.fee - t.creatorTax), token: p.reserves.token - t.tokens }
            : { quote: p.reserves.quote - (t.quote + t.fee + t.creatorTax), token: p.reserves.token + t.tokens };
      }
      this.evaluate(p);
    }
  }

  /**
   * Feed fast path: exempt wallets calling transfer/transferFrom on a held token or sell on its
   * curve. Sender recovery happens only for txs addressed to those contracts.
   */
  async onFeedBlock(b: FeedBlock): Promise<void> {
    if (this.byKey.size === 0) return;
    for (const tx of b.txs) {
      if (!tx.to || !tx.selector) continue;
      const ps = this.byToken.get(tx.to) ?? this.byCurve.get(tx.to);
      if (!ps || ps.every((p) => p.closed)) continue;
      const sel = tx.selector;
      if (sel !== SEL_TRANSFER && sel !== SEL_TRANSFER_FROM && sel !== SEL_SELL) continue;
      let args: readonly unknown[];
      try {
        args = decodeFunctionData({ abi: outflowAbi, data: tx.input }).args;
      } catch {
        continue;
      }
      const from = await tx.recoverFrom();
      for (const p of ps) {
        if (p.closed) continue;
        let owner: string;
        let to: string;
        let amount: bigint;
        if (sel === SEL_SELL && tx.to === p.curve) {
          owner = from;
          to = p.curve;
          amount = args[0] as bigint;
        } else if (sel === SEL_TRANSFER && tx.to === p.token) {
          owner = from;
          to = (args[0] as string).toLowerCase();
          amount = args[1] as bigint;
        } else if (sel === SEL_TRANSFER_FROM && tx.to === p.token) {
          owner = (args[0] as string).toLowerCase();
          to = (args[1] as string).toLowerCase();
          amount = args[2] as bigint;
        } else continue;
        if (!p.exempt.has(owner) || p.exempt.has(to)) continue;
        p.countedOutflowTxs.add(tx.hash.toLowerCase());
        this.addOutflow(p, amount, sel === SEL_SELL ? 'sell(feed)' : 'transfer(feed)');
      }
    }
    this.tick();
  }

  private addOutflow(p: PositionEntry, amount: bigint, how: string): void {
    p.exemptOutflow += amount;
    this.updateOutflowPct(p);
    this.stats.dumpSignals++;
    this.o.logger.info({ key: p.key, token: p.token, how, amount: amount.toString(), pct: p.state.exemptOutflowPct }, 'exempt outflow');
    this.evaluate(p);
  }

  private updateOutflowPct(p: PositionEntry): void {
    if (p.exemptOutflow === 0n) return;
    // unknown or empty baseline ⇒ any outflow counts as a full dump
    p.state.exemptOutflowPct =
      p.exemptBaseline && p.exemptBaseline > 0n ? Number((p.exemptOutflow * 1_000_000n) / p.exemptBaseline) / 10_000 : 100;
  }

  /** Timeouts and periodic re-evaluation. */
  tick(): void {
    for (const p of this.byKey.values()) if (!p.closed) this.evaluate(p);
  }

  markPrice(p: PositionEntry): number | null {
    if (!p.reserves || p.state.tokensHeld <= 0n) return null;
    const out = quoteSell(p.reserves, p.state.tokensHeld, this.o.feeBps ?? CURVE_FEE_BPS, p.creatorTaxBps);
    return Number(out) / Number(p.state.tokensHeld);
  }

  private evaluate(p: PositionEntry): void {
    if (p.closed || p.exiting) return;
    const mark = this.markPrice(p);
    const now = this.o.now();
    let sig: ExitSignal | null;
    if (mark === null) {
      // no price yet: only time / dump based exits
      sig = evaluatePosition(p.state, p.state.entryPrice, now, { ...p.preset, takeProfits: [], stopLossPct: Number.POSITIVE_INFINITY });
    } else {
      p.lastMark = mark;
      p.lastPnlPct = (mark / p.state.entryPrice - 1) * 100;
      sig = evaluatePosition(p.state, mark, now, p.preset);
    }
    if (sig) void this.exit(p, sig);
  }

  private async exit(p: PositionEntry, sig: ExitSignal): Promise<void> {
    p.exiting = true;
    this.stats.exits++;
    const slips = this.o.exitSlippageBps ?? [1500, 4000, 10_000];
    let res: ExitResult | null = null;
    for (let i = 0; i < slips.length; i++) {
      const expected = p.reserves ? quoteSell(p.reserves, sig.sellTokens, this.o.feeBps ?? CURVE_FEE_BPS, p.creatorTaxBps) : 0n;
      const minQuoteOut = (expected * BigInt(10_000 - Math.min(10_000, slips[i]!))) / 10_000n;
      res = await this.o.backend
        .exit({
          key: p.key,
          curve: p.curve,
          token: p.token,
          tokensIn: sig.sellTokens,
          minQuoteOut,
          reason: sig.reason,
          gasLimit: this.o.gasLimit ?? p.preset.gasLimit,
          maxFeeGwei: this.o.maxFeeGwei ?? p.preset.maxFeeGwei,
        })
        .catch((e: unknown) => ({ ok: false, tokensIn: sig.sellTokens, quoteOut: 0n, error: (e as Error).message }));
      if (res.ok) break;
      this.o.logger.warn({ key: p.key, attempt: i + 1, err: res.error }, 'exit attempt failed');
    }
    if (!res || !res.ok) {
      this.stats.exitFailures++;
      p.exiting = false;
      this.o.onExitFailed?.(p, res?.error ?? 'unknown');
      return;
    }
    const sale: SaleRecord = {
      reason: sig.reason,
      tokensIn: res.tokensIn,
      quoteOut: res.quoteOut,
      ...(res.txHash ? { txHash: res.txHash } : {}),
      ...(res.block !== undefined ? { block: res.block } : {}),
      at: this.o.now(),
    };
    p.sales.push(sale);
    p.realizedQuote += res.quoteOut;
    applySale(p.state, sig, res.tokensIn);
    // paper: reflect our own sale in the book so later marks are consistent
    if (p.reserves && this.o.backend.mode === 'paper') {
      p.reserves = { quote: p.reserves.quote - res.quoteOut, token: p.reserves.token + res.tokensIn };
    }
    p.exiting = false;
    this.o.onSale?.(p, sale);
    if (p.state.tokensHeld === 0n) this.close(p);
    else this.evaluate(p);
  }

  private close(p: PositionEntry): void {
    p.closed = true;
    p.unwatch?.();
    this.stats.closed++;
    const pnlEth = (Number(p.realizedQuote) - Number(p.costBasis)) / 1e18;
    this.byKey.delete(p.key);
    for (const m of [this.byCurve, this.byToken]) {
      for (const [k, l] of m) {
        const rest = l.filter((x) => x !== p);
        if (rest.length) m.set(k, rest);
        else m.delete(k);
      }
    }
    this.o.onClosed?.(p, pnlEth);
  }
}
