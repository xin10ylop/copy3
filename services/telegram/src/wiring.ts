/**
 * Binds the agent/tracker ports to the real modules at runtime.
 *
 * The bot imports them dynamically (by package name first, then by the source path the SPEC
 * names) instead of statically, so the Telegram service builds, typechecks and runs while the
 * other services evolve; whatever is missing falls back to the stubs in src/stubs/ with a warning.
 */
import type { Logger } from 'pino';
import { normalizeAgentResult, normalizeWatchPlay, type AgentPort, type TrackerPort, type WatchPlayInput } from './ports.js';
import { stubAgentPort } from './stubs/agent.js';
import { stubTrackerPort } from './stubs/tracker.js';

export type ModuleLoader = (specifier: string) => Promise<unknown>;

const dynamicImport: ModuleLoader = (specifier) => import(specifier);

type AnyFn = (...args: unknown[]) => unknown;
const fnOf = (mod: unknown, name: string): AnyFn | null => {
  const f = mod && typeof mod === 'object' ? (mod as Record<string, unknown>)[name] : undefined;
  return typeof f === 'function' ? (f as AnyFn) : null;
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const AGENT_MODULES = ['@hood/agent', new URL('../../agent/src/runner.ts', import.meta.url).href];
export const TRACKER_MODULES = ['@hood/tracker', new URL('../../tracker/src/watch.ts', import.meta.url).href];

export async function loadAgentPort(log: Pick<Logger, 'info' | 'warn'>, load: ModuleLoader = dynamicImport, specs = AGENT_MODULES): Promise<AgentPort> {
  const problems: string[] = [];
  for (const spec of specs) {
    try {
      const mod = await load(spec);
      const play = fnOf(mod, 'runPlayFinder');
      const scout = fnOf(mod, 'runScout');
      const backtest = fnOf(mod, 'runBacktest');
      if (play && scout && backtest) {
        log.info({ module: spec }, 'agent runner bound');
        return {
          available: true,
          runPlayFinder: async (input) => normalizeAgentResult(await play(input)),
          runScout: async (input) => normalizeAgentResult(await scout(input)),
          runBacktest: async (input) => normalizeAgentResult(await backtest(input)),
        };
      }
      problems.push(`${spec}: no runPlayFinder/runScout/runBacktest exports`);
    } catch (e) {
      problems.push(`${spec}: ${errMsg(e)}`);
    }
  }
  log.warn({ problems }, 'agent runner not available - /play, /scout, /backtest use the stub');
  return stubAgentPort(problems.join('; '));
}

export async function loadTrackerPort(log: Pick<Logger, 'info' | 'warn'>, load: ModuleLoader = dynamicImport, specs = TRACKER_MODULES): Promise<TrackerPort> {
  const problems: string[] = [];
  for (const spec of specs) {
    try {
      const mod = await load(spec);
      const build = fnOf(mod, 'buildWatchPlay');
      if (build) {
        log.info({ module: spec }, 'tracker buildWatchPlay bound');
        return {
          available: true,
          buildWatchPlay: async (input: WatchPlayInput) =>
            normalizeWatchPlay(await Promise.resolve(build(input)), input.name ?? `watch ${input.funder.slice(0, 8)}`),
        };
      }
      problems.push(`${spec}: no buildWatchPlay export`);
    } catch (e) {
      problems.push(`${spec}: ${errMsg(e)}`);
    }
  }
  log.warn({ problems }, 'tracker buildWatchPlay not available - /watch uses the local stub');
  return stubTrackerPort();
}
