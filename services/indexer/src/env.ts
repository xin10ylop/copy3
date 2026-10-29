import { z } from 'zod';

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const url = (protocols: string[]) =>
  z.string().refine((s) => {
    try {
      return protocols.includes(new URL(s).protocol);
    } catch {
      return false;
    }
  }, `must be a ${protocols.join('/')} URL`);
const bool = z
  .preprocess(blankToUndef, z.enum(['0', '1', 'true', 'false']).default('0'))
  .transform((v) => v === '1' || v === 'true');
const boolDefault = (def: boolean) =>
  z
    .preprocess(blankToUndef, z.enum(['0', '1', 'true', 'false']).default(def ? '1' : '0'))
    .transform((v) => v === '1' || v === 'true');
const int = (def: number) => z.preprocess(blankToUndef, z.coerce.number().int().min(0).default(def));

export const IndexerEnvSchema = z.object({
  NODE_WS: z.preprocess(blankToUndef, url(['ws:', 'wss:']).optional()),
  NODE_HTTP: url(['http:', 'https:']),
  DATABASE_URL: z.string().min(1),
  START_BLOCK: z.preprocess(blankToUndef, z.coerce.number().int().min(0).optional()),
  /**
   * blocks: every block + receipts (ETH transfers, wallets, traces; ~2 RPC calls per block).
   * logs:   eth_getLogs ranges (launches, trades, token transfers, metrics only; ~1-3 calls/s).
   */
  INDEXER_MODE: z.preprocess(blankToUndef, z.enum(['blocks', 'logs']).default('blocks')),
  /** blocks mode only (ignored in logs mode) */
  TRACE_INTERNAL: bool,
  CONFIRMATIONS: int(0),
  REORG_DEPTH: int(10),
  /** spacing between RPC calls; 0 for an own node, >=150 for the public RPC */
  RPC_MIN_INTERVAL_MS: int(0),
  /** logs mode: at most one range per LOGS_INTERVAL_MS unless LOGS_MIN_BLOCKS are pending */
  LOGS_INTERVAL_MS: int(1000),
  LOGS_MIN_BLOCKS: int(10),
  /** logs mode: max blocks per eth_getLogs range while catching up */
  LOGS_CHUNK_BLOCKS: z.preprocess(blankToUndef, z.coerce.number().int().min(1).max(20_000).default(2000)),
  /**
   * logs mode: Transfer logs are fetched for tokens launched within this many hours. One extra
   * eth_getLogs per LOGS_ADDRESS_BATCH tokens per range: ~17 launches/h -> 6 h ~ 100 tokens.
   */
  LOGS_TOKEN_WINDOW_HOURS: int(6),
  /** logs mode: token addresses per eth_getLogs (one call per batch per range) */
  LOGS_ADDRESS_BATCH: z.preprocess(blankToUndef, z.coerce.number().int().min(1).default(100)),
  /** subscribe to newHeads on NODE_WS (logs mode can poll the head instead; the logs subscription stays) */
  WS_NEW_HEADS: boolDefault(true),
  HEALTH_PORT: int(8081),
  /** /healthz turns 503 when head - last processed block exceeds this */
  HEALTH_MAX_LAG_BLOCKS: int(600),
  LOG_LEVEL: z.preprocess(blankToUndef, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')),
});
export type IndexerEnv = z.infer<typeof IndexerEnvSchema>;

export function parseIndexerEnv(env: Record<string, string | undefined>): IndexerEnv {
  const r = IndexerEnvSchema.safeParse(env);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid indexer env: ${issues}`);
  }
  return r.data;
}
