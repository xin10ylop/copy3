/**
 * Test doubles: an in-memory BotStore and a grammY bot whose API calls are captured by a
 * transformer (no network), following grammY's recommended testing approach.
 */
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { createBot, type BotConfig, type BotDeps } from '../src/bot.js';
import { Links } from '../src/format.js';
import { JobRunner } from '../src/jobs.js';
import type { Messenger } from '../src/messenger.js';
import type { AgentPort, AgentRunSummary, TrackerPort } from '../src/ports.js';
import { Registry } from '../src/registry.js';
import { stubTrackerPort } from '../src/stubs/tracker.js';
import type {
  ArmedRow,
  BotStore,
  EventRow,
  NewEvent,
  NewPlay,
  PlayRow,
  PnlBucket,
  PnlSummary,
  SnipeRow,
  StatusSnapshot,
} from '../src/store.js';
import { parseEthUsd, parseKillState, SETTINGS } from '../src/store.js';

export const ADMIN = { id: 1001, is_bot: false, first_name: 'Owner', username: 'owner' };
export const STRANGER = { id: 666, is_bot: false, first_name: 'Eve' };
export const FUNDER = '0x1111111111111111111111111111111111111111';
export const TOKEN = '0x2222222222222222222222222222222222222222';
export const CURVE = '0x3333333333333333333333333333333333333333';
export const WALLET = '0x4444444444444444444444444444444444444444';
export const TX = `0x${'ab'.repeat(32)}`;
export const NOW = new Date('2026-10-28T16:00:00Z');

export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const bucket = (): PnlBucket => ({ closed: 0, wins: 0, losses: 0, pnlEth: 0, bestEth: null, worstEth: null, aborted: 0, failed: 0, taxPaidWei: 0n, investedWei: 0n });

export function makePlay(over: Partial<PlayRow> = {}): PlayRow {
  return {
    id: 1,
    name: 'test play',
    enabled: false,
    operatorId: null,
    trigger: { armedWallet: { funders: [FUNDER], minEth: 0.01, maxEth: 0.015, freshOnly: true, maxAgeSec: 172800, contractMode: false }, require: ['armedWallet'] },
    preset: {},
    createdBy: 'agent',
    createdAt: NOW,
    updatedAt: NOW,
    stats: {},
    armedCount: 0,
    ...over,
  };
}

export function makeSnipe(over: Partial<SnipeRow> = {}): SnipeRow {
  return {
    id: 7,
    playId: 1,
    playName: 'test play',
    token: TOKEN,
    curve: CURVE,
    tokenName: 'Amlil',
    tokenSymbol: 'AMLIL',
    launchTs: new Date('2026-10-28T15:59:00Z'),
    mode: 'live',
    status: 'pending',
    decidedAt: new Date('2026-10-28T15:59:00.400Z'),
    decision: { matched: ['armedWallet'] },
    burst: [
      { nonce: 41, hash: TX, sentAt: 1_793_203_140_880, endpoint: 'https://rpc.mainnet.chain.robinhood.com', status: 'mined', block: 100, ts: 1_793_203_141 },
      { nonce: 42, sentAt: 1_793_203_140_895, endpoint: 'https://rpc.mainnet.chain.robinhood.com', status: 'reverted' },
      { nonce: 43, sentAt: 1_793_203_140_910, endpoint: 'http://nitro:8547', status: 'reverted' },
    ],
    buyBlock: null,
    buyTs: null,
    quoteInWei: 70_000_000_000_000_000n,
    tokensOut: null,
    taxPaidWei: null,
    entryPrice: null,
    sells: [],
    realizedPnlEth: null,
    closedAt: null,
    notes: null,
    lastPrice: null,
    ...over,
  };
}

export class FakeStore implements BotStore {
  plays = new Map<number, PlayRow>();
  armed: ArmedRow[] = [];
  snipes = new Map<number, SnipeRow>();
  events: EventRow[] = [];
  settings = new Map<string, unknown>();
  notifies: Array<{ channel: string; payload: unknown }> = [];
  nextPlayId = 1;
  nextEventId = 1;
  status: Partial<StatusSnapshot> = {};
  pnl: PnlSummary = { since: NOW, live: bucket(), paper: bucket(), byPlay: [] };

  addPlay(p: PlayRow): PlayRow {
    this.plays.set(p.id, p);
    this.nextPlayId = Math.max(this.nextPlayId, p.id + 1);
    return p;
  }
  addEvent(e: Omit<EventRow, 'id' | 'ts'> & { id?: number; ts?: Date }): EventRow {
    const row: EventRow = { id: e.id ?? this.nextEventId, ts: e.ts ?? NOW, level: e.level, source: e.source, type: e.type, payload: e.payload };
    this.nextEventId = Math.max(this.nextEventId, row.id) + 1;
    this.events.push(row);
    return row;
  }

  async listPlays(): Promise<PlayRow[]> {
    return [...this.plays.values()].sort((a, b) => a.id - b.id);
  }
  async getPlay(id: number): Promise<PlayRow | null> {
    const p = this.plays.get(id);
    return p ? structuredClone(p) : null;
  }
  async insertPlay(p: NewPlay): Promise<number> {
    const id = this.nextPlayId++;
    this.plays.set(id, makePlay({ id, name: p.name, enabled: p.enabled, trigger: p.trigger, preset: p.preset, createdBy: p.createdBy, operatorId: p.operatorId ?? null, stats: p.stats ?? {} }));
    this.notifies.push({ channel: 'plays_changed', payload: { op: 'insert', playId: id } });
    return id;
  }
  async setPlayEnabled(id: number, enabled: boolean, statsPatch?: Record<string, unknown>): Promise<PlayRow | null> {
    const p = this.plays.get(id);
    if (!p) return null;
    p.enabled = enabled;
    p.stats = { ...p.stats, ...(statsPatch ?? {}) };
    this.notifies.push({ channel: 'plays_changed', payload: { op: enabled ? 'enable' : 'disable', playId: id } });
    return structuredClone(p);
  }
  async updatePlayPreset(id: number, preset: unknown): Promise<void> {
    const p = this.plays.get(id);
    if (p) p.preset = preset;
    this.notifies.push({ channel: 'plays_changed', payload: { op: 'preset', playId: id } });
  }
  async listArmed(limit: number): Promise<ArmedRow[]> {
    return this.armed.filter((a) => a.status === 'armed').slice(0, limit);
  }
  async armedAfter(id: number, limit: number): Promise<ArmedRow[]> {
    return this.armed.filter((a) => a.id > id).sort((a, b) => a.id - b.id).slice(0, limit);
  }
  async maxArmedId(): Promise<number> {
    return Math.max(0, ...this.armed.map((a) => a.id));
  }
  async listOpenSnipes(): Promise<SnipeRow[]> {
    return [...this.snipes.values()].filter((s) => s.status === 'pending' || s.status === 'open');
  }
  async getSnipes(ids: number[]): Promise<SnipeRow[]> {
    return ids.map((i) => this.snipes.get(i)).filter((s): s is SnipeRow => !!s).map((s) => structuredClone(s));
  }
  async snipesAfter(id: number, limit: number): Promise<SnipeRow[]> {
    return [...this.snipes.values()].filter((s) => s.id > id).sort((a, b) => a.id - b.id).slice(0, limit).map((s) => structuredClone(s));
  }
  async maxSnipeId(): Promise<number> {
    return Math.max(0, ...this.snipes.keys());
  }
  async pnlSummary(since: Date): Promise<PnlSummary> {
    return { ...this.pnl, since };
  }
  async getStatus(): Promise<StatusSnapshot> {
    return {
      feed: { block: 100_302_108, ts: new Date(NOW.getTime() - 1000), arrivalMs: NOW.getTime() - 900 },
      indexerBlock: 100_302_000,
      kill: parseKillState(this.settings.get(SETTINGS.killSwitch)),
      openPositions: { live: 1, paper: 2 },
      dailyPnl: { live: 0.0123, paper: -0.004 },
      enabledPlays: [...this.plays.values()].filter((p) => p.enabled).length,
      pendingReview: 0,
      armed: this.armed.length,
      lastError: null,
      ethUsd: parseEthUsd(this.settings.get(SETTINGS.ethUsd)),
      ...this.status,
    };
  }
  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return this.settings.has(key) ? (structuredClone(this.settings.get(key)) as T) : null;
  }
  async setSetting(key: string, value: unknown, opts: { notify?: boolean } = {}): Promise<void> {
    this.settings.set(key, structuredClone(value));
    if (opts.notify !== false) this.notifies.push({ channel: 'settings_changed', payload: { key } });
  }
  async insertEvent(e: NewEvent): Promise<void> {
    this.addEvent(e);
  }
  async eventsAfter(id: number, limit: number): Promise<EventRow[]> {
    return this.events.filter((e) => e.id > id).sort((a, b) => a.id - b.id).slice(0, limit);
  }
  async maxEventId(): Promise<number> {
    return Math.max(0, ...this.events.map((e) => e.id));
  }
  async countEventsSince(since: Date, level: string): Promise<number> {
    return this.events.filter((e) => e.ts >= since && e.level === level).length;
  }
}

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export const BOT_INFO: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'HoodSniper',
  username: 'hood_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;

let updateId = 1;
let messageId = 100;

export function commandUpdate(text: string, from: { id: number; is_bot: boolean; first_name: string; username?: string } = ADMIN): Update {
  const cmd = text.split(/\s/)[0]!;
  return {
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: Math.floor(NOW.getTime() / 1000),
      chat: { id: from.id, type: 'private', first_name: from.first_name },
      from,
      text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: cmd.length }] : [],
    },
  } as Update;
}

export function callbackUpdate(data: string, from: { id: number; is_bot: boolean; first_name: string; username?: string } = ADMIN): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from,
      chat_instance: 'ci',
      data,
      message: {
        message_id: 555,
        date: Math.floor(NOW.getTime() / 1000),
        chat: { id: from.id, type: 'private', first_name: from.first_name },
        text: 'card',
      },
    },
  } as Update;
}

export function fakeAgent(over: Partial<AgentPort> = {}): AgentPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  const result = (summary: string): AgentRunSummary => ({ runId: 9, summary, reportPath: null, csvPath: null, proposedPlayIds: [], costUsd: 1.25, error: null });
  return {
    available: true,
    calls,
    runPlayFinder: async (i) => {
      calls.push(['play', i]);
      return result('operator found');
    },
    runScout: async (i) => {
      calls.push(['scout', i]);
      return result('scout done');
    },
    runBacktest: async (i) => {
      calls.push(['backtest', i]);
      return result('backtest done');
    },
    ...over,
  };
}

export interface Harness {
  bot: Bot;
  messenger: Messenger;
  store: FakeStore;
  calls: ApiCall[];
  jobs: JobRunner;
  registry: Registry;
  send: (u: Update) => Promise<void>;
  texts: () => string[];
}

export function makeHarness(opts: { store?: FakeStore; agent?: AgentPort; tracker?: TrackerPort; config?: Partial<BotConfig>; deps?: Partial<BotDeps> } = {}): Harness {
  const store = opts.store ?? new FakeStore();
  const calls: ApiCall[] = [];
  const jobs = new JobRunner({ concurrency: 1, maxQueue: 3, log: silentLog });
  const registry = new Registry();
  const { bot, messenger } = createBot(
    '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz',
    {
      store,
      agent: opts.agent ?? fakeAgent(),
      tracker: opts.tracker ?? stubTrackerPort(),
      jobs,
      registry,
      notifyChatIds: [ADMIN.id, -100200],
      links: new Links(),
      chainHeads: async () => ({ node: 100_302_100, publicRpc: 100_302_108 }),
      log: silentLog,
      now: () => NOW,
      config: {
        adminIds: new Set([ADMIN.id]),
        tz: 'America/New_York',
        reportsDir: '/nonexistent',
        maxBuyEth: 1,
        maxWatchEth: 100,
        scout: { sinceMinutes: 60, minPeak10Pct: 100 },
        ...opts.config,
      },
      ...opts.deps,
    },
    { botInfo: BOT_INFO },
  );
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as Record<string, unknown>;
    const result =
      method === 'sendMessage' || method === 'sendDocument' || method === 'editMessageText'
        ? { message_id: messageId++, date: 0, chat: { id: Number(p.chat_id ?? ADMIN.id), type: 'private' }, text: String(p.text ?? '') }
        : true;
    return { ok: true, result } as never;
  });
  return {
    bot,
    messenger,
    store,
    calls,
    jobs,
    registry,
    send: (u) => bot.handleUpdate(u),
    texts: () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => String(c.payload.text)),
  };
}
