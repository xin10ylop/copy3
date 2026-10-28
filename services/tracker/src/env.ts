import { z } from 'zod';

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const int = (def: number) => z.preprocess(blankToUndef, z.coerce.number().int().min(0).default(def));
const bool = (def: '0' | '1') =>
  z.preprocess(blankToUndef, z.enum(['0', '1', 'true', 'false']).default(def)).transform((v) => v === '1' || v === 'true');

export const TrackerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HEALTH_PORT: int(8082),
  /** contract mode: a contract created by a funder counts for this many blocks (~1 h at 10 blocks/s) */
  CONTRACT_MAX_AGE_BLOCKS: int(36_000),
  SWEEP_INTERVAL_MS: int(60_000),
  POLL_MS: int(5_000),
  /** first start without checkpoint: also scan this many blocks before the newest transfer */
  INITIAL_LOOKBACK_BLOCKS: int(0),
  /** arm when the indexer could not read the nonce at first funding (default: no) */
  UNKNOWN_NONCE_IS_FRESH: bool('0'),
  LOG_LEVEL: z.preprocess(blankToUndef, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')),
});
export type TrackerEnv = z.infer<typeof TrackerEnvSchema>;

export function parseTrackerEnv(env: Record<string, string | undefined>): TrackerEnv {
  const r = TrackerEnvSchema.safeParse(env);
  if (!r.success) throw new Error(`invalid tracker env: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}
