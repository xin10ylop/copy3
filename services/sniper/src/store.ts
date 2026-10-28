/**
 * Persistence port of the sniper. The hot path never awaits it: config is loaded into memory
 * at start and refreshed on NOTIFY; results are written asynchronously by the Recorder.
 * `MemoryStore` backs tests and DB-less paper runs; `PgStore` (store-db.ts) backs production.
 */
import type { ArmedCandidate, Play } from '@hood/core';

export type ChangeChannel = 'plays_changed' | 'armed_changed' | 'settings_changed';

export interface SnipeRecord {
  playId: number;
  token: string;
  curve: string;
  decidedAt: Date;
  decision: unknown;
  mode: 'live' | 'paper';
  burst: unknown;
  buyBlock?: number | null;
  buyTs?: Date | null;
  quoteIn?: bigint | null;
  tokensOut?: bigint | null;
  taxPaid?: bigint | null;
  entryPrice?: number | null;
  status: 'pending' | 'open' | 'closed' | 'failed' | 'aborted';
  sells: unknown;
  realizedPnlEth?: number | null;
  closedAt?: Date | null;
  notes?: string | null;
}

/**
 * A snipe row to reconcile at startup: pending / open, or aborted while a burst member was still
 * in flight (`burst[].status = 'sent'`: the process stopped before the run ended — N3).
 */
export interface ActiveSnipe {
  id: number;
  playId: number;
  token: string;
  curve: string;
  mode: 'live' | 'paper';
  /** pending / open / aborted from `loadActiveSnipes`; any status from `findSnipesByToken` */
  status: SnipeRecord['status'];
  decidedAt: Date;
  decision: unknown;
  quoteIn: bigint | null;
  tokensOut: bigint | null;
  entryPrice: number | null;
  buyBlock: number | null;
  sells: unknown;
}

export interface SnipeStats {
  countsByPlay: Record<number, number>;
  openCount: number;
  realizedPnlSince: number;
  /** all-time realised PnL of this mode (paper bankroll); optional for older stores */
  realizedPnlTotal?: number;
  tokens: string[];
  playDeployers: { playId: number; deployer: string }[];
}

export interface FeedBlockRow {
  block: number;
  ts: number;
  arrivalMs: number;
  nTxs: number;
}

export interface EventRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  type: string;
  payload: unknown;
}

export interface SniperStore {
  loadPlays(): Promise<Play[]>;
  loadArmed(): Promise<ArmedCandidate[]>;
  loadSettings(): Promise<Record<string, unknown>>;
  /** risk aggregates for ONE mode (paper runs never affect live limits and vice versa) */
  loadSnipeStats(since: Date, mode: 'live' | 'paper'): Promise<SnipeStats>;
  loadActiveSnipes(mode: 'live' | 'paper'): Promise<ActiveSnipe[]>;
  /**
   * NOTIFY subscription. `onConnect` runs on every (re)connect of the LISTEN connection: postgres.js
   * re-LISTENs after a reconnect but never replays what was NOTIFYed meanwhile, so the caller
   * reloads its state there (NEW-2).
   */
  onChange(cb: (channel: ChangeChannel, payload: string) => void, onConnect?: () => void): Promise<() => Promise<void>>;
  insertSnipe(s: SnipeRecord): Promise<number>;
  updateSnipe(id: number, patch: Partial<SnipeRecord>): Promise<void>;
  insertEvent(e: EventRecord): Promise<void>;
  notifySnipeEvent(payload: string): Promise<void>;
  insertFeedBlocks(rows: FeedBlockRow[]): Promise<void>;
  /** delete feed_blocks rows older than `before` (FEED_BLOCKS_RETENTION_DAYS); returns how many */
  pruneFeedBlocks(before: Date): Promise<number>;
  /** every row of `token` in this mode, newest first (startup orphan sweep, NEW-3) */
  findSnipesByToken(token: string, mode: 'live' | 'paper'): Promise<ActiveSnipe[]>;
  /** a persisted block cursor (e.g. the Sniped-event sweep checkpoint); null = never set */
  getCursor(key: string): Promise<number | null>;
  setCursor(key: string, block: number): Promise<void>;
  close(): Promise<void>;
}

/** A recorded burst with a member still marked `sent` (the run never reached its end). */
export function inFlight(burst: unknown): boolean {
  return Array.isArray(burst) && burst.some((m) => typeof m === 'object' && m !== null && (m as { status?: unknown }).status === 'sent');
}

/** In-memory store (tests, DB-less paper mode). */
export class MemoryStore implements SniperStore {
  plays: Play[] = [];
  armed: ArmedCandidate[] = [];
  settings: Record<string, unknown> = {};
  snipes = new Map<number, SnipeRecord>();
  events: EventRecord[] = [];
  notifications: string[] = [];
  feedBlocks: FeedBlockRow[] = [];
  cursors = new Map<string, number>();
  private nextId = 1;
  private listeners: ((c: ChangeChannel, p: string) => void)[] = [];

  constructor(init: { plays?: Play[]; armed?: ArmedCandidate[]; settings?: Record<string, unknown> } = {}) {
    this.plays = init.plays ?? [];
    this.armed = init.armed ?? [];
    this.settings = init.settings ?? {};
  }

  async loadPlays(): Promise<Play[]> {
    return this.plays.filter((p) => p.enabled);
  }
  async loadArmed(): Promise<ArmedCandidate[]> {
    const now = Date.now();
    return this.armed.filter((a) => a.status === 'armed' && (!a.expiresAt || a.expiresAt.getTime() > now));
  }
  async loadSettings(): Promise<Record<string, unknown>> {
    return { ...this.settings };
  }
  async loadSnipeStats(since: Date, mode: 'live' | 'paper'): Promise<SnipeStats> {
    const all = [...this.snipes.values()].filter((s) => s.mode === mode);
    const countsByPlay: Record<number, number> = {};
    for (const s of all) if (s.status === 'pending' || s.status === 'open' || s.status === 'closed') countsByPlay[s.playId] = (countsByPlay[s.playId] ?? 0) + 1;
    const played = (s: SnipeRecord): boolean =>
      s.status === 'open' || s.status === 'closed' || (s.decision as { confirmed?: unknown } | null)?.confirmed === true;
    const deployers = new Map<string, { playId: number; deployer: string }>();
    for (const s of all) {
      if (!played(s)) continue;
      const d = (s.decision as { launch?: { event?: { deployer?: string } } } | null)?.launch?.event?.deployer;
      if (d) deployers.set(`${s.playId}:${d}`, { playId: s.playId, deployer: d });
    }
    return {
      countsByPlay,
      openCount: all.filter((s) => s.status === 'open' || s.status === 'pending').length,
      realizedPnlSince: all.filter((s) => s.closedAt && s.closedAt >= since).reduce((a, s) => a + (s.realizedPnlEth ?? 0), 0),
      realizedPnlTotal: all.reduce((a, s) => a + (s.realizedPnlEth ?? 0), 0),
      tokens: all.filter((s) => played(s) && s.token).map((s) => s.token),
      playDeployers: [...deployers.values()],
    };
  }
  private static active(id: number, s: SnipeRecord): ActiveSnipe {
    return {
      id,
      playId: s.playId,
      token: s.token,
      curve: s.curve,
      mode: s.mode,
      status: s.status as ActiveSnipe['status'],
      decidedAt: s.decidedAt,
      decision: s.decision,
      quoteIn: s.quoteIn ?? null,
      tokensOut: s.tokensOut ?? null,
      entryPrice: s.entryPrice ?? null,
      buyBlock: s.buyBlock ?? null,
      sells: s.sells,
    };
  }
  async loadActiveSnipes(mode: 'live' | 'paper'): Promise<ActiveSnipe[]> {
    return [...this.snipes.entries()]
      .filter(([, s]) => s.mode === mode && (s.status === 'pending' || s.status === 'open' || (s.status === 'aborted' && inFlight(s.burst))))
      .map(([id, s]) => MemoryStore.active(id, s));
  }
  async findSnipesByToken(token: string, mode: 'live' | 'paper'): Promise<ActiveSnipe[]> {
    return [...this.snipes.entries()]
      .filter(([, s]) => s.mode === mode && s.token.toLowerCase() === token.toLowerCase())
      .sort(([a], [b]) => b - a)
      .map(([id, s]) => MemoryStore.active(id, s));
  }
  /** test helper: the LISTEN connection (re)connected */
  reconnect(): void {
    for (const c of this.connectListeners) c();
  }
  private connectListeners: (() => void)[] = [];
  /** test helper: drop NOTIFYs (a LISTEN connection that is down) */
  dropNotifications = false;
  async onChange(cb: (channel: ChangeChannel, payload: string) => void, onConnect?: () => void): Promise<() => Promise<void>> {
    this.listeners.push(cb);
    if (onConnect) {
      this.connectListeners.push(onConnect);
      onConnect(); // postgres.js calls onlisten once the first LISTEN is up, too
    }
    return async () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
      if (onConnect) this.connectListeners = this.connectListeners.filter((l) => l !== onConnect);
    };
  }
  /** test helper: simulate NOTIFY */
  emitChange(channel: ChangeChannel, payload = ''): void {
    if (this.dropNotifications) return;
    for (const l of this.listeners) l(channel, payload);
  }
  async insertSnipe(s: SnipeRecord): Promise<number> {
    const id = this.nextId++;
    this.snipes.set(id, { ...s });
    return id;
  }
  async updateSnipe(id: number, patch: Partial<SnipeRecord>): Promise<void> {
    const cur = this.snipes.get(id);
    if (cur) this.snipes.set(id, { ...cur, ...patch });
  }
  async insertEvent(e: EventRecord): Promise<void> {
    this.events.push(e);
  }
  async notifySnipeEvent(payload: string): Promise<void> {
    this.notifications.push(payload);
  }
  async insertFeedBlocks(rows: FeedBlockRow[]): Promise<void> {
    this.feedBlocks.push(...rows);
    if (this.feedBlocks.length > 10_000) this.feedBlocks.splice(0, this.feedBlocks.length - 10_000);
  }
  async pruneFeedBlocks(before: Date): Promise<number> {
    const n = this.feedBlocks.length;
    this.feedBlocks = this.feedBlocks.filter((r) => r.ts * 1000 >= before.getTime());
    return n - this.feedBlocks.length;
  }
  async getCursor(key: string): Promise<number | null> {
    return this.cursors.get(key) ?? null;
  }
  async setCursor(key: string, block: number): Promise<void> {
    this.cursors.set(key, block);
  }
  async close(): Promise<void> {}
}
