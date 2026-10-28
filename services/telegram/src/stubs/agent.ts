/**
 * ============================================================================
 * STUB - used only when services/agent's runner cannot be loaded (see wiring.ts).
 * ============================================================================
 * Real implementation: services/agent/src/runner.ts (runPlayFinder, runScout, runBacktest).
 * Every call fails with ServiceUnavailableError so /play, /scout and /backtest answer
 * "agent not available" instead of crashing the bot.
 */
import { ServiceUnavailableError, type AgentPort, type AgentRunSummary } from '../ports.js';

export function stubAgentPort(reason: string): AgentPort {
  const fail = async (): Promise<AgentRunSummary> => {
    throw new ServiceUnavailableError(`agent not available: ${reason}`);
  };
  return { available: false, runPlayFinder: fail, runScout: fail, runBacktest: fail };
}
