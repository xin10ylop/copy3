/**
 * Types used by the indexer.
 *
 * - `Rpc*` types mirror the raw JSON-RPC shapes (hex quantities) so that fixtures
 *   captured from the node can be fed straight into the pure functions.
 * - `*Row` types are the camelCase form of the tables in docs/SPEC.md §2 (the
 *   Postgres store maps them to snake_case columns).
 */
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// ---------------------------------------------------------------- raw JSON-RPC

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  /** Nitro returns 0x0 here for eth_getLogs; never rely on it. */
  blockTimestamp?: Hex;
  removed?: boolean;
}

export interface RpcTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: Hex;
  input: Hex;
  nonce: Hex;
  blockNumber: Hex | null;
  blockHash: Hex | null;
  transactionIndex: Hex | null;
  type?: Hex;
}

export interface RpcBlock<TTx = RpcTransaction> {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
  transactions: TTx[];
}

export interface RpcReceipt {
  transactionHash: Hex;
  transactionIndex: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  from: Address;
  to: Address | null;
  contractAddress: Address | null;
  /** 0x1 success, 0x0 revert */
  status: Hex;
  logs: RpcLog[];
}

/** One frame of a geth `callTracer` result. */
export interface CallFrame {
  type: string; // CALL | STATICCALL | DELEGATECALL | CALLCODE | CREATE | CREATE2 | SELFDESTRUCT
  from: Address;
  to?: Address;
  value?: Hex;
  error?: string;
  revertReason?: string;
  calls?: CallFrame[];
}

// ---------------------------------------------------------------- domain rows

/** entry point used (matches @hood/core LaunchKind) or 'unknown' when the calldata was not decodable */
export type LaunchKind = 'launchToken' | 'launchAndBuy' | 'launchTokenFor' | 'unknown';

export interface LaunchRow {
  token: Address;
  curve: Address;
  deployer: Address;
  /** tx.to of the launch tx (factory, LaunchAndBuy router, or a whitelisted launcher) */
  launcher: Address | null;
  launchKind: LaunchKind;
  creatorFeeRecipient: Address | null;
  creatorTaxBps: number | null;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  pairToken: Address;
  launchConfigId: bigint;
  graduationThreshold: bigint;
  /** explicit calldata exemptions ∪ every SnipeTaxExempted address seen for this curve */
  exemptions: Address[];
  /** dev buy at launch (router launchAndBuy or a CurveBuy inside the launch tx); null when none */
  devBuyQuote: bigint | null;
  block: number;
  ts: number; // unix seconds
  txHash: Hex;
  txFrom: Address;
  startPrice: number | null; // ETH per token (spot, before the first trade)
  startMcapEth: number | null;
  graduated: boolean;
}

export type TradeSide = 'buy' | 'sell';

export interface TradeRow {
  token: Address;
  curve: Address;
  block: number;
  ts: number; // unix seconds
  txHash: Hex;
  logIndex: number;
  side: TradeSide;
  /** CurveBuy.buyer / CurveSell.seller (may be a router) */
  trader: Address;
  recipient: Address;
  txFrom: Address | null;
  /** buy: quoteIn (gross), sell: quoteOut (net) */
  quote: bigint;
  /** buy: tokensOut, sell: tokensIn */
  tokens: bigint;
  /** CurveBuy/CurveSell.fee - trade fee, which INCLUDES the snipe tax on buys */
  fee: bigint;
  /** CurveBuy/CurveSell.tax - the CREATOR tax */
  tax: bigint;
  /** SnipeTaxCharged.amount joined from the same tx (0 when none) */
  snipeTax: bigint;
  /** spot price (quoteReserve / tokenReserve) after the trade, ETH per token */
  priceAfter: number | null;
  secondsSinceLaunch: number | null;
  exempt: boolean;
}

export type TransferKind = 'tx' | 'internal' | 'create';

export interface TransferRow {
  block: number;
  ts: number;
  txHash: Hex;
  /** '' for the top-level tx, else comma-joined callTracer path, e.g. '0,2' */
  traceAddr: string;
  from: Address;
  to: Address;
  value: bigint;
  kind: TransferKind;
}

export interface TokenTransferRow {
  token: Address;
  block: number;
  ts: number;
  txHash: Hex;
  logIndex: number;
  from: Address;
  to: Address;
  value: bigint;
}

export interface WalletRow {
  address: Address;
  firstSeenBlock: number;
  firstSeenTs: number;
  firstFunder: Address | null;
  firstFundingValue: bigint | null;
  firstFundingTx: Hex | null;
  isContract: boolean | null;
  txCountAtFirstFunding: number | null;
}

export interface TokenMetricsRow {
  token: Address;
  firstTaxedBuyer: Address | null;
  firstTaxedTs: number | null;
  firstTaxedBlock: number | null;
  firstTaxedPrice: number | null;
  firstTaxedMcapEth: number | null;
  taxFreeBuyCount: number;
  taxFreeQuote: bigint;
  athPrice: number | null;
  athTs: number | null;
  athMcapEth: number | null;
  peak2Pct: number | null;
  peak5Pct: number | null;
  peak10Pct: number | null;
  peak30Pct: number | null;
  peak60Pct: number | null;
  mcap2: number | null;
  mcap5: number | null;
  mcap10: number | null;
  mcap30: number | null;
  mcap60: number | null;
  lowAfterEntryPct: number | null;
  nBuys60s: number;
  nSells60s: number;
  exemptSoldWithinSec: number | null;
  /** recipients of token transfers out of exempt wallets (the operator's dump wallets) */
  dumpWallets: Address[];
  /** ETH received by exempt ∪ dump wallets from curve sells */
  operatorSellEth: number;
}

export interface Reserves {
  quote: bigint;
  token: bigint;
}

export interface Checkpoint {
  block: number;
  hash: Hex;
}
