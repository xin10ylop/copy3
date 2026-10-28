/** Sniper entry point: env → store, chain, clock, backend (live|paper) → feed loop + /healthz. */
import { readFileSync } from 'node:fs';
import { CHAIN_ID, FeedClient, SequencerClock, parsePlay, type Play } from '@hood/core';
import { parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemChain } from './chain.js';
import { executorKeys, loadConfig, redactedConfig } from './config.js';
import { LaunchDetector } from './detector.js';
import { LiveExecutor, type ExecutionBackend } from './executor.js';
import { installCrashGuards } from './guards.js';
import { startHealthServer } from './health.js';
import { createLogger } from './log.js';
import { PaperExecutor } from './paper.js';
import { liveStartupChecks } from './preflight.js';
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

  // `sniper` is referenced lazily by callbacks (backends, crash guards)
  // eslint-disable-next-line prefer-const
  let sniper: Sniper | undefined;
  installCrashGuards(logger, (kind, err) => sniper?.alert('process_error', { kind, err: err instanceof Error ? err.message : String(err) }, 'error'));

  const store: SniperStore = cfg.DATABASE_URL ? PgStore.fromUrl(cfg.DATABASE_URL) : new MemoryStore({ plays: loadPlaysFile(cfg.PLAYS_FILE) });
  const chain = new ViemChain({ httpUrl: cfg.NODE_HTTP || cfg.PUBLIC_RPC, ...(cfg.NODE_WS ? { wsUrl: cfg.NODE_WS } : {}) });
  const clock = new SequencerClock({ windowMs: cfg.CLOCK_WINDOW_MS });
  const scheduler = new PreciseScheduler(cfg.SPIN_MS);
  const senders = cfg.SEND_ENDPOINTS.map((u) => new JsonRpcHttp(u));
  const rttMs = (): number => (cfg.RTT_MS > 0 ? cfg.RTT_MS : (senders[0]?.rttMs ?? 30));
  const sniperContract = cfg.SNIPER_CONTRACT ? (cfg.SNIPER_CONTRACT.toLowerCase() as Address) : undefined;

  let live: LiveExecutor | null = null;
  let backend: ExecutionBackend;
  if (cfg.EXECUTION_MODE === 'live') {
    const accounts = executorKeys(cfg).map((k) => privateKeyToAccount(k));
    live = new LiveExecutor({
      accounts,
      sniper: sniperContract!,
      chainId: CHAIN_ID,
      senders,
      chain,
      scheduler,
      logger,
      blockTs: (n) => sniper?.blockTimestamp(n),
      receiptPollMs: cfg.BURST_RECEIPT_POLL_MS,
      exitReceiptTimeoutMs: cfg.EXIT_RECEIPT_TIMEOUT_MS,
      minGasBalanceWei: parseEther(String(cfg.MIN_GAS_BALANCE_ETH)),
      fillerMaxFeeGwei: cfg.MAX_GAS_PRICE_GWEI,
      onFinal: (run) => sniper?.recorder.snipe(run, sniper.positions.get(run.key), 'burst_final'),
      onAlert: (type, payload) => sniper?.alert(type, payload, 'error'),
    });
    if (live.burstKeys.length === 1 && live.burstKeys[0] === live.exitKey)
      logger.warn('single executor key: exits and bursts share one nonce sequence and serialise (set EXECUTOR_PRIVATE_KEYS=exitKey,burstKey1,…)');
    if (cfg.MAX_CONCURRENT > live.burstKeys.length)
      logger.warn({ maxConcurrent: cfg.MAX_CONCURRENT, burstKeys: live.burstKeys.length }, 'fewer burst keys than MAX_CONCURRENT: concurrent bursts beyond the key count are refused');
    await live.init();

    // live-mode gate: cold owner, operators, factory, L6 gas estimate
    const plays = (await store.loadPlays()).filter((p) => p.enabled);
    const gate = await liveStartupChecks({
      chain,
      sniper: sniperContract!,
      keys: live.keys.map((k) => k.address),
      estimateFrom: live.burstKeys[0]!.address,
      gasLimit: plays.length ? Math.min(...plays.map((p) => p.preset.gasLimit)) : 300_000,
      ...(plays.length ? { maxBuyEth: Math.max(...plays.map((p) => p.preset.buyEth)) } : {}),
      allowHotOwner: cfg.ALLOW_HOT_OWNER,
      gasCheck: cfg.GAS_CHECK,
      lookbackBlocks: cfg.GAS_CHECK_LOOKBACK_BLOCKS,
    });
    for (const w of gate.warnings) logger.warn(w);
    if (!gate.ok) {
      logger.fatal({ errors: gate.errors, gasEstimate: gate.gasEstimate?.toString() }, 'live startup checks failed: refusing to start');
      process.exit(1);
    }
    logger.info({ gasEstimate: gate.gasEstimate?.toString(), keys: live.keys.map((k) => `${k.role}:${k.address}`) }, 'live startup checks passed');
    backend = live;
  } else {
    backend = new PaperExecutor({
      chain,
      logger,
      book: (c) => sniper?.positions.book(c) ?? null,
      creatorTaxBps: (c) => sniper?.creatorTaxBps(c) ?? 0,
      fill: cfg.PAPER_FILL,
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
    detector: new LaunchDetector({ prediction: cfg.ADDRESS_PREDICTION, maxLaunchAgeMs: cfg.MAX_LAUNCH_AGE_MS, launchers: cfg.LAUNCHERS }),
    rttMs,
    maxConcurrent: cfg.MAX_CONCURRENT,
    dailyLossLimitEth: cfg.DAILY_LOSS_LIMIT_ETH,
    maxGasPriceGwei: cfg.MAX_GAS_PRICE_GWEI,
    deadlineBlocks: cfg.DEADLINE_BLOCKS,
    addressTimeoutMs: cfg.ADDRESS_TIMEOUT_MS,
    receiptPollMs: cfg.RECEIPT_POLL_MS,
    reservesPollMs: cfg.RESERVES_POLL_MS,
    reconcileMs: cfg.RECONCILE_MS,
    maxExitRounds: cfg.EXIT_MAX_ROUNDS,
    exitBackoffMs: cfg.EXIT_BACKOFF_MS,
    ...(sniperContract && cfg.EXECUTION_MODE === 'live' ? { sniperContract } : {}),
    nonce: () => live?.nonces.value ?? null,
  });
  const s = sniper;
  await s.start();

  const feed = new FeedClient({ urls: [cfg.FEED_URL, ...cfg.FEED_URL_SECONDARY] });
  feed.on('block', (b) => s.onFeedBlock(b));
  feed.on('gap', (g) => logger.warn(g, 'feed gap'));
  feed.on('reset', (r) => logger.warn(r, 'feed sequence reset'));
  feed.on('connected', (url) => logger.info({ url }, 'feed connected'));
  feed.on('disconnected', (d) => logger.warn(d, 'feed disconnected'));
  feed.on('error', (e) => logger.warn({ err: e }, 'feed error'));
  feed.start();

  const pinger = setInterval(() => {
    for (const x of senders) x.ping().catch(() => undefined);
  }, 5000);
  for (const x of senders) x.ping().catch(() => undefined);
  const balances = live
    ? setInterval(() => {
        live!.refreshBalances().catch((e: unknown) => logger.warn({ err: e }, 'balance refresh failed'));
      }, cfg.BALANCE_POLL_MS)
    : null;
  const health = startHealthServer(cfg.HEALTH_PORT, () => s.health(feed.stats.snapshot()));
  logger.info({ mode: cfg.EXECUTION_MODE, port: cfg.HEALTH_PORT, exitKey: live?.exitKey.address, burstKeys: live?.burstKeys.map((k) => k.address) }, 'sniper running');

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    clearInterval(pinger);
    if (balances) clearInterval(balances);
    feed.stop();
    health.close();
    await s.stop();
    await store.close();
    senders.forEach((x) => x.close());
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT').catch(() => process.exit(1)));
  process.on('SIGTERM', () => void shutdown('SIGTERM').catch(() => process.exit(1)));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
