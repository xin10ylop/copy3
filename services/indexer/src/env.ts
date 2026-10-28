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
const int = (def: number) => z.preprocess(blankToUndef, z.coerce.number().int().min(0).default(def));

export const IndexerEnvSchema = z.object({
  NODE_WS: z.preprocess(blankToUndef, url(['ws:', 'wss:']).optional()),
  NODE_HTTP: url(['http:', 'https:']),
  DATABASE_URL: z.string().min(1),
  START_BLOCK: z.preprocess(blankToUndef, z.coerce.number().int().min(0).optional()),
  TRACE_INTERNAL: bool,
  CONFIRMATIONS: int(0),
  REORG_DEPTH: int(10),
  /** spacing between RPC calls; 0 for an own node, >=150 for the public RPC */
  RPC_MIN_INTERVAL_MS: int(0),
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
