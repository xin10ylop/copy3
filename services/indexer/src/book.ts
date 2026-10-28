/**
 * In-memory per-curve state (LRU). Holds what is needed to compute price_after
 * (reserves) and token metrics incrementally without re-reading the DB on every
 * block. Entries are re-hydrated from the DB on a miss (see pipeline.ts).
 */
import { exemptSetOf } from './launch.js';
import { applyTrade, buildTradeRow, type TradeEventInput } from './trades.js';
import type { Address, LaunchRow, Reserves, TokenTransferRow, TradeRow } from './types.js';

export interface CurveState {
  curve: Address;
  token: Address;
  launch: LaunchRow | null;
  launchTs: number | null;
  /** reserves before the first trade (null when unknown) */
  initialReserves: Reserves | null;
  /** reserves after the last trade in `trades` (null when unknown) */
  reserves: Reserves | null;
  exempt: Set<string>;
  /** sorted by (block, logIndex) */
  trades: TradeRow[];
  tradeKeys: Set<string>;
  tokenTransfers: TokenTransferRow[];
  transferKeys: Set<string>;
}

export function replay(initial: Reserves, trades: readonly TradeRow[]): Reserves {
  let r = initial;
  for (const t of trades) r = applyTrade(r, t);
  return r;
}

export function newCurveState(init: {
  curve: Address;
  token: Address;
  launch: LaunchRow | null;
  launchTs?: number | null;
  initialReserves: Reserves | null;
  /** explicit tail reserves (e.g. getReserves at block n-1) when initial is unknown */
  reserves?: Reserves | null;
  trades?: TradeRow[];
  tokenTransfers?: TokenTransferRow[];
  exempt?: Iterable<string>;
}): CurveState {
  const trades = [...(init.trades ?? [])].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const transfers = [...(init.tokenTransfers ?? [])].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const exempt = new Set<string>(init.exempt ?? []);
  if (init.launch) for (const a of exemptSetOf(init.launch)) exempt.add(a);
  return {
    curve: init.curve,
    token: init.token,
    launch: init.launch,
    launchTs: init.launchTs ?? init.launch?.ts ?? null,
    initialReserves: init.initialReserves,
    reserves: init.reserves !== undefined ? init.reserves : init.initialReserves ? replay(init.initialReserves, trades) : null,
    exempt,
    trades,
    tradeKeys: new Set(trades.map((t) => `${t.txHash}:${t.logIndex}`)),
    tokenTransfers: transfers,
    transferKeys: new Set(transfers.map((t) => `${t.txHash}:${t.logIndex}`)),
  };
}

const before = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) =>
  a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex);

/**
 * Add a trade to the state (idempotent). Returns the new row, or null when it was
 * already known. Handles out-of-order inserts (backfill filling a gap).
 */
export function addTrade(state: CurveState, ev: TradeEventInput, ctx: { ts: number; txFrom: Address | null }): TradeRow | null {
  const key = `${ev.txHash}:${ev.logIndex}`;
  if (state.tradeKeys.has(key)) return null;
  let idx = state.trades.length;
  while (idx > 0 && before(ev, state.trades[idx - 1]!)) idx--;
  const atTail = idx === state.trades.length;
  const reservesBefore = atTail
    ? state.reserves
    : state.initialReserves
      ? replay(state.initialReserves, state.trades.slice(0, idx))
      : null;
  const { row, reserves } = buildTradeRow(ev, {
    token: state.token,
    ts: ctx.ts,
    txFrom: ctx.txFrom,
    launchTs: state.launchTs,
    exempt: state.exempt,
    reserves: reservesBefore,
  });
  state.trades.splice(idx, 0, row);
  state.tradeKeys.add(key);
  // reserve accounting is additive, so the tail is order independent
  if (atTail) state.reserves = reserves;
  else if (state.reserves) state.reserves = applyTrade(state.reserves, ev);
  return row;
}

export function addTokenTransfer(state: CurveState, row: TokenTransferRow): boolean {
  const key = `${row.txHash}:${row.logIndex}`;
  if (state.transferKeys.has(key)) return false;
  let idx = state.tokenTransfers.length;
  while (idx > 0 && before(row, state.tokenTransfers[idx - 1]!)) idx--;
  state.tokenTransfers.splice(idx, 0, row);
  state.transferKeys.add(key);
  return true;
}

export class CurveBook {
  private readonly states = new Map<Address, CurveState>();
  private readonly tokenToCurve = new Map<Address, Address>();

  constructor(readonly maxEntries = 2000) {}

  get(curve: Address): CurveState | undefined {
    const s = this.states.get(curve);
    if (s) {
      // refresh LRU position
      this.states.delete(curve);
      this.states.set(curve, s);
    }
    return s;
  }

  getByToken(token: Address): CurveState | undefined {
    const c = this.tokenToCurve.get(token);
    return c ? this.get(c) : undefined;
  }

  has(curve: Address): boolean {
    return this.states.has(curve);
  }

  put(state: CurveState): void {
    this.states.delete(state.curve);
    this.states.set(state.curve, state);
    this.tokenToCurve.set(state.token, state.curve);
    while (this.states.size > this.maxEntries) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
  }

  evict(curve: Address): void {
    const s = this.states.get(curve);
    if (s) this.tokenToCurve.delete(s.token);
    this.states.delete(curve);
  }

  clear(): void {
    this.states.clear();
    this.tokenToCurve.clear();
  }

  get size(): number {
    return this.states.size;
  }
}
