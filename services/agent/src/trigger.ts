/**
 * Pure PlayTrigger evaluation against a historical launch (used to select a play's
 * launches for backtests and to decide whether a scout cluster is already covered).
 *
 * SPEC §4 semantics: conditions listed in `require` must all hold; the remaining
 * specified conditions are OR-ed (at least one must hold when any exist). `launchKind`
 * and the dev-buy range are hard filters. A trigger with no condition matches nothing.
 */
import type { PlayTrigger } from './deps.js';

export type TriggerCondition = 'armedWallet' | 'deployerIn' | 'teamWalletsAny' | 'nameRegex' | 'symbolRegex';

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
  launchKind: string | null;
  devBuyEth: number | null;
  /** exemptions ∪ creator_fee_recipient (lower-case) */
  teamWallets: string[];
  fundings: WalletFunding[];
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
  return (ctx.devBuyEth ?? 0) > 0 || ctx.launchKind === 'devBuy';
}

export function specifiedConditions(trigger: PlayTrigger): TriggerCondition[] {
  const out: TriggerCondition[] = [];
  if (trigger.armedWallet) out.push('armedWallet');
  if (trigger.deployerIn && trigger.deployerIn.length) out.push('deployerIn');
  if (trigger.teamWalletsAny && trigger.teamWalletsAny.length) out.push('teamWalletsAny');
  if (trigger.nameRegex) out.push('nameRegex');
  if (trigger.symbolRegex) out.push('symbolRegex');
  return out;
}

export function matchTrigger(ctx: LaunchContext, trigger: PlayTrigger): TriggerMatch {
  const kind = trigger.launchKind ?? 'any';
  const devBuy = isDevBuy(ctx);
  if (kind === 'devBuy' && !devBuy) return { matched: false, hits: [], reason: 'launchKind' };
  if (kind === 'noDevBuy' && devBuy) return { matched: false, hits: [], reason: 'launchKind' };
  const dev = ctx.devBuyEth ?? 0;
  if (trigger.minDevBuyEth !== undefined && dev < trigger.minDevBuyEth) return { matched: false, hits: [], reason: 'minDevBuyEth' };
  if (trigger.maxDevBuyEth !== undefined && dev > trigger.maxDevBuyEth) return { matched: false, hits: [], reason: 'maxDevBuyEth' };

  const conds = specifiedConditions(trigger);
  if (conds.length === 0) return { matched: false, hits: [], reason: 'no conditions' };

  const test: Record<TriggerCondition, () => boolean> = {
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

  const hits = conds.filter((c) => test[c]());
  const required = trigger.require.filter((c) => conds.includes(c));
  if (!required.every((c) => hits.includes(c))) return { matched: false, hits, reason: 'require' };
  const optional = conds.filter((c) => !required.includes(c));
  if (optional.length > 0 && !optional.some((c) => hits.includes(c))) return { matched: false, hits, reason: 'no optional hit' };
  return { matched: true, hits };
}
