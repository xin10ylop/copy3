/**
 * Environment of the Telegram service (validated once at startup; the process exits with a
 * readable message when something is missing).
 */
import { z } from 'zod';
import { parseAdminIds } from './auth.js';
import { DEFAULT_EXPLORER_URL, DEFAULT_GMGN_CHAIN, isValidTimeZone } from './format.js';

const intIn = (min: number, max: number, def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer in [${min}, ${max}]` });
        return z.NEVER;
      }
      return n;
    });

const numIn = (min: number, max: number, def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be a number in [${min}, ${max}]` });
        return z.NEVER;
      }
      return n;
    });

const ids = (required: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      try {
        const out = parseAdminIds(v);
        if (required && out.length === 0) {
          ctx.addIssue({ code: 'custom', message: 'at least one numeric Telegram user id is required' });
          return z.NEVER;
        }
        return out;
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
        return z.NEVER;
      }
    });

export const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{20,}$/, 'expected the BotFather token, e.g. 123456:ABC-DEF…'),
  TELEGRAM_ADMIN_IDS: ids(true),
  /** chats that receive notifications; default = the admin ids (their private chats) */
  TELEGRAM_NOTIFY_CHAT_IDS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const parts = (v ?? '').split(/[\s,;]+/).filter(Boolean);
      const out: number[] = [];
      for (const p of parts) {
        if (!/^-?\d{1,16}$/.test(p)) {
          ctx.addIssue({ code: 'custom', message: `"${p}" is not a numeric chat id` });
          return z.NEVER;
        }
        out.push(Number(p));
      }
      return out;
    }),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'expected postgres://user:pass@host:5432/db'),
  REPORTS_DIR: z.string().default('./reports'),
  TELEGRAM_DAILY_SUMMARY_HOUR: intIn(0, 23, 8),
  TELEGRAM_TZ: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'UTC'))
    .refine(isValidTimeZone, 'unknown IANA time zone'),
  TELEGRAM_MAX_BUY_ETH: numIn(0, 100, 1),
  TELEGRAM_MAX_WATCH_ETH: numIn(0, 1000, 100),
  TELEGRAM_POLL_MS: intIn(500, 60_000, 5000),
  TELEGRAM_AGENT_CONCURRENCY: intIn(1, 4, 1),
  SCOUT_SINCE_MINUTES: intIn(5, 10_080, 60),
  SCOUT_MIN_PEAK10_PCT: intIn(10, 100_000, 100),
  HEALTH_PORT: intIn(0, 65_535, 8080),
  NODE_HTTP: z.string().optional(),
  PUBLIC_RPC: z.string().default('https://rpc.mainnet.chain.robinhood.com'),
  EXPLORER_URL: z.string().url().default(DEFAULT_EXPLORER_URL),
  GMGN_CHAIN: z.string().regex(/^[a-z0-9-]+$/).default(DEFAULT_GMGN_CHAIN),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`invalid telegram environment:\n${lines.join('\n')}`);
  }
  return r.data;
}

/** Notification targets: TELEGRAM_NOTIFY_CHAT_IDS, else every admin's private chat. */
export function notifyChats(env: Pick<Env, 'TELEGRAM_NOTIFY_CHAT_IDS' | 'TELEGRAM_ADMIN_IDS'>): number[] {
  return env.TELEGRAM_NOTIFY_CHAT_IDS.length > 0 ? env.TELEGRAM_NOTIFY_CHAT_IDS : env.TELEGRAM_ADMIN_IDS;
}
