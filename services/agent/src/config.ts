import { z } from 'zod';
import type { NightlyOptions } from './autopilot.js';
import { DEFAULT_LIMITS } from './defaults.js';

const csv = z
  .string()
  .optional()
  .transform((s) =>
    (s ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter((x) => /^0x[0-9a-f]{40}$/.test(x)),
  );

export const AgentEnvSchema = z.object({
  /** Optional: the SDK also resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile. */
  ANTHROPIC_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  NODE_HTTP: z.string().url().optional(),
  REPORTS_DIR: z.string().default('./reports'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  AGENT_MAX_ROUNDS: z.coerce.number().int().min(1).max(200).default(DEFAULT_LIMITS.maxRounds),
  AGENT_MAX_COST_USD: z.coerce.number().positive().max(200).default(DEFAULT_LIMITS.maxCostUsd),
  SCOUT_INTERVAL_MIN: z.coerce.number().positive().max(24 * 60).default(15),
  SCOUT_SINCE_MIN: z.coerce.number().int().positive().max(7 * 24 * 60).optional(),
  SCOUT_MIN_PEAK10_PCT: z.coerce.number().min(0).default(100),
  SCOUT_MAX_CLUSTERS: z.coerce.number().int().min(0).max(20).default(2),
  SCOUT_MIN_CLUSTER_SIZE: z.coerce.number().int().min(1).max(20).default(2),
  SCOUT_IGNORE: csv,
  AGENT_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(9470),
  /** `serve`: hour (UTC) of the nightly refit / auto-disable / blacklist job; -1 = off */
  NIGHTLY_HOUR_UTC: z.coerce.number().int().min(-1).max(23).default(3),
  /** look-back of the nightly refit backtest, days */
  REFIT_DAYS: z.coerce.number().positive().max(60).default(3),
  /** minimum simulated snipes for a refit (and for a refit-based disable) */
  REFIT_MIN_COINS: z.coerce.number().int().min(1).default(20),
  /** a refit preset must beat the current one by more than this, ETH per snipe */
  REFIT_MARGIN_ETH: z.coerce.number().min(0).default(0.0005),
  /** rolling window of realised snipes (paper or live) for the auto-disable */
  ROLLING_TRADES: z.coerce.number().int().min(1).max(500).default(30),
  /** realised snipes needed before the rolling expectancy can disable a play */
  DISABLE_MIN_TRADES: z.coerce.number().int().min(1).default(10),
  /** generic plays: blacklist operators whose last N matching launches all lost */
  BLACKLIST_MIN_LAUNCHES: z.coerce.number().int().min(2).default(5),
});

export type AgentEnv = z.infer<typeof AgentEnvSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const r = AgentEnvSchema.safeParse(env);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
    throw new Error(`invalid agent environment (${problems})`);
  }
  return r.data;
}

/** Nightly job options (autopilot.ts) from the environment. */
export function nightlyOptions(env: AgentEnv): Partial<NightlyOptions> {
  return {
    refitDays: env.REFIT_DAYS,
    minCoins: env.REFIT_MIN_COINS,
    marginEth: env.REFIT_MARGIN_ETH,
    rollingTrades: env.ROLLING_TRADES,
    minTrades: env.DISABLE_MIN_TRADES,
    blacklistMinLaunches: env.BLACKLIST_MIN_LAUNCHES,
  };
}
