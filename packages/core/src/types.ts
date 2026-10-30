/**
 * Shared zod schemas + inferred types for HoodSniper (SPEC §4).
 *
 * All addresses are lower-cased hex strings; money is kept as `bigint` wei on
 * the hot path but presets/config use human `number` units (ETH, percent, bps)
 * exactly as in the video's TradeWiz/Packet Tracker UIs. `parsePreset` and
 * `parsePlay` apply the SPEC defaults.
 */
import { z } from 'zod';

/** 0x-prefixed 40-hex address, normalised to lower-case. */
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, 'invalid address')
  .transform((s) => s.toLowerCase() as `0x${string}`);
export type Address = z.infer<typeof AddressSchema>;

/** 0x-prefixed 32-byte hash, lower-cased. */
export const HashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, 'invalid hash')
  .transform((s) => s.toLowerCase() as `0x${string}`);
export type Hash = z.infer<typeof HashSchema>;

// ---------------------------------------------------------------------------
// Preset — one armed wallet / play's execution + risk parameters
// ---------------------------------------------------------------------------

export const BurstSchema = z.object({
  /** ms relative to the predicted T+1 second boundary to start firing (negative = before). */
  startMs: z.number().default(-120),
  /** ms between consecutive burst members. */
  spacingMs: z.number().positive().default(15),
  /** number of pre-signed txs in the burst. */
  count: z.number().int().positive().default(10),
});
export type Burst = z.infer<typeof BurstSchema>;

export const TakeProfitSchema = z.object({
  /** trigger at +pct% from entry. */
  pct: z.number(),
  /** sell this percent of the remaining position. */
  sellPct: z.number().min(0).max(100),
});
export type TakeProfit = z.infer<typeof TakeProfitSchema>;

export const TrailingSchema = z.object({
  /** arm the trailing stop once up this many percent. */
  activatePct: z.number(),
  /** exit when price drops this many percent from the peak. */
  dropPct: z.number(),
});
export type Trailing = z.infer<typeof TrailingSchema>;

/**
 * Position sizing. `fixed` buys `buyEth` every time (default). `bankroll` compounds: the buy is
 * `clamp(bankroll × fraction / maxConcurrent, minEth, maxEth)`, rounded down to 0.001 ETH, where
 * the bankroll is the PonsSniper contract's ETH balance (live) or PAPER_BANKROLL_ETH + realised
 * paper PnL (paper). Tax and fees are proportional to size, so the per-trade edge does not depend
 * on it; gas (~0.00004 ETH per burst) makes 0.01 ETH the practical floor.
 */
export const SizingSchema = z.object({
  mode: z.enum(['fixed', 'bankroll']).default('fixed'),
  /** share of the bankroll committed across MAX_CONCURRENT positions (0.25 → each gets 25 % / maxConcurrent). */
  fraction: z.number().positive().max(1).default(0.25),
  minEth: z.number().positive().default(0.01),
  maxEth: z.number().positive().default(0.3),
});
export type Sizing = z.infer<typeof SizingSchema>;

export const PresetSchema = z.object({
  /** buy size in `fixed` sizing mode (and the fallback label in `bankroll` mode). */
  buyEth: z.number().positive().default(0.07),
  sizing: SizingSchema.default({ mode: 'fixed', fraction: 0.25, minEth: 0.01, maxEth: 0.3 }),
  /** max snipe tax tolerated ("tax protection"), bps. 1000 = 10 %. */
  // ≥ 9900 would disable the gate (launch-second tax is 9900); anything above ~700 is pointless
  // because the schedule only takes 9900 / 618 / 19 / 0. PonsSniper also refuses ≥ 9900.
  maxTaxBps: z.number().int().min(0).max(5000).default(1000),
  /** slippage tolerance in bps; default 3000 plus impact-aware minOut (SPEC). */
  slippageBps: z.number().int().min(0).default(3000),
  burst: BurstSchema.default({ startMs: -120, spacingMs: 15, count: 10 }),
  /** 300k ran out of gas live on 29 Oct 2026 (a buy used 231k; a launcher-contract token needed more): a limit costs nothing unless consumed */
  gasLimit: z.number().int().positive().default(600_000),
  maxFeeGwei: z.number().positive().default(1),
  priorityFeeGwei: z.number().min(0).default(0),
  stopAfter: z.number().int().positive().default(1),
  firstBuyOnly: z.boolean().default(true),
  tokenCap: z.boolean().default(false),
  // Exit defaults = the preset the 3-day walk-forward picked (docs/BACKTEST.md, Backtest #2):
  // no fixed take-profit, trailing 50/20, SL 40 %, 60 s timeout, exit on the first exempt outflow.
  /** fixed take-profit ladder; default none (the trailing stop takes profit). */
  takeProfits: z.array(TakeProfitSchema).default([]),
  /** null disables the trailing stop; omitted = default (arm at +50 %, exit on a 20 % pull-back). */
  trailing: TrailingSchema.nullable().default({ activatePct: 50, dropPct: 20 }),
  stopLossPct: z.number().default(40),
  /** null disables the timeout. */
  timeoutSec: z.number().positive().nullable().default(60),
  minQuoteReserveEth: z.number().optional(),
  maxEntryMcapEth: z.number().optional(),
  abortIfExemptSellInLaunchBlock: z.boolean().default(true),
  /**
   * exit if exempt (team) wallets moved out ≥ this percent of their holding (transfer or sell).
   * Default 0 = exit on the FIRST exempt transfer-out/sell (dump exit on); omit-able per play.
   */
  /**
   * exit when exempt wallets have TRANSFERRED OUT (to a wallet other than the curve) at least this
   * % of their holding; null disables. This is the backtest's dump signal (bt_month.py: `dump` =
   * an exempt Transfer to a non-curve address). Exempt SELLS are price events the stop / trailing
   * handle, unless `dumpOnExemptSells` is on.
   */
  exitIfExemptSellsPct: z.number().min(0).nullable().default(0),
  /**
   * also count exempt wallets' curve SELLS as dump outflow. Off = the backtest's definition. On
   * (the live default until 30 Oct 2026) exited on the first partial team sell, seconds after
   * launch, while the replay of the same launches held through +53 % / +83 % runs: 20 live trades
   * −0.0017 ETH vs +0.0051 ETH replayed.
   */
  dumpOnExemptSells: z.boolean().default(false),
});
export type Preset = z.infer<typeof PresetSchema>;

/** Apply SPEC defaults to a partial preset. */
export function parsePreset(input: unknown): Preset {
  return PresetSchema.parse(input ?? {});
}

// ---------------------------------------------------------------------------
// PlayTrigger — how an incoming launch is matched to a play
// ---------------------------------------------------------------------------

export const ArmedWalletRuleSchema = z.object({
  funders: z.array(AddressSchema).default([]),
  minEth: z.number().min(0).default(0),
  maxEth: z.number().min(0).default(Number.MAX_SAFE_INTEGER),
  freshOnly: z.boolean().default(true),
  maxAgeSec: z.number().int().positive().default(48 * 3600),
  /** funder sends through a throwaway disperse contract (internal transfer). */
  contractMode: z.boolean().default(false),
});
export type ArmedWalletRule = z.infer<typeof ArmedWalletRuleSchema>;

export const TriggerFieldSchema = z.enum([
  'armedWallet',
  'deployerIn',
  'teamWalletsAny',
  'nameRegex',
  'symbolRegex',
  'launchSecond',
]);
export type TriggerField = z.infer<typeof TriggerFieldSchema>;

export const LaunchKindFilterSchema = z.enum(['any', 'noDevBuy', 'devBuy']);
export type LaunchKindFilter = z.infer<typeof LaunchKindFilterSchema>;

/**
 * Launch-second fingerprint (docs/BACKTEST.md): what happened in the launch second `T` (blocks
 * with timestamp == launch timestamp, 99 % snipe tax for everyone who is not exempt).
 *  - team buy = a curve buy whose recipient is in the launch's exempt set (deployer ∪
 *    creatorFeeRecipient ∪ SnipeTaxExempted) and is NOT the deployer, outside the launch tx;
 *  - dev buy  = the launchAndBuy quote plus curve buys to the deployer in the launch second.
 * All conditions must hold (AND). The rule always behaves as if listed in `require`.
 */
export const LaunchSecondRuleSchema = z.object({
  /** total ETH (quote-in) of team buys in the launch second, at least. */
  minTeamBuyEth: z.number().min(0).optional(),
  /** total ETH of team buys in the launch second, at most. */
  maxTeamBuyEth: z.number().min(0).optional(),
  /** distinct team wallets that bought in the launch second, at least. */
  minTeamBuyers: z.number().int().min(0).optional(),
  /** dev buy (launchAndBuy quote + deployer buys in the launch second), at least. */
  minDevBuyEth: z.number().min(0).optional(),
  /** dev buy, at most. */
  maxDevBuyEth: z.number().min(0).optional(),
  /** no dev buy at all in the launch second. */
  requireNoDevBuy: z.boolean().optional(),
});
export type LaunchSecondRule = z.infer<typeof LaunchSecondRuleSchema>;

/**
 * A launch-second rule counts as a matcher on its own (a trigger may consist of it alone) only
 * when it demands that someone spent ETH in the launch second: `minTeamBuyEth > 0`,
 * `minTeamBuyers ≥ 1` or `minDevBuyEth > 0`. Otherwise it is only a filter (e.g.
 * `requireNoDevBuy` alone would match almost every launch).
 */
export function launchSecondIsMatcher(rule: LaunchSecondRule | undefined | null): boolean {
  if (!rule) return false;
  return (rule.minTeamBuyEth ?? 0) > 0 || (rule.minTeamBuyers ?? 0) >= 1 || (rule.minDevBuyEth ?? 0) > 0;
}

export const PlayTriggerSchema = z.object({
  armedWallet: ArmedWalletRuleSchema.optional(),
  deployerIn: z.array(AddressSchema).optional(),
  /** match a launch's exemptions ∪ creatorFeeRecipient. */
  teamWalletsAny: z.array(AddressSchema).optional(),
  nameRegex: z.string().optional(),
  symbolRegex: z.string().optional(),
  launchKind: LaunchKindFilterSchema.default('any'),
  minDevBuyEth: z.number().optional(),
  maxDevBuyEth: z.number().optional(),
  /** launch-second fingerprint (team / dev buys in the launch second); always AND. */
  launchSecond: LaunchSecondRuleSchema.optional(),
  /** blacklist (AND): never match a launch whose deployer (or tx sender) is listed. */
  deployerNotIn: z.array(AddressSchema).optional(),
  /** blacklist (AND): never match a launch whose team set (exemptions ∪ creatorFeeRecipient) contains a listed wallet. */
  teamWalletsNotIn: z.array(AddressSchema).optional(),
  /** fields that MUST all match (AND); the rest are OR-combined. */
  require: z.array(TriggerFieldSchema).default([]),
});
export type PlayTrigger = z.infer<typeof PlayTriggerSchema>;

// ---------------------------------------------------------------------------
// Play — operator fingerprint → trigger + preset
// ---------------------------------------------------------------------------

export const PlaySchema = z.object({
  id: z.number().int().optional(),
  operatorId: z.number().int().optional(),
  name: z.string().default(''),
  enabled: z.boolean().default(false),
  trigger: PlayTriggerSchema,
  preset: PresetSchema,
  createdBy: z.string().optional(),
  stats: z.record(z.string(), z.unknown()).default({}),
});
export type Play = z.infer<typeof PlaySchema>;

/** Apply SPEC defaults to a partial play (trigger + preset defaulted). */
export function parsePlay(input: unknown): Play {
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return PlaySchema.parse({
    ...obj,
    trigger: PlayTriggerSchema.parse(obj.trigger ?? {}),
    preset: PresetSchema.parse(obj.preset ?? {}),
  });
}

// ---------------------------------------------------------------------------
// ArmedCandidate — a wallet funded by a tracked funder, waiting to launch
// ---------------------------------------------------------------------------

export const ArmedStatusSchema = z.enum(['armed', 'fired', 'expired', 'disarmed']);
export type ArmedStatus = z.infer<typeof ArmedStatusSchema>;

export const ArmedCandidateSchema = z.object({
  id: z.number().int().optional(),
  playId: z.number().int(),
  wallet: AddressSchema,
  sourceFunder: AddressSchema.optional(),
  fundedValue: z.bigint().nonnegative().optional(),
  fundedTx: HashSchema.optional(),
  armedAt: z.date().optional(),
  expiresAt: z.date().optional(),
  status: ArmedStatusSchema.default('armed'),
});
export type ArmedCandidate = z.infer<typeof ArmedCandidateSchema>;

// ---------------------------------------------------------------------------
// LaunchEvent — a decoded launch (from feed tx and/or TokenLaunched log)
// ---------------------------------------------------------------------------

export const LaunchKindSchema = z.enum(['launchToken', 'launchAndBuy', 'launchTokenFor']);
export type LaunchKind = z.infer<typeof LaunchKindSchema>;

export const LaunchEventSchema = z.object({
  deployer: AddressSchema,
  token: AddressSchema.optional(),
  curve: AddressSchema.optional(),
  name: z.string(),
  symbol: z.string(),
  launchKind: LaunchKindSchema,
  /** deployer ∪ creatorFeeRecipient ∪ explicit snipeTaxExemptions. */
  exemptions: z.array(AddressSchema).default([]),
  creatorFeeRecipient: AddressSchema,
  creatorTaxBps: z.number().int().min(0),
  /** quote-in of the launch tx's own buy (launchAndBuy, or a launcher contract's bundled buy) in wei; 0 otherwise. */
  devBuyQuoteIn: z.bigint().nonnegative().default(0n),
  /**
   * recipient of that buy when it is not the deployer (launchAndBuy `recipient`, or the receipt's
   * CurveBuy). Launcher contracts (0x6319…) launch for a fresh deployer wallet while the tx
   * sender, exempted in the same tx, buys 0.2–0.8 ETH: that is a TEAM buy (the backtest's
   * definition: exempt recipient ≠ deployer), not a dev buy.
   */
  devBuyRecipient: AddressSchema.optional(),
  pairToken: AddressSchema,
  launchConfigId: z.bigint().nonnegative().default(0n),
  block: z.number().int().optional(),
  ts: z.number().int().optional(),
  txHash: HashSchema.optional(),
  /** the EOA that signed the launch tx. */
  txFrom: AddressSchema.optional(),
  /** the contract the launch tx was sent to (factory or router). */
  launcher: AddressSchema.optional(),
});
export type LaunchEvent = z.infer<typeof LaunchEventSchema>;

// ---------------------------------------------------------------------------
// Snipe — a decision + its burst + fills + exits
// ---------------------------------------------------------------------------

export const SnipeModeSchema = z.enum(['live', 'paper']);
export type SnipeMode = z.infer<typeof SnipeModeSchema>;

export const SnipeStatusSchema = z.enum(['pending', 'open', 'closed', 'failed', 'aborted']);
export type SnipeStatus = z.infer<typeof SnipeStatusSchema>;

export const BurstTxStatusSchema = z.enum(['sent', 'mined', 'reverted', 'dropped', 'skipped']);
export type BurstTxStatus = z.infer<typeof BurstTxStatusSchema>;

export const BurstTxSchema = z.object({
  nonce: z.number().int().nonnegative(),
  hash: HashSchema.optional(),
  sentAt: z.number().int(),
  endpoint: z.string(),
  status: BurstTxStatusSchema,
  block: z.number().int().optional(),
  ts: z.number().int().optional(),
});
export type BurstTx = z.infer<typeof BurstTxSchema>;

export const SnipeSellSchema = z.object({
  reason: z.string(),
  tokensIn: z.bigint().nonnegative(),
  quoteOut: z.bigint().nonnegative(),
  txHash: HashSchema.optional(),
  block: z.number().int().optional(),
  ts: z.number().int().optional(),
});
export type SnipeSell = z.infer<typeof SnipeSellSchema>;

export const SnipeSchema = z.object({
  id: z.number().int().optional(),
  playId: z.number().int(),
  token: AddressSchema,
  curve: AddressSchema,
  decidedAt: z.date().optional(),
  decision: z.record(z.string(), z.unknown()).default({}),
  mode: SnipeModeSchema.default('paper'),
  burst: z.array(BurstTxSchema).default([]),
  buyBlock: z.number().int().optional(),
  buyTs: z.number().int().optional(),
  quoteIn: z.bigint().nonnegative().optional(),
  tokensOut: z.bigint().nonnegative().optional(),
  taxPaid: z.bigint().nonnegative().optional(),
  entryPrice: z.number().optional(),
  status: SnipeStatusSchema.default('pending'),
  sells: z.array(SnipeSellSchema).default([]),
  realizedPnlEth: z.number().optional(),
  notes: z.string().optional(),
});
export type Snipe = z.infer<typeof SnipeSchema>;

// ---------------------------------------------------------------------------
// Position — live view of an open snipe for the position manager
// ---------------------------------------------------------------------------

export const PositionSchema = z.object({
  snipeId: z.number().int().optional(),
  token: AddressSchema,
  curve: AddressSchema,
  tokensHeld: z.bigint().nonnegative(),
  entryPrice: z.number(),
  entryTs: z.number().int(),
  peakPrice: z.number(),
  trailingArmed: z.boolean().default(false),
  realizedQuote: z.bigint().nonnegative().default(0n),
  status: SnipeStatusSchema.default('open'),
});
export type Position = z.infer<typeof PositionSchema>;
