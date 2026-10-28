/**
 * Adapter from the indexer's row types (camelCase, unix-second timestamps, bigint
 * wei) onto the @hood/db helpers (`*Input` types, Date timestamps). The only
 * module besides pg-store/funding that knows about @hood/db.
 */
import {
  getSetting,
  insertTokenTransfer,
  insertTrade,
  insertTransfer,
  setSetting,
  upsertLaunch,
  upsertTokenMetrics,
  upsertWallet,
  type Sql,
} from '@hood/db';
import type { LaunchRow, TokenMetricsRow, TokenTransferRow, TradeRow, TransferRow, WalletRow } from './types.js';

export type { Sql, Row } from '@hood/db';
export { getSetting, setSetting };

const date = (ts: number | null): Date | null => (ts === null ? null : new Date(ts * 1000));

export async function writeLaunch(sql: Sql, l: LaunchRow): Promise<void> {
  await upsertLaunch(sql, {
    token: l.token,
    curve: l.curve,
    deployer: l.deployer,
    launcher: l.launcher,
    launchKind: l.launchKind,
    creatorFeeRecipient: l.creatorFeeRecipient,
    creatorTaxBps: l.creatorTaxBps ?? 0,
    name: l.name,
    symbol: l.symbol,
    logo: l.logo,
    pairToken: l.pairToken,
    launchConfigId: l.launchConfigId,
    graduationThreshold: l.graduationThreshold,
    exemptions: l.exemptions,
    devBuyQuote: l.devBuyQuote ?? 0n,
    block: l.block,
    ts: date(l.ts),
    txHash: l.txHash,
    txFrom: l.txFrom,
    startPrice: l.startPrice,
    startMcapEth: l.startMcapEth,
  });
  if (l.graduated) await sql.query(`update launches set graduated = true where token = $1`, [l.token]);
}

export async function writeTrade(sql: Sql, t: TradeRow): Promise<void> {
  await insertTrade(sql, {
    token: t.token,
    curve: t.curve,
    block: t.block,
    ts: date(t.ts),
    txHash: t.txHash,
    logIndex: t.logIndex,
    side: t.side,
    trader: t.trader,
    recipient: t.recipient,
    txFrom: t.txFrom,
    quote: t.quote,
    tokens: t.tokens,
    fee: t.fee,
    tax: t.tax,
    snipeTax: t.snipeTax,
    priceAfter: t.priceAfter,
    secondsSinceLaunch: t.secondsSinceLaunch,
    exempt: t.exempt,
  });
}

export async function writeTokenTransfer(sql: Sql, t: TokenTransferRow): Promise<void> {
  await insertTokenTransfer(sql, {
    token: t.token,
    block: t.block,
    ts: date(t.ts),
    txHash: t.txHash,
    logIndex: t.logIndex,
    fromAddr: t.from,
    toAddr: t.to,
    value: t.value,
  });
}

export async function writeTransfer(sql: Sql, t: TransferRow): Promise<void> {
  await insertTransfer(sql, {
    block: t.block,
    ts: date(t.ts),
    txHash: t.txHash,
    traceAddr: t.traceAddr,
    fromAddr: t.from,
    toAddr: t.to,
    value: t.value,
    kind: t.kind,
  });
}

export async function writeWallet(sql: Sql, w: WalletRow): Promise<void> {
  await upsertWallet(sql, {
    address: w.address,
    firstSeenBlock: w.firstSeenBlock,
    firstSeenTs: date(w.firstSeenTs),
    firstFunder: w.firstFunder,
    firstFundingValue: w.firstFundingValue,
    firstFundingTx: w.firstFundingTx,
    isContract: w.isContract ?? false,
    txCountAtFirstFunding: w.txCountAtFirstFunding,
  });
}

export interface MetricsExtraColumns {
  dumpWallets: boolean;
  operatorSellEth: boolean;
}

/**
 * token_metrics via @hood/db upsertTokenMetrics (SPEC columns), plus the coordinator's
 * dump_wallets / operator_sell_eth when the migration has those columns.
 */
export async function writeMetrics(sql: Sql, m: TokenMetricsRow, extra: MetricsExtraColumns): Promise<void> {
  await upsertTokenMetrics(sql, m.token, {
    first_taxed_buyer: m.firstTaxedBuyer,
    first_taxed_ts: date(m.firstTaxedTs),
    first_taxed_block: m.firstTaxedBlock,
    first_taxed_price: m.firstTaxedPrice,
    first_taxed_mcap_eth: m.firstTaxedMcapEth,
    tax_free_buy_count: m.taxFreeBuyCount,
    tax_free_quote: m.taxFreeQuote,
    ath_price: m.athPrice,
    ath_ts: date(m.athTs),
    ath_mcap_eth: m.athMcapEth,
    peak2_pct: m.peak2Pct,
    peak5_pct: m.peak5Pct,
    peak10_pct: m.peak10Pct,
    peak30_pct: m.peak30Pct,
    peak60_pct: m.peak60Pct,
    mcap2: m.mcap2,
    mcap5: m.mcap5,
    mcap10: m.mcap10,
    mcap30: m.mcap30,
    mcap60: m.mcap60,
    low_after_entry_pct: m.lowAfterEntryPct,
    n_buys_60s: m.nBuys60s,
    n_sells_60s: m.nSells60s,
    exempt_sold_within_sec: m.exemptSoldWithinSec,
  });
  if (extra.dumpWallets) {
    await sql.query(`update token_metrics set dump_wallets = $2::text[] where token = $1`, [m.token, m.dumpWallets]);
  }
  if (extra.operatorSellEth) {
    await sql.query(`update token_metrics set operator_sell_eth = $2 where token = $1`, [m.token, m.operatorSellEth]);
  }
}

/** Which columns a table has (information_schema), e.g. to detect optional columns. */
export async function columnsOf(sql: Sql, table: string): Promise<Set<string>> {
  const rows = await sql.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}
