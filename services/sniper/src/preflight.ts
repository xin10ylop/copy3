/**
 * Live-mode startup gate (README "Live-mode gate"). Refuses to start when:
 *  - the PonsSniper owner is one of the hot executor keys (M4: the owner must be cold),
 *  - the contract's factory is not the Pons V2 factory,
 *  - an executor key is not an operator,
 *  - L6: `eth_estimateGas` of a real `snipe()` against the most recent live curve does not fit
 *    the smallest preset gas limit (or cannot be estimated at all — fail closed; GAS_CHECK=0
 *    skips it explicitly).
 */
import { sniperAbi } from '@hood/contracts';
import { PONS_V2 } from '@hood/core';
import { encodeFunctionData, formatEther, parseEther, type Address } from 'viem';
import type { ChainClient } from './chain.js';

export interface StartupCheckInput {
  chain: ChainClient;
  sniper: Address;
  /** every executor key, exit key first */
  keys: readonly Address[];
  /** key used as `from` for the gas estimate (a burst key) */
  estimateFrom: Address;
  /** smallest gasLimit among the enabled presets (default 300k) */
  gasLimit: number;
  /** largest buyEth among the enabled presets (warn when above the on-chain maxQuoteIn) */
  maxBuyEth?: number;
  factory?: Address;
  allowHotOwner?: boolean;
  gasCheck?: boolean;
  lookbackBlocks?: number;
}

export interface StartupCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  gasEstimate: bigint | null;
}

export async function liveStartupChecks(i: StartupCheckInput): Promise<StartupCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let gasEstimate: bigint | null = null;
  const keys = i.keys.map((k) => k.toLowerCase() as Address);
  try {
    const cfg = await i.chain.readSniperConfig(i.sniper, keys);
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
      warnings.push(`a preset buys ${i.maxBuyEth} ETH but the contract's maxQuoteIn is ${formatEther(cfg.maxQuoteIn)} ETH: those snipes revert QuoteTooLarge`);
  } catch (e) {
    errors.push(`reading the PonsSniper config failed: ${(e as Error).message}`);
  }
  if (i.gasCheck !== false) {
    try {
      const launch = await i.chain.recentLaunch(i.lookbackBlocks ?? 36_000);
      if (!launch) errors.push(`L6: no TokenLaunched in the last ${i.lookbackBlocks ?? 36_000} blocks to estimate snipe() gas against (GAS_CHECK=0 skips)`);
      else {
        const head = await i.chain.getBlockNumber();
        const data = encodeFunctionData({
          abi: sniperAbi,
          functionName: 'snipe',
          args: [launch.curve, launch.token, parseEther('0.0001'), 0n, 1000, BigInt(head + 10_000)],
        });
        gasEstimate = await i.chain.estimateGas({ from: i.estimateFrom, to: i.sniper, data });
        if (gasEstimate > BigInt(i.gasLimit)) errors.push(`L6: snipe() estimate ${gasEstimate} gas > preset gas limit ${i.gasLimit} (curve ${launch.curve})`);
        else if (gasEstimate * 10n > BigInt(i.gasLimit) * 8n) warnings.push(`L6: snipe() estimate ${gasEstimate} gas is within 20 % of the gas limit ${i.gasLimit}`);
      }
    } catch (e) {
      errors.push(`L6: eth_estimateGas of snipe() failed: ${(e as Error).message.split('\n')[0]} (fund the contract; GAS_CHECK=0 skips)`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, gasEstimate };
}
