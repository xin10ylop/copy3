/** Sniper entry point: env → store, chain, clock, backend (live|paper|probe) → feed loop + /healthz. */
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
import { LiveGate, liveStartupChecks, probeStartupChecks } from './preflight.js';
import { ProbeExecutor } from './probe.js';
import { RaceTracker } from './race.js';
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
  // receipts are raced against the sequencer's own RPC: a launcher-contract launch is built from its receipt
  const chain = new ViemChain({ httpUrl: cfg.NODE_HTTP || cfg.PUBLIC_RPC, ...(cfg.NODE_WS ? { wsUrl: cfg.NODE_WS } : {}), receiptUrls: [cfg.PUBLIC_RPC] });
  const clock = new SequencerClock({ windowMs: cfg.CLOCK_WINDOW_MS });
  const scheduler = new PreciseScheduler(cfg.SPIN_MS);
  const senders = cfg.SEND_ENDPOINTS.map((u) => new JsonRpcHttp(u));
  const rttMs = (): number => (cfg.RTT_MS > 0 ? cfg.RTT_MS : (senders[0]?.rttMs ?? 30));
  const sniperContract = cfg.SNIPER_CONTRACT ? (cfg.SNIPER_CONTRACT.toLowerCase() as Address) : undefined;

  const race = new RaceTracker({ chain, logger });
  let live: LiveExecutor | null = null;
  let probe: ProbeExecutor | null = null;
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
      exitKeys: cfg.EXIT_KEYS,
      fillerMaxFeeGwei: cfg.MAX_GAS_PRICE_GWEI,
      // N7: member statuses are final — update the run's row, never insert a second one
      onFinal: (run) => sniper?.recorder.update(run, sniper.positions.get(run.key), 'burst_final'),
      onAlert: (type, payload) => sniper?.alert(type, payload, 'error'),
    });
    if (live.burstKeys.length === 1 && live.burstKeys[0] === live.exitKey)
      logger.warn('single executor key: exits and bursts share one nonce sequence and serialise (set EXECUTOR_PRIVATE_KEYS=exitKey,burstKey1,…)');
    if (cfg.MAX_CONCURRENT > live.burstKeys.length)
      logger.warn({ maxConcurrent: cfg.MAX_CONCURRENT, burstKeys: live.burstKeys.length }, 'fewer burst keys than MAX_CONCURRENT: concurrent bursts beyond the key count are refused');
    await live.init();
    backend = live;
  } else {
    const paper = new PaperExecutor({
      chain,
      logger,
      book: (c) => sniper?.positions.book(c) ?? null,
      creatorTaxBps: (c) => sniper?.creatorTaxBps(c) ?? 0,
      fill: cfg.PAPER_FILL,
    });
    backend = paper;
    if (cfg.EXECUTION_MODE === 'probe') {
      // paper fills + one 0-value self-transfer per planned burst (never a contract call)
      probe = new ProbeExecutor({
        paper,
        accounts: executorKeys(cfg).map((k) => privateKeyToAccount(k)),
        chainId: CHAIN_ID,
        senders,
        chain,
        scheduler,
        logger,
        race,
        receiptPollMs: cfg.BURST_RECEIPT_POLL_MS,
        receiptTimeoutMs: cfg.PROBE_RECEIPT_TIMEOUT_MS,
        minGasBalanceWei: parseEther(String(cfg.MIN_GAS_BALANCE_ETH)),
        onProbe: (run) => sniper?.recorder.update(run, sniper.positions.get(run.key), 'probe_final'),
        onAlert: (type, payload) => sniper?.alert(type, payload, 'error'),
      });
      probe.setGate('probe startup checks have not passed yet');
      await probe.init();
      backend = probe;
    }
  }

  sniper = new Sniper({
    // probe mode is paper mode for the orchestrator (paper rows, paper risk, paper bankroll)
    mode: cfg.EXECUTION_MODE === 'live' ? 'live' : 'paper',
    race,
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
    dailyLossLimitPct: cfg.DAILY_LOSS_LIMIT_PCT,
    paperBankrollEth: cfg.PAPER_BANKROLL_ETH,
    maxGasPriceGwei: cfg.MAX_GAS_PRICE_GWEI,
    deadlineBlocks: cfg.DEADLINE_BLOCKS,
    repriceLeadMs: cfg.REPRICE_LEAD_MS,
    addressTimeoutMs: cfg.ADDRESS_TIMEOUT_MS,
    receiptPollMs: cfg.RECEIPT_POLL_MS,
    reservesPollMs: cfg.RESERVES_POLL_MS,
    reconcileMs: cfg.RECONCILE_MS,
    maxExitRounds: cfg.EXIT_MAX_ROUNDS,
    exitBackoffMs: cfg.EXIT_BACKOFF_MS,
    maxExitBackoffMs: cfg.EXIT_MAX_BACKOFF_MS,
    stuckRearmMs: cfg.STUCK_REARM_MS,
    settingsReloadMs: cfg.SETTINGS_RELOAD_MS,
    playsReloadMs: cfg.PLAYS_RELOAD_MS,
    feedBlocksRetentionDays: cfg.FEED_BLOCKS_RETENTION_DAYS,
    sweepLookbackBlocks: cfg.SWEEP_LOOKBACK_BLOCKS,
    sweepIntervalMs: cfg.SWEEP_INTERVAL_MS,
    paperLimits: {
      maxQuoteIn: parseEther(String(cfg.PAPER_MAX_QUOTE_IN_ETH)),
      maxSpend: parseEther(String(cfg.PAPER_MAX_SPEND_PER_WINDOW_ETH ?? cfg.PAPER_MAX_QUOTE_IN_ETH * 4)),
      spendWindow: cfg.PAPER_SPEND_WINDOW_SEC,
    },
    ...(sniperContract && cfg.EXECUTION_MODE === 'live' ? { sniperContract } : {}),
    nonce: () => live?.nonces.value ?? null,
  });
  const s = sniper;
  // N1: the live gate runs AFTER the startup reconciliation (positions are managed whatever it
  // says) and only blocks new entries while it fails; it retries every GATE_RETRY_MS
  let gate: LiveGate | null = null;
  if (live) s.risk.blockEntries('live startup checks have not passed yet');
  await s.start();
  if (live) {
    const exec = live;
    const gateInput = async (gasCheck: boolean): Promise<Parameters<typeof liveStartupChecks>[0]> => {
      const plays = (await store.loadPlays()).filter((p) => p.enabled);
      const fixed = plays.filter((p) => p.preset.sizing.mode !== 'bankroll').map((p) => p.preset.buyEth);
      const bankroll = plays.filter((p) => p.preset.sizing.mode === 'bankroll').map((p) => p.preset.sizing.maxEth);
      return {
        chain,
        sniper: sniperContract!,
        keys: exec.keys.map((k) => k.address),
        estimateFrom: exec.burstKeys[0]!.address,
        exitFrom: exec.exitKey.address,
        gasLimit: plays.length ? Math.min(...plays.map((p) => p.preset.gasLimit)) : 300_000,
        // fixed presets above maxQuoteIn are refused; bankroll sizes are clamped to it (NEW-6)
        ...(fixed.length ? { maxBuyEth: Math.max(...fixed), fixedBuysEth: fixed } : {}),
        ...(bankroll.length ? { maxBankrollEth: Math.max(...bankroll) } : {}),
        allowHotOwner: cfg.ALLOW_HOT_OWNER,
        gasCheck,
        lookbackBlocks: cfg.GAS_CHECK_LOOKBACK_BLOCKS,
      };
    };
    gate = new LiveGate({
      logger,
      retryMs: cfg.GATE_RETRY_MS,
      refreshMs: cfg.GATE_REFRESH_MS,
      check: async () => liveStartupChecks(await gateInput(cfg.GAS_CHECK)),
      // NEW-8: the contract config (maxQuoteIn, spend budget, owner, operators) is re-read while passing
      refresh: async () => liveStartupChecks(await gateInput(false)),
      onResult: (r) => {
        if (r.maxQuoteIn !== null) s.setContractLimits({ maxQuoteIn: r.maxQuoteIn, spend: r.spend ?? null });
        if (r.ok) s.risk.blockEntries(null);
        else {
          s.risk.blockEntries(`live gate: ${r.errors.join('; ')}`);
          s.alert('live_gate_failed', { errors: r.errors }, 'error');
        }
      },
    });
    void gate.run(); // never rejects; the feed starts right away (positions need it)
  }

  if (probe) {
    // probe gate: every probe key funded (no contract involved); failing → probes skipped, paper goes on
    const p = probe;
    gate = new LiveGate({
      logger,
      label: 'probe gate',
      failing: 'probes skipped',
      retryMs: cfg.GATE_RETRY_MS,
      check: () => probeStartupChecks({ chain, keys: p.keys.map((k) => k.address), minBalanceWei: parseEther(String(cfg.MIN_GAS_BALANCE_ETH)) }),
      onResult: (r) => {
        p.setGate(r.ok ? null : r.errors.join('; '));
        if (!r.ok) s.alert('probe_gate_failed', { errors: r.errors }, 'error');
      },
    });
    void gate.run();
  }

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
  const balanced = live ?? probe;
  const balances = balanced
    ? setInterval(() => {
        balanced.refreshBalances().catch((e: unknown) => logger.warn({ err: e }, 'balance refresh failed'));
      }, cfg.BALANCE_POLL_MS)
    : null;
  const health = startHealthServer(cfg.HEALTH_PORT, () => s.health(feed.stats.snapshot()));
  logger.info(
    { mode: cfg.EXECUTION_MODE, port: cfg.HEALTH_PORT, exitKey: live?.exitKey.address, burstKeys: live?.burstKeys.map((k) => k.address), probeKeys: probe?.keys.map((k) => k.address) },
    'sniper running',
  );

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    clearInterval(pinger);
    if (balances) clearInterval(balances);
    gate?.stop();
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
