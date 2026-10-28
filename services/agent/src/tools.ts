/**
 * Tool definitions for the play finder (docs/SPEC.md §3 + get_token_transfers /
 * get_exempt_flow for the team-transfer exit pattern).
 *
 * - `betaZodTool` schemas: the tool runner validates every input against them before
 *   `run` is called (required because the tools stream with `eager_input_streaming`,
 *   which turns off server-side validation). Addresses are trimmed, checked and
 *   lower-cased by the schema itself.
 * - Outputs are compact JSON, at most MAX_ROWS rows per call (paginate with
 *   offset / next_offset) and at most MAX_OUTPUT_CHARS characters.
 * - Tool order and descriptions are static: they are part of the cached prompt prefix.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  backtestPlay,
  derivePresetFromPeaks,
  gridSearch,
  peakStats,
  quantile,
  type BacktestSummary,
  type DerivedPreset,
  type GridSpec,
  type PeakMetrics,
  type SimPreset,
} from './backtest.js';
import { DEFAULT_LIMITS, DEFAULT_PRESET } from './defaults.js';
import { PlayTriggerSchema, PresetSchema, type PlayTrigger, type Preset } from './deps.js';
import {
  csvSources,
  exemptFlow,
  fundingPath,
  getEthUsdSetting,
  getToken,
  getTokenMetricsRaw,
  getTokens,
  getTrades,
  insertProposedPlay,
  launchContexts,
  loadBacktestItems,
  MAX_ROWS,
  recentLaunches,
  runners,
  siblingsFundedBy,
  tokenTransfers,
  tokensByDeployer,
  tokensByName,
  transfers,
  triggerCandidates,
  walletSummary,
  walletTrades,
  type AgentRunKind,
  type Db,
  type TokenRow,
} from './queries.js';
import { buildCsvRow, dateRange, renderReport, resolveEthUsd, toCsv, writeOutput, type CsvRow, type EthUsd, type PlayPattern } from './report.js';
import { matchTrigger } from './trigger.js';

export const MAX_OUTPUT_CHARS = 40_000;

// ---------------------------------------------------------------------------
// Context shared by the tools of one run
// ---------------------------------------------------------------------------

export interface RpcLike {
  getBalance(args: { address: `0x${string}` }): Promise<bigint>;
}

export interface ToolCallLog {
  name: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface ProposedPlay {
  playId: number;
  operatorId: number;
  eventId: number;
  name: string;
  operatorName: string;
  pattern: PlayPattern;
  trigger: PlayTrigger;
  preset: Preset;
  stats: Record<string, unknown>;
}

export interface RunState {
  reportPath: string | null;
  reportMd: string | null;
  csvPath: string | null;
  proposedPlays: ProposedPlay[];
  tokensSeen: Set<string>;
  toolCalls: ToolCallLog[];
  lastBacktest: BacktestSummary | null;
  ethUsd: EthUsd | null;
}

export function newRunState(): RunState {
  return {
    reportPath: null,
    reportMd: null,
    csvPath: null,
    proposedPlays: [],
    tokensSeen: new Set(),
    toolCalls: [],
    lastBacktest: null,
    ethUsd: null,
  };
}

export interface ToolContext {
  sql: Db;
  rpc: RpcLike | null;
  reportsDir: string;
  runId: number;
  kind: AgentRunKind;
  logger: Logger;
  now: () => Date;
  state: RunState;
  /** returns a notice when the run is close to its round / cost limits */
  budgetNotice: () => string | null;
  maxProposals?: number;
}

/** The tool list type the SDK's tool runner accepts. */
export type AgentTools = Parameters<Anthropic['beta']['messages']['toolRunner']>[0]['tools'];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte hex address')
  .toLowerCase()
  .describe('0x-prefixed 40-hex-char address');

const limit = z.number().int().min(1).max(MAX_ROWS).optional().describe(`rows per page, default 50, max ${MAX_ROWS}`);
const offset = z.number().int().min(0).optional().describe('row offset; pass next_offset from the previous page');
const unixTs = z.number().int().min(0).max(4_102_444_800);

const takeProfitSchema = z.object({
  pct: z.number().positive().max(10_000).describe('position mark % (value vs cost) that triggers the sale'),
  sellPct: z.number().positive().max(100).describe('% of the initial position sold at this rung'),
});

const trailingSchema = z.object({ activatePct: z.number().min(0).max(10_000), dropPct: z.number().positive().max(100) });

/** Tool-facing PlayTrigger (no transforms so it renders to JSON Schema); re-validated with core's PlayTriggerSchema. */
export const triggerInputSchema = z.object({
  armedWallet: z
    .object({
      funders: z.array(addressSchema).min(1).max(20),
      minEth: z.number().min(0).max(100),
      maxEth: z.number().positive().max(100),
      freshOnly: z.boolean(),
      maxAgeSec: z.number().int().min(60).max(7 * 86_400),
      contractMode: z.boolean().describe('also arm wallets funded by contracts the funders created (disperse)'),
    })
    .optional(),
  deployerIn: z.array(addressSchema).max(50).optional(),
  teamWalletsAny: z.array(addressSchema).max(50).optional().describe('matches launch exemptions ∪ creatorFeeRecipient'),
  nameRegex: z.string().min(1).max(100).optional(),
  symbolRegex: z.string().min(1).max(100).optional(),
  launchKind: z.enum(['any', 'noDevBuy', 'devBuy']).optional(),
  minDevBuyEth: z.number().min(0).optional(),
  maxDevBuyEth: z.number().min(0).optional(),
  require: z
    .array(z.enum(['armedWallet', 'deployerIn', 'teamWalletsAny', 'nameRegex', 'symbolRegex']))
    .describe('conditions that must all hold; the other specified conditions are OR-ed'),
});

const simPresetPatch = z.object({
  buyEth: z.number().positive().max(5).optional(),
  maxTaxBps: z.number().int().min(0).max(9900).optional(),
  takeProfits: z.array(takeProfitSchema).max(5).optional(),
  trailing: trailingSchema.nullable().optional().describe('null disables the trailing stop'),
  stopLossPct: z.number().positive().max(100).optional(),
  timeoutSec: z.number().int().positive().max(3600).nullable().optional(),
  maxEntryMcapEth: z.number().positive().nullable().optional(),
  minQuoteReserveEth: z.number().min(0).nullable().optional(),
  abortIfExemptSellInLaunchBlock: z.boolean().optional(),
  exitIfExemptSellsPct: z.number().positive().max(100).nullable().optional().describe('exit when an exempt wallet has sold or transferred out this % of its holding'),
});
type SimPresetPatch = z.infer<typeof simPresetPatch>;

const presetPatch = simPresetPatch.extend({
  slippageBps: z.number().int().min(0).max(9900).optional(),
  stopAfter: z.number().int().min(0).max(100).optional(),
  firstBuyOnly: z.boolean().optional(),
  tokenCap: z.boolean().optional(),
});

const patternSchema = z.enum(['dev_buys', 'team_buys', 'decoys', 'mixed', 'unknown']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON with a hard size cap: shrinks the largest top-level array until it fits. */
export function compactJson(payload: Record<string, unknown>, maxChars = MAX_OUTPUT_CHARS): string {
  let out = JSON.stringify(payload);
  if (out.length <= maxChars) return out;
  const copy: Record<string, unknown> = { ...payload };
  for (let guard = 0; guard < 40 && out.length > maxChars; guard++) {
    let key: string | null = null;
    let len = 0;
    for (const [k, v] of Object.entries(copy)) {
      if (Array.isArray(v) && v.length > len) {
        key = k;
        len = v.length;
      }
    }
    if (key === null || len <= 1) break;
    copy[key] = (copy[key] as unknown[]).slice(0, Math.floor(len / 2));
    copy['truncated'] = `${key} cut to ${Math.floor(len / 2)} of ${len} entries to fit the output limit; request a smaller page`;
    out = JSON.stringify(copy);
  }
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}

function respond(ctx: ToolContext, payload: Record<string, unknown>): string {
  const notice = ctx.budgetNotice();
  return compactJson(notice ? { ...payload, budget_notice: notice } : payload);
}

const page = <T>(p: { rows: T[]; nextOffset: number | null }): { rows: T[]; next_offset: number | null } => ({
  rows: p.rows,
  next_offset: p.nextOffset,
});

function tool<S extends z.ZodObject>(
  ctx: ToolContext,
  name: string,
  description: string,
  inputSchema: S,
  run: (input: z.output<S>) => Promise<Record<string, unknown>>,
) {
  const def = betaZodTool({
    name,
    description,
    inputSchema,
    run: async (input) => {
      const started = Date.now();
      try {
        const result = await run(input as z.output<S>);
        const ms = Date.now() - started;
        ctx.state.toolCalls.push({ name, ms, ok: true });
        ctx.logger.info({ tool: name, ms, input }, 'tool call');
        return respond(ctx, result);
      } catch (err) {
        const ms = Date.now() - started;
        const message = err instanceof Error ? err.message : String(err);
        ctx.state.toolCalls.push({ name, ms, ok: false, error: message.slice(0, 300) });
        ctx.logger.warn({ tool: name, ms, input, err: message }, 'tool call failed');
        throw new Error(`${name} failed: ${message.slice(0, 500)}`);
      }
    },
  });
  // SDK 0.90's betaZodTool has no option for it yet, so spread it on (claude-api skill).
  return { ...def, eager_input_streaming: true };
}

function tokenBrief(t: TokenRow): Record<string, unknown> {
  return {
    ...t,
    launchTimeIso: new Date(t.ts * 1000).toISOString(),
    teamWallets: [...new Set([...(t.creatorFeeRecipient ? [t.creatorFeeRecipient] : []), ...t.exemptions])].filter((w) => w !== t.deployer),
  };
}

async function ethUsd(ctx: ToolContext): Promise<EthUsd> {
  if (!ctx.state.ethUsd) {
    ctx.state.ethUsd = resolveEthUsd(await getEthUsdSetting(ctx.sql));
    if (ctx.state.ethUsd.warning) ctx.logger.warn(ctx.state.ethUsd.warning);
  }
  return ctx.state.ethUsd;
}

export function toMetrics(t: TokenRow): PeakMetrics {
  const m = t.metrics;
  return {
    token: t.token,
    peak2Pct: m?.peak2Pct ?? null,
    peak5Pct: m?.peak5Pct ?? null,
    peak10Pct: m?.peak10Pct ?? null,
    peak30Pct: m?.peak30Pct ?? null,
    peak60Pct: m?.peak60Pct ?? null,
    lowAfterEntryPct: m?.lowAfterEntryPct ?? null,
  };
}

export function derive(tokens: readonly TokenRow[]): DerivedPreset | null {
  const creator = quantile(
    tokens.map((t) => t.creatorTaxBps ?? 0),
    0.5,
  );
  return derivePresetFromPeaks(tokens.map(toMetrics), { creatorTaxBps: creator ?? 0 });
}

export function applySimPatch(base: SimPreset, p: SimPresetPatch | undefined): SimPreset {
  if (!p) return base;
  const out: SimPreset = { ...base };
  if (p.buyEth !== undefined) out.buyEth = p.buyEth;
  if (p.maxTaxBps !== undefined) out.maxTaxBps = p.maxTaxBps;
  if (p.takeProfits !== undefined) out.takeProfits = p.takeProfits;
  if (p.stopLossPct !== undefined) out.stopLossPct = p.stopLossPct;
  if (p.abortIfExemptSellInLaunchBlock !== undefined) out.abortIfExemptSellInLaunchBlock = p.abortIfExemptSellInLaunchBlock;
  const opt = <K extends 'trailing' | 'timeoutSec' | 'maxEntryMcapEth' | 'minQuoteReserveEth' | 'exitIfExemptSellsPct'>(k: K): void => {
    const v = p[k];
    if (v === undefined) return;
    if (v === null) delete out[k];
    else (out as Record<K, unknown>)[k] = v;
  };
  opt('trailing');
  opt('timeoutSec');
  opt('maxEntryMcapEth');
  opt('minQuoteReserveEth');
  opt('exitIfExemptSellsPct');
  return out;
}

export function defaultGrid(derived: DerivedPreset | null): GridSpec {
  const tp = new Set<number>([50, 80, 100, 150, 200, 300]);
  const trailing: GridSpec['trailing'] = [null, { activatePct: 100, dropPct: 25 }, { activatePct: 150, dropPct: 30 }];
  const sl = new Set<number>([25, 40, 60]);
  if (derived) {
    tp.add(derived.takeProfits[0]!.pct);
    if (derived.trailing) trailing.push(derived.trailing);
    sl.add(derived.stopLossPct);
  }
  return { tp: [...tp].sort((a, b) => a - b), trailing, sl: [...sl].sort((a, b) => a - b), timeoutSec: [60, 120, 300] };
}

export async function tokensForTrigger(sql: Db, trigger: PlayTrigger, sinceTs: number): Promise<{ tokens: string[]; candidates: number }> {
  const cands = await triggerCandidates(
    sql,
    {
      deployers: trigger.deployerIn ?? [],
      team: trigger.teamWalletsAny ?? [],
      funders: trigger.armedWallet?.funders ?? [],
      nameRegex: trigger.nameRegex ?? null,
      symbolRegex: trigger.symbolRegex ?? null,
    },
    sinceTs,
  );
  const ctxs = await launchContexts(sql, cands);
  return { tokens: ctxs.filter((c) => matchTrigger(c, trigger).matched).map((c) => c.token), candidates: cands.length };
}

function validRegex(s: string): boolean {
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function buildTools(ctx: ToolContext): AgentTools {
  const maxProposals = ctx.maxProposals ?? DEFAULT_LIMITS.maxProposalsPerRun;

  const getTokenTool = tool(
    ctx,
    'get_token',
    'Launch facts and stored metrics for one Pons V2 token: deployer, curve, launch kind (devBuy/noDevBuy), dev buy, creator tax, exemptions and creatorFeeRecipient (the team wallets), launch time, start mcap, first taxed buyer and peaks. Start every investigation here.',
    z.object({ ca: addressSchema.describe('token contract address') }),
    async ({ ca }) => {
      const t = await getToken(ctx.sql, ca);
      if (!t) return { found: false, ca, note: 'token not in the launches table (not a Pons V2 launch, or not indexed yet)' };
      ctx.state.tokensSeen.add(t.token);
      return { found: true, token: tokenBrief(t) };
    },
  );

  const getTradesTool = tool(
    ctx,
    'get_trades',
    'Curve trades of one token in a window of seconds since launch, ordered by block. Each trade has side, recipient, tx_from, quoteEth, tokens, snipeTaxEth (the snipe tax), creatorTaxEth, priceAfter and exempt. Use from_sec=0,to_sec=0 to see the launch-second (tax-free) buys and from_sec=1,to_sec=1 for the first taxed buyers.',
    z.object({
      ca: addressSchema,
      from_sec: z.number().int().min(0).max(86_400).optional(),
      to_sec: z.number().int().min(0).max(86_400).optional(),
      side: z.enum(['buy', 'sell']).optional(),
      limit,
      offset,
    }),
    async (i) => page(await getTrades(ctx.sql, i.ca, { fromSec: i.from_sec, toSec: i.to_sec, side: i.side, limit: i.limit ?? 100, offset: i.offset })),
  );

  const getMetricsTool = tool(
    ctx,
    'get_token_metrics',
    "All stored token_metrics for a token: first taxed buyer, its entry price and mcap (ETH), peaks at 2/5/10/30/60 s from that entry with mcaps, ATH, low after entry, tax-free buy count and quote, buys/sells in the first 60 s, and when an exempt wallet first sold.",
    z.object({ ca: addressSchema }),
    async ({ ca }) => {
      const m = await getTokenMetricsRaw(ctx.sql, ca);
      return m ? { found: true, metrics: m } : { found: false, ca, note: 'no metrics row yet' };
    },
  );

  const getWalletTool = tool(
    ctx,
    'get_wallet',
    'Summary of a wallet or contract: first funder and first funding value, fresh flag (tx count at first funding), is_contract and its creator, counts and totals of ETH in/out, tokens deployed, curve trades, last activity and the live ETH balance.',
    z.object({ address: addressSchema }),
    async ({ address }) => {
      const w = await walletSummary(ctx.sql, address);
      let balanceEth: number | null = null;
      if (ctx.rpc) {
        try {
          balanceEth = Number(await ctx.rpc.getBalance({ address: address as `0x${string}` })) / 1e18;
        } catch (err) {
          ctx.logger.warn({ address, err: String(err) }, 'balance lookup failed');
        }
      }
      return { wallet: { ...w, fresh: w.txCountAtFirstFunding === null ? null : w.txCountAtFirstFunding === 0, balanceEth } };
    },
  );

  const getFundingTool = tool(
    ctx,
    'get_wallet_funding',
    "How a wallet was funded: the funding path (first incoming funding of each hop, up to `depth` hops, showing internal transfers from disperse contracts and who created them) plus a page of its incoming ETH transfers. Use on deployers, team wallets, dump wallets and treasuries.",
    z.object({
      address: addressSchema,
      depth: z.number().int().min(1).max(8).optional().describe('hops to walk, default 4'),
      min_eth: z.number().min(0).optional().describe('filter incoming transfers below this value'),
      limit,
      offset,
    }),
    async (i) => {
      const [path, incoming] = await Promise.all([
        fundingPath(ctx.sql, i.address, i.depth ?? 4),
        transfers(ctx.sql, i.address, 'in', { minEth: i.min_eth, limit: i.limit ?? 20, offset: i.offset }),
      ]);
      return { path, incoming: page(incoming) };
    },
  );

  const getOutgoingTool = tool(
    ctx,
    'get_wallet_outgoing',
    "Where a wallet sent ETH. mode 'children' (default) lists every wallet it funded directly or through contracts it CREATEd (disperse / contract mode) with each child's freshness and the tokens it deployed - use it on funders to find the operator's other coins. mode 'raw' lists its plain outgoing transfers (e.g. a dump wallet paying a treasury).",
    z.object({
      address: addressSchema,
      mode: z.enum(['children', 'raw']).optional(),
      since_ts: unixTs.optional(),
      min_eth: z.number().min(0).optional(),
      max_eth: z.number().positive().optional(),
      limit,
      offset,
    }),
    async (i) => {
      const opts = { sinceTs: i.since_ts, minEth: i.min_eth, maxEth: i.max_eth, limit: i.limit, offset: i.offset };
      if (i.mode === 'raw') return { mode: 'raw', ...page(await transfers(ctx.sql, i.address, 'out', opts)) };
      return { mode: 'children', ...page(await siblingsFundedBy(ctx.sql, i.address, opts)) };
    },
  );

  const byDeployerTool = tool(
    ctx,
    'list_tokens_by_deployer',
    'Tokens launched by a deployer, newest first, with launch kind, dev buy, start/ATH/first-taxed mcaps (ETH), tax-free buy count and peaks.',
    z.object({ address: addressSchema, limit, offset }),
    async (i) => page(await tokensByDeployer(ctx.sql, i.address, { limit: i.limit, offset: i.offset })),
  );

  const byNameTool = tool(
    ctx,
    'list_tokens_by_name',
    'Tokens whose name or symbol matches a case-insensitive regex (POSIX), newest first. Use it to find decoys: the same name launched from different wallets.',
    z.object({
      regex: z.string().min(1).max(100).refine(validRegex, 'invalid regular expression'),
      since_ts: unixTs.optional(),
      limit,
      offset,
    }),
    async (i) => page(await tokensByName(ctx.sql, i.regex, { sinceTs: i.since_ts, limit: i.limit, offset: i.offset })),
  );

  const recentTool = tool(
    ctx,
    'list_recent_launches',
    'Launches in the last N minutes, newest first, with their metrics summary.',
    z.object({
      since_minutes: z.number().int().min(1).max(10_080),
      launch_kind: z.enum(['devBuy', 'noDevBuy']).optional(),
      limit,
      offset,
    }),
    async (i) => {
      const sinceTs = Math.floor(ctx.now().getTime() / 1000) - i.since_minutes * 60;
      return page(await recentLaunches(ctx.sql, { sinceTs, launchKind: i.launch_kind, limit: i.limit, offset: i.offset }));
    },
  );

  const runnersTool = tool(
    ctx,
    'list_runners',
    "Launches whose peak within `window` seconds of the first taxed entry reached min_peak_pct, newest first, with the deployer's first funder (and the funder's creator when it is a contract), deployer freshness, exemptions and creatorFeeRecipient - enough to group coins by operator.",
    z.object({
      since_hours: z.number().min(0.1).max(24 * 60).optional().describe('look-back, default 24'),
      until_ts: unixTs.optional(),
      min_peak_pct: z.number().min(0).max(100_000).optional().describe('default 100'),
      window: z.union([z.literal(2), z.literal(5), z.literal(10), z.literal(30), z.literal(60)]).optional().describe('seconds, default 10'),
      limit,
      offset,
    }),
    async (i) => {
      const sinceTs = Math.floor(ctx.now().getTime() / 1000) - (i.since_hours ?? 24) * 3600;
      return page(
        await runners(ctx.sql, { sinceTs, untilTs: i.until_ts, minPeakPct: i.min_peak_pct ?? 100, window: i.window ?? 10, limit: i.limit, offset: i.offset }),
      );
    },
  );

  const walletTradesTool = tool(
    ctx,
    'get_wallet_trades',
    "A wallet's curve trading per token: buys/sells, ETH in (including snipe tax) and out, tokens, realised PnL in ETH, and how many seconds after launch it first bought.",
    z.object({ address: addressSchema, limit, offset }),
    async (i) => {
      const r = await walletTrades(ctx.sql, i.address, { limit: i.limit, offset: i.offset });
      return { ...page(r), totals: r.totals };
    },
  );

  const tokenTransfersTool = tool(
    ctx,
    'get_token_transfers',
    'ERC-20 Transfer events of a launched token, optionally filtered by sender and/or receiver, with seconds since launch. Use it to follow tokens out of exempt (team) wallets to the dump wallet.',
    z.object({ ca: addressSchema, from: addressSchema.optional(), to: addressSchema.optional(), limit, offset }),
    async (i) => page(await tokenTransfers(ctx.sql, i.ca, { from: i.from, to: i.to, limit: i.limit, offset: i.offset })),
  );

  const exemptFlowTool = tool(
    ctx,
    'get_exempt_flow',
    "The team's exit for one token: each exempt wallet (deployer, creatorFeeRecipient, exemptions) with its launch-second buys, curve sells and token transfers out; the dump wallets that received those tokens (batches, timing, their curve sells and ETH); and where that ETH went next (the operator's treasury).",
    z.object({ ca: addressSchema }),
    async ({ ca }) => {
      const f = await exemptFlow(ctx.sql, ca);
      return f ? { found: true, flow: f } : { found: false, ca };
    },
  );

  const backtestTool = tool(
    ctx,
    'backtest_play',
    "Simulates sniping each coin at +1 s (in front of the first taxed buyer; 6.18 % snipe tax on top, 1 % fee, creator tax, own price impact) and exiting with the preset's take-profit ladder, trailing stop, stop loss, timeout and exempt-disposal exit, over the stored trade paths. Pass the operator's coins in `tokens` (or a `trigger` to select launches since since_days). Returns win rate, average/median PnL, max drawdown, expectancy per snipe, exit reasons, the preset derived from the peak distribution and, with grid=true, the best presets by expectancy (needs >= 5 coins).",
    z.object({
      tokens: z.array(addressSchema).min(1).max(MAX_ROWS).optional(),
      trigger: triggerInputSchema.optional(),
      since_days: z.number().min(0.1).max(180).optional().describe('with trigger: look-back, default 30'),
      preset: simPresetPatch.optional().describe('overrides on the default preset (0.07 ETH, TP +150 %, trailing 100/25, SL 40 %, timeout 120 s)'),
      grid: z.boolean().optional(),
    }),
    async (i) => {
      let tokens = i.tokens ?? [];
      let candidates: number | undefined;
      if (tokens.length === 0) {
        if (!i.trigger) throw new Error('pass tokens or a trigger');
        const trig = PlayTriggerSchema.parse(i.trigger);
        const sinceTs = Math.floor(ctx.now().getTime() / 1000) - (i.since_days ?? 30) * 86_400;
        const sel = await tokensForTrigger(ctx.sql, trig, sinceTs);
        tokens = sel.tokens.slice(0, MAX_ROWS);
        candidates = sel.candidates;
      }
      const [items, rows] = await Promise.all([loadBacktestItems(ctx.sql, tokens), getTokens(ctx.sql, tokens)]);
      const preset = applySimPatch(DEFAULT_PRESET, i.preset);
      const report = backtestPlay(items, preset);
      const { perToken, ...summary } = report;
      ctx.state.lastBacktest = summary;
      const derived = derive(rows);
      const grid = i.grid ? gridSearch(items, preset, defaultGrid(derived), { minN: 5, top: 5 }) : null;
      return {
        coins: items.length,
        candidates,
        dateRange: items.length ? `${new Date(items[0]!.launch.ts * 1000).toISOString()} -> ${new Date(items[items.length - 1]!.launch.ts * 1000).toISOString()}` : null,
        preset,
        summary,
        perToken: perToken.slice(0, 60).map((r) => ({
          token: r.token,
          entered: r.entered,
          exitReason: r.exitReason,
          pnlPct: Number(r.pnlPct.toFixed(1)),
          pnlEth: Number(r.pnlEth.toFixed(5)),
          holdSec: r.holdSec,
          peakPct: Number(r.peakPct.toFixed(1)),
          entryMcapEth: r.entryMcapEth === null ? null : Number(r.entryMcapEth.toFixed(3)),
        })),
        derivedFromPeaks: derived,
        grid: grid && {
          evaluated: grid.evaluated,
          n: grid.n,
          insufficient: grid.insufficient,
          best: grid.results.map((g) => ({ preset: g.preset, ...g.summary })),
        },
      };
    },
  );

  const writeCsvTool = tool(
    ctx,
    'write_csv',
    'Writes the operator CSV (one row per coin: CA, dev wallet, name, start/ATH mcap USD, launch time UTC and New York, tax-free badge and buyers, first taxed buyer and entry mcap, peaks and mcaps at 2/5/10/30/60 s, funding route, launch kind, dev buy, notes). All numbers are filled from the database; you give the CAs, notes and, if you traced a better one, the funding route. Returns the file path.',
    z.object({
      rows: z
        .array(
          z.object({
            ca: addressSchema,
            notes: z.string().max(500).optional(),
            funded_by: z.string().max(400).optional().describe('funding route you traced, source first'),
            funded_eth: z.number().min(0).optional(),
          }),
        )
        .min(1)
        .max(MAX_ROWS),
      slug: z.string().max(40).optional().describe('file name hint, e.g. the operator name'),
    }),
    async (i) => {
      const fx = await ethUsd(ctx);
      const sources = await csvSources(
        ctx.sql,
        i.rows.map((r) => r.ca),
      );
      const byCa = new Map(sources.map((s) => [s.token.token, s]));
      const rows: CsvRow[] = [];
      const missing: string[] = [];
      for (const r of i.rows) {
        const src = byCa.get(r.ca);
        if (!src) {
          missing.push(r.ca);
          continue;
        }
        rows.push(buildCsvRow(src, fx.usd, { notes: r.notes, fundedBy: r.funded_by, fundedEth: r.funded_eth }));
      }
      if (rows.length === 0) throw new Error(`none of the CAs are indexed launches: ${missing.join(', ')}`);
      const file = await writeOutput(ctx.reportsDir, `${i.slug ?? rows[0]!.symbol ?? 'play'}-run${ctx.runId}`, 'csv', toCsv(rows), ctx.now());
      ctx.state.csvPath = file;
      return { path: file, rows: rows.length, missing, dateRange: dateRange(rows), ethUsd: fx, preview: rows.slice(0, 2) };
    },
  );

  const writeReportTool = tool(
    ctx,
    'write_report',
    "Writes the markdown report: your sections (operator summary, how they are funded, how to catch it, recommended preset with justification, caveats) plus a coin table, the peak distribution and the derived preset that the tool computes from the database for the CAs in `tokens`. Returns the file path.",
    z.object({
      title: z.string().min(3).max(120),
      pattern: patternSchema,
      operator_summary: z.string().min(1).max(6000),
      how_funded: z.string().min(1).max(6000),
      how_to_catch: z.string().min(1).max(6000),
      recommended_preset: z.string().min(1).max(6000),
      caveats: z.string().min(1).max(4000),
      tokens: z.array(addressSchema).max(MAX_ROWS).describe("the operator's coins for the table and statistics"),
      extra_md: z.string().max(8000).optional(),
    }),
    async (i) => {
      const fx = await ethUsd(ctx);
      const sources = await csvSources(ctx.sql, i.tokens);
      const rows = sources.map((s) => buildCsvRow(s, fx.usd));
      const tokens = sources.map((s) => s.token);
      const md = renderReport({
        title: i.title,
        pattern: i.pattern,
        sections: {
          operatorSummary: i.operator_summary,
          howFunded: i.how_funded,
          howToCatch: i.how_to_catch,
          recommendedPreset: i.recommended_preset,
          caveats: i.caveats,
        },
        coins: rows,
        ethUsd: fx,
        generatedAt: ctx.now(),
        runId: ctx.runId,
        stats: tokens.length ? peakStats(tokens.map(toMetrics)) : undefined,
        derived: derive(tokens),
        extraMd: i.extra_md,
      });
      const file = await writeOutput(ctx.reportsDir, `${i.title}-run${ctx.runId}`, 'md', md, ctx.now());
      ctx.state.reportPath = file;
      ctx.state.reportMd = md;
      return { path: file, coins: rows.length, chars: md.length };
    },
  );

  const proposeTool = tool(
    ctx,
    'propose_play',
    "Saves a candidate play for human approval in Telegram: creates a 'candidate' operator and a DISABLED play with the trigger and preset, backtests it on the evidence coins, and posts a play_proposed event. Only call it when at least 3 coins share the fingerprint and the backtest is positive after taxes.",
    z.object({
      operator_name: z.string().min(3).max(60),
      operator_notes: z.string().max(2000),
      play_name: z.string().min(3).max(80),
      pattern: patternSchema,
      trigger: triggerInputSchema,
      preset: presetPatch.optional().describe('overrides on the default preset'),
      evidence_tokens: z.array(addressSchema).min(1).max(MAX_ROWS).describe('the coins that justify the play'),
      summary: z.string().min(1).max(1000).describe('one paragraph for the approver'),
    }),
    async (i) => {
      if (ctx.state.proposedPlays.length >= maxProposals) throw new Error(`at most ${maxProposals} proposals per run`);
      const trigger = PlayTriggerSchema.parse(i.trigger);
      const { trailing, timeoutSec, maxEntryMcapEth, minQuoteReserveEth, exitIfExemptSellsPct, ...rest } = i.preset ?? {};
      const merged: Record<string, unknown> = { ...DEFAULT_PRESET, ...rest };
      const nullable = { trailing, timeoutSec, maxEntryMcapEth, minQuoteReserveEth, exitIfExemptSellsPct };
      for (const [k, v] of Object.entries(nullable)) {
        if (v === null) delete merged[k];
        else if (v !== undefined) merged[k] = v;
      }
      const preset = PresetSchema.parse(merged);
      const [items, ctxs] = await Promise.all([loadBacktestItems(ctx.sql, i.evidence_tokens), launchContexts(ctx.sql, i.evidence_tokens)]);
      const matched = ctxs.filter((c) => matchTrigger(c, trigger).matched).length;
      const bt = backtestPlay(items, preset);
      const { perToken, ...summary } = bt;
      const stats: Record<string, unknown> = {
        pattern: i.pattern,
        evidenceCoins: items.length,
        triggerMatches: matched,
        dateRange: bt.firstLaunchTs !== null ? [new Date(bt.firstLaunchTs * 1000).toISOString(), new Date(bt.lastLaunchTs! * 1000).toISOString()] : null,
        backtest: summary,
        backtestAt: ctx.now().toISOString(),
        runId: ctx.runId,
      };
      const rec = await insertProposedPlay(ctx.sql, {
        operatorName: i.operator_name,
        operatorNotes: i.operator_notes,
        playName: i.play_name,
        trigger,
        preset,
        stats,
        runId: ctx.runId,
        summary: i.summary,
      });
      const proposed: ProposedPlay = { ...rec, name: i.play_name, operatorName: i.operator_name, pattern: i.pattern, trigger, preset, stats };
      ctx.state.proposedPlays.push(proposed);
      return {
        saved: true,
        playId: rec.playId,
        operatorId: rec.operatorId,
        enabled: false,
        awaiting: 'approval in Telegram',
        triggerMatchesEvidence: `${matched}/${ctxs.length}`,
        backtest: { n: summary.n, winRate: summary.winRate, expectancyEth: summary.expectancyEth, medianPnlPct: summary.medianPnlPct, maxDD: summary.maxDD },
        perToken: perToken.slice(0, 20).map((r) => ({ token: r.token, exitReason: r.exitReason, pnlPct: Number(r.pnlPct.toFixed(1)) })),
      };
    },
  );

  const ethUsdTool = tool(
    ctx,
    'eth_usd',
    'The ETH/USD rate used for USD columns (settings.eth_usd, or a fixed fallback with a warning).',
    z.object({}),
    async () => ({ ...(await ethUsd(ctx)) }),
  );

  return [
    getTokenTool,
    getTradesTool,
    getMetricsTool,
    getWalletTool,
    getFundingTool,
    getOutgoingTool,
    byDeployerTool,
    byNameTool,
    recentTool,
    runnersTool,
    walletTradesTool,
    tokenTransfersTool,
    exemptFlowTool,
    backtestTool,
    writeReportTool,
    writeCsvTool,
    proposeTool,
    ethUsdTool,
  ];
}

export const TOOL_NAMES = [
  'get_token',
  'get_trades',
  'get_token_metrics',
  'get_wallet',
  'get_wallet_funding',
  'get_wallet_outgoing',
  'list_tokens_by_deployer',
  'list_tokens_by_name',
  'list_recent_launches',
  'list_runners',
  'get_wallet_trades',
  'get_token_transfers',
  'get_exempt_flow',
  'backtest_play',
  'write_report',
  'write_csv',
  'propose_play',
  'eth_usd',
] as const;
