import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Address, Hex, LaunchRow, RpcBlock, RpcLog, RpcReceipt, RpcTransaction, TradeRow } from '../../src/types.js';
import { applyTrade } from '../../src/trades.js';
import { priceFromReserves } from '../../src/pons.js';

const FIXTURES = fileURLToPath(new URL('../../../../packages/core/test/fixtures/', import.meta.url));

/** JSON.parse that keeps integers with >= 16 digits exact (as strings). */
export function loadFixture<T>(name: string): T {
  const text = readFileSync(FIXTURES + name, 'utf8').replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  return JSON.parse(text) as T;
}

export interface LaunchTxFixture {
  tx: RpcTransaction & { blockTimestamp: Hex };
  receipt: RpcReceipt;
  block: Omit<RpcBlock<Hex>, 'transactions'> & Record<string, unknown>;
  blockTxHashes: Hex[];
}

export const launchTxFixture = () => loadFixture<LaunchTxFixture>('launch-tx.json');
export const curveLogsFixture = () => loadFixture<RpcLog[]>('curve-logs.json');

export interface AmlilTrade {
  blk: number;
  side: 'buy' | 'sell';
  actor: Address;
  recipient: Address;
  q: number | string;
  tok: number | string;
  fee: number | string;
  tax: number | string;
  snipe_tax: number | string;
  tx: Hex;
  ts: number;
}
export interface AmlilFixture {
  trades: AmlilTrade[];
  snipe: RpcLog[];
  meta: { token: Address; curve: Address; deployer: Address; launchedAt: number; exempt: Address[]; name: string; symbol: string };
}
export const amlilFixture = () => loadFixture<AmlilFixture>('amlil-trades.json');

export const AMLIL_DUMP_WALLET = '0xa98da960d6bbd1dcbbae5435ada744009adcea35' as Address;
export const ROUTER = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc' as Address;
export const START_RESERVES = { quote: 1_680_000_000_000_000_000n, token: 10n ** 27n };

export function amlilLaunch(f: AmlilFixture): LaunchRow {
  return {
    token: f.meta.token,
    curve: f.meta.curve,
    deployer: f.meta.deployer,
    launcher: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
    launchKind: 'launchToken',
    creatorFeeRecipient: null,
    creatorTaxBps: 200,
    name: f.meta.name,
    symbol: f.meta.symbol,
    logo: null,
    pairToken: '0x0000000000000000000000000000000000000000',
    launchConfigId: 0n,
    graduationThreshold: 4_200_000_000_000_000_000n,
    exemptions: f.meta.exempt.filter((a) => a !== f.meta.deployer),
    devBuyQuote: null,
    block: 95_940_695,
    ts: f.meta.launchedAt,
    txHash: '0x00',
    txFrom: f.meta.deployer,
    startPrice: 1.68e-9,
    startMcapEth: 1.68,
    graduated: false,
  };
}

/** Amlil trades as curve_trades rows, price_after from exact reserve replay. */
export function amlilTrades(f: AmlilFixture): TradeRow[] {
  let r = START_RESERVES;
  const exempt = new Set(f.meta.exempt);
  return f.trades.map((t, i) => {
    const amounts = {
      side: t.side,
      quote: BigInt(t.q),
      tokens: BigInt(t.tok),
      fee: BigInt(t.fee),
      tax: BigInt(t.tax),
    };
    r = applyTrade(r, amounts);
    const txFrom = t.actor === ROUTER ? t.recipient : t.actor;
    return {
      token: f.meta.token,
      curve: f.meta.curve,
      block: t.blk,
      ts: t.ts,
      txHash: t.tx,
      logIndex: i,
      ...amounts,
      trader: t.actor,
      recipient: t.recipient,
      txFrom,
      snipeTax: BigInt(t.snipe_tax),
      priceAfter: priceFromReserves(r.quote, r.token),
      secondsSinceLaunch: t.ts - f.meta.launchedAt,
      exempt: exempt.has(t.recipient) || exempt.has(t.actor),
    };
  });
}
