import { PresetSchema, type Preset } from './deps.js';

/**
 * SPEC §4 defaults from core (0.07 ETH at +1 s, 10 % tax protection, TP +150 %,
 * trailing 100/25, SL 40 %) plus a 120 s timeout for the agent's backtests/proposals.
 */
export const DEFAULT_PRESET: Preset = PresetSchema.parse({ timeoutSec: 120 });

/** Limits for one model run. */
export const DEFAULT_LIMITS = {
  maxRounds: 60,
  maxCostUsd: 8,
  maxProposalsPerRun: 3,
} as const;
