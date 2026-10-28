/** Sniper entry point: env → store, chain, clock, backend (live|paper) → feed loop + /healthz. */
import { readFileSync } from 'node:fs';
import { CHAIN_ID, FeedClient, SequencerClock, parsePlay, type Play } from '@hood/core';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemChain } from './chain.js';
import { loadConfig, redactedConfig } from './config.js';
import { LaunchDetector } from './detector.js';
import { LiveExecutor, type ExecutionBackend } from './executor.js';
import { startHealthServer } from './health.js';
import { createLogger } from './log.js';
import { PaperExecutor } from './paper.js';
import { JsonRpcHttp } from './rpc.js';
import { PreciseScheduler } from './scheduler.js';
import { Sniper } from './sniper.js';
import { PgStore } from './store-db.js';
import { MemoryStore, type SniperStore } from './store.js';

function loadPlaysFile(path: string): Play[] {
  if (!path) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return (Array.isArray(raw) ? raw : [raw]).map((p, i) => {
    const play = parsePlay(p);
    return { ...play, id: play.id ?? i + 1, enabled: (p as { enabled?: boolean }).enabled ?? true };
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.LOG_LEVEL);
  logger.info({ config: redactedConfig(cfg) }, 'sniper starting');

  const store: SniperStore = cfg.DATABASE_URL ? PgStore.fromUrl(cfg.DATABASE_URL) : new MemoryStore({ plays: loadPlaysFile(cfg.PLAYS_FILE) });
  const chain = new ViemChain({ httpUrl: cfg.NODE_HTTP || cfg.PUBLIC_RPC, ...(cfg.NODE_WS ? { wsUrl: cfg.NODE_WS } : {}) });
  const clock = new SequencerClock({ windowMs: cfg.CLOCK_WINDOW_MS });
  const scheduler = new PreciseScheduler(cfg.SPIN_MS);
  const senders = cfg.SEND_ENDPOINTS.map((u) => new JsonRpcHttp(u));
  const rttMs = (): number => (cfg.RTT_MS > 0 ? cfg.RTT_MS : (senders[0]?.rttMs ?? 30));

  // `sniper` is referenced lazily by the backends' callbacks
  // eslint-disable-next-line prefer-const
  let sniper: Sniper;
  let live: LiveExecutor | null = null;
  let backend: ExecutionBackend;
  if (cfg.EXECUTION_MODE === 'live') {
    live = new LiveExecutor({
      account: privateKeyToAccount(cfg.EXECUTOR_PRIVATE_KEY as Hex),
      sniper: cfg.SNIPER_CONTRACT.toLowerCase() as Address,
      chainId: CHAIN_ID,
      senders,
      chain,
      scheduler,
      logger,
      blockTs: (n) => sniper.blockTimestamp(n),
      onFinal: (run) => sniper.recorder.snipe(run, sniper.positions.get(run.key), 'burst_final'),
    });
    await live.init();
    backend = live;
  } else {
    backend = new PaperExecutor({
      chain,
      logger,
      book: (c) => sniper.positions.book(c),
      creatorTaxBps: (c) => sniper.creatorTaxBps(c),
    });
  }

  sniper = new Sniper({
    mode: cfg.EXECUTION_MODE,
    store,
    chain,
    backend,
    clock,
    scheduler,
    logger,
    detector: new LaunchDetector({ prediction: cfg.ADDRESS_PREDICTION, maxLaunchAgeMs: cfg.MAX_LAUNCH_AGE_MS }),
    rttMs,
    maxConcurrent: cfg.MAX_CONCURRENT,
    dailyLossLimitEth: cfg.DAILY_LOSS_LIMIT_ETH,
    maxGasPriceGwei: cfg.MAX_GAS_PRICE_GWEI,
    deadlineBlocks: cfg.DEADLINE_BLOCKS,
    addressTimeoutMs: cfg.ADDRESS_TIMEOUT_MS,
    receiptPollMs: cfg.RECEIPT_POLL_MS,
    reservesPollMs: cfg.RESERVES_POLL_MS,
    nonce: () => live?.nonces.value ?? null,
  });
  await sniper.start();

  const feed = new FeedClient({ urls: [cfg.FEED_URL, ...cfg.FEED_URL_SECONDARY] });
  feed.on('block', (b) => sniper.onFeedBlock(b));
  feed.on('gap', (g) => logger.warn(g, 'feed gap'));
  feed.on('connected', (url) => logger.info({ url }, 'feed connected'));
  feed.on('disconnected', (d) => logger.warn(d, 'feed disconnected'));
  feed.on('error', (e) => logger.warn({ err: e }, 'feed error'));
  feed.start();

  const pinger = setInterval(() => {
    for (const s of senders) s.ping().catch(() => undefined);
  }, 5000);
  for (const s of senders) s.ping().catch(() => undefined);
  const health = startHealthServer(cfg.HEALTH_PORT, () => sniper.health(feed.stats.snapshot()));
  logger.info({ mode: cfg.EXECUTION_MODE, port: cfg.HEALTH_PORT, executor: live?.address }, 'sniper running');

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    clearInterval(pinger);
    feed.stop();
    health.close();
    await sniper.stop();
    await store.close();
    senders.forEach((s) => s.close());
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
