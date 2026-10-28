/**
 * Adapter between the indexer and the Pons V2 decoding helpers of @hood/core.
 * This is the ONLY module that imports the core parsers / curve math; it maps
 * their shapes (throwing parsers, Reserves objects, array exempt sets) onto what
 * the indexer needs. Everything downstream works on the `PonsEvent` union below.
 */
import {
  LAUNCH_SUPPLY,
  PONS_V2,
  SNIPE_TAX_SECONDS,
  TOPICS,
  exemptSetForLaunch as coreExemptSet,
  mcapFromReserves as coreMcap,
  parseCurveTradeLog as coreParseTrade,
  parseLaunchCall as coreParseLaunchCall,
  parseSnipeTaxChargedLog as coreParseSnipeCharged,
  parseSnipeTaxExemptedLog as coreParseExempted,
  parseTokenLaunchedLog as coreParseLaunched,
  priceFromReserves as corePrice,
  type LaunchCall,
} from '@hood/core';
import type { Address, Hex, RpcLog } from './types.js';
import { hexToNum } from './hex.js';

export { LAUNCH_SUPPLY, SNIPE_TAX_SECONDS, type LaunchCall };

/** Pons topics used by the indexer (subset of @hood/core TOPICS). */
export const PONS_TOPICS = {
  TokenLaunched: TOPICS.TokenLaunched,
  RouterLaunched: TOPICS.RouterLaunched,
  CurveBuy: TOPICS.CurveBuy,
  CurveSell: TOPICS.CurveSell,
  SnipeTaxCharged: TOPICS.SnipeTaxCharged,
  SnipeTaxExempted: TOPICS.SnipeTaxExempted,
  CurveInitialized: TOPICS.CurveInitialized,
  CurveCompleted: TOPICS.CurveCompleted,
  LaunchSwept: TOPICS.LaunchSwept,
  PoolGraduated: TOPICS.PoolGraduated,
  Erc20Transfer: TOPICS.Erc20Transfer,
} as const satisfies Record<string, Hex>;

export const PONS_ADDRESSES = {
  factory: PONS_V2.factory,
  launchAndBuyRouter: PONS_V2.launchAndBuyRouter,
  launchDeployer: PONS_V2.launchDeployer,
  tradeRouterProxy: PONS_V2.tradeRouterProxy,
  uniswapV4PoolManager: PONS_V2.uniswapV4PoolManager,
} as const satisfies Record<string, Address>;

type LogLike = { address: string; topics: readonly string[]; data: string };

/** @hood/core parsers throw on a mismatching log; the indexer wants null. */
function tryParse<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** TokenLaunched (factory) or the router's Launched (same layout, different topic0). */
function parseTokenLaunchedLog(log: LogLike) {
  const topics = log.topics[0] === TOPICS.RouterLaunched ? [TOPICS.TokenLaunched, ...log.topics.slice(1)] : log.topics;
  const ev = tryParse(() => coreParseLaunched({ ...log, topics }));
  return ev
    ? {
        token: ev.token,
        curve: ev.curve,
        deployer: ev.deployer,
        pairToken: ev.pairToken,
        launchConfigId: ev.launchConfigId,
        graduationThreshold: ev.graduationThreshold,
      }
    : null;
}

function parseCurveTradeLog(log: LogLike) {
  const ev = tryParse(() => coreParseTrade(log));
  return ev
    ? { side: ev.side, curve: ev.curve, trader: ev.trader, recipient: ev.recipient, quote: ev.quote, tokens: ev.tokens, fee: ev.fee, tax: ev.creatorTax }
    : null;
}

function parseSnipeTaxExemptedLog(log: LogLike) {
  return tryParse(() => coreParseExempted(log));
}

function parseSnipeTaxChargedLog(log: LogLike) {
  const ev = tryParse(() => coreParseSnipeCharged(log));
  return ev ? { curve: ev.curve, recipient: ev.recipient, amount: ev.amount } : null;
}

/** parseLaunchCall from @hood/core (null for non-launch calldata or decode errors). */
export function parseLaunchCall(tx: { from: string; input: string }): LaunchCall | null {
  return tryParse(() => coreParseLaunchCall({ from: tx.from, input: tx.input }));
}

/** ETH per token from (quoteReserve, tokenReserve). */
export function priceFromReserves(quote: bigint, token: bigint): number {
  return corePrice({ quote, token });
}

/** market cap in ETH (1e9 supply). */
export function mcapFromReserves(quote: bigint, token: bigint): number {
  return coreMcap({ quote, token });
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** exempt set = deployer ∪ creatorFeeRecipient ∪ exemptions (lower-case). */
export function exemptSetForLaunch(launch: {
  deployer: string;
  creatorFeeRecipient?: string | null;
  exemptions?: readonly string[] | null;
}): Set<string> {
  const lc = (a: string) => a.toLowerCase() as Address;
  return new Set<string>(
    coreExemptSet({
      deployer: lc(launch.deployer),
      creatorFeeRecipient: launch.creatorFeeRecipient ? lc(launch.creatorFeeRecipient) : ZERO_ADDRESS,
      exemptions: (launch.exemptions ?? []).map(lc),
    }).map((a) => a.toLowerCase()),
  );
}

/** topic0 set subscribed to / fetched by the indexer (all Pons events, any address). */
export const INDEXED_TOPICS: Hex[] = [
  PONS_TOPICS.TokenLaunched,
  PONS_TOPICS.RouterLaunched,
  PONS_TOPICS.CurveBuy,
  PONS_TOPICS.CurveSell,
  PONS_TOPICS.SnipeTaxCharged,
  PONS_TOPICS.SnipeTaxExempted,
  PONS_TOPICS.CurveInitialized,
  PONS_TOPICS.CurveCompleted,
  PONS_TOPICS.LaunchSwept,
  PONS_TOPICS.PoolGraduated,
];

const INDEXED_SET = new Set<string>(INDEXED_TOPICS);

/** Addresses that are never "dump wallets": routers, the v4 pool manager, zero. */
export const VENUE_ADDRESSES = new Set<string>([
  PONS_ADDRESSES.tradeRouterProxy,
  PONS_ADDRESSES.launchAndBuyRouter,
  PONS_ADDRESSES.uniswapV4PoolManager,
  '0x0000000000000000000000000000000000000000',
]);

interface LogPos {
  block: number;
  txHash: Hex;
  logIndex: number;
  address: Address;
}

export type PonsEvent =
  | (LogPos & { type: 'launched'; token: Address; curve: Address; deployer: Address; pairToken: Address; launchConfigId: bigint; graduationThreshold: bigint; viaRouter: boolean })
  | (LogPos & { type: 'trade'; side: 'buy' | 'sell'; curve: Address; trader: Address; recipient: Address; quote: bigint; tokens: bigint; fee: bigint; tax: bigint; snipeTax: bigint })
  | (LogPos & { type: 'snipeTaxCharged'; curve: Address; recipient: Address; amount: bigint })
  | (LogPos & { type: 'exempted'; curve: Address; account: Address })
  | (LogPos & { type: 'initialized'; curve: Address; token: Address })
  | (LogPos & { type: 'graduated'; token: Address | null; curve: Address | null; event: 'CurveCompleted' | 'LaunchSwept' | 'PoolGraduated' });

export function isIndexedTopic(topic0: string | undefined): boolean {
  return topic0 !== undefined && INDEXED_SET.has(topic0);
}

function topicAddr(t: string | undefined): Address | null {
  if (!t || t.length !== 66) return null;
  return `0x${t.slice(26)}`.toLowerCase() as Address;
}

export function decodePonsLog(log: RpcLog): PonsEvent | null {
  const pos: LogPos = {
    block: hexToNum(log.blockNumber),
    txHash: log.transactionHash,
    logIndex: hexToNum(log.logIndex),
    address: log.address.toLowerCase() as Address,
  };
  const t0 = log.topics[0];
  switch (t0) {
    case PONS_TOPICS.TokenLaunched:
    case PONS_TOPICS.RouterLaunched: {
      const ev = parseTokenLaunchedLog(log);
      return ev ? { ...pos, type: 'launched', ...ev, viaRouter: t0 === PONS_TOPICS.RouterLaunched } : null;
    }
    case PONS_TOPICS.CurveBuy:
    case PONS_TOPICS.CurveSell: {
      const ev = parseCurveTradeLog(log);
      return ev ? { ...pos, type: 'trade', ...ev, snipeTax: 0n } : null;
    }
    case PONS_TOPICS.SnipeTaxCharged: {
      const ev = parseSnipeTaxChargedLog(log);
      return ev ? { ...pos, type: 'snipeTaxCharged', ...ev } : null;
    }
    case PONS_TOPICS.SnipeTaxExempted: {
      const ev = parseSnipeTaxExemptedLog(log);
      return ev ? { ...pos, type: 'exempted', ...ev } : null;
    }
    case PONS_TOPICS.CurveInitialized: {
      const token = log.data.length >= 66 ? (`0x${log.data.slice(26, 66)}`.toLowerCase() as Address) : null;
      return token ? { ...pos, type: 'initialized', curve: pos.address, token } : null;
    }
    case PONS_TOPICS.CurveCompleted:
      return { ...pos, type: 'graduated', token: null, curve: pos.address, event: 'CurveCompleted' };
    case PONS_TOPICS.LaunchSwept:
      return { ...pos, type: 'graduated', token: topicAddr(log.topics[1]), curve: null, event: 'LaunchSwept' };
    case PONS_TOPICS.PoolGraduated:
      return { ...pos, type: 'graduated', token: topicAddr(log.topics[1]), curve: null, event: 'PoolGraduated' };
    default:
      return null;
  }
}

/**
 * Decode + order logs and join every `SnipeTaxCharged` onto the `CurveBuy` it
 * belongs to. The snipe tax is a separate log that PRECEDES the CurveBuy in the
 * same tx and from the same curve (CurveBuy.tax is the creator tax; CurveBuy.fee
 * includes the snipe tax). A tx can contain several buys (bundlers), so each
 * charge goes to the first later, still unpaired CurveBuy of the same curve whose
 * recipient equals the charged recipient, else to the first later unpaired one.
 */
export function decodePonsLogs(logs: readonly RpcLog[]): PonsEvent[] {
  const sorted = [...logs].sort((a, b) => {
    const db = hexToNum(a.blockNumber) - hexToNum(b.blockNumber);
    return db !== 0 ? db : hexToNum(a.logIndex) - hexToNum(b.logIndex);
  });
  const out: PonsEvent[] = [];
  for (const log of sorted) {
    if (log.removed) continue;
    const ev = decodePonsLog(log);
    if (ev) out.push(ev);
  }
  const byTx = new Map<string, number[]>();
  out.forEach((e, i) => {
    if (e.type !== 'snipeTaxCharged' && !(e.type === 'trade' && e.side === 'buy')) return;
    const list = byTx.get(e.txHash) ?? [];
    list.push(i);
    byTx.set(e.txHash, list);
  });
  for (const idxs of byTx.values()) {
    const paired = new Set<number>();
    for (const [k, ci] of idxs.entries()) {
      const charge = out[ci]!;
      if (charge.type !== 'snipeTaxCharged') continue;
      const later = idxs.slice(k + 1).filter((j) => {
        const e = out[j]!;
        return !paired.has(j) && e.type === 'trade' && e.curve === charge.curve;
      });
      const j = later.find((x) => {
        const e = out[x]!;
        return e.type === 'trade' && e.recipient === charge.recipient;
      }) ?? later[0];
      if (j === undefined) continue;
      const buy = out[j]!;
      if (buy.type === 'trade') buy.snipeTax = charge.amount;
      paired.add(j);
    }
  }
  return out;
}

/** True when `addr` is any participant of the trade that is in the exempt set. */
export function tradeIsExempt(
  t: { trader: string; recipient: string; txFrom: string | null },
  exempt: ReadonlySet<string>,
): boolean {
  return exempt.has(t.recipient) || exempt.has(t.trader) || (t.txFrom !== null && exempt.has(t.txFrom));
}

/**
 * Factory/router events are only trusted from the real factory/router; curve
 * events can come from any address (curves are validated against the launch
 * directory or `factory()` before their trades are recorded).
 */
export function ponsLogAllowed(log: Pick<RpcLog, 'address' | 'topics'>): boolean {
  const t0 = log.topics[0];
  if (!isIndexedTopic(t0)) return false;
  const addr = log.address.toLowerCase();
  if (t0 === PONS_TOPICS.TokenLaunched || t0 === PONS_TOPICS.LaunchSwept || t0 === PONS_TOPICS.PoolGraduated) {
    return addr === PONS_ADDRESSES.factory;
  }
  if (t0 === PONS_TOPICS.RouterLaunched) return addr === PONS_ADDRESSES.launchAndBuyRouter;
  return true;
}
