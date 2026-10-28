/** Public surface of @hood/agent (used by services/telegram). */
export {
  runPlayFinder,
  runScout,
  runBacktest,
  createAgentDeps,
  setDefaultDeps,
  accountMessage,
  MODEL,
  PRICES,
  type AgentDeps,
  type AgentLimits,
  type RunResult,
  type ScoutArgs,
  type ScoutResult,
  type BacktestArgs,
  type BacktestRunResult,
  type PlayFinderArgs,
  type StopKind,
  type UsageTotals,
} from './runner.js';
export type { ProposedPlay, RunState, ToolCallLog } from './tools.js';
export { simulateSnipe, backtestPlay, gridSearch, derivePresetFromPeaks, peakStats } from './backtest.js';
export type { BacktestItem, BacktestLaunch, BacktestTrade, BacktestTransfer, SimPreset, SnipeResult, BacktestSummary } from './backtest.js';
export { CSV_COLUMNS, type CsvRow } from './report.js';
export { DEFAULT_PRESET } from './defaults.js';
export { loadEnv, type AgentEnv } from './config.js';
export { tagged, type Db, type Queryable } from './db.js';
