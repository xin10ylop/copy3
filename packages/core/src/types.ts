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

export const PresetSchema = z.object({
  buyEth: z.number().positive().default(0.07),
  /** max snipe tax tolerated ("tax protection"), bps. 1000 = 10 %. */
  // ≥ 9900 would disable the gate (launch-second tax is 9900); anything above ~700 is pointless
  // because the schedule only takes 9900 / 618 / 19 / 0. PonsSniper also refuses ≥ 9900.
  maxTaxBps: z.number().int().min(0).max(5000).default(1000),
  /** slippage tolerance in bps; default 3000 plus impact-aware minOut (SPEC). */
  slippageBps: z.number().int().min(0).default(3000),
  burst: BurstSchema.default({ startMs: -120, spacingMs: 15, count: 10 }),
  gasLimit: z.number().int().positive().default(300_000),
  maxFeeGwei: z.number().positive().default(1),
  priorityFeeGwei: z.number().min(0).default(0),
  stopAfter: z.number().int().positive().default(1),
  firstBuyOnly: z.boolean().default(true),
  tokenCap: z.boolean().default(false),
  takeProfits: z.array(TakeProfitSchema).default([{ pct: 150, sellPct: 100 }]),
  /** null disables the trailing stop; omitted = SPEC default. */
  trailing: TrailingSchema.nullable().default({ activatePct: 100, dropPct: 25 }),
  stopLossPct: z.number().default(40),
  timeoutSec: z.number().positive().optional(),
  minQuoteReserveEth: z.number().optional(),
  maxEntryMcapEth: z.number().optional(),
  abortIfExemptSellInLaunchBlock: z.boolean().default(true),
  /** exit if an exempt wallet dumps ≥ this percent of its holding (via transfer or sell). */
  exitIfExemptSellsPct: z.number().optional(),
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
]);
export type TriggerField = z.infer<typeof TriggerFieldSchema>;

export const LaunchKindFilterSchema = z.enum(['any', 'noDevBuy', 'devBuy']);
export type LaunchKindFilter = z.infer<typeof LaunchKindFilterSchema>;

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
  /** dev-buy quote-in for launchAndBuy (wei); 0 otherwise. */
  devBuyQuoteIn: z.bigint().nonnegative().default(0n),
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
