/** Sniper environment config (zod-validated). Every variable is documented in README.md. */
import type { Hex } from 'viem';
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
/** optional positive number; unset or '' = undefined */
const optNum = z.preprocess((v) => (v === '' || v === undefined || v === null ? undefined : v), z.coerce.number().positive().optional());
const bool = (d: boolean) =>
  z
    .string()
    .default(d ? '1' : '0')
    .transform((s) => ['1', 'true', 'yes', 'on'].includes(s.trim().toLowerCase()));

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

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
    /** comma list of operator keys: FIRST = exit key, the rest = one burst slot each (M1) */
    EXECUTOR_PRIVATE_KEYS: csv,
    /** legacy single key (exits and bursts share one nonce sequence; not recommended) */
    EXECUTOR_PRIVATE_KEY: z.string().default(''),
    SNIPER_CONTRACT: z.string().default(''),
    /** extra launcher contracts (Pons whitelisted launchers) besides the factory and the launch router (H1) */
    LAUNCHERS: csv,
    MAX_GAS_PRICE_GWEI: num(1),
    /** fixed daily loss limit (realised live PnL, UTC day); unset = DAILY_LOSS_LIMIT_PCT of the day's starting bankroll */
    DAILY_LOSS_LIMIT_ETH: optNum,
    /** daily loss limit as % of the bankroll (contract ETH balance) at the start of the UTC day, when DAILY_LOSS_LIMIT_ETH is unset */
    DAILY_LOSS_LIMIT_PCT: z.coerce.number().positive().max(100).default(15),
    /** paper mode: starting bankroll for `sizing.mode = 'bankroll'`; grows with realised paper PnL */
    PAPER_BANKROLL_ETH: z.coerce.number().positive().default(0.1),
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
    /** launch receipt polling while confirming a launch (H1; on the decide path, one receipt) */
    RECEIPT_POLL_MS: num(20),
    /** burst / exit receipt polling (nonce-gated: one nonce read per tick + one receipt per landed member) */
    BURST_RECEIPT_POLL_MS: num(200),
    /** give up waiting for an exit receipt after this long (the round then counts as failed) */
    EXIT_RECEIPT_TIMEOUT_MS: num(10_000),
    /** stop waiting for TokenLaunched after this long */
    ADDRESS_TIMEOUT_MS: num(1500),
    CLOCK_WINDOW_MS: num(120_000),
    /** busy-wait this long before each scheduled send for sub-ms accuracy */
    SPIN_MS: num(1.5),
    /** sniper ignores launches whose feed block arrived later than this after the block second */
    MAX_LAUNCH_AGE_MS: num(2500),
    /** paper fill model: first = first in the +1 s block (optimistic), last = after its other buys (pessimistic) */
    PAPER_FILL: z.enum(['first', 'last']).default('first'),
    /** minimum gas balance per executor key; below it bursts are refused and a low_balance alert fires (L8) */
    MIN_GAS_BALANCE_ETH: num(0.001),
    /** contract / key balance refresh (off the hot path) */
    BALANCE_POLL_MS: num(5000),
    /** exit rounds (each = up to 3 attempts at widening slippage) before a position is marked stuck (H4) */
    EXIT_MAX_ROUNDS: num(3),
    /** first backoff between exit rounds; doubles per round */
    EXIT_BACKOFF_MS: num(3000),
    /** cap of that backoff for failures without an on-chain verdict (retried forever, N2) */
    EXIT_MAX_BACKOFF_MS: num(60_000),
    /** a stuck position that still holds tokens is re-armed this long after it got stuck (N2) */
    STUCK_REARM_MS: num(300_000),
    /** chain reconciliation of unresolved runs and stuck/graduated positions */
    RECONCILE_MS: num(30_000),
    /** live startup: eth_estimateGas of snipe() on a recent curve must fit the gas limit (L6) */
    GAS_CHECK: bool(true),
    GAS_CHECK_LOOKBACK_BLOCKS: num(36_000),
    /** allow an executor key to be the contract owner (M4: the owner should be a cold key) */
    ALLOW_HOT_OWNER: bool(false),
    /** allow live mode with ONE executor key (exits then queue behind bursts; N5: refused by default) */
    ALLOW_SINGLE_KEY: bool(false),
    /** retry the live gate this often while it fails (new entries blocked meanwhile, N1) */
    GATE_RETRY_MS: num(60_000),
  })
  .superRefine((c, ctx) => {
    if (c.EXECUTION_MODE === 'live') {
      const keys = c.EXECUTOR_PRIVATE_KEYS.length ? c.EXECUTOR_PRIVATE_KEYS : c.EXECUTOR_PRIVATE_KEY ? [c.EXECUTOR_PRIVATE_KEY] : [];
      if (keys.length === 0 || keys.some((k) => !KEY_RE.test(k)))
        ctx.addIssue({ code: 'custom', path: ['EXECUTOR_PRIVATE_KEYS'], message: 'live mode needs 0x-prefixed 32-byte keys (EXECUTOR_PRIVATE_KEYS, first = exit key)' });
      if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length)
        ctx.addIssue({ code: 'custom', path: ['EXECUTOR_PRIVATE_KEYS'], message: 'duplicate executor key' });
      if (keys.length === 1 && !c.ALLOW_SINGLE_KEY)
        ctx.addIssue({
          code: 'custom',
          path: ['EXECUTOR_PRIVATE_KEYS'],
          message: 'live mode needs ≥ 2 keys: EXECUTOR_PRIVATE_KEYS=exitKey,burstKey1[,burstKey2…] (one key makes exits wait behind bursts; ALLOW_SINGLE_KEY=1 overrides)',
        });
      if (!ADDR_RE.test(c.SNIPER_CONTRACT))
        ctx.addIssue({ code: 'custom', path: ['SNIPER_CONTRACT'], message: 'live mode needs the PonsSniper address' });
      if (c.SEND_ENDPOINTS.length === 0)
        ctx.addIssue({ code: 'custom', path: ['SEND_ENDPOINTS'], message: 'live mode needs at least one send endpoint' });
      if (!c.DATABASE_URL)
        ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'live mode records every snipe; DATABASE_URL required' });
    }
    for (const a of c.LAUNCHERS) if (!ADDR_RE.test(a)) ctx.addIssue({ code: 'custom', path: ['LAUNCHERS'], message: `not an address: ${a}` });
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = ConfigSchema.parse(env);
  if (cfg.SEND_ENDPOINTS.length === 0) cfg.SEND_ENDPOINTS = [cfg.NODE_HTTP || cfg.PUBLIC_RPC];
  return cfg;
}

/** Operator keys, first = exit key (one key = shared exit/burst key). */
export function executorKeys(c: Config): Hex[] {
  return (c.EXECUTOR_PRIVATE_KEYS.length ? c.EXECUTOR_PRIVATE_KEYS : c.EXECUTOR_PRIVATE_KEY ? [c.EXECUTOR_PRIVATE_KEY] : []) as Hex[];
}

/** Config with the secrets redacted, for logs and /healthz. */
export function redactedConfig(c: Config): Record<string, unknown> {
  return {
    ...c,
    EXECUTOR_PRIVATE_KEY: c.EXECUTOR_PRIVATE_KEY ? '<set>' : '',
    EXECUTOR_PRIVATE_KEYS: c.EXECUTOR_PRIVATE_KEYS.map(() => '<set>'),
    DATABASE_URL: c.DATABASE_URL ? '<set>' : '',
  };
}
