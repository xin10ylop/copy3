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

/**
 * Third-party launcher contracts seen launching real Pons tokens (live paper box, 3 h, 52 launches):
 * 0x6319…cce2 (16, unknown selector 0xf955751f) and 0x9dcc…3961 (8, launchAndBuy-shaped). Their txs
 * start the early log path (receipt polled from the feed block on); the launch itself is always
 * built from the factory's TokenLaunched log. LAUNCHERS (env) adds to this list.
 */
export const DEFAULT_LAUNCHERS: readonly string[] = ['0x6319141dcc29e7dceaab6c4563cca1fb58e8cce2', '0x9dcceb091218cdedbc2875514386615a8ce63961'];
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export const ConfigSchema = z
  .object({
    /**
     * paper: simulated fills, nothing sent; live: real bursts through PonsSniper; probe: paper fills
     * + ONE real 0-value self-transfer per planned burst at its first slot (race measurement, gas only)
     */
    EXECUTION_MODE: z.enum(['live', 'paper', 'probe']).default('paper'),
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
    LAUNCHERS: csv.transform((l) => [...new Set([...DEFAULT_LAUNCHERS, ...l.map((a) => a.toLowerCase())])]),
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
    /** burst deadline in L2 blocks after the launch block (≈ the end of second T+1 at 10 blocks/s); the wall-clock deadlineTs is the binding one under congestion */
    DEADLINE_BLOCKS: num(20),
    /** re-price minTokensOut this many ms before the first send (0 = off); see Sniper.repriceLeadMs */
    REPRICE_LEAD_MS: num(250),
    HEALTH_PORT: num(8081),
    LOG_LEVEL: z.string().default('info'),
    /** none (wait for TokenLaunched/receipt) | nonce (CREATE prediction; Pons V2 uses CREATE2 → wrong) */
    ADDRESS_PREDICTION: z.enum(['none', 'nonce']).default('none'),
    RESERVES_POLL_MS: num(500),
    /** launch receipt polling while confirming a launch (H1; on the decide path, one receipt) */
    RECEIPT_POLL_MS: num(20),
    /** burst / exit receipt polling (nonce-gated: one nonce read per tick + one receipt per landed member) */
    BURST_RECEIPT_POLL_MS: num(200),
    /** probe mode: give up waiting for the probe tx's receipt after this long (`not mined`) */
    PROBE_RECEIPT_TIMEOUT_MS: num(5000),
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
    /** NEW-8: while the gate passes, re-read the contract config (owner, operators, maxQuoteIn, spend budget) this often */
    GATE_REFRESH_MS: num(60_000),
    /** NEW-9: the first n executor keys serve exits (round-robin, a free key first); the rest are burst keys */
    EXIT_KEYS: z.coerce.number().int().min(1).default(1),
    /** NEW-2: re-read settings (kill switch) this often, whatever NOTIFY delivered */
    SETTINGS_RELOAD_MS: z.coerce.number().min(1_000).default(10_000),
    /** NEW-2: re-read plays and armed candidates this often */
    PLAYS_RELOAD_MS: z.coerce.number().min(5_000).default(60_000),
    /** keep feed_blocks rows this many days (pruned hourly); 0 = keep everything */
    FEED_BLOCKS_RETENTION_DAYS: num(7),
    /** NEW-3: startup sweep of the contract's Sniped events; the first run looks back this many blocks (0 = off) */
    SWEEP_LOOKBACK_BLOCKS: num(864_000),
    /** R4-2: re-run the orphan sweep from its checkpoint this often */
    SWEEP_INTERVAL_MS: z.coerce.number().min(10_000).default(300_000),
    /** NEW-4/6 paper mode: the contract caps live would enforce (defaults = the deploy defaults) */
    PAPER_MAX_QUOTE_IN_ETH: z.coerce.number().positive().default(0.3),
    /** paper spend budget per PAPER_SPEND_WINDOW_SEC; unset = 4 × PAPER_MAX_QUOTE_IN_ETH */
    PAPER_MAX_SPEND_PER_WINDOW_ETH: optNum,
    /** paper spend window (s); 0 = budget off (like disableSpendLimit) */
    PAPER_SPEND_WINDOW_SEC: z.coerce.number().int().min(0).default(3600),
  })
  .superRefine((c, ctx) => {
    if (c.EXECUTION_MODE === 'live') {
      const keys = c.EXECUTOR_PRIVATE_KEYS.length ? c.EXECUTOR_PRIVATE_KEYS : c.EXECUTOR_PRIVATE_KEY ? [c.EXECUTOR_PRIVATE_KEY] : [];
      if (keys.length === 0 || keys.some((k) => !KEY_RE.test(k)))
        ctx.addIssue({ code: 'custom', path: ['EXECUTOR_PRIVATE_KEYS'], message: 'live mode needs 0x-prefixed 32-byte keys (EXECUTOR_PRIVATE_KEYS, first = exit key)' });
      if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length)
        ctx.addIssue({ code: 'custom', path: ['EXECUTOR_PRIVATE_KEYS'], message: 'duplicate executor key' });
      if (keys.length > 1 && c.EXIT_KEYS >= keys.length)
        ctx.addIssue({ code: 'custom', path: ['EXIT_KEYS'], message: `EXIT_KEYS=${c.EXIT_KEYS} leaves no burst key among ${keys.length} executor keys` });
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
    if (c.EXECUTION_MODE === 'probe') {
      // probe: gas-only keys (no contract, no operator role); one key is enough
      const keys = c.EXECUTOR_PRIVATE_KEYS.length ? c.EXECUTOR_PRIVATE_KEYS : c.EXECUTOR_PRIVATE_KEY ? [c.EXECUTOR_PRIVATE_KEY] : [];
      if (keys.length === 0 || keys.some((k) => !KEY_RE.test(k)))
        ctx.addIssue({ code: 'custom', path: ['EXECUTOR_PRIVATE_KEYS'], message: 'probe mode needs at least one 0x-prefixed 32-byte key with gas (EXECUTOR_PRIVATE_KEYS; hoodctl keygen 1)' });
      if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length)
        ctx.addIssue({ code: 'custom', path: ['EXECUTOR_PRIVATE_KEYS'], message: 'duplicate executor key' });
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

/**
 * Hide credentials embedded in an RPC/feed URL (user:pass@, an API key as a path segment such as
 * Alchemy's `/v2/<key>`, query strings) so endpoint URLs can be logged. Non-URLs pass through.
 */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    url.pathname = url.pathname
      .split('/')
      .map((seg) => (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) ? '***' : seg))
      .join('/');
    if (url.search) url.search = '?***';
    return url.toString();
  } catch {
    return u;
  }
}

/** Config with the secrets redacted, for logs and /healthz. */
export function redactedConfig(c: Config): Record<string, unknown> {
  return {
    ...c,
    NODE_HTTP: redactUrl(c.NODE_HTTP),
    NODE_WS: redactUrl(c.NODE_WS),
    PUBLIC_RPC: redactUrl(c.PUBLIC_RPC),
    FEED_URL: redactUrl(c.FEED_URL),
    FEED_URL_SECONDARY: c.FEED_URL_SECONDARY.map(redactUrl),
    SEND_ENDPOINTS: c.SEND_ENDPOINTS.map(redactUrl),
    EXECUTOR_PRIVATE_KEY: c.EXECUTOR_PRIVATE_KEY ? '<set>' : '',
    EXECUTOR_PRIVATE_KEYS: c.EXECUTOR_PRIVATE_KEYS.map(() => '<set>'),
    DATABASE_URL: c.DATABASE_URL ? '<set>' : '',
  };
}
