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

export interface SnipeStats {
  countsByPlay: Record<number, number>;
  openCount: number;
  realizedPnlSince: number;
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
  loadSnipeStats(since: Date): Promise<SnipeStats>;
  onChange(cb: (channel: ChangeChannel, payload: string) => void): Promise<() => Promise<void>>;
  insertSnipe(s: SnipeRecord): Promise<number>;
  updateSnipe(id: number, patch: Partial<SnipeRecord>): Promise<void>;
  insertEvent(e: EventRecord): Promise<void>;
  notifySnipeEvent(payload: string): Promise<void>;
  insertFeedBlocks(rows: FeedBlockRow[]): Promise<void>;
  close(): Promise<void>;
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
  async loadSnipeStats(since: Date): Promise<SnipeStats> {
    const all = [...this.snipes.values()];
    const live = all.filter((s) => s.mode === 'live');
    const countsByPlay: Record<number, number> = {};
    for (const s of live) if (s.status !== 'aborted' && s.status !== 'failed') countsByPlay[s.playId] = (countsByPlay[s.playId] ?? 0) + 1;
    return {
      countsByPlay,
      openCount: all.filter((s) => s.status === 'open' || s.status === 'pending').length,
      realizedPnlSince: live
        .filter((s) => s.closedAt && s.closedAt >= since)
        .reduce((a, s) => a + (s.realizedPnlEth ?? 0), 0),
      tokens: all.filter((s) => s.status !== 'aborted').map((s) => s.token),
      playDeployers: [],
    };
  }
  async onChange(cb: (channel: ChangeChannel, payload: string) => void): Promise<() => Promise<void>> {
    this.listeners.push(cb);
    return async () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
  /** test helper: simulate NOTIFY */
  emitChange(channel: ChangeChannel, payload = ''): void {
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
  async close(): Promise<void> {}
}
