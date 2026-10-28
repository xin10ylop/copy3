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
 *    curve with a state override that gives the contract a balance; above the gas limit → fail.
 * `LiveGate` runs the checks after the startup reconciliation and keeps retrying while they fail.
 */
import { sniperAbi } from '@hood/contracts';
import { PONS_V2 } from '@hood/core';
import { encodeFunctionData, formatEther, parseEther, type Address } from 'viem';
import { erc20HoldingOverride, type ChainClient, type RecentLaunch } from './chain.js';
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
  /** largest buy among the enabled presets (buyEth, or sizing.maxEth in bankroll mode) */
  maxBuyEth?: number;
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
  /** curve the estimates ran on */
  estimatedOn: RecentLaunch | null;
}

export async function liveStartupChecks(i: StartupCheckInput): Promise<StartupCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let gasEstimate: bigint | null = null;
  let exitGasEstimate: bigint | null = null;
  let maxQuoteIn: bigint | null = null;
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
        const data = encodeFunctionData({ abi: sniperAbi, functionName: 'snipe', args: [c.curve, c.token, parseEther('0.0001'), 0n, 1000, BigInt(head + 10_000)] });
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
  return { ok: errors.length === 0, errors, warnings, gasEstimate, exitGasEstimate, maxQuoteIn, estimatedOn };
}

export interface LiveGateOptions {
  check: () => Promise<StartupCheckResult>;
  /** every result (block / unblock entries, alerts) */
  onResult: (r: StartupCheckResult) => void;
  logger: Logger;
  /** retry while failing. Default 60 s. */
  retryMs?: number;
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
    if (!r.ok && !this.stopped) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.run();
      }, this.o.retryMs ?? 60_000);
      this.timer.unref?.();
    }
    return r;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
