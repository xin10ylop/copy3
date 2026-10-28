/**
 * Pure funding-trail matcher (docs/SPEC.md §3 tracker, docs/ARCHITECTURE.md §1).
 *
 * A transfer arms (play, recipient) when, for a play with `trigger.armedWallet`:
 *  1. funder: `from` is a listed funder ("direct"), or - in contractMode - `from`
 *     is a contract created by a funder in the same tx or within
 *     `contractMaxAgeBlocks` ("contract"), or the transfer is an internal transfer
 *     inside a tx sent by a funder, e.g. through a public disperse contract ("sameTx");
 *  2. value ∈ [minEth, maxEth] (inclusive, compared in wei);
 *  3. recipient is not a contract and not itself a funder;
 *  4. freshOnly: recipient had no earlier eth_transfers and nonce 0 at first funding;
 *  5. not already armed for that play.
 */
import type { ArmedWalletRule } from '@hood/core';
import { ethToWei, type Address, type Hex, type TransferKind } from '@hood/indexer';

export interface TransferEvent {
  id: number;
  block: number;
  ts: number;
  txHash: Hex;
  traceAddr: string;
  from: Address;
  to: Address;
  value: bigint;
  kind: TransferKind;
}

export interface WatchPlay {
  id: number;
  name: string;
  rule: ArmedWalletRule;
  /** preset.stopAfter: disarm remaining candidates once this many fired */
  stopAfter: number;
}

/** an eth_transfers kind='create' row: `creator` created `contract` */
export interface ContractOrigin {
  contract: Address;
  creator: Address;
  block: number;
  txHash: Hex;
}

export interface RecipientFacts {
  /** eth_transfers rows involving the recipient (in or out) before this transfer */
  priorTransfers: number;
  txCountAtFirstFunding: number | null;
  firstFundingTx: Hex | null;
  isContract: boolean | null;
}

export type MatchVia = 'direct' | 'contract' | 'sameTx';

export interface FunderMatch {
  via: MatchVia;
  funder: Address;
}

export interface MatchFacts {
  recipient: RecipientFacts | null;
  /** creations of `transfer.from` (when it is a contract) */
  origins: readonly ContractOrigin[];
  /** sender of the top-level tx (from the tx's trace_addr '' row), when known */
  txSender: Address | null;
  /** `${playId}:${wallet}` already armed (any status) */
  armed: ReadonlySet<string>;
}

export interface MatchOptions {
  now: Date;
  contractMaxAgeBlocks: number;
  /** treat an unknown nonce at first funding as fresh (default false = conservative) */
  unknownNonceIsFresh?: boolean;
}

export interface ArmDecision {
  playId: number;
  playName: string;
  wallet: Address;
  sourceFunder: Address;
  via: MatchVia;
  value: bigint;
  txHash: Hex;
  block: number;
  expiresAt: Date;
}

export type RejectReason =
  | 'kind'
  | 'funder'
  | 'range'
  | 'contract_recipient'
  | 'funder_recipient'
  | 'not_fresh'
  | 'nonce_unknown'
  | 'duplicate';

export interface Rejection {
  playId: number;
  reason: RejectReason;
}

export interface MatchResult {
  arms: ArmDecision[];
  rejections: Rejection[];
}

export const armedKey = (playId: number, wallet: string) => `${playId}:${wallet.toLowerCase()}`;

const funderSet = (rule: ArmedWalletRule) => new Set(rule.funders.map((f) => f.toLowerCase()));

/** Step 1 only (no DB facts needed except origins/txSender). */
export function funderMatch(
  t: Pick<TransferEvent, 'from' | 'kind' | 'block' | 'txHash'>,
  rule: ArmedWalletRule,
  ctx: { origins: readonly ContractOrigin[]; txSender: Address | null; contractMaxAgeBlocks: number },
): FunderMatch | null {
  if (t.kind === 'create') return null;
  const funders = funderSet(rule);
  if (funders.has(t.from)) return { via: 'direct', funder: t.from };
  if (!rule.contractMode) return null;
  const origin = ctx.origins.find(
    (o) =>
      o.contract === t.from &&
      funders.has(o.creator) &&
      (o.txHash === t.txHash || (o.block <= t.block && t.block - o.block <= ctx.contractMaxAgeBlocks)),
  );
  if (origin) return { via: 'contract', funder: origin.creator };
  if (t.kind === 'internal' && ctx.txSender && funders.has(ctx.txSender)) return { via: 'sameTx', funder: ctx.txSender };
  return null;
}

export function inRange(value: bigint, rule: Pick<ArmedWalletRule, 'minEth' | 'maxEth'>): boolean {
  const max = Number.isFinite(rule.maxEth) && rule.maxEth < Number.MAX_SAFE_INTEGER ? ethToWei(rule.maxEth) : null;
  return value >= ethToWei(rule.minEth) && (max === null || value <= max);
}

export function isFresh(
  t: Pick<TransferEvent, 'txHash'>,
  r: RecipientFacts,
  unknownNonceIsFresh = false,
): { fresh: true } | { fresh: false; reason: 'not_fresh' | 'nonce_unknown' } {
  if (r.priorTransfers > 0) return { fresh: false, reason: 'not_fresh' };
  if (r.firstFundingTx !== null && r.firstFundingTx !== t.txHash) return { fresh: false, reason: 'not_fresh' };
  if (r.txCountAtFirstFunding === null) return unknownNonceIsFresh ? { fresh: true } : { fresh: false, reason: 'nonce_unknown' };
  return r.txCountAtFirstFunding === 0 ? { fresh: true } : { fresh: false, reason: 'not_fresh' };
}

export function matchTransfer(
  t: TransferEvent,
  plays: readonly WatchPlay[],
  facts: MatchFacts,
  opts: MatchOptions,
): MatchResult {
  const res: MatchResult = { arms: [], rejections: [] };
  for (const play of plays) {
    const rule = play.rule;
    const reject = (reason: RejectReason) => res.rejections.push({ playId: play.id, reason });
    if (t.kind === 'create') {
      reject('kind');
      continue;
    }
    const fm = funderMatch(t, rule, { origins: facts.origins, txSender: facts.txSender, contractMaxAgeBlocks: opts.contractMaxAgeBlocks });
    if (!fm) {
      reject('funder');
      continue;
    }
    if (!inRange(t.value, rule)) {
      reject('range');
      continue;
    }
    if (funderSet(rule).has(t.to)) {
      reject('funder_recipient');
      continue;
    }
    if (facts.recipient?.isContract === true) {
      reject('contract_recipient');
      continue;
    }
    if (rule.freshOnly) {
      const f = facts.recipient
        ? isFresh(t, facts.recipient, opts.unknownNonceIsFresh)
        : ({ fresh: false, reason: 'nonce_unknown' } as const);
      if (!f.fresh) {
        reject(f.reason);
        continue;
      }
    }
    if (facts.armed.has(armedKey(play.id, t.to)) || res.arms.some((a) => a.playId === play.id && a.wallet === t.to)) {
      reject('duplicate');
      continue;
    }
    res.arms.push({
      playId: play.id,
      playName: play.name,
      wallet: t.to,
      sourceFunder: fm.funder,
      via: fm.via,
      value: t.value,
      txHash: t.txHash,
      block: t.block,
      expiresAt: new Date(opts.now.getTime() + rule.maxAgeSec * 1000),
    });
  }
  return res;
}
