/**
 * Agent entry points used by the CLI and by services/telegram:
 *   runPlayFinder({ ca, hint? })                 - unravel the operator behind one coin
 *   runScout({ sinceMinutes, minPeak10Pct })     - cluster recent runners (SQL first), investigate uncovered clusters
 *   runBacktest({ playId })                      - deterministic backtest + grid of a stored play (no model call)
 *
 * Model runs follow the claude-api skill: claude-opus-5-5, adaptive thinking, effort high,
 * streaming tool runner with betaZodTool tools (eager_input_streaming), server-side
 * refusal fallbacks (`fallbacks: "default"`, beta server-side-fallback-2026-07-01),
 * refusal handling, no forced tool_choice, and prompt caching (explicit breakpoint on
 * the static system prompt + automatic caching of the growing conversation tail).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import pino, { type Logger } from 'pino';
import { createPublicClient, http } from 'viem';
import { backtestPlay, gridSearch, peakStats } from './backtest.js';
import { loadEnv, type AgentEnv } from './config.js';
import { DEFAULT_LIMITS, DEFAULT_PRESET } from './defaults.js';
import { tagged } from './db.js';
import { createDb, PlayTriggerSchema, PresetSchema, type HoodSql } from './deps.js';
import { playFinderMessage, scoutMessage, SYSTEM_PROMPT } from './prompts.js';
import {
  activePlays,
  csvSources,
  finishAgentRun,
  getTokens,
  insertAgentRun,
  insertEvent,
  launchContexts,
  loadBacktestItems,
  runners,
  getPlay,
  updatePlayStats,
  type AgentRunKind,
  type Db,
  type RunnerRow,
} from './queries.js';
import { buildCsvRow, renderReport, resolveEthUsd, toCsv, writeOutput } from './report.js';
import { getEthUsdSetting } from './queries.js';
import { clusterRunners, fingerprintOf, type RunnerCluster } from './scout.js';
import { buildTools, defaultGrid, derive, newRunState, tokensForTrigger, type ProposedPlay, type RpcLike, type RunState } from './tools.js';
import type { LaunchContext } from './trigger.js';

export const MODEL = 'claude-opus-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const MAX_TOKENS = 64_000;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AgentLimits {
  maxRounds: number;
  maxCostUsd: number;
}

export interface AgentDeps {
  sql: Db;
  client: Anthropic;
  rpc: RpcLike | null;
  reportsDir: string;
  logger: Logger;
  now: () => Date;
  limits: AgentLimits;
  scout: { maxClusters: number; minClusterSize: number; ignore: string[] };
}

/**
 * Builds deps from env. A host service can pass its own `@hood/db` Sql (and logger)
 * so the agent shares its connection pool.
 */
export function createAgentDeps(env: AgentEnv = loadEnv(), opts: { sql?: HoodSql; logger?: Logger } = {}): AgentDeps {
  const logger = opts.logger ?? pino({ name: 'agent', level: env.LOG_LEVEL });
  return {
    sql: tagged(opts.sql ?? createDb(env.DATABASE_URL, { max: 4 })),
    client: new Anthropic(),
    rpc: env.NODE_HTTP ? createPublicClient({ transport: http(env.NODE_HTTP) }) : null,
    reportsDir: env.REPORTS_DIR,
    logger,
    now: () => new Date(),
    limits: { maxRounds: env.AGENT_MAX_ROUNDS, maxCostUsd: env.AGENT_MAX_COST_USD },
    scout: { maxClusters: env.SCOUT_MAX_CLUSTERS, minClusterSize: env.SCOUT_MIN_CLUSTER_SIZE, ignore: env.SCOUT_IGNORE },
  };
}

let defaultDeps: AgentDeps | null = null;

/** Lets a host service (telegram) share its DB pool / logger instead of the env-built defaults. */
export function setDefaultDeps(deps: AgentDeps | null): void {
  defaultDeps = deps;
}

function resolveDeps(overrides?: Partial<AgentDeps>): AgentDeps {
  if (overrides && isComplete(overrides)) return overrides;
  defaultDeps ??= createAgentDeps();
  return { ...defaultDeps, ...overrides };
}

function isComplete(d: Partial<AgentDeps>): d is AgentDeps {
  return !!(d.sql && d.client && d.rpc !== undefined && d.reportsDir && d.logger && d.now && d.limits && d.scout);
}

// ---------------------------------------------------------------------------
// Cost accounting (USD per million tokens, from the claude-api skill)
// ---------------------------------------------------------------------------

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  fallbacks: number;
}

interface UsageLike {
  type?: string;
  model?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

function priceOf(model: string | undefined): ModelPrice {
  return (model && PRICES[model]) || PRICES[MODEL]!;
}

function addUsage(t: UsageTotals, u: UsageLike, model: string | undefined): void {
  const p = priceOf(u.model ?? model);
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = Math.max(0, write - w1h);
  t.inputTokens += input;
  t.outputTokens += output;
  t.cacheReadTokens += read;
  t.cacheWriteTokens += write;
  t.costUsd += (input * p.input + output * p.output + read * p.cacheRead + w5m * p.cacheWrite5m + w1h * p.cacheWrite1h) / 1e6;
}

/**
 * Adds one response's usage. With fallbacks, `usage.iterations` is the per-attempt source
 * of truth: attempts on the requested model are priced at its rates, `fallback_message`
 * attempts at the serving model's (the entry's `model`, else the response's `model`).
 */
export function accountMessage(t: UsageTotals, message: Pick<BetaMessage, 'usage' | 'model'>, requestedModel: string = MODEL): void {
  const usage: BetaUsage = message.usage;
  const iterations = (usage.iterations ?? []) as UsageLike[];
  if (iterations.length > 0) {
    for (const it of iterations) {
      if (it.type === 'fallback_message') t.fallbacks++;
      addUsage(t, it, it.type === 'fallback_message' ? message.model : requestedModel);
    }
  } else {
    addUsage(t, usage, message.model);
  }
}

export const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, fallbacks: 0 });

// ---------------------------------------------------------------------------
// The model loop
// ---------------------------------------------------------------------------

export type StopKind = 'end_turn' | 'refusal' | 'max_rounds' | 'budget' | 'max_tokens' | 'error';

export interface LoopOutcome {
  stop: StopKind;
  rounds: number;
  usage: UsageTotals;
  finalText: string;
  refusal?: { category: string | null; explanation: string | null } | undefined;
  error?: string | undefined;
}

class TruncatedToolInput extends Error {}

export interface RunResult {
  runId: number;
  kind: AgentRunKind;
  reportPath: string | null;
  csvPath: string | null;
  /** the first play proposed in this run (also in proposedPlays) */
  proposedPlay?: ProposedPlay | undefined;
  proposedPlays: ProposedPlay[];
  summary: string;
  costUsd: number;
  rounds: number;
  stop: StopKind;
  usage: UsageTotals;
  error?: string | undefined;
}

async function runModel(deps: AgentDeps, kind: AgentRunKind, runId: number, userMessage: string, state: RunState): Promise<LoopOutcome> {
  const { client, logger, limits } = deps;
  const usage = emptyUsage();
  let rounds = 0;
  const budgetNotice = (): string | null => {
    const roundsLeft = limits.maxRounds - rounds;
    if (roundsLeft > Math.max(3, limits.maxRounds * 0.25) && usage.costUsd < limits.maxCostUsd * 0.75) return null;
    return `Budget nearly used (${rounds}/${limits.maxRounds} rounds, ${usage.costUsd.toFixed(2)}/${limits.maxCostUsd} USD). Finish now: write_csv, write_report, propose_play if warranted, then the summary.`;
  };
  const tools = buildTools({ sql: deps.sql, rpc: deps.rpc, reportsDir: deps.reportsDir, runId, kind, logger, now: deps.now, state, budgetNotice });

  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' as const, display: 'summarized' as const },
    output_config: { effort: 'high' as const },
    system: [{ type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } }],
    cache_control: { type: 'ephemeral' as const },
    betas: [FALLBACK_BETA],
    tools,
    messages: [{ role: 'user' as const, content: userMessage }],
    stream: true as const,
    max_iterations: limits.maxRounds,
    // Server-side refusal fallbacks; not yet typed in SDK 0.90, passed through in the body.
    fallbacks: 'default' as const,
  };

  let runner = client.beta.messages.toolRunner(params);
  let jsonRetries = 0;
  let finalText = '';
  let stop: StopKind = 'end_turn';
  let refusal: LoopOutcome['refusal'];

  for (;;) {
    try {
      outer: for await (const messageStream of runner) {
        // SDK 0.90's stream accumulator drops message_delta.stop_details; keep it from the raw event.
        let streamedStopDetails: { category?: string | null; explanation?: string | null } | null = null;
        for await (const event of messageStream) {
          if (event.type === 'content_block_start') {
            const block = event.content_block as { type: string; name?: string };
            if (block.type === 'tool_use') logger.debug({ runId, tool: block.name }, 'tool_use streaming');
            if (block.type === 'fallback') logger.warn({ runId, block }, 'server-side fallback engaged');
          } else if (event.type === 'message_delta') {
            const sd = (event.delta as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
            if (sd) streamedStopDetails = sd;
          }
        }
        const message = await messageStream.finalMessage();
        jsonRetries = 0;
        rounds++;
        accountMessage(usage, message);
        const text = message.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text) finalText = text;
        for (const b of message.content) if (b.type === 'thinking' && b.thinking) logger.debug({ runId, thinking: b.thinking.slice(0, 2000) }, 'thinking');
        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        logger.info(
          { runId, round: rounds, stop_reason: message.stop_reason, tools: toolUses.map((b) => b.name), costUsd: Number(usage.costUsd.toFixed(4)), model: message.model },
          'model turn',
        );
        // A refusal can cut a tool_use off mid-input: never run that turn's tools.
        if (message.stop_reason === 'refusal') {
          stop = 'refusal';
          const sd = message.stop_details ?? streamedStopDetails;
          refusal = { category: sd?.category ?? null, explanation: sd?.explanation ?? null };
          logger.warn({ runId, refusal }, 'model refused');
          break outer;
        }
        // A truncated tool input can still pass schema validation: do not run it.
        if (message.stop_reason === 'max_tokens' && toolUses.length > 0) throw new TruncatedToolInput('tool input truncated at max_tokens');
        if (toolUses.length === 0) {
          stop = message.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn';
          continue; // the runner ends by itself when no tool is requested
        }
        if (usage.costUsd >= limits.maxCostUsd) {
          stop = 'budget';
          logger.warn({ runId, costUsd: usage.costUsd }, 'cost budget reached; stopping before the next turn');
          break outer;
        }
        if (rounds >= limits.maxRounds) stop = 'max_rounds'; // the runner executes this turn's tools, then stops (max_iterations)
      }
      return { stop, rounds, usage, finalText, refusal };
    } catch (err) {
      if (err instanceof Anthropic.APIError || err instanceof TruncatedToolInput || jsonRetries >= 2) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ runId, err: msg }, 'model loop failed');
        return { stop: 'error', rounds, usage, finalText, error: msg };
      }
      // Tool input JSON that could not be parsed at all (eager input streaming): re-issue the turn.
      jsonRetries++;
      logger.warn({ runId, err: String(err), attempt: jsonRetries }, 'unparseable tool input; re-issuing the turn');
      runner = client.beta.messages.toolRunner({ ...runner.params, stream: true, max_iterations: Math.max(1, limits.maxRounds - rounds) });
    }
  }
}

// ---------------------------------------------------------------------------
// Finalisation shared by play / scout runs
// ---------------------------------------------------------------------------

function stopNote(o: LoopOutcome): string | null {
  switch (o.stop) {
    case 'refusal':
      return `The model declined this request (${o.refusal?.category ?? 'no category'}${o.refusal?.explanation ? `: ${o.refusal.explanation}` : ''}).`;
    case 'max_rounds':
      return `Stopped at the tool-round limit (${o.rounds}).`;
    case 'budget':
      return `Stopped at the cost budget (${o.usage.costUsd.toFixed(2)} USD).`;
    case 'max_tokens':
      return 'The final answer hit max_tokens and may be cut off.';
    case 'error':
      return `Error: ${o.error ?? 'unknown'}`;
    default:
      return null;
  }
}

async function finalize(
  deps: AgentDeps,
  kind: AgentRunKind,
  runId: number,
  args: Record<string, unknown>,
  state: RunState,
  outcome: LoopOutcome,
  fallbackTokens: string[],
): Promise<RunResult> {
  const { logger } = deps;
  const notes: string[] = [];
  const note = stopNote(outcome);
  if (note) notes.push(note);

  // Every run returns a CSV and a report: fill in deterministically what the model did not write.
  const tokens = [...new Set([...fallbackTokens, ...state.tokensSeen])].slice(0, 200);
  const fx = state.ethUsd ?? resolveEthUsd(await getEthUsdSetting(deps.sql).catch(() => null));
  let rows: ReturnType<typeof buildCsvRow>[] = [];
  if ((!state.csvPath || !state.reportPath) && tokens.length) {
    try {
      rows = (await csvSources(deps.sql, tokens)).map((s) => buildCsvRow(s, fx.usd, { notes: 'auto-generated: the model did not write the CSV' }));
    } catch (err) {
      logger.warn({ runId, err: String(err) }, 'fallback CSV sources failed');
    }
  }
  if (!state.csvPath && rows.length) {
    state.csvPath = await writeOutput(deps.reportsDir, `${rows[0]!.symbol || 'play'}-run${runId}-auto`, 'csv', toCsv(rows), deps.now());
    notes.push('CSV auto-generated from the coins the model looked at.');
  }
  if (!state.reportPath) {
    const md = renderReport({
      title: `${kind === 'scout' ? 'Scout' : 'Play finder'} run #${runId} (incomplete)`,
      pattern: 'unknown',
      sections: {
        operatorSummary: outcome.finalText || 'The model did not write a report.',
        howFunded: 'Not established in this run.',
        howToCatch: 'Not established in this run.',
        recommendedPreset: 'None.',
        caveats: notes.join('\n') || 'Report generated automatically.',
      },
      coins: rows,
      ethUsd: fx,
      generatedAt: deps.now(),
      runId,
    });
    state.reportPath = await writeOutput(deps.reportsDir, `run${runId}-auto`, 'md', md, deps.now());
    state.reportMd = md;
  }

  const summary = [outcome.finalText.slice(0, 3000), ...notes].filter(Boolean).join('\n\n') || 'No summary.';
  const meta = {
    model: MODEL,
    stop: outcome.stop,
    rounds: outcome.rounds,
    usage: outcome.usage,
    toolCalls: state.toolCalls,
    refusal: outcome.refusal ?? null,
    error: outcome.error ?? null,
  };
  const proposed = state.proposedPlays.map((p) => ({ playId: p.playId, operatorId: p.operatorId, name: p.name, trigger: p.trigger, preset: p.preset }));
  await finishAgentRun(deps.sql, runId, {
    input: { args, meta },
    reportMd: state.reportMd,
    csvPath: state.csvPath,
    proposedPlay: proposed.length === 0 ? null : proposed.length === 1 ? proposed[0] : proposed,
    costUsd: outcome.usage.costUsd,
  });
  await insertEvent(deps.sql, {
    level: outcome.stop === 'error' ? 'error' : outcome.stop === 'end_turn' ? 'info' : 'warn',
    type: 'agent_run_finished',
    payload: { runId, kind, stop: outcome.stop, costUsd: outcome.usage.costUsd, reportPath: state.reportPath, csvPath: state.csvPath, playIds: proposed.map((p) => p.playId), summary: summary.slice(0, 1500) },
  });
  logger.info({ runId, kind, stop: outcome.stop, rounds: outcome.rounds, costUsd: outcome.usage.costUsd, report: state.reportPath, csv: state.csvPath }, 'run finished');
  return {
    runId,
    kind,
    reportPath: state.reportPath,
    csvPath: state.csvPath,
    proposedPlay: state.proposedPlays[0],
    proposedPlays: state.proposedPlays,
    summary,
    costUsd: outcome.usage.costUsd,
    rounds: outcome.rounds,
    stop: outcome.stop,
    usage: outcome.usage,
    error: outcome.error,
  };
}

// ---------------------------------------------------------------------------
// runPlayFinder
// ---------------------------------------------------------------------------

export interface PlayFinderArgs {
  ca: string;
  hint?: string | undefined;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function runPlayFinder(args: PlayFinderArgs, overrides?: Partial<AgentDeps>): Promise<RunResult> {
  if (!ADDRESS.test(args.ca.trim())) throw new Error(`invalid contract address: ${args.ca}`);
  const deps = resolveDeps(overrides);
  const ca = args.ca.trim().toLowerCase();
  const input = { ca, hint: args.hint?.slice(0, 500) };
  const runId = await insertAgentRun(deps.sql, 'play', input);
  const state = newRunState();
  const outcome = await runModel(deps, 'play', runId, playFinderMessage(input, deps.now(), deps.limits), state);
  return finalize(deps, 'play', runId, input, state, outcome, [ca]);
}

// ---------------------------------------------------------------------------
// runScout
// ---------------------------------------------------------------------------

export interface ScoutArgs {
  sinceMinutes: number;
  minPeak10Pct: number;
  /** clusters to investigate with the model this pass (default from env, 2) */
  maxClusters?: number | undefined;
}

export interface ScoutResult {
  runId: number;
  runners: number;
  clusters: Array<Pick<RunnerCluster, 'key' | 'covered' | 'coveredBy' | 'sharedFunders' | 'sharedTeamWallets' | 'sharedDeployers'> & { tokens: string[] }>;
  investigated: RunResult[];
  skippedCovered: number;
  reportPath: string;
  summary: string;
  costUsd: number;
}

export async function runScout(args: ScoutArgs, overrides?: Partial<AgentDeps>): Promise<ScoutResult> {
  const deps = resolveDeps(overrides);
  const { sql, logger } = deps;
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const input = { sinceMinutes: args.sinceMinutes, minPeak10Pct: args.minPeak10Pct };
  const runId = await insertAgentRun(sql, 'scout', input);

  // SQL first: runners in the window, their fingerprints, and the plays that already exist.
  const rows: RunnerRow[] = [];
  for (let offset = 0; offset < 600; offset += 200) {
    const page = await runners(sql, { sinceTs: nowSec - args.sinceMinutes * 60, minPeakPct: args.minPeak10Pct, window: 10, limit: 200, offset });
    rows.push(...page.rows);
    if (page.nextOffset === null) break;
  }
  const contexts = await launchContexts(
    sql,
    rows.map((r) => r.token),
  );
  const ctxMap = new Map<string, LaunchContext>(contexts.map((c) => [c.token, c]));
  const plays = (await activePlays(sql)).flatMap((p) => {
    const t = PlayTriggerSchema.safeParse(p.trigger);
    return t.success ? [{ playId: p.id, trigger: t.data }] : [];
  });
  const fps = rows.flatMap((r) => {
    const c = ctxMap.get(r.token);
    return c ? [fingerprintOf(c, { ts: r.ts, peakPct: r.peakPct })] : [];
  });
  const clusters = clusterRunners(fps, { ignore: deps.scout.ignore, plays, contexts: ctxMap, minSize: deps.scout.minClusterSize });
  const uncovered = clusters.filter((c) => !c.covered);
  const maxClusters = args.maxClusters ?? deps.scout.maxClusters;
  logger.info({ runId, runners: rows.length, clusters: clusters.length, uncovered: uncovered.length }, 'scout clusters');

  const investigated: RunResult[] = [];
  for (const cluster of uncovered.slice(0, maxClusters)) {
    const childInput = { cluster: cluster.key, tokens: cluster.tokens.map((t) => t.token), parentRunId: runId };
    const childId = await insertAgentRun(sql, 'scout', childInput);
    const state = newRunState();
    const outcome = await runModel(deps, 'scout', childId, scoutMessage(cluster, deps.now(), deps.limits), state);
    investigated.push(await finalize(deps, 'scout', childId, childInput, state, outcome, cluster.tokens.map((t) => t.token)));
  }

  const lines = [
    `# Scout run #${runId}`,
    '',
    `Window: last ${args.sinceMinutes} min, peak10 >= ${args.minPeak10Pct} %. Runners: ${rows.length}. Clusters (size >= ${deps.scout.minClusterSize}): ${clusters.length}, already covered: ${clusters.length - uncovered.length}, investigated: ${investigated.length}.`,
    '',
    ...clusters.map(
      (c) =>
        `- ${c.covered ? `covered by play ${c.coveredBy.join(', ')}` : 'NEW'}: ${c.tokens.length} coins (${c.tokens.map((t) => (t.name ?? t.token).replace(/[\r\n|]/g, ' ').slice(0, 30)).join(', ')}); funders ${c.sharedFunders.join(' ') || '-'}; team ${c.sharedTeamWallets.join(' ') || '-'}`,
    ),
    '',
    ...investigated.map((r) => `- run #${r.runId}: ${r.stop}, ${r.proposedPlays.length} play(s) proposed, report ${r.reportPath}`),
  ];
  const md = lines.join('\n') + '\n';
  const reportPath = await writeOutput(deps.reportsDir, `scout-run${runId}`, 'md', md, deps.now());
  const costUsd = investigated.reduce((s, r) => s + r.costUsd, 0);
  const summaryClusters = clusters.map((c) => ({
    key: c.key,
    covered: c.covered,
    coveredBy: c.coveredBy,
    sharedFunders: c.sharedFunders,
    sharedTeamWallets: c.sharedTeamWallets,
    sharedDeployers: c.sharedDeployers,
    tokens: c.tokens.map((t) => t.token),
  }));
  await finishAgentRun(sql, runId, {
    input: { args: input, meta: { runners: rows.length, clusters: summaryClusters, investigated: investigated.map((r) => r.runId) } },
    reportMd: md,
    csvPath: null,
    proposedPlay: null,
    costUsd,
  });
  const summary = `Scout: ${rows.length} runners, ${clusters.length} clusters, ${clusters.length - uncovered.length} covered, ${investigated.length} investigated, ${investigated.reduce((s, r) => s + r.proposedPlays.length, 0)} play(s) proposed.`;
  await insertEvent(sql, { level: 'info', type: 'scout_finished', payload: { runId, summary, reportPath, childRuns: investigated.map((r) => r.runId) } });
  return { runId, runners: rows.length, clusters: summaryClusters, investigated, skippedCovered: clusters.length - uncovered.length, reportPath, summary, costUsd };
}

// ---------------------------------------------------------------------------
// runBacktest (deterministic: no model call, cost 0)
// ---------------------------------------------------------------------------

export interface BacktestArgs {
  playId: number;
  sinceDays?: number | undefined;
}

export interface BacktestRunResult {
  runId: number;
  playId: number;
  coins: number;
  summary: string;
  stats: Omit<ReturnType<typeof backtestPlay>, 'perToken'>;
  best: ReturnType<typeof gridSearch>;
  reportPath: string;
  csvPath: string | null;
  costUsd: 0;
}

export async function runBacktest(args: BacktestArgs, overrides?: Partial<AgentDeps>): Promise<BacktestRunResult> {
  const deps = resolveDeps(overrides);
  const { sql } = deps;
  const play = await getPlay(sql, args.playId);
  if (!play) throw new Error(`play ${args.playId} not found`);
  const trigger = PlayTriggerSchema.parse(play.trigger);
  const preset = PresetSchema.parse({ ...DEFAULT_PRESET, ...(play.preset as Record<string, unknown>) });
  const input = { playId: args.playId, sinceDays: args.sinceDays ?? 30 };
  const runId = await insertAgentRun(sql, 'backtest', input);

  const sinceTs = Math.floor(deps.now().getTime() / 1000) - input.sinceDays * 86_400;
  const { tokens, candidates } = await tokensForTrigger(sql, trigger, sinceTs);
  const [items, rows] = await Promise.all([loadBacktestItems(sql, tokens), getTokens(sql, tokens)]);
  const report = backtestPlay(items, preset);
  const { perToken, ...stats } = report;
  const derived = derive(rows);
  const best = gridSearch(items, preset, defaultGrid(derived), { minN: 5, top: 5 });

  const fx = resolveEthUsd(await getEthUsdSetting(sql));
  const csvRows = (await csvSources(sql, tokens)).map((s) => {
    const r = perToken.find((p) => p.token === s.token.token);
    return buildCsvRow(s, fx.usd, { notes: r ? `backtest: ${r.exitReason} ${r.pnlPct.toFixed(1)} % in ${r.holdSec} s` : undefined });
  });
  const csvPath = csvRows.length ? await writeOutput(deps.reportsDir, `play${play.id}-backtest-run${runId}`, 'csv', toCsv(csvRows), deps.now()) : null;
  const pctf = (x: number): string => `${x.toFixed(1)} %`;
  const bestLines = best.insufficient
    ? [`Grid search skipped: ${best.n} coins < minimum ${best.minN}.`]
    : best.results.map(
        (g, i) =>
          `${i + 1}. TP ${g.preset.takeProfits.map((t) => `+${t.pct} %/${t.sellPct} %`).join(', ') || 'none'}, trailing ${g.preset.trailing ? `${g.preset.trailing.activatePct}/${g.preset.trailing.dropPct}` : 'off'}, SL ${g.preset.stopLossPct} %, timeout ${g.preset.timeoutSec ?? '-'} s -> expectancy ${g.summary.expectancyEth.toFixed(4)} ETH, win ${pctf(g.summary.winRate * 100)}, median ${pctf(g.summary.medianPnlPct)}, maxDD ${g.summary.maxDD.toFixed(4)} ETH`,
      );
  const md = renderReport({
    title: `Backtest of play #${play.id} ${play.name}`,
    pattern: 'unknown',
    sections: {
      operatorSummary: `Operator ${play.operatorName ?? '-'} (${play.operatorStatus ?? '-'}). ${candidates} candidate launches in the last ${input.sinceDays} days, ${tokens.length} matched the trigger.`,
      howFunded: 'See the trigger stored with the play.',
      howToCatch: '```json\n' + JSON.stringify(trigger, null, 2) + '\n```',
      recommendedPreset: [
        `Current preset: n ${stats.n}, win rate ${pctf(stats.winRate * 100)}, expectancy ${stats.expectancyEth.toFixed(4)} ETH per snipe, median ${pctf(stats.medianPnlPct)}, PnL sum ${stats.pnlSum.toFixed(4)} ETH, max drawdown ${stats.maxDD.toFixed(4)} ETH; exits ${JSON.stringify(stats.exitReasons)}.`,
        '',
        'Best presets by expectancy:',
        ...bestLines,
      ].join('\n'),
      caveats: 'Simulated fills assume we land first in the first +1 s block; exits are priced against the historical curve without our own buy. Small samples overfit.',
    },
    coins: csvRows,
    ethUsd: fx,
    generatedAt: deps.now(),
    runId,
    stats: rows.length ? peakStats(rows.map((t) => ({ peak2Pct: t.metrics?.peak2Pct ?? null, peak5Pct: t.metrics?.peak5Pct ?? null, peak10Pct: t.metrics?.peak10Pct ?? null, peak30Pct: t.metrics?.peak30Pct ?? null, peak60Pct: t.metrics?.peak60Pct ?? null, lowAfterEntryPct: t.metrics?.lowAfterEntryPct ?? null }))) : undefined,
    derived,
  });
  const reportPath = await writeOutput(deps.reportsDir, `play${play.id}-backtest-run${runId}`, 'md', md, deps.now());
  await updatePlayStats(sql, play.id, { backtest: stats, backtestAt: deps.now().toISOString(), backtestRunId: runId, gridBest: best.results[0]?.preset ?? null });
  await finishAgentRun(sql, runId, { input: { args: input, meta: { coins: tokens.length, candidates } }, reportMd: md, csvPath, proposedPlay: null, costUsd: 0 });
  const summary = `Play #${play.id} ${play.name}: ${stats.n} snipes over ${tokens.length} coins, win ${pctf(stats.winRate * 100)}, expectancy ${stats.expectancyEth.toFixed(4)} ETH, median ${pctf(stats.medianPnlPct)}, maxDD ${stats.maxDD.toFixed(4)} ETH.`;
  await insertEvent(sql, { level: 'info', type: 'backtest_finished', payload: { runId, playId: play.id, summary, reportPath, csvPath } });
  return { runId, playId: play.id, coins: tokens.length, summary, stats, best, reportPath, csvPath, costUsd: 0 };
}

export { DEFAULT_LIMITS };
