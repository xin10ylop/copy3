import type { Preset } from './deps.js';

/** SPEC §4 defaults (the video's TradeWiz settings, adapted): 0.07 ETH at +1 s, 10 % tax protection. */
export const DEFAULT_PRESET: Preset = {
  buyEth: 0.07,
  maxTaxBps: 1000,
  slippageBps: 3000,
  burst: { startMs: -120, spacingMs: 15, count: 10 },
  gasLimit: 600_000,
  maxFeeGwei: 1,
  priorityFeeGwei: 0,
  stopAfter: 1,
  firstBuyOnly: true,
  tokenCap: true,
  takeProfits: [{ pct: 150, sellPct: 100 }],
  trailing: { activatePct: 100, dropPct: 25 },
  stopLossPct: 40,
  timeoutSec: 120,
  abortIfExemptSellInLaunchBlock: true,
};

/** Limits for one model run. */
export const DEFAULT_LIMITS = {
  maxRounds: 60,
  maxCostUsd: 8,
  maxProposalsPerRun: 3,
} as const;
