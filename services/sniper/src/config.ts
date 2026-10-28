/** Sniper environment config (zod-validated). Every variable is documented in README.md. */
import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const num = (d: number) => z.coerce.number().default(d);

export const ConfigSchema = z
  .object({
    EXECUTION_MODE: z.enum(['live', 'paper']).default('paper'),
    FEED_URL: z.string().default('wss://feed.mainnet.chain.robinhood.com'),
    /** comma list of extra feeds tried in order after FEED_URL fails */
    FEED_URL_SECONDARY: csv,
    NODE_HTTP: z.string().default(''),
    NODE_WS: z.string().default(''),
    PUBLIC_RPC: z.string().default('https://rpc.mainnet.chain.robinhood.com'),
    /** comma list; first = primary (used for RTT measurement and nonce reads) */
    SEND_ENDPOINTS: csv,
    DATABASE_URL: z.string().default(''),
    /** optional JSON file with plays (array of Play) for DB-less paper runs */
    PLAYS_FILE: z.string().default(''),
    EXECUTOR_PRIVATE_KEY: z.string().default(''),
    SNIPER_CONTRACT: z.string().default(''),
    MAX_GAS_PRICE_GWEI: num(1),
    DAILY_LOSS_LIMIT_ETH: num(0.5),
    MAX_CONCURRENT: num(3),
    /** fixed RTT to the sequencer (ms); 0 = measure against the primary send endpoint */
    RTT_MS: num(0),
    /** L2 blocks after the launch block after which burst txs revert with Expired() */
    DEADLINE_BLOCKS: num(40),
    HEALTH_PORT: num(8081),
    LOG_LEVEL: z.string().default('info'),
    /** none (wait for TokenLaunched/receipt) | nonce (CREATE prediction; Pons V2 uses CREATE2 → wrong) */
    ADDRESS_PREDICTION: z.enum(['none', 'nonce']).default('none'),
    RESERVES_POLL_MS: num(500),
    RECEIPT_POLL_MS: num(20),
    /** stop waiting for TokenLaunched after this long */
    ADDRESS_TIMEOUT_MS: num(1500),
    CLOCK_WINDOW_MS: num(120_000),
    /** busy-wait this long before each scheduled send for sub-ms accuracy */
    SPIN_MS: num(1.5),
    /** sniper ignores launches whose feed block arrived later than this after the block second */
    MAX_LAUNCH_AGE_MS: num(2500),
  })
  .superRefine((c, ctx) => {
    if (c.EXECUTION_MODE === 'live') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(c.EXECUTOR_PRIVATE_KEY))
        ctx.addIssue({ code: 'custom', path: ['EXECUTOR_PRIVATE_KEY'], message: 'live mode needs a 0x-prefixed 32-byte key' });
      if (!/^0x[0-9a-fA-F]{40}$/.test(c.SNIPER_CONTRACT))
        ctx.addIssue({ code: 'custom', path: ['SNIPER_CONTRACT'], message: 'live mode needs the PonsSniper address' });
      if (c.SEND_ENDPOINTS.length === 0)
        ctx.addIssue({ code: 'custom', path: ['SEND_ENDPOINTS'], message: 'live mode needs at least one send endpoint' });
      if (!c.DATABASE_URL)
        ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'live mode records every snipe; DATABASE_URL required' });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = ConfigSchema.parse(env);
  if (cfg.SEND_ENDPOINTS.length === 0) cfg.SEND_ENDPOINTS = [cfg.NODE_HTTP || cfg.PUBLIC_RPC];
  return cfg;
}

/** Config with the secret redacted, for logs and /healthz. */
export function redactedConfig(c: Config): Record<string, unknown> {
  return { ...c, EXECUTOR_PRIVATE_KEY: c.EXECUTOR_PRIVATE_KEY ? '<set>' : '', DATABASE_URL: c.DATABASE_URL ? '<set>' : '' };
}
