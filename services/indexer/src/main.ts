/** indexer service entry point: `pnpm --filter @hood/indexer start` */
import pino from 'pino';
import { Chain } from './chain.js';
import { parseIndexerEnv } from './env.js';
import { startHealthServer } from './health.js';
import { LogFollower } from './log-follower.js';
import { PgStore } from './pg-store.js';
import { INDEXED_TOPICS } from './pons.js';
import { BlockPipeline } from './pipeline.js';
import { HttpRpc, diffCounts } from './rpc.js';
import { createDb } from '@hood/db';
import { WsSubscriber } from './ws.js';

const RPC_SUMMARY_MS = 60_000;

async function main(): Promise<void> {
  const env = parseIndexerEnv(process.env);
  const log = pino({ name: 'indexer', level: env.LOG_LEVEL });
  const sql = createDb(env.DATABASE_URL);
  const rpc = new HttpRpc(env.NODE_HTTP, {
    minIntervalMs: env.RPC_MIN_INTERVAL_MS,
    onRetry: (i) => log.debug(i, 'rpc retry'),
  });
  const chain = new Chain(rpc);
  const store = new PgStore(sql);
  const mode = env.INDEXER_MODE;
  const pipeline = new BlockPipeline(chain, store, log, {
    traceInternal: mode === 'blocks' && env.TRACE_INTERNAL,
    confirmations: env.CONFIRMATIONS,
    reorgDepth: env.REORG_DEPTH,
    startBlock: env.START_BLOCK,
  });
  await pipeline.init();
  if (mode === 'logs' && env.TRACE_INTERNAL) log.warn('TRACE_INTERNAL is ignored in INDEXER_MODE=logs (no ETH transfers are indexed)');

  const follower =
    mode === 'logs'
      ? new LogFollower(chain, store, pipeline, log, {
          confirmations: env.CONFIRMATIONS,
          reorgDepth: env.REORG_DEPTH,
          intervalMs: env.LOGS_INTERVAL_MS,
          minBlocks: env.LOGS_MIN_BLOCKS,
          chunkBlocks: env.LOGS_CHUNK_BLOCKS,
          tokenWindowSec: env.LOGS_TOKEN_WINDOW_HOURS * 3600,
          addressBatch: env.LOGS_ADDRESS_BATCH,
        })
      : null;

  const ws = env.NODE_WS
    ? new WsSubscriber({
        url: env.NODE_WS,
        topics: INDEXED_TOPICS,
        heads: env.WS_NEW_HEADS,
        onHead: (h) => (follower ? follower.onHead(h) : pipeline.onHead(h.number)),
        onLog: (l) => (follower ? follower.onLog(l) : pipeline.onLog(l)),
        onStatus: (s, detail) => {
          pipeline.stats.wsConnected = s === 'open';
          log.info({ ws: s, detail }, 'websocket status');
        },
      })
    : null;
  ws?.start();

  const server = startHealthServer(env.HEALTH_PORT, () => {
    const s = pipeline.stats;
    const lag = s.head - (s.lastBlock ?? s.next - 1);
    return {
      ok: lag <= env.HEALTH_MAX_LAG_BLOCKS,
      mode,
      lagBlocks: lag,
      ...s,
      ...(follower ? { logs: follower.stats } : {}),
      rpc: rpc.counter.snapshot(),
    };
  });

  // one line per minute with the RPC calls of that minute (the Alchemy budget)
  let prev = rpc.counter.snapshot();
  const summary = setInterval(() => {
    const cur = rpc.counter.snapshot();
    const perMin = diffCounts(prev, cur);
    prev = cur;
    const calls = Object.values(perMin).reduce((a, b) => a + b, 0);
    const s = pipeline.stats;
    log.info(
      { mode, calls, perSec: Math.round((calls / (RPC_SUMMARY_MS / 1000)) * 100) / 100, rpc: perMin, lagBlocks: s.head - (s.lastBlock ?? s.next - 1) },
      'rpc calls in the last minute',
    );
  }, RPC_SUMMARY_MS);
  summary.unref();

  const ac = new AbortController();
  const shutdown = (sig: string) => {
    log.info({ sig }, 'shutting down');
    ac.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  log.info(
    { mode, traceInternal: pipeline.cfg.traceInternal, ws: Boolean(env.NODE_WS), newHeads: env.WS_NEW_HEADS, port: env.HEALTH_PORT },
    'indexer running',
  );
  await (follower ? follower.run(ac.signal) : pipeline.run(ac.signal));
  clearInterval(summary);
  ws?.stop();
  server.close();
  await sql.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
