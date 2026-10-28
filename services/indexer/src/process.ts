/**
 * Applies decoded Pons events + token transfers to the CurveBook and produces the
 * rows to persist. Pure apart from mutating the book; all RPC/DB lookups (launch
 * txs, start reserves, hydration of unknown curves) happen before, in the caller.
 * Used by both the live BlockPipeline and the backfill.
 */
import { addTokenTransfer, addTrade, newCurveState, type CurveBook } from './book.js';
import { buildLaunchRow } from './launch.js';
import { computeTokenMetrics, type MetricsOptions } from './metrics.js';
import type { PonsEvent } from './pons.js';
import type { Address, Hex, LaunchRow, Reserves, TokenMetricsRow, TokenTransferRow, TradeRow } from './types.js';

export interface TxInfo {
  from: Address;
  to: Address | null;
  input: Hex;
}

export interface ProcessContext {
  tsOf(block: number): number | undefined;
  txOf(hash: Hex): TxInfo | undefined;
  /** reserves before any trade for a curve launched in this batch */
  startReserves(curve: Address): Reserves | null;
}

export interface ProcessResult {
  launches: LaunchRow[];
  trades: TradeRow[];
  tokenTransfers: TokenTransferRow[];
  /** token -> full exemptions list after a post-launch SnipeTaxExempted */
  exemptionUpdates: Map<Address, Address[]>;
  graduated: Set<Address>;
  /** curves whose metrics must be recomputed */
  touched: Set<Address>;
  skipped: { unknownCurve: number; missingTs: number };
}

type LaunchedEv = Extract<PonsEvent, { type: 'launched' }>;

/** Curves referenced by events that are neither in the book nor launched in this batch. */
export function curvesNeedingHydration(book: CurveBook, events: readonly PonsEvent[]): Address[] {
  const launched = new Set(events.filter((e) => e.type === 'launched').map((e) => (e as LaunchedEv).curve));
  const need = new Set<Address>();
  for (const e of events) {
    const curve = e.type === 'trade' || e.type === 'exempted' ? e.curve : e.type === 'graduated' ? e.curve : null;
    if (curve && !launched.has(curve) && !book.has(curve)) need.add(curve);
  }
  return [...need];
}

/** Launch events of the batch, one per token (factory TokenLaunched preferred over router Launched). */
export function launchesInBatch(events: readonly PonsEvent[]): LaunchedEv[] {
  const byToken = new Map<Address, LaunchedEv>();
  for (const e of events) {
    if (e.type !== 'launched') continue;
    const prev = byToken.get(e.token);
    if (!prev || (prev.viaRouter && !e.viaRouter)) byToken.set(e.token, e);
  }
  return [...byToken.values()];
}

export function processEvents(
  book: CurveBook,
  events: readonly PonsEvent[],
  tokenTransfers: readonly TokenTransferRow[],
  ctx: ProcessContext,
): ProcessResult {
  const res: ProcessResult = {
    launches: [],
    trades: [],
    tokenTransfers: [],
    exemptionUpdates: new Map(),
    graduated: new Set(),
    touched: new Set(),
    skipped: { unknownCurve: 0, missingTs: 0 },
  };
  const launchTxCurves = new Set<string>();

  // 1. launches first (a curve cannot trade before it exists)
  for (const ev of launchesInBatch(events)) {
    launchTxCurves.add(`${ev.txHash}:${ev.curve}`);
    const existing = book.get(ev.curve);
    if (existing?.launch) continue; // idempotent
    const ts = ctx.tsOf(ev.block);
    if (ts === undefined) {
      res.skipped.missingTs++;
      continue;
    }
    const sameTx = events.filter((e) => e.txHash === ev.txHash);
    const exempted = sameTx.flatMap((e) => (e.type === 'exempted' && e.curve === ev.curve ? [e.account] : []));
    const devBuys = sameTx.filter((e) => e.type === 'trade' && e.side === 'buy' && e.curve === ev.curve);
    const devBuyInTx = devBuys.length ? devBuys.reduce((s, e) => s + (e.type === 'trade' ? e.quote : 0n), 0n) : null;
    const firstTrade = events.find((e) => e.type === 'trade' && e.curve === ev.curve);
    const startReserves = ctx.startReserves(ev.curve);
    const launch = buildLaunchRow({
      launched: ev,
      tx: ctx.txOf(ev.txHash) ?? null,
      ts,
      exempted,
      devBuyInTx,
      startReserves,
      firstTrade: firstTrade && firstTrade.type === 'trade' ? firstTrade : null,
    });
    if (existing) {
      // hydrated as "unknown launch" earlier: attach the launch now
      existing.launch = launch;
      existing.launchTs = launch.ts;
      for (const a of [launch.deployer, launch.creatorFeeRecipient, ...launch.exemptions]) if (a) existing.exempt.add(a);
    } else {
      book.put(newCurveState({ curve: ev.curve, token: ev.token, launch, initialReserves: startReserves }));
    }
    res.launches.push(launch);
    res.touched.add(ev.curve);
  }

  // 2. everything else in log order
  for (const ev of events) {
    switch (ev.type) {
      case 'trade': {
        const st = book.get(ev.curve);
        if (!st) {
          res.skipped.unknownCurve++;
          break;
        }
        const ts = ctx.tsOf(ev.block);
        if (ts === undefined) {
          res.skipped.missingTs++;
          break;
        }
        const row = addTrade(st, ev, { ts, txFrom: ctx.txOf(ev.txHash)?.from ?? null });
        if (row) {
          res.trades.push(row);
          res.touched.add(ev.curve);
        }
        break;
      }
      case 'exempted': {
        const st = book.get(ev.curve);
        if (!st) {
          res.skipped.unknownCurve++;
          break;
        }
        if (st.exempt.has(ev.account)) break;
        st.exempt.add(ev.account);
        if (st.launch && !launchTxCurves.has(`${ev.txHash}:${ev.curve}`)) {
          st.launch.exemptions = [...new Set([...st.launch.exemptions, ev.account])].sort() as Address[];
          res.exemptionUpdates.set(st.token, st.launch.exemptions);
        }
        res.touched.add(ev.curve);
        break;
      }
      case 'graduated': {
        const st = ev.curve ? book.get(ev.curve) : ev.token ? book.getByToken(ev.token) : undefined;
        const token = ev.token ?? st?.token;
        if (!token) {
          res.skipped.unknownCurve++;
          break;
        }
        res.graduated.add(token);
        if (st?.launch) st.launch.graduated = true;
        break;
      }
      default:
        break;
    }
  }

  // 3. token transfers of launched tokens
  for (const tr of tokenTransfers) {
    res.tokenTransfers.push(tr);
    const st = book.getByToken(tr.token);
    if (st && addTokenTransfer(st, tr) && st.exempt.has(tr.from)) res.touched.add(st.curve);
  }
  return res;
}

/** Recompute metrics for the given curves (those with a known launch). */
export function metricsFor(book: CurveBook, curves: Iterable<Address>, opts?: MetricsOptions): TokenMetricsRow[] {
  const out: TokenMetricsRow[] = [];
  for (const c of curves) {
    const st = book.get(c);
    if (!st?.launch) continue;
    out.push(computeTokenMetrics(st.launch, st.trades, st.tokenTransfers, opts));
  }
  return out;
}
