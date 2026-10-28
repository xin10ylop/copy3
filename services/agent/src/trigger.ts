/**
 * Pure PlayTrigger evaluation against a historical launch (used to select a play's
 * launches for backtests and to decide whether a scout cluster is already covered).
 *
 * SPEC §4 semantics (same as services/sniper/src/rules.ts): conditions listed in `require`
 * must all hold; the remaining specified identity conditions are OR-ed (at least one must hold
 * when any exist). `launchKind`, the dev-buy range and the blacklists (`deployerNotIn`,
 * `teamWalletsNotIn`) are hard filters. `launchSecond` (team / dev buys in the launch second,
 * from curve_trades) always has to hold, and counts as a condition on its own only when it
 * demands ETH (`launchSecondIsMatcher`). A trigger with no condition matches nothing.
 */
import { launchSecondIsMatcher } from './deps.js';

export type TriggerCondition = 'armedWallet' | 'deployerIn' | 'teamWalletsAny' | 'nameRegex' | 'symbolRegex' | 'launchSecond';
export type IdentityCondition = Exclude<TriggerCondition, 'launchSecond'>;

/** Structural view of core's LaunchSecondRule. */
export interface LaunchSecondLike {
  minTeamBuyEth?: number | undefined;
  maxTeamBuyEth?: number | undefined;
  minTeamBuyers?: number | undefined;
  minDevBuyEth?: number | undefined;
  maxDevBuyEth?: number | undefined;
  requireNoDevBuy?: boolean | undefined;
}

/** Launch-second totals of a historical launch (curve_trades in second 0 joined with the exempt set). */
export interface LaunchSecondFacts {
  /** quote-in of buys to exempt non-deployer wallets outside the launch tx, ETH */
  teamBuyEth: number;
  teamBuyers: number;
  /** launches.dev_buy_quote + buys to the deployer outside the launch tx, ETH */
  devBuyEth: number;
}

/**
 * Structural view of SPEC §4 PlayTrigger: core's parsed `PlayTrigger` (defaults applied)
 * and plain objects from tools/tests are both assignable.
 */
export interface TriggerLike {
  armedWallet?:
    | { funders: readonly string[]; minEth: number; maxEth: number; freshOnly: boolean; contractMode: boolean; maxAgeSec?: number | undefined }
    | undefined;
  deployerIn?: readonly string[] | undefined;
  teamWalletsAny?: readonly string[] | undefined;
  nameRegex?: string | undefined;
  symbolRegex?: string | undefined;
  launchKind?: 'any' | 'noDevBuy' | 'devBuy' | undefined;
  minDevBuyEth?: number | undefined;
  maxDevBuyEth?: number | undefined;
  launchSecond?: LaunchSecondLike | undefined;
  deployerNotIn?: readonly string[] | undefined;
  teamWalletsNotIn?: readonly string[] | undefined;
  require?: readonly TriggerCondition[] | undefined;
}

export interface WalletFunding {
  wallet: string;
  role: 'deployer' | 'team';
  /** first funder of the wallet */
  funder: string | null;
  /** when the funder is a contract: the address that created it ("contract mode") */
  funderCreator: string | null;
  valueEth: number | null;
  /** tx_count_at_first_funding == 0 */
  fresh: boolean | null;
}

export interface LaunchContext {
  token: string;
  name: string | null;
  symbol: string | null;
  deployer: string;
  /** launches.launch_kind: the entry point (launchToken | launchAndBuy | launchTokenFor) */
  launchKind: string | null;
  devBuyEth: number | null;
  /** exemptions ∪ creator_fee_recipient (lower-case) */
  teamWallets: string[];
  fundings: WalletFunding[];
  /** tx signer of the launch (launchTokenFor: may differ from the deployer) */
  txFrom?: string | null | undefined;
  /** launch block time, unix seconds */
  ts?: number | null | undefined;
  /** launch-second totals; absent = unknown (a launchSecond trigger then does not match) */
  launchSecond?: LaunchSecondFacts | undefined;
}

export interface TriggerMatch {
  matched: boolean;
  hits: TriggerCondition[];
  reason?: string;
}

function safeRegex(src: string | undefined): RegExp | null {
  if (!src) return null;
  try {
    return new RegExp(src, 'i');
  } catch {
    return null;
  }
}

export function isDevBuy(ctx: Pick<LaunchContext, 'launchKind' | 'devBuyEth'>): boolean {
  return (ctx.devBuyEth ?? 0) > 0 || ctx.launchKind === 'launchAndBuy' || ctx.launchKind === 'devBuy';
}

/** Identity conditions (who launched / who is on the team / what it is called). */
export function identityConditions(trigger: TriggerLike): IdentityCondition[] {
  const out: IdentityCondition[] = [];
  if (trigger.armedWallet) out.push('armedWallet');
  if (trigger.deployerIn && trigger.deployerIn.length) out.push('deployerIn');
  if (trigger.teamWalletsAny && trigger.teamWalletsAny.length) out.push('teamWalletsAny');
  if (trigger.nameRegex) out.push('nameRegex');
  if (trigger.symbolRegex) out.push('symbolRegex');
  return out;
}

/** Conditions that let a trigger match on its own: identity conditions + a launchSecond rule that demands ETH. */
export function specifiedConditions(trigger: TriggerLike): TriggerCondition[] {
  const out: TriggerCondition[] = identityConditions(trigger);
  if (launchSecondIsMatcher(trigger.launchSecond)) out.push('launchSecond');
  return out;
}

/** A fingerprint play (no identity condition): it targets a pattern, not one operator. */
export function isGenericTrigger(trigger: TriggerLike): boolean {
  return identityConditions(trigger).length === 0 && launchSecondIsMatcher(trigger.launchSecond);
}

const EPS = 1e-12;

/** null = holds, else the failing bound (sniper rules.ts checkLaunchSecond, hint stage). */
export function launchSecondMiss(rule: LaunchSecondLike, f: LaunchSecondFacts | undefined): string | null {
  if (!f) return 'launchSecond: no data';
  if (rule.minTeamBuyEth !== undefined && f.teamBuyEth + EPS < rule.minTeamBuyEth) return 'minTeamBuyEth';
  if (rule.maxTeamBuyEth !== undefined && f.teamBuyEth > rule.maxTeamBuyEth + EPS) return 'maxTeamBuyEth';
  if (rule.minTeamBuyers !== undefined && f.teamBuyers < rule.minTeamBuyers) return 'minTeamBuyers';
  if (rule.minDevBuyEth !== undefined && f.devBuyEth + EPS < rule.minDevBuyEth) return 'launchSecond.minDevBuyEth';
  if (rule.maxDevBuyEth !== undefined && f.devBuyEth > rule.maxDevBuyEth + EPS) return 'launchSecond.maxDevBuyEth';
  if (rule.requireNoDevBuy && f.devBuyEth > 0) return 'requireNoDevBuy';
  return null;
}

export function matchTrigger(ctx: LaunchContext, trigger: TriggerLike): TriggerMatch {
  const lower = (xs: readonly string[] | undefined): Set<string> => new Set((xs ?? []).map((x) => x.toLowerCase()));
  const notDeployers = lower(trigger.deployerNotIn);
  if (notDeployers.has(ctx.deployer.toLowerCase()) || (ctx.txFrom && notDeployers.has(ctx.txFrom.toLowerCase()))) {
    return { matched: false, hits: [], reason: 'deployerNotIn' };
  }
  const notTeam = lower(trigger.teamWalletsNotIn);
  if (ctx.teamWallets.some((w) => notTeam.has(w.toLowerCase()))) return { matched: false, hits: [], reason: 'teamWalletsNotIn' };
  const kind = trigger.launchKind ?? 'any';
  const devBuy = isDevBuy(ctx);
  if (kind === 'devBuy' && !devBuy) return { matched: false, hits: [], reason: 'launchKind' };
  if (kind === 'noDevBuy' && devBuy) return { matched: false, hits: [], reason: 'launchKind' };
  const dev = ctx.devBuyEth ?? 0;
  if (trigger.minDevBuyEth !== undefined && dev < trigger.minDevBuyEth) return { matched: false, hits: [], reason: 'minDevBuyEth' };
  if (trigger.maxDevBuyEth !== undefined && dev > trigger.maxDevBuyEth) return { matched: false, hits: [], reason: 'maxDevBuyEth' };

  if (specifiedConditions(trigger).length === 0) return { matched: false, hits: [], reason: 'no conditions' };
  if (trigger.launchSecond) {
    const miss = launchSecondMiss(trigger.launchSecond, ctx.launchSecond);
    if (miss) return { matched: false, hits: [], reason: miss };
  }
  const conds = identityConditions(trigger);

  const test: Record<IdentityCondition, () => boolean> = {
    armedWallet: () => {
      const a = trigger.armedWallet;
      if (!a) return false;
      const funders = new Set(a.funders.map((f) => f.toLowerCase()));
      return ctx.fundings.some((f) => {
        const direct = f.funder !== null && funders.has(f.funder);
        const viaContract = a.contractMode && f.funderCreator !== null && funders.has(f.funderCreator);
        if (!direct && !viaContract) return false;
        if (f.valueEth === null || f.valueEth < a.minEth || f.valueEth > a.maxEth) return false;
        return !a.freshOnly || f.fresh === true;
      });
    },
    deployerIn: () => (trigger.deployerIn ?? []).some((d) => d.toLowerCase() === ctx.deployer),
    teamWalletsAny: () => {
      const team = new Set(ctx.teamWallets);
      return (trigger.teamWalletsAny ?? []).some((w) => team.has(w.toLowerCase()));
    },
    nameRegex: () => (ctx.name !== null && safeRegex(trigger.nameRegex)?.test(ctx.name)) === true,
    symbolRegex: () => (ctx.symbol !== null && safeRegex(trigger.symbolRegex)?.test(ctx.symbol)) === true,
  };

  const hits: TriggerCondition[] = conds.filter((c) => test[c]());
  const required = (trigger.require ?? []).filter((c): c is IdentityCondition => (conds as readonly TriggerCondition[]).includes(c));
  if (!required.every((c) => hits.includes(c))) return { matched: false, hits, reason: 'require' };
  const optional = conds.filter((c) => !required.includes(c));
  if (optional.length > 0 && !optional.some((c) => hits.includes(c))) return { matched: false, hits, reason: 'no optional hit' };
  return { matched: true, hits: trigger.launchSecond ? [...hits, 'launchSecond'] : hits };
}
