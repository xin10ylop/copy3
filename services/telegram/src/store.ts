/**
 * Persistence port of the Telegram service. `PgStore` (store-pg.ts) implements it against the
 * SPEC §2 tables; tests use an in-memory fake. Rows are already normalised (wei as bigint,
 * timestamps as Date, ids as number).
 */

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface PlayRow {
  id: number;
  name: string;
  enabled: boolean;
  operatorId: number | null;
  trigger: unknown;
  preset: unknown;
  createdBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  stats: Record<string, unknown>;
  /** live armed candidates for this play */
  armedCount: number;
}

export interface NewPlay {
  name: string;
  trigger: unknown;
  preset: unknown;
  operatorId?: number | null;
  createdBy: string;
  enabled: boolean;
  stats?: Record<string, unknown>;
}

export interface ArmedRow {
  id: number;
  playId: number;
  playName: string | null;
  wallet: string;
  sourceFunder: string | null;
  fundedValueWei: bigint | null;
  fundedTx: string | null;
  armedAt: Date | null;
  expiresAt: Date | null;
  status: string;
}

export type SnipeStatus = 'pending' | 'open' | 'closed' | 'failed' | 'aborted';

export interface SnipeRow {
  id: number;
  playId: number;
  playName: string | null;
  token: string;
  curve: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  launchTs: Date | null;
  mode: 'live' | 'paper';
  status: SnipeStatus;
  decidedAt: Date | null;
  decision: Record<string, unknown>;
  burst: unknown[];
  buyBlock: number | null;
  buyTs: Date | null;
  quoteInWei: bigint | null;
  tokensOut: bigint | null;
  taxPaidWei: bigint | null;
  /** ETH per token */
  entryPrice: number | null;
  sells: unknown[];
  realizedPnlEth: number | null;
  closedAt: Date | null;
  notes: string | null;
  /** last curve price for the token (ETH per token), for unrealised PnL in /positions */
  lastPrice?: number | null;
}

export interface EventRow {
  id: number;
  ts: Date;
  level: string;
  source: string;
  type: string;
  payload: unknown;
}

export interface NewEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  type: string;
  payload: unknown;
}

export interface PnlBucket {
  closed: number;
  wins: number;
  losses: number;
  pnlEth: number;
  bestEth: number | null;
  worstEth: number | null;
  aborted: number;
  failed: number;
  taxPaidWei: bigint;
  investedWei: bigint;
}

export interface PnlByPlay {
  playId: number;
  name: string | null;
  mode: 'live' | 'paper';
  closed: number;
  pnlEth: number;
}

export interface PnlSummary {
  since: Date;
  live: PnlBucket;
  paper: PnlBucket;
  byPlay: PnlByPlay[];
}

export interface KillState {
  on: boolean;
  reason?: string | null;
  by?: string | null;
  at?: string | null;
}

export interface FeedHead {
  block: number;
  /** block timestamp (sequencer clock) */
  ts: Date | null;
  /** local arrival time at the sniper, ms since epoch */
  arrivalMs: number | null;
}

export interface StatusSnapshot {
  feed: FeedHead | null;
  /** indexer checkpoint (settings `indexer.checkpoint`) */
  indexerBlock: number | null;
  kill: KillState;
  openPositions: { live: number; paper: number };
  /** realized PnL since local midnight, ETH */
  dailyPnl: { live: number; paper: number };
  enabledPlays: number;
  pendingReview: number;
  armed: number;
  lastError: { ts: Date; source: string; type: string } | null;
  ethUsd: number | null;
}

export interface BotStore {
  // plays
  listPlays(): Promise<PlayRow[]>;
  getPlay(id: number): Promise<PlayRow | null>;
  /** upsertPlay: inserts (no id) and NOTIFYs plays_changed; returns the id */
  insertPlay(p: NewPlay): Promise<number>;
  /** enable/disable + merge `statsPatch` into stats; NOTIFY plays_changed */
  setPlayEnabled(id: number, enabled: boolean, statsPatch?: Record<string, unknown>): Promise<PlayRow | null>;
  updatePlayPreset(id: number, preset: unknown): Promise<void>;
  // armed
  listArmed(limit: number): Promise<ArmedRow[]>;
  armedAfter(id: number, limit: number): Promise<ArmedRow[]>;
  maxArmedId(): Promise<number>;
  // snipes
  listOpenSnipes(): Promise<SnipeRow[]>;
  getSnipes(ids: number[]): Promise<SnipeRow[]>;
  snipesAfter(id: number, limit: number): Promise<SnipeRow[]>;
  maxSnipeId(): Promise<number>;
  pnlSummary(since: Date): Promise<PnlSummary>;
  // status
  getStatus(dayStart: Date): Promise<StatusSnapshot>;
  // settings
  getSetting<T = unknown>(key: string): Promise<T | null>;
  /** upsert + NOTIFY settings_changed `{key}` (pass `notify: false` for private checkpoints) */
  setSetting(key: string, value: unknown, opts?: { notify?: boolean }): Promise<void>;
  // events
  insertEvent(e: NewEvent): Promise<void>;
  eventsAfter(id: number, limit: number): Promise<EventRow[]>;
  maxEventId(): Promise<number>;
  countEventsSince(since: Date, level: string): Promise<number>;
}

/** settings keys owned by (or read by) the Telegram service */
export const SETTINGS = {
  /** global kill switch: `{ on, reason, by, at }`; the sniper must not open positions while on */
  killSwitch: 'kill_switch',
  ethUsd: 'eth_usd',
  indexerCheckpoint: 'indexer.checkpoint',
  eventsCheckpoint: 'telegram.events_checkpoint',
  armedCheckpoint: 'telegram.armed_checkpoint',
  snipesCheckpoint: 'telegram.snipes_checkpoint',
  dailySummaryLast: 'telegram.daily_summary_last',
} as const;

/** Read the kill switch from its stored JSON (`{on:true}`, `true`, `"on"`). */
export function parseKillState(v: unknown): KillState {
  if (v === true || v === 'on' || v === 'true') return { on: true };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const on = o.on === true || o.enabled === true || o.killed === true;
    return {
      on,
      reason: typeof o.reason === 'string' ? o.reason : null,
      by: typeof o.by === 'string' ? o.by : null,
      at: typeof o.at === 'string' ? o.at : null,
    };
  }
  return { on: false };
}

/** `settings.eth_usd` may be `3500`, `"3500"` or `{ "usd": 3500 }`. */
export function parseEthUsd(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : v && typeof v === 'object' ? Number((v as Record<string, unknown>).usd) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Review state of a play, kept in `plays.stats.review`. Agent/watch proposals are pending until approved. */
export function reviewStatus(p: Pick<PlayRow, 'enabled' | 'stats' | 'createdBy'>): ReviewStatus | null {
  const r = p.stats.review;
  if (r && typeof r === 'object') {
    const s = (r as Record<string, unknown>).status;
    if (s === 'pending' || s === 'approved' || s === 'rejected') return s;
  }
  if (!p.enabled && (p.createdBy === 'agent' || p.stats.needsApproval === true)) return 'pending';
  return null;
}
