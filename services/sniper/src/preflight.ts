/**
 * Live-mode gate (README "Live-mode gate"). New entries stay blocked (open positions keep being
 * managed — N1) while any of these fail:
 *  - the PonsSniper owner is one of the hot executor keys (M4: the owner must be cold),
 *  - the contract's factory is not the Pons V2 factory,
 *  - an executor key is not an operator,
 *  - L6: `eth_estimateGas` of a real `snipe()` does not fit the smallest preset gas limit, or no
 *    curve could be estimated at all (fail closed; GAS_CHECK=0 skips it explicitly). The curve is
 *    the newest recent launch we have NOT bought, whose snipe tax is 0 (launch block ≥ 3 s old)
 *    and that has not graduated; a few candidates are tried (N1);
 *  - N15: the exit (`exitAll`, incl. the treasury forwarding allowance) is estimated on the same
 *    curve with a state override that gives the contract a balance; above the gas limit → fail;
 *  - NEW-4: the contract's spend budget cannot cover the largest preset buy (every such snipe
 *    would revert SpendLimitExceeded) → fail; budget switched off → warning.
 * `LiveGate` runs the checks after the startup reconciliation and keeps retrying while they fail;
 * while they pass it re-reads the contract config every GATE_REFRESH_MS (NEW-8), so maxQuoteIn,
 * the spend budget, the owner and the operators used at decide time are never older than that.
 */
import { sniperAbi } from '@hood/contracts';
import { PONS_V2 } from '@hood/core';
import { encodeFunctionData, formatEther, parseEther, type Address } from 'viem';
import { erc20HoldingOverride, type ChainClient, type RecentLaunch, type SpendBudgetState } from './chain.js';
import type { Logger } from './log.js';

/** gas PonsSniper forwards with the exit proceeds (PROCEEDS_GAS in the contract) */
export const TREASURY_GAS_ALLOWANCE = 50_000n;

export interface StartupCheckInput {
  chain: ChainClient;
  sniper: Address;
  /** every executor key, exit key first */
  keys: readonly Address[];
  /** key used as `from` for the snipe estimate (a burst key) */
  estimateFrom: Address;
  /** key used as `from` for the exit estimate (the exit key); default `estimateFrom` */
  exitFrom?: Address;
  /** smallest gasLimit among the enabled presets (default 300k) */
  gasLimit: number;
  /** largest FIXED buy among the enabled presets (`buyEth`; refused at decide time above maxQuoteIn) */
  maxBuyEth?: number;
  /** every FIXED `buyEth` of the enabled presets (R4-8: those above maxQuoteIn are refused at decide time, so the budget check ignores them) */
  fixedBuysEth?: number[];
  /** largest `sizing.maxEth` among the enabled bankroll presets (clamped to maxQuoteIn, NEW-6) */
  maxBankrollEth?: number;
  factory?: Address;
  allowHotOwner?: boolean;
  gasCheck?: boolean;
  lookbackBlocks?: number;
  /** recent launches tried for the estimate (newest first). Default 8. */
  candidates?: number;
}

export interface StartupCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  gasEstimate: bigint | null;
  exitGasEstimate: bigint | null;
  /** the contract's per-snipe cap (refuse presets above it at decide time — N15) */
  maxQuoteIn: bigint | null;
  /** the contract's spend budget (NEW-4); null when it could not be read */
  spend?: SpendBudgetState | null;
  /** curve the estimates ran on */
  estimatedOn: RecentLaunch | null;
}

export async function liveStartupChecks(i: StartupCheckInput): Promise<StartupCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let gasEstimate: bigint | null = null;
  let exitGasEstimate: bigint | null = null;
  let maxQuoteIn: bigint | null = null;
  let spend: SpendBudgetState | null = null;
  let estimatedOn: RecentLaunch | null = null;
  const keys = i.keys.map((k) => k.toLowerCase() as Address);
  try {
    const cfg = await i.chain.readSniperConfig(i.sniper, keys);
    maxQuoteIn = cfg.maxQuoteIn;
    if (keys.includes(cfg.owner.toLowerCase() as Address)) {
      const msg = `contract owner ${cfg.owner} is a hot executor key (M4: use a cold OWNER, operators only on the host)`;
      if (i.allowHotOwner) warnings.push(msg);
      else errors.push(msg);
    }
    const factory = (i.factory ?? PONS_V2.factory).toLowerCase();
    if (cfg.factory.toLowerCase() !== factory) errors.push(`contract factory ${cfg.factory} ≠ Pons V2 factory ${factory}`);
    cfg.operators.forEach((isOp, n) => {
      if (!isOp) errors.push(`executor key ${keys[n]} is not an operator of ${i.sniper} (owner: setOperator(key, true))`);
    });
    if (i.maxBuyEth !== undefined && parseEther(String(i.maxBuyEth)) > cfg.maxQuoteIn)
      warnings.push(`a preset buys up to ${i.maxBuyEth} ETH but the contract's maxQuoteIn is ${formatEther(cfg.maxQuoteIn)} ETH: those plays are refused at decide time (N15)`);
    if (i.maxBankrollEth !== undefined && parseEther(String(i.maxBankrollEth)) > cfg.maxQuoteIn)
      warnings.push(`a bankroll preset sizes up to ${i.maxBankrollEth} ETH but the contract's maxQuoteIn is ${formatEther(cfg.maxQuoteIn)} ETH: its sizes are clamped to maxQuoteIn (NEW-6)`);
    // NEW-4: nothing read the budget before — exhausted, every member reverted SpendLimitExceeded silently
    spend = cfg.spend ?? null;
    if (spend) {
      // R4-8: a fixed preset above maxQuoteIn never buys (refused at decide time): not the "largest buy"
      const fixed = (i.fixedBuysEth ?? (i.maxBuyEth !== undefined ? [i.maxBuyEth] : []))
        .map((x) => parseEther(String(x)))
        .filter((x) => x <= cfg.maxQuoteIn)
        .reduce((a, b) => (b > a ? b : a), 0n);
      const bank = i.maxBankrollEth !== undefined ? parseEther(String(i.maxBankrollEth)) : 0n;
      const bankCapped = bank > cfg.maxQuoteIn ? cfg.maxQuoteIn : bank;
      const largest = fixed > bankCapped ? fixed : bankCapped;
      if (spend.window === 0)
        warnings.push(`NEW-4: the contract's spend budget is OFF (disableSpendLimit): a stolen operator key is bounded only by maxQuoteIn per snipe and the contract balance`);
      else if (largest > 0n && spend.maxSpend < largest)
        errors.push(
          `NEW-4: the contract's spend budget ${formatEther(spend.maxSpend)} ETH per ${spend.window} s is below the largest preset buy ${formatEther(largest)} ETH: every such snipe would revert SpendLimitExceeded (owner: setSpendLimit)`,
        );
    }
  } catch (e) {
    errors.push(`reading the PonsSniper config failed: ${(e as Error).message}`);
  }
  if (i.gasCheck !== false) {
    const lookback = i.lookbackBlocks ?? 36_000;
    try {
      const launches = await i.chain.recentLaunches(lookback, i.candidates ?? 8);
      const head = await i.chain.getBlockNumber();
      const headTs = await i.chain.getBlockTimestamp(head);
      const skipped: string[] = [];
      for (const c of launches) {
        // N1: never estimate on our own buy (AlreadyBought), in the launch second (TaxTooHigh) or after graduation
        const ts = await i.chain.getBlockTimestamp(c.block);
        if (ts + 3 > headTs) {
          skipped.push(`${c.curve}: snipe tax not 0 yet`);
          continue;
        }
        if (await i.chain.curveGraduated(c.curve)) {
          skipped.push(`${c.curve}: graduated`);
          continue;
        }
        if ((await i.chain.readSniper(i.sniper, c.token)).bought) {
          skipped.push(`${c.curve}: already bought by us`);
          continue;
        }
        const data = encodeFunctionData({ abi: sniperAbi, functionName: 'snipe', args: [c.curve, c.token, parseEther('0.0001'), 0n, 1000, BigInt(head + 10_000), BigInt(headTs + 3600)] });
        try {
          gasEstimate = await i.chain.estimateGas({ from: i.estimateFrom, to: i.sniper, data });
          estimatedOn = c;
          break;
        } catch (e) {
          skipped.push(`${c.curve}: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      if (gasEstimate === null) {
        errors.push(
          launches.length === 0
            ? `L6: no TokenLaunched in the last ${lookback} blocks to estimate snipe() gas against (GAS_CHECK=0 skips)`
            : `L6: snipe() could not be estimated on any of ${launches.length} recent curves (${skipped.join('; ')}) — fund the contract; GAS_CHECK=0 skips`,
        );
      } else if (gasEstimate > BigInt(i.gasLimit)) {
        errors.push(`L6: snipe() estimate ${gasEstimate} gas > preset gas limit ${i.gasLimit} (curve ${estimatedOn!.curve})`);
      } else if (gasEstimate * 10n > BigInt(i.gasLimit) * 8n) {
        warnings.push(`L6: snipe() estimate ${gasEstimate} gas is within 20 % of the gas limit ${i.gasLimit}`);
      }
    } catch (e) {
      errors.push(`L6: eth_estimateGas of snipe() failed: ${(e as Error).message.split('\n')[0]} (GAS_CHECK=0 skips)`);
    }
    if (estimatedOn) {
      // N15: exitAll on the same curve, the contract given a balance by a state override
      const c = estimatedOn;
      try {
        exitGasEstimate = await i.chain.estimateGas({
          from: i.exitFrom ?? i.estimateFrom,
          to: i.sniper,
          data: encodeFunctionData({ abi: sniperAbi, functionName: 'exitAll', args: [c.curve, c.token, 0n] }),
          stateOverride: erc20HoldingOverride(c.token, i.sniper, c.curve, 10n ** 24n),
        });
        const worst = exitGasEstimate + TREASURY_GAS_ALLOWANCE;
        if (exitGasEstimate > BigInt(i.gasLimit)) errors.push(`N15: exitAll() estimate ${exitGasEstimate} gas > preset gas limit ${i.gasLimit}`);
        else if (worst > BigInt(i.gasLimit)) warnings.push(`N15: exitAll() estimate ${exitGasEstimate} + ${TREASURY_GAS_ALLOWANCE} treasury allowance > gas limit ${i.gasLimit}`);
      } catch (e) {
        warnings.push(`N15: exitAll() gas could not be estimated (${(e as Error).message.split('\n')[0]}); exits use the preset gas limit ${i.gasLimit}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, gasEstimate, exitGasEstimate, maxQuoteIn, spend, estimatedOn };
}

export interface LiveGateOptions {
  check: () => Promise<StartupCheckResult>;
  /**
   * NEW-8: the light re-check run every `refreshMs` while the gate passes — the contract config
   * (owner, factory, operators, maxQuoteIn, spend budget) without the gas estimates
   * (`liveStartupChecks({ …, gasCheck: false })`). Default: no refresh.
   */
  refresh?: () => Promise<StartupCheckResult>;
  /** every result (block / unblock entries, alerts, contract limits for the decide path) */
  onResult: (r: StartupCheckResult) => void;
  logger: Logger;
  /** retry while failing. Default 60 s. */
  retryMs?: number;
  /** GATE_REFRESH_MS: re-read the contract config this often while passing. Default 60 s. */
  refreshMs?: number;
}

/**
 * N1: run the live gate after startup (positions are already managed) and keep retrying while it
 * fails; the owner of `onResult` blocks / unblocks new entries. A failing gate never exits the
 * process (that crash-looped under systemd with positions unmanaged).
 */
export class LiveGate {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  last: StartupCheckResult | null = null;

  constructor(private readonly o: LiveGateOptions) {}

  async run(): Promise<StartupCheckResult> {
    let r: StartupCheckResult;
    try {
      r = await this.o.check();
    } catch (e) {
      r = { ok: false, errors: [`gate crashed: ${(e as Error).message}`], warnings: [], gasEstimate: null, exitGasEstimate: null, maxQuoteIn: null, estimatedOn: null };
    }
    this.last = r;
    for (const w of r.warnings) this.o.logger.warn(w);
    if (!r.ok) this.o.logger.error({ errors: r.errors }, 'live gate failed: new entries blocked, retrying');
    else this.o.logger.info({ gasEstimate: r.gasEstimate?.toString(), exitGasEstimate: r.exitGasEstimate?.toString() }, 'live gate passed');
    this.o.onResult(r);
    this.schedule(r.ok);
    return r;
  }

  /**
   * NEW-8: while passing, re-read the contract config. A changed config that fails (operator
   * revoked, budget below the largest buy, hot owner …) blocks entries and falls back to the full
   * check; a read that merely failed (RPC) keeps the previous limits and state (the contract
   * enforces them anyway) and is retried at the next refresh.
   */
  async refreshNow(): Promise<StartupCheckResult | null> {
    if (!this.o.refresh) return null;
    let r: StartupCheckResult;
    try {
      r = await this.o.refresh();
    } catch (e) {
      r = { ok: false, errors: [`refresh crashed: ${(e as Error).message}`], warnings: [], gasEstimate: null, exitGasEstimate: null, maxQuoteIn: null, estimatedOn: null };
    }
    if (r.maxQuoteIn === null) {
      this.o.logger.warn({ errors: r.errors }, 'live gate refresh: contract config not readable; keeping the previous limits');
      this.schedule(true);
      return r;
    }
    const merged: StartupCheckResult = { ...r, gasEstimate: this.last?.gasEstimate ?? null, exitGasEstimate: this.last?.exitGasEstimate ?? null, estimatedOn: this.last?.estimatedOn ?? null };
    if (!r.ok) this.o.logger.error({ errors: r.errors }, 'live gate refresh failed: new entries blocked');
    this.last = merged;
    this.o.onResult(merged);
    this.schedule(r.ok);
    return merged;
  }

  private schedule(passing: boolean): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (passing && !this.o.refresh) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void (passing ? this.refreshNow() : this.run());
      },
      passing ? (this.o.refreshMs ?? 60_000) : (this.o.retryMs ?? 60_000),
    );
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
