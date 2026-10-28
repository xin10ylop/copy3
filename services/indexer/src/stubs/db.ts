/**
 * ============================================================================
 * STUB - replace with the real helpers of `@hood/db` (docs/SPEC.md §2).
 * ============================================================================
 * packages/db had no exports when this service was written. These are working
 * implementations of the SPEC'd helper names on postgres.js, written against the
 * SPEC §2 tables plus the columns the coordinator added (curve_trades.snipe_tax,
 * token_transfers, token_metrics.dump_wallets / operator_sell_eth). The assumed
 * DDL is in ./schema.ts. Only `src/pg-store.ts` and `src/funding.ts` import this.
 *
 * Portability rule (so the same SQL runs on PGlite in tests): only scalar /
 * text[] parameters, timestamps via to_timestamp(seconds), numerics as text.
 */
import postgres from 'postgres';
import type { LaunchRow, TokenMetricsRow, TokenTransferRow, TradeRow, TransferRow, WalletRow } from '../types.js';

export type Sql = postgres.Sql;
export type Queryable = postgres.Sql | postgres.TransactionSql;

/** SPEC: createDb(url) */
export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
}

/** SPEC: notify(sql, channel, payload) */
export async function notify(sql: Queryable, channel: string, payload: string): Promise<void> {
  await sql`select pg_notify(${channel}, ${payload})`;
}

/** SPEC: listen(sql, channel, onPayload) */
export async function listen(
  sql: Sql,
  channel: string,
  onPayload: (payload: string) => void,
): Promise<{ unlisten: () => Promise<void> }> {
  const sub = await sql.listen(channel, onPayload);
  return { unlisten: () => sub.unlisten() };
}

const n = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

/** SPEC: upsertLaunch(sql, row) - first write wins (idempotent backfill). */
export async function upsertLaunch(sql: Queryable, l: LaunchRow): Promise<void> {
  await sql`
    insert into launches (token, curve, deployer, launcher, launch_kind, creator_fee_recipient, creator_tax_bps,
      name, symbol, logo, pair_token, launch_config_id, graduation_threshold, exemptions, dev_buy_quote,
      block, ts, tx_hash, tx_from, start_price, start_mcap_eth, graduated)
    values (${l.token}, ${l.curve}, ${l.deployer}, ${l.launcher}, ${l.launchKind}, ${l.creatorFeeRecipient},
      ${l.creatorTaxBps}, ${l.name}, ${l.symbol}, ${l.logo}, ${l.pairToken}, ${n(l.launchConfigId)},
      ${n(l.graduationThreshold)}, ${l.exemptions}::text[], ${n(l.devBuyQuote)}, ${l.block}, to_timestamp(${l.ts}),
      ${l.txHash}, ${l.txFrom}, ${l.startPrice}, ${l.startMcapEth}, ${l.graduated})
    on conflict (token) do nothing`;
}

/** SPEC: insertTrade(sql, row) */
export async function insertTrade(sql: Queryable, t: TradeRow): Promise<void> {
  await sql`
    insert into curve_trades (token, curve, block, ts, tx_hash, log_index, side, trader, recipient, tx_from,
      quote, tokens, fee, tax, snipe_tax, price_after, seconds_since_launch, exempt)
    values (${t.token}, ${t.curve}, ${t.block}, to_timestamp(${t.ts}), ${t.txHash}, ${t.logIndex}, ${t.side},
      ${t.trader}, ${t.recipient}, ${t.txFrom}, ${n(t.quote)}, ${n(t.tokens)}, ${n(t.fee)}, ${n(t.tax)},
      ${n(t.snipeTax)}, ${t.priceAfter}, ${t.secondsSinceLaunch}, ${t.exempt})
    on conflict (tx_hash, log_index) do nothing`;
}

/** insertTokenTransfer(sql, row) - token_transfers (coordinator addition) */
export async function insertTokenTransfer(sql: Queryable, t: TokenTransferRow): Promise<void> {
  await sql`
    insert into token_transfers (token, block, ts, tx_hash, log_index, from_addr, to_addr, value)
    values (${t.token}, ${t.block}, to_timestamp(${t.ts}), ${t.txHash}, ${t.logIndex}, ${t.from}, ${t.to}, ${n(t.value)})
    on conflict (tx_hash, log_index) do nothing`;
}

/** SPEC: insertTransfer(sql, row) - eth_transfers */
export async function insertTransfer(sql: Queryable, t: TransferRow): Promise<void> {
  await sql`
    insert into eth_transfers (block, ts, tx_hash, trace_addr, from_addr, to_addr, value, kind)
    values (${t.block}, to_timestamp(${t.ts}), ${t.txHash}, ${t.traceAddr}, ${t.from}, ${t.to}, ${n(t.value)}, ${t.kind})
    on conflict (tx_hash, trace_addr) do nothing`;
}

/** SPEC: upsertWallet(sql, row) - first funding wins. */
export async function upsertWallet(sql: Queryable, w: WalletRow): Promise<void> {
  await sql`
    insert into wallets (address, first_seen_block, first_seen_ts, first_funder, first_funding_value,
      first_funding_tx, is_contract, tx_count_at_first_funding)
    values (${w.address}, ${w.firstSeenBlock}, to_timestamp(${w.firstSeenTs}), ${w.firstFunder},
      ${n(w.firstFundingValue)}, ${w.firstFundingTx}, ${w.isContract}, ${w.txCountAtFirstFunding})
    on conflict (address) do nothing`;
}

/** SPEC: upsertTokenMetrics(sql, row) */
export async function upsertTokenMetrics(sql: Queryable, m: TokenMetricsRow): Promise<void> {
  const ts = (v: number | null) => (v === null ? null : v);
  await sql`
    insert into token_metrics (token, first_taxed_buyer, first_taxed_ts, first_taxed_block, first_taxed_price,
      first_taxed_mcap_eth, tax_free_buy_count, tax_free_quote, ath_price, ath_ts, ath_mcap_eth,
      peak2_pct, peak5_pct, peak10_pct, peak30_pct, peak60_pct, mcap2, mcap5, mcap10, mcap30, mcap60,
      low_after_entry_pct, n_buys_60s, n_sells_60s, exempt_sold_within_sec, dump_wallets, operator_sell_eth, updated_at)
    values (${m.token}, ${m.firstTaxedBuyer}, to_timestamp(${ts(m.firstTaxedTs)}), ${m.firstTaxedBlock},
      ${m.firstTaxedPrice}, ${m.firstTaxedMcapEth}, ${m.taxFreeBuyCount}, ${n(m.taxFreeQuote)}, ${m.athPrice},
      to_timestamp(${ts(m.athTs)}), ${m.athMcapEth}, ${m.peak2Pct}, ${m.peak5Pct}, ${m.peak10Pct}, ${m.peak30Pct},
      ${m.peak60Pct}, ${m.mcap2}, ${m.mcap5}, ${m.mcap10}, ${m.mcap30}, ${m.mcap60}, ${m.lowAfterEntryPct},
      ${m.nBuys60s}, ${m.nSells60s}, ${m.exemptSoldWithinSec}, ${m.dumpWallets}::text[], ${m.operatorSellEth}, now())
    on conflict (token) do update set
      first_taxed_buyer = excluded.first_taxed_buyer, first_taxed_ts = excluded.first_taxed_ts,
      first_taxed_block = excluded.first_taxed_block, first_taxed_price = excluded.first_taxed_price,
      first_taxed_mcap_eth = excluded.first_taxed_mcap_eth, tax_free_buy_count = excluded.tax_free_buy_count,
      tax_free_quote = excluded.tax_free_quote, ath_price = excluded.ath_price, ath_ts = excluded.ath_ts,
      ath_mcap_eth = excluded.ath_mcap_eth, peak2_pct = excluded.peak2_pct, peak5_pct = excluded.peak5_pct,
      peak10_pct = excluded.peak10_pct, peak30_pct = excluded.peak30_pct, peak60_pct = excluded.peak60_pct,
      mcap2 = excluded.mcap2, mcap5 = excluded.mcap5, mcap10 = excluded.mcap10, mcap30 = excluded.mcap30,
      mcap60 = excluded.mcap60, low_after_entry_pct = excluded.low_after_entry_pct,
      n_buys_60s = excluded.n_buys_60s, n_sells_60s = excluded.n_sells_60s,
      exempt_sold_within_sec = excluded.exempt_sold_within_sec, dump_wallets = excluded.dump_wallets,
      operator_sell_eth = excluded.operator_sell_eth, updated_at = now()`;
}

/** settings helpers */
export async function getSetting<T>(sql: Queryable, key: string): Promise<T | null> {
  const rows = await sql<{ value: string }[]>`select value::text as value from settings where key = ${key}`;
  const v = rows[0]?.value;
  return v === undefined ? null : (JSON.parse(v) as T);
}

export async function setSetting(sql: Queryable, key: string, value: unknown): Promise<void> {
  await sql`
    insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (key) do update set value = excluded.value`;
}
