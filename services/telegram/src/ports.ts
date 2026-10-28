/**
 * Ports to the other services the bot drives in-process:
 *   services/agent   runPlayFinder({ca}), runScout({sinceMinutes, minPeak10Pct}), runBacktest({playId})
 *   services/tracker buildWatchPlay({funder, minEth, maxEth, fresh, name, preset})
 * `wiring.ts` binds them to the real modules (or to the clearly marked stubs in src/stubs/).
 * Results are normalised defensively so a shape change on the other side degrades the message,
 * not the bot.
 */
import { PlayTriggerSchema, PresetSchema, type Preset } from '@hood/core';

export interface AgentRunSummary {
  runId: number | null;
  summary: string;
  reportPath: string | null;
  csvPath: string | null;
  proposedPlayIds: number[];
  costUsd: number | null;
  error: string | null;
}

export interface ScoutInput {
  sinceMinutes: number;
  minPeak10Pct: number;
}

export interface AgentPort {
  /** false when bound to the stub (commands answer "agent not available") */
  readonly available: boolean;
  runPlayFinder(input: { ca: string }): Promise<AgentRunSummary>;
  runScout(input: ScoutInput): Promise<AgentRunSummary>;
  runBacktest(input: { playId: number }): Promise<AgentRunSummary>;
}

export interface WatchPlayInput {
  funder: string;
  minEth: number;
  maxEth: number;
  fresh: boolean;
  name?: string;
  preset?: Preset;
}

export interface WatchPlay {
  name: string;
  trigger: unknown;
  preset: Preset;
  operatorId: number | null;
}

export interface TrackerPort {
  readonly available: boolean;
  buildWatchPlay(input: WatchPlayInput): Promise<WatchPlay>;
}

export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Accepts services/agent's RunResult / ScoutResult / BacktestRunResult (or anything close):
 * summary|finalText, reportPath, csvPath, proposedPlays[].playId | proposedPlay(s), costUsd, runId,
 * error; scout results also carry `investigated[]` child runs whose proposals are collected.
 */
export function normalizeAgentResult(raw: unknown): AgentRunSummary {
  if (typeof raw === 'string') {
    return { runId: null, summary: raw, reportPath: null, csvPath: null, proposedPlayIds: [], costUsd: null, error: null };
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ids = new Set<number>();
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      const id = num((v as Record<string, unknown>).playId) ?? num((v as Record<string, unknown>).id);
      if (id !== null) ids.add(id);
    } else if (typeof v === 'number' && Number.isInteger(v)) ids.add(v);
  };
  collect(o.proposedPlays);
  collect(o.proposedPlay);
  collect(o.proposedPlayIds);
  collect(o.playIds);
  if (Array.isArray(o.investigated)) for (const child of o.investigated) normalizeAgentResult(child).proposedPlayIds.forEach((i) => ids.add(i));
  return {
    runId: num(o.runId) ?? num(o.id),
    summary: str(o.summary) ?? str(o.finalText) ?? str(o.text) ?? '',
    reportPath: str(o.reportPath),
    csvPath: str(o.csvPath),
    proposedPlayIds: [...ids],
    costUsd: num(o.costUsd),
    error: str(o.error),
  };
}

/**
 * Accepts what services/tracker's buildWatchPlay returns: a Play-like object with `trigger` and
 * `preset` (both validated with the core schemas here, so a bad play never reaches the DB).
 */
export function normalizeWatchPlay(raw: unknown, fallbackName: string): WatchPlay {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const trigger = PlayTriggerSchema.parse(o.trigger);
  if (!trigger.armedWallet) throw new Error('buildWatchPlay returned a trigger without armedWallet');
  return {
    name: str(o.name) ?? fallbackName,
    trigger,
    preset: PresetSchema.parse(o.preset ?? {}),
    operatorId: num(o.operatorId),
  };
}
