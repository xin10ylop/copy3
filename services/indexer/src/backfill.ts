/**
 * Backfill CLI:
 *   pnpm --filter @hood/indexer backfill --from <block> --to <block>
 *   pnpm --filter @hood/indexer backfill --since-days 3
 * Env: NODE_HTTP, DATABASE_URL, RPC_MIN_INTERVAL_MS (default 150), TRACE_INTERNAL (blocks mode).
 */
import pino from 'pino';
import { LogBackfill, blockBackfill } from './backfill-core.js';
import { BACKFILL_USAGE, parseBackfillArgs } from './backfill-args.js';
import { Chain } from './chain.js';
import { MemoryStore } from './memory-store.js';
import { PgStore } from './pg-store.js';
import { BlockPipeline } from './pipeline.js';
import { HttpRpc } from './rpc.js';
import type { IndexerStore } from './store.js';
import { createDb } from '@hood/db';

async function main(): Promise<void> {
  let args;
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(BACKFILL_USAGE);
    process.exit(2);
  }
  const log = pino({ name: 'indexer-backfill', level: process.env.LOG_LEVEL ?? 'info' });
  const nodeHttp = process.env.NODE_HTTP ?? 'https://rpc.mainnet.chain.robinhood.com';
  const rpc = new HttpRpc(nodeHttp, {
    minIntervalMs: Number(process.env.RPC_MIN_INTERVAL_MS ?? 150),
    onRetry: (i) => log.debug(i, 'rpc retry'),
  });
  const chain = new Chain(rpc);
  const sql = args.dryRun ? null : createDb(process.env.DATABASE_URL ?? '');
  if (!args.dryRun && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (or pass --dry-run)');
  const store: IndexerStore = sql ? new PgStore(sql) : new MemoryStore();

  const head = await chain.blockNumber();
  const to = args.to === 'latest' ? head : args.to;
  const from =
    args.from ?? (await chain.blockAtOrAfter(Math.floor(Date.now() / 1000 - (args.sinceDays ?? 1) * 86_400), 0, to));
  log.info({ from, to, mode: args.mode, chunk: args.chunk, rpc: nodeHttp }, 'backfill start');

  const pipeline = new BlockPipeline(chain, store, log, {
    traceInternal: process.env.TRACE_INTERNAL === '1',
  });
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  process.once('SIGTERM', () => ac.abort());
  try {
    if (args.mode === 'blocks') {
      const done = await blockBackfill(pipeline, from, to, log, ac.signal);
      log.info({ from, to, blocks: done }, 'block backfill done');
    } else {
      const bf = new LogBackfill(chain, store, pipeline, log, {
        from,
        to,
        chunk: args.chunk,
        tokenTransfers: args.tokenTransfers,
        tokenWindowSec: args.tokenWindowHours * 3600,
        addressBatch: args.addressBatch,
      });
      const stats = await bf.run(ac.signal);
      log.info({ from, to, ...stats }, 'log backfill done');
    }
  } finally {
    await sql?.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
