import { z } from 'zod';
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
