/**
 * ============================================================================
 * STUB - replace with the real exports of `@hood/db` (docs/SPEC.md §2).
 * ============================================================================
 * packages/db was still in progress when this service was written. This file
 * mirrors its driver-neutral `Sql` interface (packages/db/src/sql.ts:
 * query/exec/begin/listen/notify/end, `$n` placeholders) so switching to the real
 * package is an import change, and implements the SPEC'd helper names used by the
 * indexer/tracker with plain SQL against packages/db/migrations/0001_init.sql
 * (+ token_metrics.dump_wallets / operator_sell_eth when present).
 * Only src/pg-store.ts, src/funding.ts and src/main/backfill import this.
 */
import postgres from 'postgres';
import type { LaunchRow, TokenMetricsRow, TokenTransferRow, TradeRow, TransferRow, WalletRow } from '../types.js';

export type Row = Record<string, unknown>;

/** Same shape as `Sql` in packages/db/src/sql.ts. */
export interface Sql {
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
  end(): Promise<void>;
}

/** SPEC: createDb(url) - postgres.js wrapped as `Sql`. */
export function createDb(url: string, opts: { max?: number } = {}): Sql {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const wrap = (c: postgres.Sql | postgres.TransactionSql, root: postgres.Sql | null): Sql => ({
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await c.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[];
    },
    async exec(text: string): Promise<void> {
      await c.unsafe(text).simple();
    },
    begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      if (!root) return fn(wrap(c, null));
      return root.begin((tx) => fn(wrap(tx, null))) as Promise<T>;
    },
    async listen(channel, cb) {
      if (!root) throw new Error('listen() is not available inside a transaction');
      const sub = await root.listen(channel, cb);
      return () => sub.unlisten();
    },
    async notify(channel, payload) {
      await c.unsafe('select pg_notify($1, $2)', [channel, payload]);
    },
    async end() {
      if (root) await root.end({ timeout: 5 });
    },
  });
  return wrap(client, client);
}

/** SPEC: notify(sql, channel, payload) */
export async function notify(sql: Sql, channel: string, payload: string): Promise<void> {
  await sql.notify(channel, payload);
}

/** SPEC: listen(sql, channel, cb) -> unsubscribe */
export function listen(sql: Sql, channel: string, cb: (payload: string) => void): Promise<() => Promise<void>> {
  return sql.listen(channel, cb);
}

const num = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

/** SPEC: upsertLaunch(sql, row) - first write wins (idempotent backfill). */
export async function upsertLaunch(sql: Sql, l: LaunchRow): Promise<void> {
  await sql.query(
    `insert into launches (token, curve, deployer, launcher, launch_kind, creator_fee_recipient, creator_tax_bps,
       name, symbol, logo, pair_token, launch_config_id, graduation_threshold, exemptions, dev_buy_quote,
       block, ts, tx_hash, tx_from, start_price, start_mcap_eth, graduated)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15,$16,to_timestamp($17),$18,$19,$20,$21,$22)
     on conflict (token) do nothing`,
    [
      l.token, l.curve, l.deployer, l.launcher, l.launchKind, l.creatorFeeRecipient, l.creatorTaxBps ?? 0,
      l.name, l.symbol, l.logo, l.pairToken, num(l.launchConfigId), num(l.graduationThreshold), l.exemptions,
      num(l.devBuyQuote) ?? '0', l.block, l.ts, l.txHash, l.txFrom, l.startPrice, l.startMcapEth, l.graduated,
    ],
  );
}

/** SPEC: insertTrade(sql, row) */
export async function insertTrade(sql: Sql, t: TradeRow): Promise<void> {
  await sql.query(
    `insert into curve_trades (token, curve, block, ts, tx_hash, log_index, side, trader, recipient, tx_from,
       quote, tokens, fee, tax, snipe_tax, price_after, seconds_since_launch, exempt)
     values ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (tx_hash, log_index) do nothing`,
    [
      t.token, t.curve, t.block, t.ts, t.txHash, t.logIndex, t.side, t.trader, t.recipient, t.txFrom,
      num(t.quote), num(t.tokens), num(t.fee), num(t.tax), num(t.snipeTax), t.priceAfter, t.secondsSinceLaunch, t.exempt,
    ],
  );
}

/** insertTokenTransfer(sql, row) - token_transfers */
export async function insertTokenTransfer(sql: Sql, t: TokenTransferRow): Promise<void> {
  await sql.query(
    `insert into token_transfers (token, block, ts, tx_hash, log_index, from_addr, to_addr, value)
     values ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8) on conflict (tx_hash, log_index) do nothing`,
    [t.token, t.block, t.ts, t.txHash, t.logIndex, t.from, t.to, num(t.value)],
  );
}

/** SPEC: insertTransfer(sql, row) - eth_transfers */
export async function insertTransfer(sql: Sql, t: TransferRow): Promise<void> {
  await sql.query(
    `insert into eth_transfers (block, ts, tx_hash, trace_addr, from_addr, to_addr, value, kind)
     values ($1,to_timestamp($2),$3,$4,$5,$6,$7,$8) on conflict (tx_hash, trace_addr) do nothing`,
    [t.block, t.ts, t.txHash, t.traceAddr, t.from, t.to, num(t.value), t.kind],
  );
}

/** SPEC: upsertWallet(sql, row) - first funding wins. */
export async function upsertWallet(sql: Sql, w: WalletRow): Promise<void> {
  await sql.query(
    `insert into wallets (address, first_seen_block, first_seen_ts, first_funder, first_funding_value,
       first_funding_tx, is_contract, tx_count_at_first_funding)
     values ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8) on conflict (address) do nothing`,
    [w.address, w.firstSeenBlock, w.firstSeenTs, w.firstFunder, num(w.firstFundingValue), w.firstFundingTx,
      w.isContract ?? false, w.txCountAtFirstFunding],
  );
}

const METRIC_COLS = [
  'first_taxed_buyer', 'first_taxed_ts', 'first_taxed_block', 'first_taxed_price', 'first_taxed_mcap_eth',
  'tax_free_buy_count', 'tax_free_quote', 'ath_price', 'ath_ts', 'ath_mcap_eth', 'peak2_pct', 'peak5_pct',
  'peak10_pct', 'peak30_pct', 'peak60_pct', 'mcap2', 'mcap5', 'mcap10', 'mcap30', 'mcap60', 'low_after_entry_pct',
  'n_buys_60s', 'n_sells_60s', 'exempt_sold_within_sec',
] as const;
const TS_COLS = new Set(['first_taxed_ts', 'ath_ts']);

/**
 * SPEC: upsertTokenMetrics(sql, row). `extra` toggles the coordinator-added columns
 * (dump_wallets text[], operator_sell_eth double) so this works before and after
 * they exist in the migration.
 */
export async function upsertTokenMetrics(
  sql: Sql,
  m: TokenMetricsRow,
  extra: { dumpWallets: boolean; operatorSellEth: boolean } = { dumpWallets: true, operatorSellEth: true },
): Promise<void> {
  const values: Record<string, unknown> = {
    first_taxed_buyer: m.firstTaxedBuyer, first_taxed_ts: m.firstTaxedTs, first_taxed_block: m.firstTaxedBlock,
    first_taxed_price: m.firstTaxedPrice, first_taxed_mcap_eth: m.firstTaxedMcapEth,
    tax_free_buy_count: m.taxFreeBuyCount, tax_free_quote: num(m.taxFreeQuote), ath_price: m.athPrice,
    ath_ts: m.athTs, ath_mcap_eth: m.athMcapEth, peak2_pct: m.peak2Pct, peak5_pct: m.peak5Pct,
    peak10_pct: m.peak10Pct, peak30_pct: m.peak30Pct, peak60_pct: m.peak60Pct, mcap2: m.mcap2, mcap5: m.mcap5,
    mcap10: m.mcap10, mcap30: m.mcap30, mcap60: m.mcap60, low_after_entry_pct: m.lowAfterEntryPct,
    n_buys_60s: m.nBuys60s, n_sells_60s: m.nSells60s, exempt_sold_within_sec: m.exemptSoldWithinSec,
  };
  const cols: string[] = [...METRIC_COLS];
  if (extra.dumpWallets) {
    cols.push('dump_wallets');
    values.dump_wallets = m.dumpWallets;
  }
  if (extra.operatorSellEth) {
    cols.push('operator_sell_eth');
    values.operator_sell_eth = m.operatorSellEth;
  }
  const params: unknown[] = [m.token, ...cols.map((c) => values[c] ?? null)];
  const ph = cols.map((c, i) => {
    const p = `$${i + 2}`;
    if (TS_COLS.has(c)) return `to_timestamp(${p})`;
    if (c === 'dump_wallets') return `${p}::text[]`;
    return p;
  });
  await sql.query(
    `insert into token_metrics (token, ${cols.join(', ')}, updated_at) values ($1, ${ph.join(', ')}, now())
     on conflict (token) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = now()`,
    params,
  );
}

/** settings helpers */
export async function getSetting<T>(sql: Sql, key: string): Promise<T | null> {
  const rows = await sql.query<{ value: string }>(`select value::text as value from settings where key = $1`, [key]);
  const v = rows[0]?.value;
  return v === undefined ? null : (JSON.parse(v) as T);
}

export async function setSetting(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql.query(
    `insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

/** Which optional columns exist (information_schema), e.g. token_metrics.dump_wallets. */
export async function columnsOf(sql: Sql, table: string): Promise<Set<string>> {
  const rows = await sql.query<{ column_name: string }>(
    `select column_name from information_schema.columns where table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}
