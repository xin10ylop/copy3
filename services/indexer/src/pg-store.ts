/** IndexerStore on Postgres (postgres.js) via the @hood/db helpers. */
import {
  columnsOf,
  getSetting,
  insertTokenTransfer,
  insertTrade,
  insertTransfer,
  notify,
  setSetting,
  upsertLaunch,
  upsertTokenMetrics,
  upsertWallet,
  type Sql,
} from './stubs/db.js';
import { CHECKPOINT_KEY, TRANSFERS_CHANNEL, type Batch, type DirectoryEntry, type IndexerStore, type StoredCurve } from './store.js';
import type { Address, Checkpoint, Hex, LaunchKind, LaunchRow, TokenTransferRow, TradeRow, TradeSide } from './types.js';

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v));

interface LaunchDbRow {
  token: string;
  curve: string;
  deployer: string;
  launcher: string | null;
  launch_kind: string | null;
  creator_fee_recipient: string | null;
  creator_tax_bps: number | null;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  pair_token: string | null;
  launch_config_id: string | null;
  graduation_threshold: string | null;
  exemptions: string[] | null;
  dev_buy_quote: string | null;
  block: number;
  ts: number;
  tx_hash: string | null;
  tx_from: string | null;
  start_price: number | null;
  start_mcap_eth: number | null;
  graduated: boolean;
}

interface TradeDbRow {
  token: string;
  curve: string;
  block: number;
  ts: number;
  tx_hash: string;
  log_index: number;
  side: string;
  trader: string | null;
  recipient: string | null;
  tx_from: string | null;
  quote: string;
  tokens: string;
  fee: string;
  tax: string;
  snipe_tax: string | null;
  price_after: number | null;
  seconds_since_launch: number | null;
  exempt: boolean | null;
}

interface TokenTransferDbRow {
  token: string;
  block: number;
  ts: number;
  tx_hash: string;
  log_index: number;
  from_addr: string;
  to_addr: string;
  value: string;
}

export function launchFromDb(r: LaunchDbRow): LaunchRow {
  return {
    token: r.token as Address,
    curve: r.curve as Address,
    deployer: r.deployer as Address,
    launcher: r.launcher as Address | null,
    launchKind: (r.launch_kind ?? 'unknown') as LaunchKind,
    creatorFeeRecipient: r.creator_fee_recipient as Address | null,
    creatorTaxBps: r.creator_tax_bps,
    name: r.name,
    symbol: r.symbol,
    logo: r.logo,
    pairToken: (r.pair_token ?? '0x0000000000000000000000000000000000000000') as Address,
    launchConfigId: big(r.launch_config_id) ?? 0n,
    graduationThreshold: big(r.graduation_threshold) ?? 0n,
    exemptions: (r.exemptions ?? []) as Address[],
    // dev_buy_quote is NOT NULL DEFAULT 0 in the migration: 0 means "no dev buy" (null in LaunchRow)
    devBuyQuote: big(r.dev_buy_quote) || null,
    block: Number(r.block),
    ts: Number(r.ts),
    txHash: (r.tx_hash ?? '0x') as Hex,
    txFrom: (r.tx_from ?? r.deployer) as Address,
    startPrice: r.start_price,
    startMcapEth: r.start_mcap_eth,
    graduated: r.graduated,
  };
}

export function tradeFromDb(r: TradeDbRow): TradeRow {
  return {
    token: r.token as Address,
    curve: r.curve as Address,
    block: Number(r.block),
    ts: Number(r.ts),
    txHash: r.tx_hash as Hex,
    logIndex: Number(r.log_index),
    side: r.side as TradeSide,
    trader: (r.trader ?? '') as Address,
    recipient: (r.recipient ?? '') as Address,
    txFrom: r.tx_from as Address | null,
    quote: BigInt(r.quote),
    tokens: BigInt(r.tokens),
    fee: BigInt(r.fee),
    tax: BigInt(r.tax),
    snipeTax: big(r.snipe_tax) ?? 0n,
    priceAfter: r.price_after,
    secondsSinceLaunch: r.seconds_since_launch,
    exempt: r.exempt ?? false,
  };
}

function tokenTransferFromDb(r: TokenTransferDbRow): TokenTransferRow {
  return {
    token: r.token as Address,
    block: Number(r.block),
    ts: Number(r.ts),
    txHash: r.tx_hash as Hex,
    logIndex: Number(r.log_index),
    from: r.from_addr as Address,
    to: r.to_addr as Address,
    value: BigInt(r.value),
  };
}

const LAUNCH_COLS = `token, curve, deployer, launcher, launch_kind, creator_fee_recipient, creator_tax_bps, name, symbol,
  logo, pair_token, launch_config_id::text as launch_config_id, graduation_threshold::text as graduation_threshold,
  exemptions, dev_buy_quote::text as dev_buy_quote, block::float8 as block, extract(epoch from ts)::float8 as ts,
  tx_hash, tx_from, start_price, start_mcap_eth, graduated`;

export class PgStore implements IndexerStore {
  private extra: { dumpWallets: boolean; operatorSellEth: boolean } | null = null;

  constructor(readonly sql: Sql) {}

  /** token_metrics.dump_wallets / operator_sell_eth are written only if the migration has them */
  private async metricsExtra(): Promise<{ dumpWallets: boolean; operatorSellEth: boolean }> {
    if (!this.extra) {
      const cols = await columnsOf(this.sql, 'token_metrics');
      this.extra = { dumpWallets: cols.has('dump_wallets'), operatorSellEth: cols.has('operator_sell_eth') };
    }
    return this.extra;
  }

  async writeBatch(b: Batch): Promise<void> {
    const extra = b.metrics.length ? await this.metricsExtra() : null;
    await this.sql.begin(async (tx) => {
      for (const l of b.launches) await upsertLaunch(tx, l);
      for (const t of b.trades) await insertTrade(tx, t);
      for (const t of b.tokenTransfers) await insertTokenTransfer(tx, t);
      for (const t of b.transfers) await insertTransfer(tx, t);
      for (const w of b.wallets) await upsertWallet(tx, w);
      for (const [token, ex] of b.exemptionUpdates) {
        await tx.query(`update launches set exemptions = $2::text[] where token = $1`, [token, ex]);
      }
      for (const token of b.graduated) await tx.query(`update launches set graduated = true where token = $1`, [token]);
      for (const m of b.metrics) await upsertTokenMetrics(tx, m, extra ?? undefined);
      if (b.checkpoint) await setSetting(tx, CHECKPOINT_KEY, b.checkpoint);
    });
  }

  getCheckpoint(): Promise<Checkpoint | null> {
    return getSetting<Checkpoint>(this.sql, CHECKPOINT_KEY);
  }

  async loadDirectory(): Promise<DirectoryEntry[]> {
    const rows = await this.sql.query<{ token: string; curve: string; ts: number }>(
      `select token, curve, extract(epoch from ts)::float8 as ts from launches`,
    );
    return rows.map((r) => ({ token: r.token as Address, curve: r.curve as Address, ts: Number(r.ts) }));
  }

  async loadCurve(curve: Address): Promise<StoredCurve | null> {
    const launches = await this.sql.query<LaunchDbRow>(`select ${LAUNCH_COLS} from launches where curve = $1 limit 1`, [curve]);
    const trades = await this.sql.query<TradeDbRow>(
      `select token, curve, block::float8 as block, extract(epoch from ts)::float8 as ts, tx_hash, log_index, side, trader,
         recipient, tx_from, quote::text as quote, tokens::text as tokens, fee::text as fee, tax::text as tax,
         snipe_tax::text as snipe_tax, price_after, seconds_since_launch, exempt
       from curve_trades where curve = $1 order by block, log_index`,
      [curve],
    );
    const launch = launches[0] ? launchFromDb(launches[0]) : null;
    const token = launch?.token ?? (trades[0]?.token as Address | undefined);
    if (!token) return null;
    const transfers = await this.sql.query<TokenTransferDbRow>(
      `select token, block::float8 as block, extract(epoch from ts)::float8 as ts, tx_hash, log_index, from_addr, to_addr,
         value::text as value
       from token_transfers where token = $1 order by block, log_index`,
      [token],
    );
    return { launch, token, trades: trades.map(tradeFromDb), tokenTransfers: transfers.map(tokenTransferFromDb) };
  }

  async knownWallets(addresses: readonly Address[]): Promise<Set<Address>> {
    if (addresses.length === 0) return new Set();
    const rows = await this.sql.query<{ address: string }>(`select address from wallets where address = any($1::text[])`, [
      [...addresses],
    ]);
    return new Set(rows.map((r) => r.address as Address));
  }

  async rollbackFrom(block: number): Promise<Address[]> {
    return this.sql.begin(async (tx) => {
      const rows = await tx.query<{ token: string }>(
        `select distinct token from curve_trades where block >= $1
         union select distinct token from token_transfers where block >= $1`,
        [block],
      );
      await tx.query(`delete from curve_trades where block >= $1`, [block]);
      await tx.query(`delete from token_transfers where block >= $1`, [block]);
      await tx.query(`delete from token_metrics where token in (select token from launches where block >= $1)`, [block]);
      const gone = await tx.query<{ token: string }>(`delete from launches where block >= $1 returning token`, [block]);
      await tx.query(`delete from eth_transfers where block >= $1`, [block]);
      await tx.query(`delete from wallets where first_seen_block >= $1`, [block]);
      await tx.query(`delete from settings where key = $1 and (value->>'block')::bigint >= $2`, [CHECKPOINT_KEY, block]);
      const goneSet = new Set(gone.map((g) => g.token));
      return rows.map((r) => r.token as Address).filter((t) => !goneSet.has(t));
    });
  }

  async notifyTransfers(block: number): Promise<void> {
    await notify(this.sql, TRANSFERS_CHANNEL, String(block));
  }
}
