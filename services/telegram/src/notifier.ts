/**
 * Pushes what happens to the Telegram notification chats.
 *
 * Sources (each with a durable checkpoint in `settings`, so restarts neither replay nor lose):
 *   snipes table      lifecycle diff per snipe: sent/planned -> filled -> closed, or aborted/failed
 *                     (woken by NOTIFY snipe_events; polled as a backstop)
 *   armed_candidates  new rows -> "armed" (woken by NOTIFY armed_changed)
 *   settings          kill switch flips (NOTIFY settings_changed)
 *   events            tail by id: errors/warnings, play proposals (approval card), agent runs,
 *                     anything with payload.notify = true (NOTIFY plays_changed wakes it)
 *   clock             daily summary at TELEGRAM_DAILY_SUMMARY_HOUR in TELEGRAM_TZ
 * All passes run strictly one at a time, so a NOTIFY storm cannot double-send.
 */
import type { Logger } from 'pino';
import { escapeHtml, localDate, localHour, startOfLocalDay, type Links } from './format.js';
import {
  approvalKeyboard,
  armedMessage,
  dailySummaryMessage,
  eventMessage,
  killMessage,
  playProposalCard,
  snipeAbortedMessage,
  snipeClosedMessage,
  snipeFilledMessage,
  snipeSentMessage,
  type FormatCtx,
} from './messages.js';
import type { SendExtra } from './messenger.js';
import type { Registry } from './registry.js';
import { parseEthUsd, parseKillState, SETTINGS, type BotStore, type EventRow, type SnipeRow, type SnipeStatus } from './store.js';

export const NOTIFY_CHANNELS = ['snipe_events', 'armed_changed', 'settings_changed', 'plays_changed'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export interface NotifierConfig {
  pollMs: number;
  dailySummaryHour: number;
  tz: string;
  links: Links;
  /** events written by these sources are not pushed (the bot already answered in chat) */
  ignoreSources: string[];
  /** more new armed rows than this in one pass are summarised in a single message */
  armedBurstLimit: number;
}

export interface NotifierDeps {
  store: BotStore;
  broadcast: (html: string, extra?: SendExtra) => Promise<number>;
  /** number of chats broadcast() targets; 0 = notifications disabled */
  chatCount: number;
  registry: Registry;
  activeJobKinds: () => Set<string>;
  listen?: (channel: NotifyChannel, onPayload: (payload: string) => void) => Promise<() => Promise<void>>;
  log: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;
  now?: () => Date;
}

export type SnipeStep = 'sent' | 'filled' | 'closed' | 'aborted';

const RANK: Record<string, number> = { pending: 0, open: 1, closed: 2 };
const TERMINAL = new Set<SnipeStatus>(['closed', 'aborted', 'failed']);

/** Which lifecycle messages a snipe needs, given the status we last announced (undefined = never seen). */
export function snipeSteps(prev: SnipeStatus | undefined, row: Pick<SnipeRow, 'status' | 'burst'>): SnipeStep[] {
  const cur = row.status;
  const steps: SnipeStep[] = [];
  if (cur === 'aborted' || cur === 'failed') {
    if (prev !== cur) steps.push('aborted');
    return steps;
  }
  if (prev === undefined) steps.push('sent');
  const before = prev === undefined ? -1 : (RANK[prev] ?? 99);
  const now = RANK[cur] ?? -1;
  if (before < 1 && now >= 1) steps.push('filled');
  if (before < 2 && now >= 2) steps.push('closed');
  return steps;
}

interface SnipeCheckpoint {
  maxId: number;
  open: Record<string, SnipeStatus>;
}

const AGENT_FINISH_KIND: Record<string, string> = { agent_run_finished: '', scout_finished: 'scout', backtest_finished: 'backtest' };

/**
 * Rows behind the checkpoint that are re-read every pass. Several services insert events
 * concurrently, so a lower id can commit after a higher one; ids in this window that were not
 * seen yet are still delivered.
 */
export const LOOKBACK_IDS = 50;

class SeenWindow {
  private readonly ids = new Set<number>();
  add(id: number): void {
    this.ids.add(id);
  }
  has(id: number): boolean {
    return this.ids.has(id);
  }
  prune(below: number): void {
    for (const id of this.ids) if (id < below) this.ids.delete(id);
  }
}

export class Notifier {
  private eventsCp = 0;
  private armedCp = 0;
  private snipeCp: SnipeCheckpoint = { maxId: 0, open: {} };
  private lastSummaryDate: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private unlisten: Array<() => Promise<void>> = [];
  private readonly failures = new Map<number, number>();
  private readonly seenEvents = new SeenWindow();
  private readonly seenArmed = new SeenWindow();
  private initialized = false;

  constructor(
    private readonly deps: NotifierDeps,
    private readonly cfg: NotifierConfig,
  ) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Run `fn` after every previously scheduled pass (strict serialisation). */
  private serial(what: string, fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn).catch((err: unknown) => this.deps.log.error({ err, what }, 'notifier pass failed'));
    this.chain = next;
    return next;
  }

  private async fmtCtx(): Promise<FormatCtx> {
    const ethUsd = parseEthUsd(await this.deps.store.getSetting(SETTINGS.ethUsd).catch(() => null));
    return { links: this.cfg.links, ethUsd, tz: this.cfg.tz, now: this.now() };
  }

  /** Load checkpoints; on first run start from "now" (no history replay). */
  async init(): Promise<void> {
    const { store, registry } = this.deps;
    const ev = await store.getSetting<{ id?: number }>(SETTINGS.eventsCheckpoint);
    this.eventsCp = typeof ev?.id === 'number' ? ev.id : await store.maxEventId();
    const ar = await store.getSetting<{ id?: number }>(SETTINGS.armedCheckpoint);
    this.armedCp = typeof ar?.id === 'number' ? ar.id : await store.maxArmedId();
    const sn = await store.getSetting<SnipeCheckpoint>(SETTINGS.snipesCheckpoint);
    if (sn && typeof sn.maxId === 'number' && sn.open && typeof sn.open === 'object') {
      this.snipeCp = { maxId: sn.maxId, open: { ...sn.open } };
    } else {
      const open = await store.listOpenSnipes();
      this.snipeCp = { maxId: await store.maxSnipeId(), open: Object.fromEntries(open.map((s) => [String(s.id), s.status])) };
    }
    // Everything at or below the checkpoint counts as delivered (restart: no replay).
    for (const e of await store.eventsAfter(Math.max(0, this.eventsCp - LOOKBACK_IDS), LOOKBACK_IDS * 4)) if (e.id <= this.eventsCp) this.seenEvents.add(e.id);
    for (const a of await store.armedAfter(Math.max(0, this.armedCp - LOOKBACK_IDS), LOOKBACK_IDS * 4)) if (a.id <= this.armedCp) this.seenArmed.add(a.id);
    const last = await store.getSetting<string>(SETTINGS.dailySummaryLast);
    this.lastSummaryDate = typeof last === 'string' ? last : null;
    if (registry.kill === null) registry.kill = parseKillState(await store.getSetting(SETTINGS.killSwitch));
    await this.saveCheckpoints();
    this.initialized = true;
    this.deps.log.info({ eventsCp: this.eventsCp, armedCp: this.armedCp, snipes: this.snipeCp }, 'notifier initialised');
  }

  async start(): Promise<void> {
    await this.init();
    if (this.deps.listen) {
      for (const channel of NOTIFY_CHANNELS) {
        this.unlisten.push(await this.deps.listen(channel, (payload) => void this.onNotify(channel, payload)));
      }
    }
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    this.timer.unref();
    await this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unlisten.splice(0)) await u().catch(() => undefined);
    await this.chain;
  }

  /** One full pass over every source (also the polling backstop). */
  tick(): Promise<void> {
    return this.serial('tick', async () => {
      await this.processKill();
      await this.processArmed();
      await this.processSnipes();
      await this.processEvents();
      await this.processDailySummary();
    });
  }

  onNotify(channel: NotifyChannel, payload: string): Promise<void> {
    switch (channel) {
      case 'snipe_events':
        return this.serial('snipe_events', () => this.processSnipes(snipeIdsFromPayload(payload)));
      case 'armed_changed':
        return this.serial('armed_changed', () => this.processArmed());
      case 'settings_changed': {
        // the settings trigger sends {"op":…,"key":…}; only the kill switch matters here
        const key = settingsKeyFromPayload(payload);
        if (key !== null && key !== SETTINGS.killSwitch) return Promise.resolve();
        return this.serial('settings_changed', () => this.processKill());
      }
      case 'plays_changed':
        return this.serial('plays_changed', () => this.processEvents());
    }
  }

  private async saveCheckpoints(): Promise<void> {
    const { store } = this.deps;
    await store.setSetting(SETTINGS.eventsCheckpoint, { id: this.eventsCp }, { notify: false });
    await store.setSetting(SETTINGS.armedCheckpoint, { id: this.armedCp }, { notify: false });
    await store.setSetting(SETTINGS.snipesCheckpoint, this.snipeCp, { notify: false });
  }

  /** Broadcast; false when nobody received it (Telegram down) so the caller can retry later. */
  private async push(html: string, extra?: SendExtra): Promise<boolean> {
    if (this.deps.chatCount === 0) return true;
    return (await this.deps.broadcast(html, extra)) > 0;
  }

  // ------------------------------------------------------------------------------- kill switch
  async processKill(): Promise<void> {
    const state = parseKillState(await this.deps.store.getSetting(SETTINGS.killSwitch));
    const prev = this.deps.registry.kill;
    this.deps.registry.kill = state;
    if (prev === null || prev.on === state.on) return;
    await this.push(killMessage(state, state.by ?? undefined));
  }

  // ------------------------------------------------------------------------------- armed
  async processArmed(): Promise<void> {
    if (!this.initialized) return;
    const rows = (await this.deps.store.armedAfter(Math.max(0, this.armedCp - LOOKBACK_IDS), 250)).filter((r) => !this.seenArmed.has(r.id));
    if (rows.length === 0) return;
    const ctx = await this.fmtCtx();
    const fresh = rows.filter((r) => r.status === 'armed');
    if (fresh.length > this.cfg.armedBurstLimit) {
      const lines = [`<b>ARMED</b> ${fresh.length} wallets`, ...fresh.slice(0, this.cfg.armedBurstLimit).map((a) => `• play #${a.playId} ${this.cfg.links.address(a.wallet)} ← ${this.cfg.links.address(a.sourceFunder)}`), '/armed for the full list'];
      if (!(await this.push(lines.join('\n')))) return;
    } else {
      for (const a of fresh) {
        if (!(await this.push(armedMessage(a, ctx)))) return;
        this.seenArmed.add(a.id);
      }
    }
    for (const r of rows) this.seenArmed.add(r.id);
    this.armedCp = Math.max(this.armedCp, ...rows.map((r) => r.id));
    this.seenArmed.prune(this.armedCp - LOOKBACK_IDS);
    await this.deps.store.setSetting(SETTINGS.armedCheckpoint, { id: this.armedCp }, { notify: false });
  }

  // ------------------------------------------------------------------------------- snipes
  async processSnipes(hintIds: number[] = []): Promise<void> {
    if (!this.initialized) return;
    const { store } = this.deps;
    const tracked = Object.keys(this.snipeCp.open).map(Number);
    const ids = [...new Set([...tracked, ...hintIds.filter((i) => i <= this.snipeCp.maxId)])];
    const [known, fresh] = await Promise.all([store.getSnipes(ids), store.snipesAfter(this.snipeCp.maxId, 100)]);
    const rows = [...known, ...fresh].sort((a, b) => a.id - b.id);
    if (rows.length === 0) return;
    const ctx = await this.fmtCtx();
    let changed = false;
    for (const row of rows) {
      const key = String(row.id);
      const isNew = row.id > this.snipeCp.maxId;
      const prev = isNew ? undefined : this.snipeCp.open[key];
      if (!isNew && prev === undefined) continue; // already terminal and announced
      for (const step of snipeSteps(prev, row)) {
        if (step === 'sent' && row.burst.length === 0 && row.status !== 'pending') continue;
        const html =
          step === 'sent'
            ? snipeSentMessage(row, ctx)
            : step === 'filled'
              ? snipeFilledMessage(row, ctx)
              : step === 'closed'
                ? snipeClosedMessage(row, ctx)
                : snipeAbortedMessage(row, ctx);
        if (!(await this.push(html))) {
          if (changed) await store.setSetting(SETTINGS.snipesCheckpoint, this.snipeCp, { notify: false });
          return;
        }
      }
      if (TERMINAL.has(row.status)) delete this.snipeCp.open[key];
      else this.snipeCp.open[key] = row.status;
      if (isNew) this.snipeCp.maxId = row.id;
      changed = true;
    }
    if (changed) await store.setSetting(SETTINGS.snipesCheckpoint, this.snipeCp, { notify: false });
  }

  // ------------------------------------------------------------------------------- events
  /** What to do with one event row. */
  route(e: EventRow): 'card' | 'message' | 'skip' {
    if (this.cfg.ignoreSources.includes(e.source)) return 'skip';
    const payload = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
    if (e.type === 'play_proposed') return 'card';
    if (e.type in AGENT_FINISH_KIND) {
      if (this.deps.registry.runReported(payload.runId)) return 'skip';
      const kind = AGENT_FINISH_KIND[e.type] || (typeof payload.kind === 'string' ? payload.kind : '');
      if (kind && this.deps.activeJobKinds().has(kind)) return 'skip';
      if (e.type === 'scout_finished' && !(Array.isArray(payload.childRuns) && payload.childRuns.length > 0)) return 'skip';
      return 'message';
    }
    if (e.level === 'error' || e.level === 'warn') return 'message';
    if (payload.notify === true) return 'message';
    return 'skip';
  }

  async processEvents(): Promise<void> {
    if (!this.initialized) return;
    const { store, registry, log } = this.deps;
    const rows = (await store.eventsAfter(Math.max(0, this.eventsCp - LOOKBACK_IDS), 250)).filter((e) => !this.seenEvents.has(e.id));
    if (rows.length === 0) return;
    const ctx = await this.fmtCtx();
    for (const e of rows) {
      const action = this.route(e);
      let delivered = true;
      if (action === 'card') {
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        const playId = typeof payload.playId === 'number' ? payload.playId : Number(payload.playId);
        if (Number.isInteger(playId) && playId > 0 && registry.claimCard(playId)) {
          const play = await store.getPlay(playId);
          if (play && !play.enabled) {
            const source = [e.source, typeof payload.runId === 'number' ? `run #${payload.runId}` : null].filter(Boolean).join(' ');
            const summary = typeof payload.summary === 'string' ? payload.summary : null;
            delivered = await this.push(playProposalCard(play, this.cfg.links, source, summary), { reply_markup: approvalKeyboard(playId) });
          }
        }
      } else if (action === 'message') {
        delivered = await this.push(agentEventHtml(e) ?? eventMessage(e, ctx));
      }
      if (!delivered) {
        const n = (this.failures.get(e.id) ?? 0) + 1;
        this.failures.set(e.id, n);
        if (n < 3) break; // retry this event on the next pass
        log.warn({ event: e.id }, 'giving up on event after 3 failed deliveries');
      }
      this.failures.delete(e.id);
      this.seenEvents.add(e.id);
      this.eventsCp = Math.max(this.eventsCp, e.id);
    }
    this.seenEvents.prune(this.eventsCp - LOOKBACK_IDS);
    await store.setSetting(SETTINGS.eventsCheckpoint, { id: this.eventsCp }, { notify: false });
  }

  // ------------------------------------------------------------------------------- daily summary
  async processDailySummary(): Promise<void> {
    if (!this.initialized) return;
    const now = this.now();
    const today = localDate(now, this.cfg.tz);
    if (this.lastSummaryDate === today || localHour(now, this.cfg.tz) < this.cfg.dailySummaryHour) return;
    const { store } = this.deps;
    const since = new Date(now.getTime() - 86_400_000);
    const [pnl, status, errors] = await Promise.all([store.pnlSummary(since), store.getStatus(startOfLocalDay(now, 'UTC')), store.countEventsSince(since, 'error')]);
    const ctx = { ...(await this.fmtCtx()), ethUsd: status.ethUsd };
    if (!(await this.push(dailySummaryMessage(pnl, status, errors, ctx)))) return;
    this.lastSummaryDate = today;
    await store.setSetting(SETTINGS.dailySummaryLast, today, { notify: false });
  }
}

/** Short text for agent run events (summary + report path) instead of a JSON dump. */
function agentEventHtml(e: EventRow): string | null {
  if (!(e.type in AGENT_FINISH_KIND)) return null;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const title = e.type === 'scout_finished' ? 'Scout finished' : e.type === 'backtest_finished' ? 'Backtest finished' : 'Agent run finished';
  const parts = [`<b>${title}</b>${typeof p.runId === 'number' ? ` run #${p.runId}` : ''}${typeof p.costUsd === 'number' ? ` · $${p.costUsd.toFixed(2)}` : ''}`];
  if (typeof p.summary === 'string' && p.summary) parts.push(escapeHtml(p.summary.slice(0, 1500)));
  if (typeof p.reportPath === 'string') parts.push(`report: <code>${escapeHtml(p.reportPath)}</code>`);
  if (Array.isArray(p.playIds) && p.playIds.length) parts.push(`proposed: ${p.playIds.map((i) => `#${String(i)}`).join(', ')}`);
  return parts.join('\n');
}

/** `{"op":"UPDATE","key":"kill_switch"}` → "kill_switch"; null when the payload has no key. */
export function settingsKeyFromPayload(payload: string): string | null {
  try {
    const v = JSON.parse(payload) as unknown;
    return v && typeof v === 'object' && typeof (v as Record<string, unknown>).key === 'string' ? ((v as Record<string, unknown>).key as string) : null;
  } catch {
    return null;
  }
}

/** NOTIFY snipe_events payloads: `{"id":12}`, `{"snipeId":12,...}`, `12`, or anything else (ignored). */
export function snipeIdsFromPayload(payload: string): number[] {
  const s = payload.trim();
  if (/^\d+$/.test(s)) return [Number(s)];
  try {
    const v = JSON.parse(s) as unknown;
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return [o.id, o.snipeId].filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0);
  } catch {
    return [];
  }
}

