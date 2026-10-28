/** Internal sniper types (shared shapes come from @hood/core). */
import type { LaunchEvent, Play, Preset, Reserves } from '@hood/core';
import type { Address, Hex } from 'viem';

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
  block: number;
  ts: number;
  quoteIn: bigint;
  tokensOut: bigint;
  taxBps: number;
  taxPaid: bigint;
  /** effective entry price (quoteIn / tokensOut), ETH per whole token */
  entryPrice: number;
  txHash?: Hex;
  /** reserves right before the fill (paper) or after (live, if known) */
  reserves?: Reserves;
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
}
