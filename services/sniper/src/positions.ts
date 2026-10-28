/**
 * Position manager. Prices come from the node's CurveBuy/CurveSell logs (exact reserve deltas)
 * plus a periodic getReserves resync; the sequencer feed (which carries txs, not logs) is used
 * for the fastest operator-dump signal: an exempt (team) wallet calling `transfer`/
 * `transferFrom` on the token or `sell` on the curve. The same signal also comes from Transfer
 * logs (from ∈ exempt, to ∉ exempt — catches batch-contract transfers the feed can't see).
 *
 * Reserve book (reviewer M5): a snapshot is read at an EXPLICIT block number; curve trade logs
 * at or below that block are already contained in it and are ignored, later ones are kept as
 * deltas keyed by log id. reserves = snapshot + Σ deltas above it, so a snapshot that lags or
 * leads the log stream can never count a trade twice (no phantom stop-loss).
 *
 * Exits (reviewer H4): one round = up to 3 attempts at widening slippage (`all` exits use
 * `exitAll`). A failed round re-reads the chain — `balanceOf(sniper)` books any sale the chain
 * shows; `curve.graduated()` (or a CurveCompleted log) moves the position to the terminal
 * `graduated` phase — and otherwise retries with exponential backoff. After `maxExitRounds`
 * failed rounds the position is `stuck` (terminal). Both terminal phases raise an alert and stop
 * sending txs; see README "Graduation and stuck positions" for the manual procedure.
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
import type { ChainClient, SniperHolding } from './chain.js';
import type { ExecutionBackend, ExitResult } from './executor.js';
import type { Logger } from './log.js';
import { applySale, evaluatePosition, newPositionState, type ExitReason, type ExitSignal, type PositionState } from './position-logic.js';
import type { Fill, SnipeRun } from './types.js';

const outflowAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
]);
const SEL_TRANSFER = '0xa9059cbb';
const SEL_TRANSFER_FROM = '0x23b872dd';
const SEL_SELL = '0xd04c6983';
/** AlreadyGraduated() custom error selector (RESEARCH §3) */
const GRADUATED_RE = /AlreadyGraduated|0xe6a0d45f/i;
/** paper-only synthetic deltas (our simulated sales) are never contained in a chain snapshot */
const NEVER_PRUNED = Number.MAX_SAFE_INTEGER;

export interface SaleRecord {
  reason: string;
  tokensIn: bigint;
  quoteOut: bigint;
  txHash?: Hex;
  block?: number;
  at: number;
  /** quoteOut estimated from the reserves: the chain showed the tokens gone but no receipt was seen */
  estimated?: boolean;
}

export type PositionPhase = 'open' | 'graduated' | 'stuck' | 'closed';

export type PositionAlert = 'position_graduated' | 'position_stuck' | 'sale_from_chain' | 'position_closed_externally';

export interface ReserveBook {
  base: Reserves | null;
  /** block the snapshot was read at (−1 = none / unknown) */
  baseBlock: number;
  deltas: Map<string, { block: number; dq: bigint; dt: bigint }>;
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
  book: ReserveBook;
  /** derived: book.base + Σ deltas above book.baseBlock */
  reserves: Reserves | null;
  seenLogs: Set<string>;
  sales: SaleRecord[];
  realizedQuote: bigint;
  phase: PositionPhase;
  exiting: boolean;
  /** failed exit rounds so far (H4) */
  exitRounds: number;
  /** no exit attempt before this local time (backoff) */
  nextExitAt: number;
  /** exit everything at the next evaluation regardless of price (H2: fill after an abort) */
  forced: ExitReason | null;
  /** = phase === 'closed' */
  closed: boolean;
  lastMark: number | null;
  lastPnlPct: number | null;
  lastError: string | null;
  unwatch?: () => void;
}

export interface RestoreState {
  tokensHeld: bigint;
  realizedQuote: bigint;
  sales: SaleRecord[];
  openedAtMs: number;
  tpHit: number;
}

export interface PositionsOptions {
  backend: ExecutionBackend;
  chain: ChainClient;
  logger: Logger;
  now: () => number;
  feeBps?: number;
  /** slippage for exits per attempt within a round (bps); the last attempt uses 10000 (minOut 0) */
  exitSlippageBps?: number[];
  gasLimit?: number;
  maxFeeGwei?: number;
  /** live: the PonsSniper address — enables the chain re-read after a failed exit round (H4) */
  sniper?: Address;
  /** failed rounds before `stuck`. Default 3. */
  maxExitRounds?: number;
  /** backoff after the first failed round; doubles per round. Default 3000 ms. */
  exitBackoffMs?: number;
  onSale?: (p: PositionEntry, s: SaleRecord) => void;
  onClosed?: (p: PositionEntry, pnlEth: number) => void;
  onExitFailed?: (p: PositionEntry, err: string) => void;
  onAlert?: (p: PositionEntry, type: PositionAlert, detail: Record<string, unknown>) => void;
  /**
   * Graduation hook. Once the curve graduated, curve sells revert `AlreadyGraduated` and the
   * liquidity sits in a Uniswap v4 pool (PoolManager 0x8366…0951, hook 0xe5e7…e044). The tokens
   * must be swept out of PonsSniper (`sweepToken`, owner) and sold on v4; plug an automated v4
   * sale in here. Not implemented: the position stays `graduated` until the chain shows the
   * contract's balance at 0 (`recheck`).
   */
  onGraduated?: (p: PositionEntry) => void;
}

export class Positions {
  private readonly byKey = new Map<string, PositionEntry>();
  private readonly byCurve = new Map<string, PositionEntry[]>();
  private readonly byToken = new Map<string, PositionEntry[]>();
  readonly stats = { opened: 0, closed: 0, exits: 0, exitFailures: 0, dumpSignals: 0, graduated: 0, stuck: 0, chainSales: 0, staleLogs: 0 };

  constructor(private readonly o: PositionsOptions) {}

  /** Every position still holding tokens (open, graduated, stuck). */
  get open(): PositionEntry[] {
    return [...this.byKey.values()].filter((p) => !p.closed);
  }

  /** Latest reserves for a curve (paper fills/exits use this as fallback). */
  book(curve: Address): Reserves | null {
    return this.byCurve.get(curve.toLowerCase())?.[0]?.reserves ?? null;
  }

  openPosition(run: SnipeRun, fill: Fill, preset: Preset, exempt: readonly string[], restore?: RestoreState): PositionEntry {
    const token = run.launch.token!;
    const curve = run.launch.curve!;
    const state = newPositionState(fill.entryPrice, fill.tokensOut, restore?.openedAtMs ?? this.o.now());
    if (restore) {
      state.tokensHeld = restore.tokensHeld;
      state.tpHit = restore.tpHit;
    }
    const p: PositionEntry = {
      key: run.key,
      run,
      token,
      curve,
      preset,
      creatorTaxBps: run.launch.event.creatorTaxBps,
      state,
      costBasis: fill.quoteIn,
      exempt: new Set(exempt.map((e) => e.toLowerCase())),
      exemptBaseline: null,
      exemptOutflow: 0n,
      countedOutflowTxs: new Set(),
      book: { base: null, baseBlock: -1, deltas: new Map() },
      reserves: null,
      seenLogs: new Set(),
      sales: restore ? [...restore.sales] : [],
      realizedQuote: restore?.realizedQuote ?? 0n,
      phase: 'open',
      exiting: false,
      exitRounds: 0,
      nextExitAt: 0,
      forced: null,
      closed: false,
      lastMark: null,
      lastPnlPct: null,
      lastError: null,
    };
    if (fill.reserves) this.setSnapshot(p, fill.reserves, fill.reservesBlock ?? -1);
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
    p.unwatch = this.o.chain.watchToken?.(token, curve, (l) => {
      try {
        this.onLog(l);
      } catch (e) {
        this.o.logger.error({ err: e, key: p.key }, 'token log handling failed'); // never throw into the ws client (M2)
      }
    });
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

  /** H2: sell everything at the next evaluation (e.g. a fill that landed after an abort). */
  forceExit(key: string, reason: ExitReason): void {
    const p = this.byKey.get(key);
    if (!p || p.closed) return;
    p.forced = reason;
    p.nextExitAt = 0;
    this.evaluate(p);
  }

  // ------------------------------------------------------------------ reserve book (M5)
  private recompute(p: PositionEntry): void {
    const b = p.book;
    if (!b.base) {
      p.reserves = null;
      return;
    }
    let q = b.base.quote;
    let t = b.base.token;
    for (const d of b.deltas.values()) {
      if (d.block > b.baseBlock) {
        q += d.dq;
        t += d.dt;
      }
    }
    p.reserves = q > 0n && t > 0n ? { quote: q, token: t } : null;
  }

  private setSnapshot(p: PositionEntry, r: Reserves, block: number): boolean {
    const b = p.book;
    if (b.base && block >= 0 && block < b.baseBlock) return false; // older than what we have
    b.base = r;
    b.baseBlock = block;
    for (const [id, d] of b.deltas) if (d.block <= block) b.deltas.delete(id);
    this.recompute(p);
    return true;
  }

  /**
   * Authoritative reserves read at `block` (getReserves eth_call at that block number). Without
   * a block the snapshot is assumed to contain every log seen so far.
   */
  onReserves(curve: Address, r: Reserves, block?: number): void {
    for (const p of this.byCurve.get(curve.toLowerCase()) ?? []) {
      let at = block;
      if (at === undefined) {
        at = p.book.baseBlock;
        for (const d of p.book.deltas.values()) if (d.block !== NEVER_PRUNED && d.block > at) at = d.block;
      }
      if (this.setSnapshot(p, r, at)) this.evaluate(p);
    }
  }

  /** Node logs: CurveBuy/CurveSell/CurveCompleted (curve) and Transfer (token). */
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
    if (l.topics[0] === TOPICS.CurveCompleted) {
      for (const p of this.byCurve.get(addr) ?? []) if (p.phase === 'open') this.markGraduated(p, 'CurveCompleted log');
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
      if (t.block === undefined) continue; // pending log: the next snapshot contains it
      if (p.book.base && t.block <= p.book.baseBlock) {
        this.stats.staleLogs++; // already contained in the snapshot
        continue;
      }
      // exact deltas (EXAMPLES.md): buy net = quoteIn − fee(incl. snipe tax) − creator tax
      const delta =
        t.side === 'buy'
          ? { block: t.block, dq: t.quote - t.fee - t.creatorTax, dt: -t.tokens }
          : { block: t.block, dq: -(t.quote + t.fee + t.creatorTax), dt: t.tokens };
      p.book.deltas.set(id, delta);
      this.recompute(p);
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
      let from: string;
      try {
        from = await tx.recoverFrom();
      } catch {
        continue; // malformed signature: not attributable
      }
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

  /** Timeouts, backoff expiry and periodic re-evaluation. */
  tick(): void {
    for (const p of this.byKey.values()) if (p.phase === 'open') this.evaluate(p);
  }

  markPrice(p: PositionEntry): number | null {
    if (!p.reserves || p.state.tokensHeld <= 0n) return null;
    const out = quoteSell(p.reserves, p.state.tokensHeld, this.o.feeBps ?? CURVE_FEE_BPS, p.creatorTaxBps);
    return Number(out) / Number(p.state.tokensHeld);
  }

  private evaluate(p: PositionEntry): void {
    if (p.phase !== 'open' || p.exiting) return;
    const now = this.o.now();
    const mark = this.markPrice(p);
    let sig: ExitSignal | null;
    if (mark !== null) {
      p.lastMark = mark;
      p.lastPnlPct = (mark / p.state.entryPrice - 1) * 100;
    }
    if (p.forced) {
      sig = { reason: p.forced, sellTokens: p.state.tokensHeld, pnlPct: p.lastPnlPct ?? 0, all: true };
    } else if (mark === null) {
      // no price yet: only time / dump based exits
      sig = evaluatePosition(p.state, p.state.entryPrice, now, { ...p.preset, takeProfits: [], stopLossPct: Number.POSITIVE_INFINITY });
    } else {
      sig = evaluatePosition(p.state, mark, now, p.preset);
    }
    if (!sig || sig.sellTokens <= 0n) return; // L1: never send a zero-size order
    if (now < p.nextExitAt) return; // backoff after a failed round (H4)
    p.exiting = true;
    void this.exit(p, sig).catch((e: unknown) => {
      p.exiting = false;
      p.lastError = (e as Error).message;
      this.o.logger.error({ err: e, key: p.key }, 'exit crashed');
    });
  }

  private async exit(p: PositionEntry, sig: ExitSignal): Promise<void> {
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
          all: sig.all,
          minQuoteOut,
          reason: sig.reason,
          gasLimit: this.o.gasLimit ?? p.preset.gasLimit,
          maxFeeGwei: this.o.maxFeeGwei ?? p.preset.maxFeeGwei,
        })
        .catch((e: unknown): ExitResult => ({ ok: false, tokensIn: sig.sellTokens, quoteOut: 0n, error: (e as Error).message }));
      if (res.ok || p.phase !== 'open') break;
      this.o.logger.warn({ key: p.key, attempt: i + 1, round: p.exitRounds + 1, err: res.error }, 'exit attempt failed');
      // a receipt-less attempt may have sold: do not stack more sells on top, ask the chain
      if (res.unknown || (res.error !== undefined && GRADUATED_RE.test(res.error))) break;
    }
    if (p.phase !== 'open') {
      p.exiting = false;
      return;
    }
    if (!res || !res.ok) {
      await this.afterFailedRound(p, sig, res?.error ?? 'unknown');
      return;
    }
    this.bookSale(
      p,
      sig,
      {
        reason: sig.reason,
        tokensIn: res.tokensIn,
        quoteOut: res.quoteOut,
        ...(res.txHash ? { txHash: res.txHash } : {}),
        ...(res.block !== undefined ? { block: res.block } : {}),
        at: this.o.now(),
      },
      sig.all,
    );
    p.exitRounds = 0;
    p.exiting = false;
    if (p.state.tokensHeld === 0n) this.close(p);
    else this.evaluate(p);
  }

  private bookSale(p: PositionEntry, sig: ExitSignal, sale: SaleRecord, sellsAll: boolean): void {
    p.sales.push(sale);
    p.realizedQuote += sale.quoteOut;
    applySale(p.state, sig, sale.tokensIn);
    if (sellsAll) p.state.tokensHeld = 0n;
    // paper: reflect our own sale in the book so later marks are consistent
    if (this.o.backend.mode === 'paper' && p.book.base) {
      p.book.deltas.set(`paper-sale:${p.sales.length}`, { block: NEVER_PRUNED, dq: -sale.quoteOut, dt: sale.tokensIn });
      this.recompute(p);
    }
    this.o.onSale?.(p, sale);
  }

  /** H4: one round failed — ask the chain what actually happened, then back off / give up. */
  private async afterFailedRound(p: PositionEntry, sig: ExitSignal, err: string): Promise<void> {
    this.stats.exitFailures++;
    p.lastError = err;
    const [holding, graduated] = await Promise.all([
      this.o.sniper ? this.o.chain.readSniper(this.o.sniper, p.token).catch((): SniperHolding | null => null) : Promise.resolve(null),
      this.o.chain.curveGraduated(p.curve).catch((): boolean | null => null),
    ]);
    if (holding && holding.balance < p.state.tokensHeld) {
      const sold = p.state.tokensHeld - holding.balance;
      const est = p.reserves ? quoteSell(p.reserves, sold, this.o.feeBps ?? CURVE_FEE_BPS, p.creatorTaxBps) : 0n;
      this.stats.chainSales++;
      this.bookSale(p, sig, { reason: `${sig.reason}(chain)`, tokensIn: sold, quoteOut: est, at: this.o.now(), estimated: true }, holding.balance === 0n);
      this.alert(p, 'sale_from_chain', { sold: sold.toString(), estimatedQuoteOut: est.toString(), balance: holding.balance.toString(), err });
      if (holding.balance === 0n) {
        p.exiting = false;
        this.close(p);
        return;
      }
    }
    if (graduated === true || GRADUATED_RE.test(err)) {
      this.markGraduated(p, `exit failed: ${err}`);
      return;
    }
    p.exitRounds++;
    if (p.exitRounds >= (this.o.maxExitRounds ?? 3)) {
      p.phase = 'stuck';
      p.exiting = false;
      this.stats.stuck++;
      this.alert(p, 'position_stuck', { rounds: p.exitRounds, err, tokensHeld: p.state.tokensHeld.toString() });
      this.o.onExitFailed?.(p, `stuck after ${p.exitRounds} rounds: ${err}`);
      return;
    }
    p.nextExitAt = this.o.now() + (this.o.exitBackoffMs ?? 3000) * 2 ** (p.exitRounds - 1);
    p.exiting = false;
    this.o.onExitFailed?.(p, err);
  }

  private markGraduated(p: PositionEntry, why: string): void {
    if (p.phase === 'graduated' || p.closed) return;
    p.phase = 'graduated';
    p.exiting = false;
    this.stats.graduated++;
    this.alert(p, 'position_graduated', {
      why,
      tokensHeld: p.state.tokensHeld.toString(),
      action: 'curve sells revert AlreadyGraduated: sweepToken(token, cold, 0) from the owner and sell on the Uniswap v4 pool',
    });
    try {
      this.o.onGraduated?.(p);
    } catch (e) {
      this.o.logger.warn({ err: e, key: p.key }, 'onGraduated hook threw');
    }
  }

  private alert(p: PositionEntry, type: PositionAlert, detail: Record<string, unknown>): void {
    this.o.logger.warn({ key: p.key, token: p.token, type, ...detail }, 'position alert');
    try {
      this.o.onAlert?.(p, type, detail);
    } catch {
      /* sink only */
    }
  }

  /**
   * Terminal positions (graduated / stuck): close them once the chain shows the contract no
   * longer holds the token (swept / sold manually). Live only (needs `sniper`).
   */
  async recheck(): Promise<void> {
    if (!this.o.sniper) return;
    for (const p of [...this.byKey.values()]) {
      if (p.phase !== 'graduated' && p.phase !== 'stuck') continue;
      const h = await this.o.chain.readSniper(this.o.sniper, p.token).catch(() => null);
      if (!h || h.balance >= p.state.tokensHeld) continue;
      const sold = p.state.tokensHeld - h.balance;
      const sig: ExitSignal = { reason: 'timeout', sellTokens: sold, pnlPct: p.lastPnlPct ?? 0, all: h.balance === 0n };
      this.bookSale(p, sig, { reason: 'external', tokensIn: sold, quoteOut: 0n, at: this.o.now(), estimated: true }, h.balance === 0n);
      if (h.balance === 0n) {
        this.alert(p, 'position_closed_externally', { phase: p.phase, note: 'proceeds unknown, booked as 0' });
        this.close(p);
      }
    }
  }

  private close(p: PositionEntry): void {
    p.phase = 'closed';
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
