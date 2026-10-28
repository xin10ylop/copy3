/**
 * Entry point: `pnpm --filter @hood/telegram start`.
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS, DATABASE_URL (+ optional, see src/env.ts).
 */
import pino from 'pino';
import { createBot } from './bot.js';
import { createDb, listen } from '@hood/db';
import { loadEnv, notifyChats } from './env.js';
import { Links } from './format.js';
import { startHealthServer } from './health.js';
import { JobRunner } from './jobs.js';
import { COMMANDS, type ChainHeads } from './messages.js';
import { Notifier } from './notifier.js';
import { Registry } from './registry.js';
import { PgStore } from './store-pg.js';
import { loadAgentPort, loadTrackerPort } from './wiring.js';

async function blockNumber(url: string | undefined): Promise<number | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(2500),
    });
    const body = (await res.json()) as { result?: string };
    return typeof body.result === 'string' ? Number.parseInt(body.result, 16) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, base: { svc: 'telegram' } });
  const sql = createDb(env.DATABASE_URL);
  const store = new PgStore(sql, (what, err) => log.warn({ err, what }, 'status query failed'));
  const [agent, tracker] = await Promise.all([loadAgentPort(log), loadTrackerPort(log)]);
  const links = new Links({ explorerUrl: env.EXPLORER_URL, gmgnChain: env.GMGN_CHAIN });
  const registry = new Registry();
  const jobs = new JobRunner({ concurrency: env.TELEGRAM_AGENT_CONCURRENCY, maxQueue: 5, log });
  const chats = notifyChats(env);
  const chainHeads = async (): Promise<ChainHeads> => {
    const [node, publicRpc] = await Promise.all([blockNumber(env.NODE_HTTP), blockNumber(env.PUBLIC_RPC)]);
    return { node, publicRpc };
  };

  const { bot, messenger } = createBot(env.TELEGRAM_BOT_TOKEN, {
    store,
    agent,
    tracker,
    jobs,
    registry,
    notifyChatIds: chats,
    links,
    chainHeads,
    log,
    config: {
      adminIds: new Set(env.TELEGRAM_ADMIN_IDS),
      tz: env.TELEGRAM_TZ,
      reportsDir: env.REPORTS_DIR,
      maxBuyEth: env.TELEGRAM_MAX_BUY_ETH,
      maxWatchEth: env.TELEGRAM_MAX_WATCH_ETH,
      scout: { sinceMinutes: env.SCOUT_SINCE_MIN, minPeak10Pct: env.SCOUT_MIN_PEAK10_PCT },
    },
  });
  await bot.init();
  log.info({ bot: bot.botInfo.username, admins: env.TELEGRAM_ADMIN_IDS.length, notifyChats: chats.length, agent: agent.available, tracker: tracker.available }, 'bot ready');
  await bot.api.setMyCommands(COMMANDS).catch((err: unknown) => log.warn({ err }, 'setMyCommands failed'));

  const notifier = new Notifier(
    {
      store,
      broadcast: (html, extra) => messenger.broadcast(html, extra),
      chatCount: chats.length,
      registry,
      activeJobKinds: () => jobs.activeKinds(),
      listen: (channel, onPayload) => listen(sql, channel, onPayload),
      log,
    },
    {
      pollMs: env.TELEGRAM_POLL_MS,
      dailySummaryHour: env.TELEGRAM_DAILY_SUMMARY_HOUR,
      tz: env.TELEGRAM_TZ,
      links,
      ignoreSources: ['telegram'],
      armedBurstLimit: 10,
    },
  );
  await notifier.start();

  const health = startHealthServer(env.HEALTH_PORT, {
    check: async () => {
      const db = await sql.query('SELECT 1 AS ok').then(() => true).catch(() => false);
      const polling = bot.isRunning();
      return { ok: db && polling, detail: { db, polling, jobs: jobs.size } };
    },
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    await bot.stop().catch(() => undefined);
    await notifier.stop().catch(() => undefined);
    await Promise.race([jobs.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    health.close();
    await sql.end().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => log.info({ username: me.username }, 'long polling started'),
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
