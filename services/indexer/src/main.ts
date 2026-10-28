/** indexer service entry point: `pnpm --filter @hood/indexer start` */
import pino from 'pino';
import { Chain } from './chain.js';
import { parseIndexerEnv } from './env.js';
import { startHealthServer } from './health.js';
import { PgStore } from './pg-store.js';
import { INDEXED_TOPICS } from './pons.js';
import { BlockPipeline } from './pipeline.js';
import { HttpRpc } from './rpc.js';
import { createDb } from './stubs/db.js';
import { WsSubscriber } from './ws.js';

async function main(): Promise<void> {
  const env = parseIndexerEnv(process.env);
  const log = pino({ name: 'indexer', level: env.LOG_LEVEL });
  const sql = createDb(env.DATABASE_URL);
  const rpc = new HttpRpc(env.NODE_HTTP, {
    minIntervalMs: env.RPC_MIN_INTERVAL_MS,
    onRetry: (i) => log.debug(i, 'rpc retry'),
  });
  const chain = new Chain(rpc);
  const pipeline = new BlockPipeline(chain, new PgStore(sql), log, {
    traceInternal: env.TRACE_INTERNAL,
    confirmations: env.CONFIRMATIONS,
    reorgDepth: env.REORG_DEPTH,
    startBlock: env.START_BLOCK,
  });
  await pipeline.init();

  const ws = env.NODE_WS
    ? new WsSubscriber({
        url: env.NODE_WS,
        topics: INDEXED_TOPICS,
        onHead: (h) => pipeline.onHead(h.number),
        onLog: (l) => pipeline.onLog(l),
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
    return { ok: lag <= env.HEALTH_MAX_LAG_BLOCKS, lagBlocks: lag, ...s };
  });

  const ac = new AbortController();
  const shutdown = (sig: string) => {
    log.info({ sig }, 'shutting down');
    ac.abort();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  log.info({ traceInternal: env.TRACE_INTERNAL, ws: Boolean(env.NODE_WS), port: env.HEALTH_PORT }, 'indexer running');
  await pipeline.run(ac.signal);
  ws?.stop();
  server.close();
  await sql.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
