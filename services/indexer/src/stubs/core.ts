/**
 * ============================================================================
 * STUB - replace with the real exports of `@hood/core` (docs/SPEC.md §1).
 * ============================================================================
 * packages/core was still a skeleton when this service was written, so these
 * are minimal but *working* implementations of the SPEC'd functions, decoded
 * with viem from the event/function signatures in docs/RESEARCH.md §3.
 * Only `src/pons.ts` imports this file; switching to @hood/core means changing
 * that one import and adapting shapes there.
 */
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  parseAbi,
  type Abi,
} from 'viem';
import type { Address, Hex } from '../types.js';

export const PONS_TOPICS = {
  TokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  RouterLaunched: '0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37',
  CurveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  CurveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  SnipeTaxCharged: '0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934',
  SnipeTaxExempted: '0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7',
  CurveInitialized: '0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6',
  CurveCompleted: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',
  LaunchSwept: '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',
  PoolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
  Erc20Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const satisfies Record<string, Hex>;

export const PONS_ADDRESSES = {
  factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  launchAndBuyRouter: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  launchDeployer: '0x3711cea4feade896c913c68f01eda97cb06d1a42',
  tradeRouterProxy: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
  uniswapV4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
} as const satisfies Record<string, Address>;

export const LAUNCH_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const SNIPE_TAX_START_BPS = 9900;
export const SNIPE_TAX_SECONDS = 3;

const eventsAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event SnipeTaxCharged(address indexed recipient, uint256 amount)',
  'event SnipeTaxExempted(address indexed account)',
]);

const launchAbi = parseAbi([
  'struct Socials { string a; string b; string c; string d; string e; }',
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 salt1; bytes32 salt2; }',
  'function launchToken(LaunchParams params, uint256 launchConfigId, address pairToken)',
  'function launchToken(LaunchParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions)',
  'function launchTokenFor(LaunchParams params, uint256 launchConfigId, address pairToken, address deployer, address[] snipeTaxExemptions)',
  'function launchAndBuy(LaunchParams params, uint256 launchConfigId, address pairToken, uint256 buyQuoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions)',
]) satisfies Abi;

interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

const lc = (a: string): Address => a.toLowerCase() as Address;

function decode(log: LogLike) {
  const [topic0, ...rest] = log.topics;
  if (topic0 === undefined) return null;
  try {
    return decodeEventLog({
      abi: eventsAbi,
      topics: [topic0 as Hex, ...(rest as Hex[])],
      data: log.data as Hex,
      strict: true,
    });
  } catch {
    return null;
  }
}

export interface TokenLaunchedEvent {
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
}

/** SPEC: parseTokenLaunchedLog(log). Also accepts the router's `Launched` event (same layout). */
export function parseTokenLaunchedLog(log: LogLike): TokenLaunchedEvent | null {
  const t0 = log.topics[0];
  if (t0 !== PONS_TOPICS.TokenLaunched && t0 !== PONS_TOPICS.RouterLaunched) return null;
  const ev = decode({ ...log, topics: [PONS_TOPICS.TokenLaunched, ...log.topics.slice(1)] });
  if (!ev || ev.eventName !== 'TokenLaunched') return null;
  return {
    token: lc(ev.args.token),
    curve: lc(ev.args.curve),
    deployer: lc(ev.args.deployer),
    pairToken: lc(ev.args.pairToken),
    launchConfigId: ev.args.launchConfigId,
    graduationThreshold: ev.args.graduationThreshold,
  };
}

export interface CurveTradeEvent {
  curve: Address;
  side: 'buy' | 'sell';
  /** buyer / seller (may be a router) */
  trader: Address;
  recipient: Address;
  /** buy: quoteIn, sell: quoteOut */
  quote: bigint;
  /** buy: tokensOut, sell: tokensIn */
  tokens: bigint;
  fee: bigint;
  /** creator tax */
  tax: bigint;
}

/** SPEC: parseCurveTradeLog(log) */
export function parseCurveTradeLog(log: LogLike): CurveTradeEvent | null {
  const ev = decode(log);
  if (!ev) return null;
  if (ev.eventName === 'CurveBuy') {
    return {
      curve: lc(log.address),
      side: 'buy',
      trader: lc(ev.args.buyer),
      recipient: lc(ev.args.recipient),
      quote: ev.args.quoteIn,
      tokens: ev.args.tokensOut,
      fee: ev.args.fee,
      tax: ev.args.tax,
    };
  }
  if (ev.eventName === 'CurveSell') {
    return {
      curve: lc(log.address),
      side: 'sell',
      trader: lc(ev.args.seller),
      recipient: lc(ev.args.recipient),
      quote: ev.args.quoteOut,
      tokens: ev.args.tokensIn,
      fee: ev.args.fee,
      tax: ev.args.tax,
    };
  }
  return null;
}

/** SPEC: parseSnipeTaxExemptedLog(log) */
export function parseSnipeTaxExemptedLog(log: LogLike): { curve: Address; account: Address } | null {
  if (log.topics[0] !== PONS_TOPICS.SnipeTaxExempted || log.topics.length < 2) return null;
  const ev = decode(log);
  if (!ev || ev.eventName !== 'SnipeTaxExempted') return null;
  return { curve: lc(log.address), account: lc(ev.args.account) };
}

/** SnipeTaxCharged(address indexed recipient, uint256 amount) */
export function parseSnipeTaxChargedLog(log: LogLike): { curve: Address; recipient: Address; amount: bigint } | null {
  if (log.topics[0] !== PONS_TOPICS.SnipeTaxCharged) return null;
  const ev = decode(log);
  if (!ev || ev.eventName !== 'SnipeTaxCharged') return null;
  return { curve: lc(log.address), recipient: lc(ev.args.recipient), amount: ev.args.amount };
}

export type LaunchCallKind = 'launchToken' | 'launchTokenFor' | 'launchAndBuy';

export interface LaunchCall {
  kind: LaunchCallKind;
  name: string;
  symbol: string;
  logo: string;
  description: string;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  launchConfigId: bigint;
  pairToken: Address;
  exemptions: Address[];
  /** router launchAndBuy only, else 0n */
  devBuyQuoteIn: bigint;
  /** explicit for launchTokenFor, else tx.from */
  deployer: Address;
}

/** SPEC: parseLaunchCall(tx) -> LaunchCall | null */
export function parseLaunchCall(tx: { from: string; input: string }): LaunchCall | null {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: launchAbi, data: tx.input as Hex });
  } catch {
    return null;
  }
  const base = (p: (typeof decoded.args)[0]) => ({
    name: p.name,
    symbol: p.symbol,
    logo: p.logo,
    description: p.description,
    creatorFeeRecipient: lc(p.creatorFeeRecipient),
    creatorTaxBps: p.creatorTaxBps,
    buybackEnabled: p.buybackEnabled,
  });
  const from = lc(getAddress(tx.from));
  switch (decoded.functionName) {
    case 'launchToken': {
      const a = decoded.args;
      const ex = a.length === 4 ? a[3] : [];
      return {
        kind: 'launchToken',
        ...base(a[0]),
        launchConfigId: a[1],
        pairToken: lc(a[2]),
        exemptions: ex.map(lc),
        devBuyQuoteIn: 0n,
        deployer: from,
      };
    }
    case 'launchTokenFor': {
      const a = decoded.args;
      return {
        kind: 'launchTokenFor',
        ...base(a[0]),
        launchConfigId: a[1],
        pairToken: lc(a[2]),
        exemptions: a[4].map(lc),
        devBuyQuoteIn: 0n,
        deployer: lc(a[3]),
      };
    }
    case 'launchAndBuy': {
      const a = decoded.args;
      return {
        kind: 'launchAndBuy',
        ...base(a[0]),
        launchConfigId: a[1],
        pairToken: lc(a[2]),
        exemptions: a[6].map(lc),
        devBuyQuoteIn: a[3],
        deployer: from,
      };
    }
  }
}

/** SPEC: priceFromReserves - ETH (quote units) per token, both 18 decimals. */
export function priceFromReserves(quote: bigint, token: bigint): number {
  if (token === 0n) return 0;
  // both reserves convert to doubles with ~16 significant digits; a fixed-point
  // division would keep only ~9 digits at 1e-9 ETH/token prices
  return Number(quote) / Number(token);
}

/** SPEC: mcapFromReserves(quote, token) - price * 1e9 supply, in quote units. */
export function mcapFromReserves(quote: bigint, token: bigint): number {
  return priceFromReserves(quote, token) * 1e9;
}

/** SPEC: snipeTaxBps(elapsedSec, startBps=9900, seconds=3) */
export function snipeTaxBps(elapsedSec: number, startBps = SNIPE_TAX_START_BPS, seconds = SNIPE_TAX_SECONDS): number {
  if (elapsedSec < 0) return startBps;
  const shift = Math.floor((elapsedSec * 14) / seconds);
  return shift >= 31 ? 0 : startBps >> shift;
}

/** SPEC: exemptSetForLaunch = deployer ∪ creatorFeeRecipient ∪ explicit exemptions (lower-case). */
export function exemptSetForLaunch(launch: {
  deployer: string;
  creatorFeeRecipient?: string | null;
  exemptions?: readonly string[] | null;
}): Set<string> {
  const s = new Set<string>([launch.deployer.toLowerCase()]);
  if (launch.creatorFeeRecipient) s.add(launch.creatorFeeRecipient.toLowerCase());
  for (const e of launch.exemptions ?? []) s.add(e.toLowerCase());
  s.delete('0x0000000000000000000000000000000000000000');
  return s;
}
