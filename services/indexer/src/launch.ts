/**
 * launches row construction (pure). Joins the TokenLaunched log with the launch
 * tx calldata (parseLaunchCall) and the SnipeTaxExempted logs of the same tx.
 */
import { exemptSetForLaunch, mcapFromReserves, parseLaunchCall, priceFromReserves } from './pons.js';
import type { Address, Hex, LaunchRow, Reserves } from './types.js';

export interface LaunchInput {
  launched: {
    token: Address;
    curve: Address;
    deployer: Address;
    pairToken: Address;
    launchConfigId: bigint;
    graduationThreshold: bigint;
    block: number;
    txHash: Hex;
  };
  /** the launch tx (null when it could not be fetched) */
  tx: { from: Address; to: Address | null; input: Hex } | null;
  ts: number;
  /** SnipeTaxExempted accounts emitted by this curve in the launch tx */
  exempted: readonly Address[];
  /** quote of a CurveBuy on this curve inside the launch tx (router dev buy) */
  devBuyInTx: bigint | null;
  /** curve reserves before any trade, e.g. (phantomQuote, launchSupply) */
  startReserves: Reserves | null;
  /** fallback for start price when reserves are unknown: first trade quote/tokens */
  firstTrade?: { quote: bigint; tokens: bigint } | null;
}

export function buildLaunchRow(input: LaunchInput): LaunchRow {
  const { launched, tx } = input;
  const call = tx ? parseLaunchCall({ from: tx.from, input: tx.input }) : null;
  const exemptions = new Set<string>();
  for (const a of call?.exemptions ?? []) exemptions.add(a.toLowerCase());
  for (const a of input.exempted) exemptions.add(a.toLowerCase());
  exemptions.delete('0x0000000000000000000000000000000000000000');

  const devBuy = input.devBuyInTx ?? (call && call.devBuyQuoteIn > 0n ? call.devBuyQuoteIn : null);

  let startPrice: number | null = null;
  let startMcapEth: number | null = null;
  if (input.startReserves && input.startReserves.token > 0n) {
    startPrice = priceFromReserves(input.startReserves.quote, input.startReserves.token);
    startMcapEth = mcapFromReserves(input.startReserves.quote, input.startReserves.token);
  } else if (input.firstTrade && input.firstTrade.tokens > 0n) {
    startPrice = Number(input.firstTrade.quote) / Number(input.firstTrade.tokens);
    startMcapEth = startPrice * 1e9;
  }

  return {
    token: launched.token,
    curve: launched.curve,
    deployer: launched.deployer,
    launcher: tx?.to ? (tx.to.toLowerCase() as Address) : null,
    launchKind: call?.kind ?? 'unknown',
    creatorFeeRecipient: call ? call.creatorFeeRecipient : null,
    creatorTaxBps: call ? call.creatorTaxBps : null,
    name: call ? call.name : null,
    symbol: call ? call.symbol : null,
    logo: call ? call.logo : null,
    pairToken: launched.pairToken,
    launchConfigId: launched.launchConfigId,
    graduationThreshold: launched.graduationThreshold,
    exemptions: [...exemptions].sort() as Address[],
    devBuyQuote: devBuy,
    block: launched.block,
    ts: input.ts,
    txHash: launched.txHash,
    txFrom: (tx?.from.toLowerCase() ?? launched.deployer) as Address,
    startPrice,
    startMcapEth,
    graduated: false,
  };
}

/** Exempt set used for the `curve_trades.exempt` flag. */
export function exemptSetOf(launch: Pick<LaunchRow, 'deployer' | 'creatorFeeRecipient' | 'exemptions'>): Set<string> {
  return exemptSetForLaunch(launch);
}
