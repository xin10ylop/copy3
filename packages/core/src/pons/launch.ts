/**
 * Decoders for Pons V2 launch calls and curve/launch logs (SPEC §1).
 *
 * `parseLaunchCall` decodes all four launch entrypoints from a raw signed tx
 * (as seen on the sequencer feed, before execution). The log parsers decode
 * TokenLaunched / CurveBuy / CurveSell / SnipeTaxCharged / SnipeTaxExempted /
 * Initialized events from receipts or `eth_getLogs`.
 */
import {
  decodeFunctionData,
  decodeEventLog,
  getAddress,
  type Log,
} from 'viem';
import { factoryAbi, routerAbi, curveAbi } from '../abis/index.js';
import { SELECTORS } from '../addresses.js';
import type { Address, Hash, LaunchEvent, LaunchKind } from '../types.js';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** Minimal tx shape needed to decode a launch call (from the feed or a node). */
export interface LaunchTxInput {
  to?: string | null;
  input: string;
  from?: string | null;
  value?: bigint | string | null;
}

/** A log shape that accepts either viem `Log` or a plain JSON-RPC log. */
export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber?: string | bigint | number | null;
  transactionHash?: string | null;
  logIndex?: string | number | null;
}

/** Normalised decoded launch call. */
export interface LaunchCall {
  kind: LaunchKind;
  selector: string;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: readonly [string, string, string, string, string];
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  salt1: `0x${string}`;
  salt2: `0x${string}`;
  launchConfigId: bigint;
  pairToken: Address;
  /** explicit snipeTaxExemptions passed in calldata (4-arg / launchTokenFor / router). */
  exemptions: Address[];
  /** explicit deployer for launchTokenFor; else undefined (use tx.from). */
  deployer?: Address;
  /** router dev-buy quote-in (launchAndBuy); 0n otherwise. */
  devBuyQuoteIn: bigint;
  /** router minTokensOut (launchAndBuy); 0n otherwise. */
  minTokensOut: bigint;
  /** router recipient (launchAndBuy); undefined otherwise. */
  recipient?: Address;
}

/** viem decodes the Socials struct to a named object. */
type SocialsObj = { x: string; telegram: string; website: string; discord: string; farcaster: string };
type ParamsTuple = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: SocialsObj;
  creatorFeeRecipient: `0x${string}`;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  salt1: `0x${string}`;
  salt2: `0x${string}`;
};

function lc(a: string): Address {
  return a.toLowerCase() as Address;
}

function mapParams(p: ParamsTuple): Omit<
  LaunchCall,
  'kind' | 'selector' | 'launchConfigId' | 'pairToken' | 'exemptions' | 'deployer' | 'devBuyQuoteIn' | 'minTokensOut' | 'recipient'
> {
  return {
    name: p.name,
    symbol: p.symbol,
    logo: p.logo,
    description: p.description,
    socials: [p.socials.x, p.socials.telegram, p.socials.website, p.socials.discord, p.socials.farcaster],
    creatorFeeRecipient: lc(p.creatorFeeRecipient),
    creatorTaxBps: Number(p.creatorTaxBps),
    buybackEnabled: p.buybackEnabled,
    salt1: p.salt1,
    salt2: p.salt2,
  };
}

/** Which launch entrypoint a call uses, or null if it is not a launch call. */
export function launchKindOf(tx: LaunchTxInput): LaunchKind | null {
  const sel = (tx.input ?? '').slice(0, 10).toLowerCase();
  switch (sel) {
    case SELECTORS.launchToken3:
    case SELECTORS.launchToken4:
      return 'launchToken';
    case SELECTORS.launchAndBuy:
      return 'launchAndBuy';
    case SELECTORS.launchTokenFor:
      return 'launchTokenFor';
    default:
      return null;
  }
}

/**
 * Decode a launch call from a raw tx. Returns null when the selector is not one
 * of the four launch selectors (cheap fast-path for the hot loop).
 */
export function parseLaunchCall(tx: LaunchTxInput): LaunchCall | null {
  const input = tx.input ?? '';
  const sel = input.slice(0, 10).toLowerCase();
  const kind = launchKindOf(tx);
  if (!kind) return null;

  if (sel === SELECTORS.launchAndBuy) {
    const { args } = decodeFunctionData({ abi: routerAbi, data: input as `0x${string}` });
    const [params, launchConfigId, pairToken, buyQuoteIn, minTokensOut, recipient, exemptions] = args as unknown as [
      ParamsTuple,
      bigint,
      `0x${string}`,
      bigint,
      bigint,
      `0x${string}`,
      readonly `0x${string}`[],
    ];
    return {
      kind,
      selector: sel,
      ...mapParams(params),
      launchConfigId,
      pairToken: lc(pairToken),
      exemptions: exemptions.map(lc),
      devBuyQuoteIn: buyQuoteIn,
      minTokensOut,
      recipient: lc(recipient),
    };
  }

  // factory entrypoints share the factory ABI (overloaded launchToken + launchTokenFor)
  const { functionName, args } = decodeFunctionData({ abi: factoryAbi, data: input as `0x${string}` });

  if (functionName === 'launchTokenFor') {
    const [params, launchConfigId, pairToken, deployer, exemptions] = args as unknown as [
      ParamsTuple,
      bigint,
      `0x${string}`,
      `0x${string}`,
      readonly `0x${string}`[],
    ];
    return {
      kind,
      selector: sel,
      ...mapParams(params),
      launchConfigId,
      pairToken: lc(pairToken),
      exemptions: exemptions.map(lc),
      deployer: lc(deployer),
      devBuyQuoteIn: 0n,
      minTokensOut: 0n,
    };
  }

  // launchToken (3-arg or 4-arg overload)
  const params = args[0] as unknown as ParamsTuple;
  const launchConfigId = args[1] as bigint;
  const pairToken = args[2] as `0x${string}`;
  const exemptions = (args.length >= 4 ? (args[3] as readonly `0x${string}`[]) : []).map(lc);
  return {
    kind,
    selector: sel,
    ...mapParams(params),
    launchConfigId,
    pairToken: lc(pairToken),
    exemptions,
    devBuyQuoteIn: 0n,
    minTokensOut: 0n,
  };
}

/**
 * Build a `LaunchEvent` (SPEC §4) from a decoded call plus the tx envelope.
 * Deployer resolution: explicit for launchTokenFor, else the tx signer.
 */
export function launchEventFromCall(
  call: LaunchCall,
  tx: { from?: string | null; to?: string | null; hash?: string | null; block?: number; ts?: number },
): LaunchEvent {
  const txFrom = tx.from ? lc(tx.from) : undefined;
  const deployer = call.deployer ?? txFrom ?? (ZERO as Address);
  return {
    deployer,
    name: call.name,
    symbol: call.symbol,
    launchKind: call.kind,
    exemptions: exemptSetForCall(call, deployer),
    creatorFeeRecipient: call.creatorFeeRecipient,
    creatorTaxBps: call.creatorTaxBps,
    devBuyQuoteIn: call.devBuyQuoteIn,
    pairToken: call.pairToken,
    launchConfigId: call.launchConfigId,
    ...(tx.block !== undefined ? { block: tx.block } : {}),
    ...(tx.ts !== undefined ? { ts: tx.ts } : {}),
    ...(tx.hash ? { txHash: lc(tx.hash) as Hash } : {}),
    ...(txFrom ? { txFrom } : {}),
    ...(tx.to ? { launcher: lc(tx.to) } : {}),
  };
}

/** Exemption set for a decoded call: deployer ∪ creatorFeeRecipient ∪ explicit exemptions. */
function exemptSetForCall(call: LaunchCall, deployer: Address): Address[] {
  const set = new Set<Address>([deployer, call.creatorFeeRecipient, ...call.exemptions]);
  set.delete(ZERO as Address);
  return [...set];
}

/**
 * Auto-exempt set for a LaunchEvent: deployer ∪ creatorFeeRecipient ∪ explicit
 * exemptions. The first two are auto-exempt on-chain (RESEARCH §3: a plain
 * 3-arg launchToken still emits two SnipeTaxExempted events).
 */
export function exemptSetForLaunch(event: {
  deployer: Address;
  creatorFeeRecipient: Address;
  exemptions?: readonly Address[];
}): Address[] {
  const set = new Set<Address>([event.deployer, event.creatorFeeRecipient, ...(event.exemptions ?? [])]);
  set.delete(ZERO as Address);
  return [...set];
}

// ---------------------------------------------------------------------------
// Log parsers
// ---------------------------------------------------------------------------

function normLog(log: RawLog): Pick<Log, 'address' | 'topics' | 'data'> {
  return {
    address: getAddress(log.address),
    topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    data: log.data as `0x${string}`,
  };
}

function toBlockNumber(v: RawLog['blockNumber']): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return Number(BigInt(v));
}

export interface TokenLaunchedParsed {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  block?: number;
  txHash?: Hash;
}

/** Decode a factory TokenLaunched (or router Launched) log. */
export function parseTokenLaunchedLog(log: RawLog): TokenLaunchedParsed {
  const decoded = decodeEventLog({ abi: factoryAbi, ...normLog(log) });
  if (decoded.eventName !== 'TokenLaunched') {
    throw new Error(`not a TokenLaunched log: ${decoded.eventName}`);
  }
  const a = decoded.args;
  const block = toBlockNumber(log.blockNumber);
  return {
    token: lc(a.token),
    curve: lc(a.curve),
    deployer: lc(a.deployer),
    pairToken: lc(a.pairToken),
    launchConfigId: a.launchConfigId,
    graduationThreshold: a.graduationThreshold,
    ...(block !== undefined ? { block } : {}),
    ...(log.transactionHash ? { txHash: lc(log.transactionHash) as Hash } : {}),
  };
}

export type CurveTradeSide = 'buy' | 'sell';

export interface CurveTradeParsed {
  side: CurveTradeSide;
  /** CurveBuy.buyer / CurveSell.seller (may be a router). */
  trader: Address;
  recipient: Address;
  /** quote wei in (buy) or out (sell). */
  quote: bigint;
  /** token wei out (buy) or in (sell). */
  tokens: bigint;
  /** curve trade fee (feeBps). */
  fee: bigint;
  /** CREATOR tax (not snipe tax). Exposed as `creatorTax`; `tax` is a kept alias. */
  creatorTax: bigint;
  tax: bigint;
  curve: Address;
  block?: number;
  txHash?: Hash;
  logIndex?: number;
}

/** Decode a CurveBuy or CurveSell log. `tax` is the CREATOR tax (see EXAMPLES.md). */
export function parseCurveTradeLog(log: RawLog): CurveTradeParsed {
  const decoded = decodeEventLog({ abi: curveAbi, ...normLog(log) });
  const block = toBlockNumber(log.blockNumber);
  const logIndex = typeof log.logIndex === 'string' ? Number(BigInt(log.logIndex)) : log.logIndex ?? undefined;
  const common = {
    curve: lc(log.address),
    ...(block !== undefined ? { block } : {}),
    ...(log.transactionHash ? { txHash: lc(log.transactionHash) as Hash } : {}),
    ...(logIndex !== undefined && logIndex !== null ? { logIndex } : {}),
  };
  if (decoded.eventName === 'CurveBuy') {
    const a = decoded.args;
    return {
      side: 'buy',
      trader: lc(a.buyer),
      recipient: lc(a.recipient),
      quote: a.quoteIn,
      tokens: a.tokensOut,
      fee: a.fee,
      creatorTax: a.tax,
      tax: a.tax,
      ...common,
    };
  }
  if (decoded.eventName === 'CurveSell') {
    const a = decoded.args;
    return {
      side: 'sell',
      trader: lc(a.seller),
      recipient: lc(a.recipient),
      quote: a.quoteOut,
      tokens: a.tokensIn,
      fee: a.fee,
      creatorTax: a.tax,
      tax: a.tax,
      ...common,
    };
  }
  throw new Error(`not a curve trade log: ${decoded.eventName}`);
}

export interface SnipeTaxChargedParsed {
  recipient: Address;
  amount: bigint;
  curve: Address;
  block?: number;
  txHash?: Hash;
  logIndex?: number;
}

/** Decode a SnipeTaxCharged log (the actual snipe tax; separate from CurveBuy.tax). */
export function parseSnipeTaxChargedLog(log: RawLog): SnipeTaxChargedParsed {
  const decoded = decodeEventLog({ abi: curveAbi, ...normLog(log) });
  if (decoded.eventName !== 'SnipeTaxCharged') {
    throw new Error(`not a SnipeTaxCharged log: ${decoded.eventName}`);
  }
  const block = toBlockNumber(log.blockNumber);
  const logIndex = typeof log.logIndex === 'string' ? Number(BigInt(log.logIndex)) : log.logIndex ?? undefined;
  return {
    recipient: lc(decoded.args.recipient),
    amount: decoded.args.amount,
    curve: lc(log.address),
    ...(block !== undefined ? { block } : {}),
    ...(log.transactionHash ? { txHash: lc(log.transactionHash) as Hash } : {}),
    ...(logIndex !== undefined && logIndex !== null ? { logIndex } : {}),
  };
}

/** Decode a SnipeTaxExempted log; returns the exempt address. */
export function parseSnipeTaxExemptedLog(log: RawLog): { account: Address; curve: Address } {
  const decoded = decodeEventLog({ abi: curveAbi, ...normLog(log) });
  if (decoded.eventName !== 'SnipeTaxExempted') {
    throw new Error(`not a SnipeTaxExempted log: ${decoded.eventName}`);
  }
  return { account: lc(decoded.args.account), curve: lc(log.address) };
}

/** Decode a curve Initialized(token) log; returns the token address. */
export function parseCurveInitializedLog(log: RawLog): { token: Address; curve: Address } {
  const decoded = decodeEventLog({ abi: curveAbi, ...normLog(log) });
  if (decoded.eventName !== 'Initialized') {
    throw new Error(`not an Initialized log: ${decoded.eventName}`);
  }
  return { token: lc(decoded.args.token), curve: lc(log.address) };
}
