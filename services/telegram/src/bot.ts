/**
 * The grammY bot: admin gate, commands (docs/SPEC.md §3), approve/reject buttons.
 * Every dependency is injected so tests drive it with fake updates and a fake store.
 */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Logger } from 'pino';
import { PlayTriggerSchema, PresetSchema, type Preset } from '@hood/core';
import { adminOnly, userLabel } from './auth.js';
import { escapeHtml, Links, shortAddr, startOfLocalDay } from './format.js';
import type { JobRunner } from './jobs.js';
import {
  agentResultMessage,
  approvalKeyboard,
  armedList,
  helpText,
  killMessage,
  playLine,
  playProposalCard,
  playsList,
  pnlMessage,
  positionsMessage,
  presetView,
  statusMessage,
  type ChainHeads,
  type FormatCtx,
} from './messages.js';
import { Messenger } from './messenger.js';
import { parseAddress, parseId, parseIntInRange, parsePresetAssignments, parseWatchArgs, PRESET_USAGE, tokenize, WATCH_USAGE } from './parse.js';
import type { AgentPort, AgentRunSummary, TrackerPort } from './ports.js';
import { ServiceUnavailableError } from './ports.js';
import { applyPresetAssignments, fmtValue } from './preset.js';
import type { Registry } from './registry.js';
import { parseEthUsd, reviewStatus, SETTINGS, type BotStore, type KillState, type PlayRow } from './store.js';

export interface BotConfig {
  adminIds: ReadonlySet<number>;
  tz: string;
  reportsDir: string;
  /** /preset refuses buyEth above this */
  maxBuyEth: number;
  /** /watch refuses ranges above this */
  maxWatchEth: number;
  scout: { sinceMinutes: number; minPeak10Pct: number };
}

export interface BotDeps {
  store: BotStore;
  agent: AgentPort;
  tracker: TrackerPort;
  jobs: JobRunner;
  registry: Registry;
  /** chats that receive broadcasts (notifier + kill switch) */
  notifyChatIds: readonly number[];
  links: Links;
  config: BotConfig;
  chainHeads: () => Promise<ChainHeads>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  now?: () => Date;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Agent output paths may be absolute, relative to cwd, or relative to REPORTS_DIR. */
export async function resolveReportPath(p: string | null, reportsDir: string): Promise<string | null> {
  if (!p) return null;
  const candidates = isAbsolute(p) ? [p, join(reportsDir, basename(p))] : [p, join(reportsDir, p), join(reportsDir, basename(p))];
  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) return c;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function validatePlay(p: PlayRow): string | null {
  const t = PlayTriggerSchema.safeParse(p.trigger ?? {});
  if (!t.success) return `trigger is invalid: ${t.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  const pr = PresetSchema.safeParse(p.preset ?? {});
  if (!pr.success) return `preset is invalid: ${pr.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')} (fix it with /preset)`;
  return null;
}

export interface CreatedBot {
  bot: Bot;
  /** bound to bot.api, so API transformers (tests, retries) apply to notifications too */
  messenger: Messenger;
}

export function createBot(token: string, deps: BotDeps, opts: { botInfo?: UserFromGetMe } = {}): CreatedBot {
  const { store, agent, tracker, jobs, registry, links, config, log } = deps;
  const now = deps.now ?? (() => new Date());
  const bot = new Bot(token, opts.botInfo ? { botInfo: opts.botInfo } : {});
  const messenger = new Messenger(bot.api, deps.notifyChatIds, log);

  const fmtCtx = async (): Promise<FormatCtx> => ({
    links,
    ethUsd: parseEthUsd(await store.getSetting(SETTINGS.ethUsd).catch(() => null)),
    tz: config.tz,
    now: now(),
  });
  const reply = async (ctx: Context, html: string, extra: Parameters<Messenger['send']>[2] = {}): Promise<void> => {
    if (!ctx.chat) return;
    await messenger.send(ctx.chat.id, html, extra);
  };
  const args = (ctx: Context): string[] => tokenize(typeof ctx.match === 'string' ? ctx.match : '');

  bot.use(adminOnly(config.adminIds, log));

  // ---------------------------------------------------------------------------- help / status
  bot.command(['start', 'help'], (ctx) => reply(ctx, helpText()));

  bot.command('status', async (ctx) => {
    const c = await fmtCtx();
    const [snap, heads] = await Promise.all([store.getStatus(startOfLocalDay(c.now, config.tz)), deps.chainHeads().catch(() => ({ node: null, publicRpc: null }))]);
    await reply(ctx, statusMessage(snap, heads, { ...c, ethUsd: snap.ethUsd ?? c.ethUsd }));
  });

  // ---------------------------------------------------------------------------- agent jobs
  const sendAgentResult = async (chatId: number, kind: 'play' | 'scout' | 'backtest', label: string, r: AgentRunSummary, dur: number): Promise<void> => {
    registry.markRunReported(r.runId);
    await messenger.send(chatId, agentResultMessage(kind, label, r, dur));
    for (const [what, p] of [
      ['CSV', r.csvPath],
      ['report', r.reportPath],
    ] as const) {
      const path = await resolveReportPath(p, config.reportsDir);
      if (path) {
        await messenger.sendDocument(chatId, path, `${what} · ${label}`).catch((e: unknown) => log.error({ err: e, path }, 'sendDocument failed'));
      } else if (p) {
        await messenger.send(chatId, `${escapeHtml(what)} not readable from this host: <code>${escapeHtml(p)}</code>`);
      }
    }
    for (const id of r.proposedPlayIds) {
      if (!registry.claimCard(id)) continue;
      const play = await store.getPlay(id);
      if (play) await messenger.send(chatId, playProposalCard(play, links, `${kind} run${r.runId !== null ? ` #${r.runId}` : ''}`), { reply_markup: approvalKeyboard(id) });
    }
  };

  const submitAgentJob = async (
    ctx: Context,
    kind: 'play' | 'scout' | 'backtest',
    key: string,
    label: string,
    run: () => Promise<AgentRunSummary>,
  ): Promise<void> => {
    if (!agent.available) {
      await reply(ctx, 'The agent runner is not available in this process (see the telegram service logs). Run it from the agent service instead.');
      return;
    }
    const chatId = ctx.chat!.id;
    const res = jobs.submit({
      kind,
      key,
      label,
      run,
      onDone: (r, dur) => sendAgentResult(chatId, kind, label, r, dur),
      onError: async (err, dur) => {
        const msg = err instanceof ServiceUnavailableError ? err.message : `failed after ${Math.round(dur)} s: ${errText(err)}`;
        await messenger.send(chatId, `<b>${escapeHtml(kind)} ${escapeHtml(label)}</b> ${escapeHtml(msg)}`);
      },
    });
    if (!res.ok) {
      await reply(ctx, escapeHtml(res.error));
      return;
    }
    await reply(ctx, `Started ${escapeHtml(kind)} ${escapeHtml(label)} (job #${res.id}${res.queuedBehind ? `, ${res.queuedBehind} ahead in queue` : ''}). Results arrive here when it finishes (usually a few minutes).`);
  };

  bot.command('play', async (ctx) => {
    const a = args(ctx);
    const ca = parseAddress(a[0], 'contract address');
    if (!ca.ok) return reply(ctx, `${escapeHtml(ca.error)}\nusage: /play &lt;contract address&gt;`);
    await submitAgentJob(ctx, 'play', `play:${ca.value}`, shortAddr(ca.value), () => agent.runPlayFinder({ ca: ca.value }));
  });

  bot.command('scout', async (ctx) => {
    const a = args(ctx);
    const minutes = parseIntInRange(a[0], 'minutes', 5, 7 * 1440, config.scout.sinceMinutes);
    if (!minutes.ok) return reply(ctx, `${escapeHtml(minutes.error)}\nusage: /scout [minutes] [minPeak10Pct]`);
    const peak = parseIntInRange(a[1], 'minPeak10Pct', 10, 100_000, config.scout.minPeak10Pct);
    if (!peak.ok) return reply(ctx, `${escapeHtml(peak.error)}\nusage: /scout [minutes] [minPeak10Pct]`);
    await submitAgentJob(ctx, 'scout', 'scout', `last ${minutes.value} min, peak10 ≥ ${peak.value}%`, () =>
      agent.runScout({ sinceMinutes: minutes.value, minPeak10Pct: peak.value }),
    );
  });

  bot.command('backtest', async (ctx) => {
    const id = parseId(args(ctx)[0], 'play id');
    if (!id.ok) return reply(ctx, `${escapeHtml(id.error)}\nusage: /backtest &lt;playId&gt;`);
    const play = await store.getPlay(id.value);
    if (!play) return reply(ctx, `Play #${id.value} not found.`);
    await submitAgentJob(ctx, 'backtest', `backtest:${id.value}`, `play #${id.value}`, () => agent.runBacktest({ playId: id.value }));
  });

  // ---------------------------------------------------------------------------- plays
  bot.command('plays', async (ctx) => reply(ctx, playsList(await store.listPlays(), links)));

  const setEnabled = async (ctx: Context, enabled: boolean): Promise<void> => {
    const id = parseId(args(ctx)[0], 'play id');
    if (!id.ok) return reply(ctx, `${escapeHtml(id.error)}\nusage: /play_${enabled ? 'on' : 'off'} &lt;id&gt;`);
    const play = await store.getPlay(id.value);
    if (!play) return reply(ctx, `Play #${id.value} not found.`);
    if (play.enabled === enabled) return reply(ctx, `Play #${play.id} is already ${enabled ? 'enabled' : 'disabled'}.\n${playLine(play, links)}`);
    const by = userLabel(ctx.from);
    if (enabled) {
      const invalid = validatePlay(play);
      if (invalid) return reply(ctx, `Not enabled: ${escapeHtml(invalid)}`);
    }
    const review = reviewStatus(play);
    const patch = enabled && review !== 'approved' ? { review: { status: 'approved', by, at: now().toISOString() } } : undefined;
    const updated = await store.setPlayEnabled(play.id, enabled, patch);
    await store.insertEvent({ level: 'info', source: 'telegram', type: enabled ? 'play_enabled' : 'play_disabled', payload: { playId: play.id, by } });
    await reply(ctx, `${enabled ? 'Enabled' : 'Disabled'} play #${play.id}.\n${playLine(updated ?? { ...play, enabled }, links)}`);
  };
  bot.command('play_on', (ctx) => setEnabled(ctx, true));
  bot.command('play_off', (ctx) => setEnabled(ctx, false));

  bot.command('watch', async (ctx) => {
    const parsed = parseWatchArgs(args(ctx), { maxEth: config.maxWatchEth });
    if (!parsed.ok) return reply(ctx, `${escapeHtml(parsed.error)}\nusage: ${escapeHtml(WATCH_USAGE)}`);
    const w = parsed.value;
    let preset: Preset | undefined;
    if (w.presetFromPlayId !== undefined) {
      const src = await store.getPlay(w.presetFromPlayId);
      if (!src) return reply(ctx, `preset=${w.presetFromPlayId}: play not found.`);
      const p = PresetSchema.safeParse(src.preset ?? {});
      if (!p.success) return reply(ctx, `preset=${w.presetFromPlayId}: that play's preset is invalid.`);
      preset = p.data;
    }
    let built;
    try {
      built = await tracker.buildWatchPlay({
        funder: w.funder,
        minEth: w.minEth,
        maxEth: w.maxEth,
        fresh: w.fresh,
        ...(w.name ? { name: w.name } : {}),
        ...(preset ? { preset } : {}),
      });
    } catch (err) {
      return reply(ctx, `Could not build the watch play: ${escapeHtml(errText(err))}`);
    }
    const by = userLabel(ctx.from);
    const id = await store.insertPlay({
      name: built.name,
      trigger: built.trigger,
      preset: built.preset,
      operatorId: built.operatorId,
      createdBy: `telegram:${by}`,
      enabled: false,
      stats: { review: { status: 'pending', source: 'watch', by, at: now().toISOString() } },
    });
    registry.claimCard(id);
    await store.insertEvent({ level: 'info', source: 'telegram', type: 'play_proposed', payload: { playId: id, source: 'watch', by, needsApproval: true } });
    const play = await store.getPlay(id);
    if (!play) return reply(ctx, `Play #${id} was created but could not be read back.`);
    await reply(ctx, playProposalCard(play, links, `/watch by ${by}`), { reply_markup: approvalKeyboard(id) });
  });

  bot.command('preset', async (ctx) => {
    const a = args(ctx);
    const id = parseId(a[0], 'play id');
    if (!id.ok) return reply(ctx, `${escapeHtml(id.error)}\nusage: ${escapeHtml(PRESET_USAGE)}`);
    const play = await store.getPlay(id.value);
    if (!play) return reply(ctx, `Play #${id.value} not found.`);
    if (a.length === 1) return reply(ctx, presetView(play));
    const assignments = parsePresetAssignments(a.slice(1));
    if (!assignments.ok) return reply(ctx, `${escapeHtml(assignments.error)}\nusage: ${escapeHtml(PRESET_USAGE)}`);
    const res = applyPresetAssignments(play.preset, assignments.value, { maxBuyEth: config.maxBuyEth });
    if (!res.ok) return reply(ctx, [`<b>Preset not changed</b> (play #${play.id}):`, ...res.errors.map((e) => `• ${escapeHtml(e)}`)].join('\n'));
    await store.updatePlayPreset(play.id, res.preset);
    const by = userLabel(ctx.from);
    await store.insertEvent({ level: 'info', source: 'telegram', type: 'preset_changed', payload: { playId: play.id, by, changes: res.changes } });
    const lines = [
      `<b>Preset updated</b> · play #${play.id} ${escapeHtml(play.name)}${play.enabled ? ' (enabled: the sniper reloads it on plays_changed)' : ''}`,
      ...res.changes.map((c) => `• ${escapeHtml(c.path)}: ${escapeHtml(fmtValue(c.before))} → <b>${escapeHtml(fmtValue(c.after))}</b>`),
      ...res.warnings.map((w) => `warning: ${escapeHtml(w)}`),
    ];
    await reply(ctx, lines.join('\n'));
  });

  // ---------------------------------------------------------------------------- state views
  bot.command('armed', async (ctx) => reply(ctx, armedList(await store.listArmed(25), await fmtCtx())));
  bot.command('positions', async (ctx) => reply(ctx, positionsMessage(await store.listOpenSnipes(), await fmtCtx())));
  bot.command('pnl', async (ctx) => {
    const days = parseIntInRange(args(ctx)[0], 'days', 1, 365, 1);
    if (!days.ok) return reply(ctx, `${escapeHtml(days.error)}\nusage: /pnl [days]`);
    const c = await fmtCtx();
    const since = new Date(c.now.getTime() - days.value * 86_400_000);
    await reply(ctx, pnlMessage(await store.pnlSummary(since), days.value, c));
  });

  // ---------------------------------------------------------------------------- kill switch
  const setKill = async (ctx: Context, on: boolean): Promise<void> => {
    const by = userLabel(ctx.from);
    const reason = on ? (typeof ctx.match === 'string' && ctx.match.trim() ? ctx.match.trim().slice(0, 200) : 'manual /kill') : null;
    const state: KillState = { on, reason, by, at: now().toISOString() };
    await store.setSetting(SETTINGS.killSwitch, state);
    registry.kill = state;
    await store.insertEvent({ level: on ? 'warn' : 'info', source: 'telegram', type: on ? 'kill_switch_on' : 'kill_switch_off', payload: state });
    const text = killMessage(state, by);
    await reply(ctx, text);
    await messenger.broadcast(text, {}, ctx.chat?.id);
  };
  bot.command('kill', (ctx) => setKill(ctx, true));
  bot.command('resume', (ctx) => setKill(ctx, false));

  // ---------------------------------------------------------------------------- approvals
  bot.callbackQuery(/^play:(approve|reject):(\d{1,10})$/, async (ctx) => {
    const action = ctx.match[1] as 'approve' | 'reject';
    const id = Number(ctx.match[2]);
    const by = userLabel(ctx.from);
    const play = await store.getPlay(id);
    if (!play) {
      await ctx.answerCallbackQuery({ text: `Play #${id} not found` });
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      return;
    }
    const at = now().toISOString();
    if (action === 'approve') {
      if (play.enabled) {
        await ctx.answerCallbackQuery({ text: `Play #${id} is already enabled` });
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        return;
      }
      const invalid = validatePlay(play);
      if (invalid) {
        await ctx.answerCallbackQuery({ text: `Cannot enable: ${invalid}`.slice(0, 190), show_alert: true });
        return;
      }
      const updated = (await store.setPlayEnabled(id, true, { review: { status: 'approved', by, at } })) ?? { ...play, enabled: true };
      await store.insertEvent({ level: 'info', source: 'telegram', type: 'play_approved', payload: { playId: id, by } });
      await ctx.answerCallbackQuery({ text: `Play #${id} approved and enabled` });
      await ctx
        .editMessageText(`${playProposalCard(updated, links)}\n\n<b>APPROVED</b> by ${escapeHtml(by)} - enabled`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
        .catch((e: unknown) => log.warn({ err: e }, 'edit after approve failed'));
    } else {
      const updated = (await store.setPlayEnabled(id, false, { review: { status: 'rejected', by, at } })) ?? { ...play, enabled: false };
      await store.insertEvent({ level: 'info', source: 'telegram', type: 'play_rejected', payload: { playId: id, by } });
      await ctx.answerCallbackQuery({ text: `Play #${id} rejected` });
      await ctx
        .editMessageText(`${playProposalCard(updated, links)}\n\n<b>REJECTED</b> by ${escapeHtml(by)} - stays disabled`, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
        .catch((e: unknown) => log.warn({ err: e }, 'edit after reject failed'));
    }
  });

  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery({ text: 'Unknown or expired button' }));

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) await reply(ctx, 'Unknown command. /help lists them.');
  });

  bot.catch(async (err) => {
    log.error({ err: err.error, update: err.ctx.update.update_id }, 'handler failed');
    if (err.ctx.chat) {
      await messenger.send(err.ctx.chat.id, `Command failed: ${escapeHtml(errText(err.error))}`).catch(() => undefined);
    }
    if (err.ctx.callbackQuery) await err.ctx.answerCallbackQuery({ text: 'Failed, see logs' }).catch(() => undefined);
  });

  return { bot, messenger };
}
