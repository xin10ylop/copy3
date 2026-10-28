/** Internal sniper types (shared shapes come from @hood/core). */
import type { LaunchEvent, Play, Preset, Reserves } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { LaunchSecondLedger } from './ledger.js';

/** A launch seen on the feed (or recovered from a TokenLaunched log in fallback mode). */
export interface DetectedLaunch {
  event: LaunchEvent;
  /** launch block number / timestamp (whole seconds) */
  block: number;
  ts: number;
  /** local ms the launch block arrived */
  receivedAt: number;
  txHash: Hex;
  /** predicted or confirmed token/curve; undefined until resolved */
  token?: Address;
  curve?: Address;
  addressSource?: 'nonce' | 'log' | 'receipt' | 'fallback';
  source: 'feed' | 'log';
}

/** Output of the rules engine. */
export interface Decision {
  play: Play;
  preset: Preset;
  reasons: string[];
}

/** Totals of the launch second `T` (blocks with timestamp == launch timestamp), ETH. */
export interface LaunchSecondTotals {
  /** quote-in of curve buys to exempt non-deployer wallets (outside the launch tx) */
  teamBuyEth: number;
  /** distinct team wallets that bought */
  teamBuyers: number;
  /** launchAndBuy quote + curve buys to the deployer */
  devBuyEth: number;
}

/** What the launch-second ledger knows about one launch (see ledger.ts). */
export interface LaunchSecondStats {
  /** buys proven by a CurveBuy log (launch receipt, buy receipt or node log) */
  confirmed: LaunchSecondTotals;
  /** every buy seen so far: feed hints + confirmed buys, minus refuted (reverted) hints */
  seen: LaunchSecondTotals;
  /** exempt-wallet sells / token transfers out seen in the launch second */
  exemptOut: number;
  /** feed hints neither confirmed nor refuted yet */
  pending: number;
}

/**
 * `hint`: decide from the feed (seen totals, µs, before execution results exist).
 * `confirm`: before signing — minimums against confirmed totals, maximums against seen totals.
 */
export type LaunchSecondStage = 'hint' | 'confirm';

export interface BurstMember {
  index: number;
  nonce: number;
  hash: Hex;
  raw: Hex;
  scheduledAt: number;
  sentAt?: number;
  /** per-endpoint results */
  sends: { endpoint: string; sentAt: number; doneAt?: number; ok?: boolean; error?: string }[];
  status: 'planned' | 'sent' | 'mined' | 'reverted' | 'dropped' | 'skipped';
  block?: number;
  revertReason?: string;
}

export interface Fill {
  /** block of the buy (live: receipt; paper: simulated block; recovered: best known, see `recovered`) */
  block: number;
  ts: number;
  quoteIn: bigint;
  tokensOut: bigint;
  taxBps: number;
  taxPaid: bigint;
  /** effective entry price (quoteIn / tokensOut), ETH per whole token */
  entryPrice: number;
  txHash?: Hex;
  /** reserves the position book starts from (paper: before or after the fill block, see PAPER_FILL) */
  reserves?: Reserves;
  /** block number `reserves` were read at; logs at or below it are already contained (M5) */
  reservesBlock?: number;
  /** reconstructed from chain state (sniper.bought / balanceOf) because the receipts were missed (H3) */
  recovered?: boolean;
}

/** Ground truth of a launch from its receipt (H1). */
export interface LaunchConfirmation {
  token: Address;
  curve: Address;
  deployer: Address;
  /** SnipeTaxExempted(account) logs emitted by the curve in the launch receipt */
  exemptions: Address[];
  block: number;
}

export type SnipeStatus = 'pending' | 'open' | 'closed' | 'failed' | 'aborted';

/** In-memory record of one snipe (mirrors the `snipes` table). */
export interface SnipeRun {
  id: number;
  key: string;
  mode: 'live' | 'paper';
  playId: number;
  launch: DetectedLaunch;
  decision: Decision;
  status: SnipeStatus;
  decidedAt: number;
  quoteIn: bigint;
  minTokensOut: bigint;
  maxTaxBps: number;
  deadlineBlock: number;
  plan?: { times: number[]; boundaryMs: number; latestMs: number; droppedPast: number; clipped: number; rttMs: number };
  burst: BurstMember[];
  fill?: Fill;
  notes: string[];
  /** the launch receipt proved it (TokenLaunched from the factory with the same deployer) */
  confirmed?: boolean;
  /** why the run was aborted while members were possibly in flight (H2: a later fill exits at once) */
  abortReason?: string;
  /** risk slot released / run finished (guards double accounting) */
  ended?: boolean;
  /** the burst passed the last kill-switch / daily-loss check right before its first send (L2) */
  sendCleared?: boolean;
  /** executor key address that signed the burst (M1) */
  signer?: Address;
  /** launch-second ledger of the launch (launch-second plays: confirmation + last-moment re-check) */
  ledger?: LaunchSecondLedger;
}
