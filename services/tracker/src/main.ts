/** tracker service entry point: `pnpm --filter @hood/tracker start` */
import { TRANSFERS_CHANNEL, createDb, errMsg, listen, startHealthServer } from '@hood/indexer';
import pino from 'pino';
import { parseTrackerEnv } from './env.js';
import { PgTrackerStore } from './store.js';
import { Tracker } from './tracker.js';

async function main(): Promise<void> {
  const env = parseTrackerEnv(process.env);
  const log = pino({ name: 'tracker', level: env.LOG_LEVEL });
  const sql = createDb(env.DATABASE_URL);
  const tracker = new Tracker(new PgTrackerStore(sql), log, {
    contractMaxAgeBlocks: env.CONTRACT_MAX_AGE_BLOCKS,
    sweepIntervalMs: env.SWEEP_INTERVAL_MS,
    pollMs: env.POLL_MS,
    initialLookbackBlocks: env.INITIAL_LOOKBACK_BLOCKS,
    unknownNonceIsFresh: env.UNKNOWN_NONCE_IS_FRESH,
  });
  await tracker.init();

  const unlistenTransfers = await listen(sql, TRANSFERS_CHANNEL, (payload) => {
    const n = Number(payload);
    if (Number.isInteger(n)) void tracker.onBlock(n);
  });
  const unlistenPlays = await listen(sql, 'plays_changed', () => {
    tracker.reloadPlays().catch((err: unknown) => log.error({ err: errMsg(err) }, 'reload plays failed'));
  });
  tracker.stats.listening = true;

  const safe = (what: string, fn: () => Promise<unknown>) => () => {
    fn().catch((err: unknown) => {
      tracker.stats.errors++;
      log.error({ err: errMsg(err) }, `${what} failed`);
    });
  };
  const sweepTimer = setInterval(safe('sweep', async () => {
    await tracker.reloadPlays();
    await tracker.sweep();
  }), env.SWEEP_INTERVAL_MS);
  const pollTimer = setInterval(safe('poll', () => tracker.poll()), env.POLL_MS);
  await tracker.poll();
  await tracker.sweep();

  const server = startHealthServer(env.HEALTH_PORT, () => {
    const s = tracker.stats;
    const sweepFresh = s.lastSweepAt !== null && Date.now() - s.lastSweepAt < env.SWEEP_INTERVAL_MS * 3;
    return { ok: s.listening && sweepFresh, ...s };
  });
  log.info({ port: env.HEALTH_PORT, plays: tracker.plays.length }, 'tracker running');

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    clearInterval(sweepTimer);
    clearInterval(pollTimer);
    server.close();
    await unlistenTransfers().catch(() => {});
    await unlistenPlays().catch(() => {});
    await sql.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
