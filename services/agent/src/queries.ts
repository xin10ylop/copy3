/**
 * Typed SQL (postgres.js tagged templates) for the agent's tools, against the schema in
 * docs/SPEC.md §2 plus the indexer additions `curve_trades.snipe_tax` and
 * `token_transfers(token, block, ts, tx_hash, log_index, from_addr, to_addr, value)`.
 *
 * Conventions:
 *  - addresses are passed lower-case (the tool layer validates and lower-cases them);
 *  - wei columns come back as ETH (float8) - `value::float8 / 1e18` - and token amounts
 *    as whole tokens, so the model never sees 78-digit integers;
 *  - timestamps come back as unix seconds (float8) via `extract(epoch from ts)`;
 *  - every list is paginated: `limit` is clamped to MAX_ROWS and one extra row is
 *    fetched to compute `nextOffset`.
 * The agent deliberately keeps its own SQL (instead of importing services/indexer's
 * funding helpers) so the two services stay decoupled. `Db` (src/db.ts) turns these
 * templates into `query(text, params)` calls on @hood/db's driver-agnostic `Sql`.
 *
 * Money conventions (core curve math): for buys `quote` is the gross quoteIn the buyer
 * sent; `fee` (1 %) INCLUDES the snipe tax, which is also stored separately in
 * `snipe_tax`; `tax` is the creator tax. For sells `quote` is the net quoteOut.
 */
import type { Db } from './db.js';
import type { BacktestItem, BacktestTrade, BacktestTransfer } from './backtest.js';
import { identityConditions, matchTrigger, type LaunchContext, type LaunchSecondFacts, type TriggerLike, type WalletFunding } from './trigger.js';

export type { Db };

export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 50;

export interface Page {
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface Paged<T> {
  rows: T[];
  nextOffset: number | null;
}

export function clampLimit(limit: number | undefined, def = DEFAULT_ROWS): number {
  if (limit === undefined || !Number.isFinite(limit)) return def;
  return Math.max(1, Math.min(MAX_ROWS, Math.floor(limit)));
}

function pageOf(page: Page, def = DEFAULT_ROWS): { limit: number; offset: number } {
  return { limit: clampLimit(page.limit, def), offset: Math.max(0, Math.floor(page.offset ?? 0)) };
}

function paged<T>(rows: readonly T[], p: { limit: number; offset: number }): Paged<T> {
  return { rows: rows.slice(0, p.limit), nextOffset: rows.length > p.limit ? p.offset + p.limit : null };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface LaunchRow {
  token: string;
  curve: string;
  deployer: string;
  launcher: string | null;
  launchKind: string | null;
  creatorFeeRecipient: string | null;
  creatorTaxBps: number | null;
  name: string | null;
  symbol: string | null;
  pairToken: string | null;
  exemptions: string[];
  devBuyEth: number | null;
  block: number;
  ts: number;
  txHash: string;
  txFrom: string | null;
  startPrice: number | null;
  startMcapEth: number | null;
  graduated: boolean;
}

export interface MetricsRow {
  firstTaxedBuyer: string | null;
  firstTaxedTs: number | null;
  firstTaxedBlock: number | null;
  firstTaxedPrice: number | null;
  firstTaxedMcapEth: number | null;
  taxFreeBuyCount: number | null;
  taxFreeQuoteEth: number | null;
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
  nBuys60s: number | null;
  nSells60s: number | null;
  exemptSoldWithinSec: number | null;
}

export type TokenRow = LaunchRow & { metrics: MetricsRow | null };

const launchCols = (sql: Db) => sql`
  l.token, l.curve, l.deployer, l.launcher, l.launch_kind as "launchKind",
  l.creator_fee_recipient as "creatorFeeRecipient", l.creator_tax_bps::int as "creatorTaxBps",
  l.name, l.symbol, l.pair_token as "pairToken", coalesce(l.exemptions, '{}'::text[]) as exemptions,
  (l.dev_buy_quote::float8 / 1e18) as "devBuyEth", l.block::float8 as block,
  extract(epoch from l.ts)::float8 as ts, l.tx_hash as "txHash", l.tx_from as "txFrom",
  l.start_price::float8 as "startPrice", l.start_mcap_eth::float8 as "startMcapEth", coalesce(l.graduated, false) as graduated`;

const metricCols = (sql: Db) => sql`
  m.token as "mToken", m.first_taxed_buyer as "firstTaxedBuyer", extract(epoch from m.first_taxed_ts)::float8 as "firstTaxedTs",
  m.first_taxed_block::float8 as "firstTaxedBlock", m.first_taxed_price::float8 as "firstTaxedPrice",
  m.first_taxed_mcap_eth::float8 as "firstTaxedMcapEth", m.tax_free_buy_count::int as "taxFreeBuyCount",
  (m.tax_free_quote::float8 / 1e18) as "taxFreeQuoteEth", m.ath_price::float8 as "athPrice",
  extract(epoch from m.ath_ts)::float8 as "athTs", m.ath_mcap_eth::float8 as "athMcapEth",
  m.peak2_pct::float8 as "peak2Pct", m.peak5_pct::float8 as "peak5Pct", m.peak10_pct::float8 as "peak10Pct",
  m.peak30_pct::float8 as "peak30Pct", m.peak60_pct::float8 as "peak60Pct",
  m.mcap2::float8 as mcap2, m.mcap5::float8 as mcap5, m.mcap10::float8 as mcap10, m.mcap30::float8 as mcap30, m.mcap60::float8 as mcap60,
  m.low_after_entry_pct::float8 as "lowAfterEntryPct", m.n_buys_60s::int as "nBuys60s", m.n_sells_60s::int as "nSells60s",
  m.exempt_sold_within_sec::float8 as "exemptSoldWithinSec"`;

type JoinedRow = LaunchRow & MetricsRow & { mToken: string | null };

function splitJoined(r: JoinedRow): TokenRow {
  const {
    mToken,
    firstTaxedBuyer,
    firstTaxedTs,
    firstTaxedBlock,
    firstTaxedPrice,
    firstTaxedMcapEth,
    taxFreeBuyCount,
    taxFreeQuoteEth,
    athPrice,
    athTs,
    athMcapEth,
    peak2Pct,
    peak5Pct,
    peak10Pct,
    peak30Pct,
    peak60Pct,
    mcap2,
    mcap5,
    mcap10,
    mcap30,
    mcap60,
    lowAfterEntryPct,
    nBuys60s,
    nSells60s,
    exemptSoldWithinSec,
    ...launch
  } = r;
  const metrics: MetricsRow | null = mToken
    ? {
        firstTaxedBuyer,
        firstTaxedTs,
        firstTaxedBlock,
        firstTaxedPrice,
        firstTaxedMcapEth,
        taxFreeBuyCount,
        taxFreeQuoteEth,
        athPrice,
        athTs,
        athMcapEth,
        peak2Pct,
        peak5Pct,
        peak10Pct,
        peak30Pct,
        peak60Pct,
        mcap2,
        mcap5,
        mcap10,
        mcap30,
        mcap60,
        lowAfterEntryPct,
        nBuys60s,
        nSells60s,
        exemptSoldWithinSec,
      }
    : null;
  return { ...launch, exemptions: [...(launch.exemptions ?? [])], metrics };
}

export async function getToken(sql: Db, ca: string): Promise<TokenRow | null> {
  const rows = await sql<JoinedRow[]>`
    select ${launchCols(sql)}, ${metricCols(sql)}
    from launches l left join token_metrics m on m.token = l.token
    where l.token = ${ca}`;
  return rows[0] ? splitJoined(rows[0]) : null;
}

export async function getTokens(sql: Db, cas: readonly string[]): Promise<TokenRow[]> {
  if (cas.length === 0) return [];
  const rows = await sql<JoinedRow[]>`
    select ${launchCols(sql)}, ${metricCols(sql)}
    from launches l left join token_metrics m on m.token = l.token
    where l.token = any(${[...cas]}::text[])
    order by l.ts`;
  return rows.map(splitJoined);
}

/** All token_metrics columns as stored (robust to columns added by the indexer). */
export async function getTokenMetricsRaw(sql: Db, ca: string): Promise<Record<string, unknown> | null> {
  const rows = await sql<{ m: Record<string, unknown> }[]>`select to_jsonb(m) as m from token_metrics m where m.token = ${ca}`;
  const m = rows[0]?.m;
  if (!m) return null;
  return typeof m === 'string' ? (JSON.parse(m) as Record<string, unknown>) : m;
}

export interface LaunchSummary {
  token: string;
  name: string | null;
  symbol: string | null;
  deployer: string;
  launchKind: string | null;
  devBuyEth: number | null;
  ts: number;
  startMcapEth: number | null;
  athMcapEth: number | null;
  firstTaxedMcapEth: number | null;
  taxFreeBuyCount: number | null;
  peak5Pct: number | null;
  peak10Pct: number | null;
  peak30Pct: number | null;
  peak60Pct: number | null;
}

const summaryCols = (sql: Db) => sql`
  l.token, l.name, l.symbol, l.deployer, l.launch_kind as "launchKind", (l.dev_buy_quote::float8 / 1e18) as "devBuyEth",
  extract(epoch from l.ts)::float8 as ts, l.start_mcap_eth::float8 as "startMcapEth", m.ath_mcap_eth::float8 as "athMcapEth",
  m.first_taxed_mcap_eth::float8 as "firstTaxedMcapEth", m.tax_free_buy_count::int as "taxFreeBuyCount",
  m.peak5_pct::float8 as "peak5Pct", m.peak10_pct::float8 as "peak10Pct", m.peak30_pct::float8 as "peak30Pct", m.peak60_pct::float8 as "peak60Pct"`;

export async function tokensByDeployer(sql: Db, deployer: string, page: Page = {}): Promise<Paged<LaunchSummary>> {
  const p = pageOf(page);
  const rows = await sql<LaunchSummary[]>`
    select ${summaryCols(sql)}
    from launches l left join token_metrics m on m.token = l.token
    where l.deployer = ${deployer}
    order by l.ts desc limit ${p.limit + 1} offset ${p.offset}`;
  return paged(rows, p);
}

/** Case-insensitive POSIX regex on name or symbol (validate the pattern before calling). */
export async function tokensByName(sql: Db, regex: string, opts: Page & { sinceTs?: number | undefined } = {}): Promise<Paged<LaunchSummary>> {
  const p = pageOf(opts);
  const since = opts.sinceTs ?? 0;
  const rows = await sql<LaunchSummary[]>`
    select ${summaryCols(sql)}
    from launches l left join token_metrics m on m.token = l.token
    where (l.name ~* ${regex} or l.symbol ~* ${regex}) and l.ts >= to_timestamp(${since}::float8)
    order by l.ts desc limit ${p.limit + 1} offset ${p.offset}`;
  return paged(rows, p);
}

/** SQL predicate: the launch included a dev buy (launchAndBuy, or a recorded dev_buy_quote). */
const devBuyPredicate = (sql: Db) => sql`(coalesce(l.dev_buy_quote, 0) > 0 or l.launch_kind in ('launchAndBuy', 'devBuy'))`;

export async function recentLaunches(
  sql: Db,
  opts: Page & { sinceTs: number; launchKind?: 'devBuy' | 'noDevBuy' | undefined },
): Promise<Paged<LaunchSummary>> {
  const p = pageOf(opts);
  const kind = opts.launchKind ?? null;
  const rows = await sql<LaunchSummary[]>`
    select ${summaryCols(sql)}
    from launches l left join token_metrics m on m.token = l.token
    where l.ts >= to_timestamp(${opts.sinceTs}::float8)
      and (${kind}::text is null or (${kind}::text = 'devBuy') = ${devBuyPredicate(sql)})
    order by l.ts desc limit ${p.limit + 1} offset ${p.offset}`;
  return paged(rows, p);
}

export type PeakWindowSec = 2 | 5 | 10 | 30 | 60;

export interface RunnerRow extends LaunchSummary {
  peakPct: number | null;
  creatorFeeRecipient: string | null;
  exemptions: string[];
  deployerFunder: string | null;
  deployerFundingEth: number | null;
  deployerFresh: boolean | null;
  funderIsContract: boolean | null;
  funderCreator: string | null;
}

/** Launches whose peak in `window` seconds from the first taxed entry is >= minPeakPct, with deployer-funding fingerprint. */
export async function runners(
  sql: Db,
  opts: Page & { sinceTs: number; untilTs?: number | undefined; minPeakPct: number; window: PeakWindowSec },
): Promise<Paged<RunnerRow>> {
  const p = pageOf(opts);
  const until = opts.untilTs ?? 4_102_444_800; // 2100-01-01
  const rows = await sql<RunnerRow[]>`
    select ${summaryCols(sql)},
      (case ${opts.window}::int when 2 then m.peak2_pct when 5 then m.peak5_pct when 10 then m.peak10_pct
                                when 30 then m.peak30_pct else m.peak60_pct end)::float8 as "peakPct",
      l.creator_fee_recipient as "creatorFeeRecipient", coalesce(l.exemptions, '{}'::text[]) as exemptions,
      coalesce(w.first_funder, fi.from_addr) as "deployerFunder",
      (coalesce(w.first_funding_value, fi.value)::float8 / 1e18) as "deployerFundingEth",
      (w.tx_count_at_first_funding = 0) as "deployerFresh",
      fw.is_contract as "funderIsContract", cr.from_addr as "funderCreator"
    from launches l
    join token_metrics m on m.token = l.token
    left join wallets w on w.address = l.deployer
    left join lateral (
      select e.from_addr, e.value from eth_transfers e
      where e.to_addr = l.deployer and e.value > 0 order by e.block, e.id limit 1
    ) fi on true
    left join wallets fw on fw.address = coalesce(w.first_funder, fi.from_addr)
    left join lateral (
      select c.from_addr from eth_transfers c
      where c.to_addr = coalesce(w.first_funder, fi.from_addr) and c.kind = 'create' limit 1
    ) cr on true
    where l.ts >= to_timestamp(${opts.sinceTs}::float8) and l.ts < to_timestamp(${until}::float8)
      and (case ${opts.window}::int when 2 then m.peak2_pct when 5 then m.peak5_pct when 10 then m.peak10_pct
                                     when 30 then m.peak30_pct else m.peak60_pct end) >= ${opts.minPeakPct}::float8
    order by l.ts desc limit ${p.limit + 1} offset ${p.offset}`;
  return paged(
    rows.map((r) => ({ ...r, exemptions: [...(r.exemptions ?? [])] })),
    p,
  );
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export interface TradeRow {
  id: number;
  block: number;
  ts: number;
  logIndex: number;
  secondsSinceLaunch: number | null;
  side: 'buy' | 'sell';
  trader: string;
  recipient: string;
  txFrom: string | null;
  txHash: string;
  quoteEth: number;
  tokens: number;
  feeEth: number;
  creatorTaxEth: number;
  snipeTaxEth: number;
  priceAfter: number | null;
  exempt: boolean;
}

const tradeCols = (sql: Db) => sql`
  t.id::float8 as id, t.block::float8 as block, extract(epoch from t.ts)::float8 as ts, t.log_index::int as "logIndex",
  t.seconds_since_launch::int as "secondsSinceLaunch", t.side, t.trader, t.recipient, t.tx_from as "txFrom", t.tx_hash as "txHash",
  (t.quote::float8 / 1e18) as "quoteEth", (t.tokens::float8 / 1e18) as tokens, (greatest(coalesce(t.fee, 0) - coalesce(t.snipe_tax, 0), 0)::float8 / 1e18) as "feeEth",
  (coalesce(t.tax, 0)::float8 / 1e18) as "creatorTaxEth", (coalesce(t.snipe_tax, 0)::float8 / 1e18) as "snipeTaxEth",
  t.price_after::float8 as "priceAfter", coalesce(t.exempt, false) as exempt`;

/** Trades of one curve inside [fromSec, toSec] seconds since launch. */
export async function getTrades(
  sql: Db,
  token: string,
  opts: Page & { fromSec?: number | undefined; toSec?: number | undefined; side?: 'buy' | 'sell' | undefined } = {},
): Promise<Paged<TradeRow>> {
  const p = pageOf(opts, 100);
  const from = opts.fromSec ?? -1;
  const to = opts.toSec ?? 1_000_000_000;
  const side = opts.side ?? null;
  const rows = await sql<TradeRow[]>`
    select ${tradeCols(sql)} from curve_trades t
    where t.token = ${token} and coalesce(t.seconds_since_launch, 0) between ${from}::int and ${to}::int
      and (${side}::text is null or t.side = ${side}::text)
    order by t.block, t.log_index limit ${p.limit + 1} offset ${p.offset}`;
  return paged(rows, p);
}

export interface WalletTokenPnl {
  token: string;
  name: string | null;
  symbol: string | null;
  buys: number;
  sells: number;
  ethIn: number;
  ethOut: number;
  tokensBought: number;
  tokensSold: number;
  pnlEth: number;
  firstTs: number;
  lastTs: number;
  firstBuySecondsSinceLaunch: number | null;
  snipeTaxEth: number;
}

/** A wallet's curve activity per token (matched as recipient for buys and as trader/recipient/tx.from for sells). ETH in is the gross quote sent, snipe tax included. */
export async function walletTrades(sql: Db, wallet: string, page: Page = {}): Promise<Paged<WalletTokenPnl> & { totals: { pnlEth: number; tokens: number } }> {
  const p = pageOf(page);
  const rows = await sql<WalletTokenPnl[]>`
    select t.token, l.name, l.symbol,
      count(*) filter (where t.side = 'buy')::int as buys, count(*) filter (where t.side = 'sell')::int as sells,
      coalesce(sum(t.quote::float8) filter (where t.side = 'buy'), 0) / 1e18 as "ethIn",
      coalesce(sum(t.quote::float8) filter (where t.side = 'sell'), 0) / 1e18 as "ethOut",
      coalesce(sum(t.tokens::float8) filter (where t.side = 'buy'), 0) / 1e18 as "tokensBought",
      coalesce(sum(t.tokens::float8) filter (where t.side = 'sell'), 0) / 1e18 as "tokensSold",
      (coalesce(sum(t.quote::float8) filter (where t.side = 'sell'), 0)
        - coalesce(sum(t.quote::float8) filter (where t.side = 'buy'), 0)) / 1e18 as "pnlEth",
      min(extract(epoch from t.ts))::float8 as "firstTs", max(extract(epoch from t.ts))::float8 as "lastTs",
      min(t.seconds_since_launch) filter (where t.side = 'buy')::int as "firstBuySecondsSinceLaunch",
      coalesce(sum(coalesce(t.snipe_tax, 0)::float8), 0) / 1e18 as "snipeTaxEth"
    from curve_trades t left join launches l on l.token = t.token
    where (t.side = 'buy' and t.recipient = ${wallet})
       or (t.side = 'sell' and (t.trader = ${wallet} or t.recipient = ${wallet} or t.tx_from = ${wallet}))
    group by t.token, l.name, l.symbol
    order by min(t.ts) desc limit ${p.limit + 1} offset ${p.offset}`;
  const out = paged(rows, p);
  return { ...out, totals: { pnlEth: out.rows.reduce((s, r) => s + r.pnlEth, 0), tokens: out.rows.length } };
}

// ---------------------------------------------------------------------------
// Wallets and ETH transfers
// ---------------------------------------------------------------------------

export interface WalletSummary {
  address: string;
  known: boolean;
  firstSeenBlock: number | null;
  firstSeenTs: number | null;
  firstFunder: string | null;
  firstFundingEth: number | null;
  firstFundingTx: string | null;
  isContract: boolean | null;
  txCountAtFirstFunding: number | null;
  labels: Record<string, unknown>;
  nIncoming: number;
  nOutgoing: number;
  ethIn: number;
  ethOut: number;
  tokensDeployed: number;
  curveTrades: number;
  createdBy: string | null;
  lastActivityTs: number | null;
}

export async function walletSummary(sql: Db, address: string): Promise<WalletSummary> {
  const rows = await sql<Array<Omit<WalletSummary, 'labels'> & { labels: unknown }>>`
    select ${address}::text as address, (w.address is not null) as known,
      w.first_seen_block::float8 as "firstSeenBlock", extract(epoch from w.first_seen_ts)::float8 as "firstSeenTs",
      w.first_funder as "firstFunder", (w.first_funding_value::float8 / 1e18) as "firstFundingEth",
      w.first_funding_tx as "firstFundingTx", w.is_contract as "isContract",
      w.tx_count_at_first_funding::int as "txCountAtFirstFunding", coalesce(w.labels, '{}'::jsonb) as labels,
      (select count(*) from eth_transfers e where e.to_addr = ${address})::int as "nIncoming",
      (select count(*) from eth_transfers e where e.from_addr = ${address})::int as "nOutgoing",
      coalesce((select sum(e.value::float8) from eth_transfers e where e.to_addr = ${address}), 0) / 1e18 as "ethIn",
      coalesce((select sum(e.value::float8) from eth_transfers e where e.from_addr = ${address}), 0) / 1e18 as "ethOut",
      (select count(*) from launches l where l.deployer = ${address})::int as "tokensDeployed",
      (select count(*) from curve_trades t where t.recipient = ${address} or t.trader = ${address} or t.tx_from = ${address})::int as "curveTrades",
      (select c.from_addr from eth_transfers c where c.to_addr = ${address} and c.kind = 'create' limit 1) as "createdBy",
      (select max(extract(epoch from e.ts)) from eth_transfers e where e.to_addr = ${address} or e.from_addr = ${address})::float8 as "lastActivityTs"
    from (select 1) one left join wallets w on w.address = ${address}`;
  const r = rows[0]!;
  const labels = typeof r.labels === 'string' ? (JSON.parse(r.labels) as Record<string, unknown>) : ((r.labels ?? {}) as Record<string, unknown>);
  return { ...r, labels };
}

export interface TransferRow {
  id: number;
  block: number;
  ts: number;
  txHash: string;
  traceAddr: string | null;
  from: string;
  to: string;
  valueEth: number;
  kind: 'tx' | 'internal' | 'create';
  /** the other side of the transfer */
  counterpartyIsContract: boolean | null;
  counterpartyTokensDeployed: number;
}

export async function transfers(
  sql: Db,
  address: string,
  direction: 'in' | 'out',
  opts: Page & { minEth?: number | undefined; maxEth?: number | undefined; sinceTs?: number | undefined } = {},
): Promise<Paged<TransferRow>> {
  const p = pageOf(opts);
  const minWei = (opts.minEth ?? 0) * 1e18;
  const maxWei = opts.maxEth !== undefined ? opts.maxEth * 1e18 : 1e40;
  const since = opts.sinceTs ?? 0;
  const incoming = direction === 'in';
  const rows = await sql<TransferRow[]>`
    select e.id::float8 as id, e.block::float8 as block, extract(epoch from e.ts)::float8 as ts, e.tx_hash as "txHash",
      e.trace_addr as "traceAddr", e.from_addr as "from", e.to_addr as "to", (e.value::float8 / 1e18) as "valueEth", e.kind,
      cw.is_contract as "counterpartyIsContract",
      (select count(*) from launches l where l.deployer = cw_addr.addr)::int as "counterpartyTokensDeployed"
    from eth_transfers e
    cross join lateral (select case when ${incoming}::boolean then e.from_addr else e.to_addr end as addr) cw_addr
    left join wallets cw on cw.address = cw_addr.addr
    where (case when ${incoming}::boolean then e.to_addr else e.from_addr end) = ${address}
      and e.value::float8 >= ${minWei}::float8 and e.value::float8 <= ${maxWei}::float8
      and e.ts >= to_timestamp(${since}::float8)
    order by e.block, e.id limit ${p.limit + 1} offset ${p.offset}`;
  return paged(rows, p);
}

export interface FundingHop {
  depth: number;
  address: string;
  funder: string | null;
  valueEth: number | null;
  txHash: string | null;
  ts: number | null;
  kind: string | null;
  isContract: boolean | null;
  /** creator of `address` when it is a contract made by a CREATE (disperse contracts) */
  createdBy: string | null;
  fresh: boolean | null;
}

/**
 * Funding path to depth N: for each hop take the FIRST incoming value transfer
 * (by block, id) and step to its sender. Stops on a cycle or a wallet with no funding.
 */
export async function fundingPath(sql: Db, wallet: string, depth: number): Promise<FundingHop[]> {
  const maxDepth = Math.max(1, Math.min(10, Math.floor(depth)));
  return sql<FundingHop[]>`
    with recursive path(depth, address, funder, value, tx_hash, ts, kind, visited) as (
      select 0, ${wallet}::text, f.from_addr, f.value, f.tx_hash, f.ts, f.kind, array[${wallet}::text]
      from (select 1) one
      left join lateral (
        select e.from_addr, e.value, e.tx_hash, e.ts, e.kind from eth_transfers e
        where e.to_addr = ${wallet} and e.value > 0 order by e.block, e.id limit 1
      ) f on true
      union all
      select p.depth + 1, p.funder, f.from_addr, f.value, f.tx_hash, f.ts, f.kind, p.visited || p.funder
      from path p
      left join lateral (
        select e.from_addr, e.value, e.tx_hash, e.ts, e.kind from eth_transfers e
        where e.to_addr = p.funder and e.value > 0 order by e.block, e.id limit 1
      ) f on true
      where p.funder is not null and p.depth + 1 < ${maxDepth}::int and not (p.funder = any(p.visited))
    )
    select p.depth::int as depth, p.address, p.funder, (p.value::float8 / 1e18) as "valueEth", p.tx_hash as "txHash",
      extract(epoch from p.ts)::float8 as ts, p.kind, w.is_contract as "isContract",
      (select c.from_addr from eth_transfers c where c.to_addr = p.address and c.kind = 'create' limit 1) as "createdBy",
      (w.tx_count_at_first_funding = 0) as fresh
    from path p left join wallets w on w.address = p.address
    order by p.depth`;
}

export interface SiblingRow {
  wallet: string;
  /** funder itself, or a contract the funder created (contract mode) */
  via: string;
  viaContract: boolean;
  valueEth: number;
  ts: number;
  txHash: string;
  kind: string;
  fresh: boolean | null;
  isContract: boolean | null;
  tokensDeployed: number;
  tokenNames: string[];
}

/**
 * Wallets funded by `funder` directly or through contracts it created (disperse /
 * "contract mode"), with what each child deployed. One row per transfer.
 */
export async function siblingsFundedBy(
  sql: Db,
  funder: string,
  opts: Page & { sinceTs?: number | undefined; minEth?: number | undefined; maxEth?: number | undefined } = {},
): Promise<Paged<SiblingRow>> {
  const p = pageOf(opts);
  const since = opts.sinceTs ?? 0;
  const minWei = (opts.minEth ?? 0) * 1e18;
  const maxWei = opts.maxEth !== undefined ? opts.maxEth * 1e18 : 1e40;
  const rows = await sql<SiblingRow[]>`
    with sources as (
      select ${funder}::text as addr, false as via_contract
      union
      select c.to_addr, true from eth_transfers c where c.from_addr = ${funder} and c.kind = 'create'
    )
    select e.to_addr as wallet, s.addr as via, s.via_contract as "viaContract", (e.value::float8 / 1e18) as "valueEth",
      extract(epoch from e.ts)::float8 as ts, e.tx_hash as "txHash", e.kind,
      (w.tx_count_at_first_funding = 0) as fresh, w.is_contract as "isContract",
      (select count(*) from launches l where l.deployer = e.to_addr)::int as "tokensDeployed",
      coalesce((select array_agg(coalesce(l.name, l.token) order by l.ts) from (
        select * from launches l2 where l2.deployer = e.to_addr order by l2.ts limit 10) l), '{}'::text[]) as "tokenNames"
    from eth_transfers e
    join sources s on e.from_addr = s.addr
    left join wallets w on w.address = e.to_addr
    where e.kind <> 'create' and e.value > 0 and e.ts >= to_timestamp(${since}::float8)
      and e.value::float8 >= ${minWei}::float8 and e.value::float8 <= ${maxWei}::float8
    order by e.block, e.id limit ${p.limit + 1} offset ${p.offset}`;
  return paged(
    rows.map((r) => ({ ...r, tokenNames: [...(r.tokenNames ?? [])] })),
    p,
  );
}

// ---------------------------------------------------------------------------
// Token transfers and the team's exit flow
// ---------------------------------------------------------------------------

export interface TokenTransferRow {
  block: number;
  ts: number;
  secondsSinceLaunch: number | null;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  tokens: number;
}

export async function tokenTransfers(
  sql: Db,
  token: string,
  opts: Page & { from?: string | undefined; to?: string | undefined } = {},
): Promise<Paged<TokenTransferRow>> {
  const p = pageOf(opts, 100);
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const rows = await sql<TokenTransferRow[]>`
    select x.block::float8 as block, extract(epoch from x.ts)::float8 as ts,
      (extract(epoch from x.ts) - extract(epoch from l.ts))::float8 as "secondsSinceLaunch",
      x.tx_hash as "txHash", x.log_index::int as "logIndex", x.from_addr as "from", x.to_addr as "to",
      (x.value::float8 / 1e18) as tokens
    from token_transfers x left join launches l on l.token = x.token
    where x.token = ${token} and (${from}::text is null or x.from_addr = ${from}::text) and (${to}::text is null or x.to_addr = ${to}::text)
    order by x.block, x.log_index limit ${p.limit + 1} offset ${p.offset}`;
  return paged(rows, p);
}

export interface ExemptFlow {
  token: string;
  launchTs: number;
  deployer: string;
  curve: string;
  exemptWallets: Array<{
    wallet: string;
    role: string;
    buys: number;
    ethIn: number;
    tokensBought: number;
    firstBuySec: number | null;
    curveSells: number;
    ethOutCurve: number;
    tokensTransferredOut: number;
    firstTransferOutSec: number | null;
  }>;
  dumpWallets: Array<{
    wallet: string;
    fromExempt: string[];
    batches: number;
    tokensReceived: number;
    firstReceiveSec: number;
    lastReceiveSec: number;
    sells: number;
    tokensSold: number;
    ethFromSells: number;
    firstSellSec: number | null;
    isContract: boolean | null;
    fresh: boolean | null;
    funder: string | null;
  }>;
  ethDestinations: Array<{
    from: string;
    to: string;
    valueEth: number;
    transfers: number;
    firstSec: number;
    isContract: boolean | null;
    toTokensDeployed: number;
  }>;
}

/**
 * The "team" exit: exempt wallets (exemptions ∪ deployer ∪ creator_fee_recipient) usually
 * do not sell on the curve; they move tokens (ERC-20 Transfer batches) to a fresh dump
 * wallet which sells. Returns exempt buys -> transfers out -> dump wallets' sells -> where
 * the ETH went next (the operator's treasury fingerprint).
 */
export async function exemptFlow(sql: Db, token: string): Promise<ExemptFlow | null> {
  const launch = await sql<Array<{ deployer: string; curve: string; ts: number; team: string[]; roles: string[] }>>`
    select l.deployer, l.curve, extract(epoch from l.ts)::float8 as ts,
      array(select distinct a from unnest(array[l.deployer, l.creator_fee_recipient] || coalesce(l.exemptions, '{}'::text[])) a where a is not null) as team,
      array[l.deployer, coalesce(l.creator_fee_recipient, '')] as roles
    from launches l where l.token = ${token}`;
  const L = launch[0];
  if (!L) return null;
  const team = [...L.team];
  const cfr = L.roles[1] ?? '';

  const exemptWallets = await sql<ExemptFlow['exemptWallets']>`
    select a.wallet,
      case when a.wallet = ${L.deployer} then 'deployer' when a.wallet = ${cfr} then 'creator_fee_recipient' else 'exemption' end as role,
      count(t.*) filter (where t.side = 'buy')::int as buys,
      coalesce(sum(t.quote::float8) filter (where t.side = 'buy'), 0) / 1e18 as "ethIn",
      coalesce(sum(t.tokens::float8) filter (where t.side = 'buy'), 0) / 1e18 as "tokensBought",
      min(t.seconds_since_launch) filter (where t.side = 'buy')::float8 as "firstBuySec",
      count(t.*) filter (where t.side = 'sell')::int as "curveSells",
      coalesce(sum(t.quote::float8) filter (where t.side = 'sell'), 0) / 1e18 as "ethOutCurve",
      coalesce((select sum(x.value::float8) from token_transfers x
        where x.token = ${token} and x.from_addr = a.wallet and x.to_addr <> ${L.curve}), 0) / 1e18 as "tokensTransferredOut",
      (select min(extract(epoch from x.ts)) from token_transfers x
        where x.token = ${token} and x.from_addr = a.wallet and x.to_addr <> ${L.curve})::float8 - ${L.ts}::float8 as "firstTransferOutSec"
    from unnest(${team}::text[]) as a(wallet)
    left join curve_trades t on t.token = ${token}
      and ((t.side = 'buy' and t.recipient = a.wallet) or (t.side = 'sell' and (t.trader = a.wallet or t.tx_from = a.wallet)))
    group by a.wallet
    order by a.wallet`;

  const dumpWallets = await sql<ExemptFlow['dumpWallets']>`
    with outs as (
      select x.to_addr as wallet, x.from_addr, x.value, x.ts from token_transfers x
      where x.token = ${token} and x.from_addr = any(${team}::text[])
        and x.to_addr <> ${L.curve} and not (x.to_addr = any(${team}::text[]))
    ), d as (
      select wallet, array_agg(distinct from_addr) as from_exempt, count(*)::int as batches, sum(value::float8) / 1e18 as tokens,
        min(extract(epoch from ts))::float8 - ${L.ts}::float8 as first_sec, max(extract(epoch from ts))::float8 - ${L.ts}::float8 as last_sec
      from outs group by wallet
    )
    select d.wallet, d.from_exempt as "fromExempt", d.batches, d.tokens as "tokensReceived",
      d.first_sec as "firstReceiveSec", d.last_sec as "lastReceiveSec",
      count(t.*)::int as sells, coalesce(sum(t.tokens::float8), 0) / 1e18 as "tokensSold",
      coalesce(sum(t.quote::float8), 0) / 1e18 as "ethFromSells", min(t.seconds_since_launch)::float8 as "firstSellSec",
      w.is_contract as "isContract", (w.tx_count_at_first_funding = 0) as fresh, w.first_funder as funder
    from d
    left join curve_trades t on t.token = ${token} and t.side = 'sell' and (t.trader = d.wallet or t.tx_from = d.wallet or t.recipient = d.wallet)
    left join wallets w on w.address = d.wallet
    group by d.wallet, d.from_exempt, d.batches, d.tokens, d.first_sec, d.last_sec, w.is_contract, w.tx_count_at_first_funding, w.first_funder
    order by d.tokens desc limit 20`;

  const sources = [...new Set([...team, ...dumpWallets.map((d) => d.wallet)])];
  const ethDestinations = await sql<ExemptFlow['ethDestinations']>`
    select e.from_addr as "from", e.to_addr as "to", sum(e.value::float8) / 1e18 as "valueEth", count(*)::int as transfers,
      min(extract(epoch from e.ts))::float8 - ${L.ts}::float8 as "firstSec", w.is_contract as "isContract",
      (select count(*) from launches l where l.deployer = e.to_addr)::int as "toTokensDeployed"
    from eth_transfers e left join wallets w on w.address = e.to_addr
    where e.from_addr = any(${sources}::text[]) and e.ts >= to_timestamp(${L.ts}::float8) and e.value > 0
    group by e.from_addr, e.to_addr, w.is_contract
    order by sum(e.value::float8) desc limit 20`;

  return {
    token,
    launchTs: L.ts,
    deployer: L.deployer,
    curve: L.curve,
    exemptWallets: exemptWallets.map((r) => ({ ...r })),
    dumpWallets: dumpWallets.map((r) => ({ ...r, fromExempt: [...(r.fromExempt ?? [])] })),
    ethDestinations: ethDestinations.map((r) => ({ ...r })),
  };
}

// ---------------------------------------------------------------------------
// Operator fingerprints (launch kind, team-wallet overlap, funder overlap, names)
// ---------------------------------------------------------------------------

/**
 * Launch-second totals (docs/BACKTEST.md fingerprint), as lateral joins on `launches l`:
 *  - `tw.team`: exempt set minus the deployer (exemptions ∪ creator_fee_recipient);
 *  - `ls`: buys in second 0 (block timestamp == launch timestamp) outside the launch tx:
 *    team = recipient ∈ tw.team, dev = recipient = deployer (+ launches.dev_buy_quote).
 * Same classification as the sniper's ledger (services/sniper/src/ledger.ts).
 */
const launchSecondJoins = (sql: Db) => sql`
    cross join lateral (
      select array(select distinct a from unnest(coalesce(l.exemptions, '{}'::text[]) || array[l.creator_fee_recipient]) a
                   where a is not null and a <> l.deployer) as team
    ) tw
    left join lateral (
      select coalesce(sum(t.quote::float8) filter (where t.recipient = any(tw.team)), 0) / 1e18 as team_eth,
             count(distinct t.recipient) filter (where t.recipient = any(tw.team))::int as team_buyers,
             coalesce(sum(t.quote::float8) filter (where t.recipient = l.deployer), 0) / 1e18 as dev_eth
      from curve_trades t
      where t.token = l.token and t.side = 'buy' and t.tx_hash is distinct from l.tx_hash
        and (t.seconds_since_launch = 0 or (t.seconds_since_launch is null and t.ts = l.ts))
    ) ls on true`;

const launchSecondCols = (sql: Db) => sql`
      coalesce(ls.team_eth, 0)::float8 as "lsTeamEth", coalesce(ls.team_buyers, 0)::int as "lsTeamBuyers",
      (coalesce(l.dev_buy_quote, 0)::float8 / 1e18 + coalesce(ls.dev_eth, 0))::float8 as "lsDevEth"`;

/** Per-launch context for trigger matching and clustering: deployer + team wallets with their first funding, and the launch-second totals. */
export async function launchContexts(sql: Db, tokens: readonly string[]): Promise<LaunchContext[]> {
  if (tokens.length === 0) return [];
  const rows = await sql<
    Array<{
      token: string;
      name: string | null;
      symbol: string | null;
      deployer: string;
      txFrom: string | null;
      ts: number | null;
      launchKind: string | null;
      devBuyEth: number | null;
      teamWallets: string[];
      fundings: WalletFunding[] | string;
      lsTeamEth: number;
      lsTeamBuyers: number;
      lsDevEth: number;
    }>
  >`
    select l.token, l.name, l.symbol, l.deployer, l.tx_from as "txFrom", extract(epoch from l.ts)::float8 as ts,
      l.launch_kind as "launchKind", (l.dev_buy_quote::float8 / 1e18) as "devBuyEth", ${launchSecondCols(sql)},
      array(select distinct a from unnest(coalesce(l.exemptions, '{}'::text[]) || array[l.creator_fee_recipient]) a
            where a is not null and a <> l.deployer) as "teamWallets",
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'wallet', a.wallet, 'role', case when a.wallet = l.deployer then 'deployer' else 'team' end,
          'funder', coalesce(w.first_funder, fi.from_addr),
          'funderCreator', cr.from_addr,
          'valueEth', coalesce(w.first_funding_value, fi.value)::float8 / 1e18,
          'fresh', (w.tx_count_at_first_funding = 0)))
        from (select distinct x as wallet from unnest(array[l.deployer, l.creator_fee_recipient] || coalesce(l.exemptions, '{}'::text[])) x
              where x is not null) a
        left join wallets w on w.address = a.wallet
        left join lateral (select e.from_addr, e.value from eth_transfers e where e.to_addr = a.wallet and e.value > 0
                           order by e.block, e.id limit 1) fi on true
        left join lateral (select c.from_addr from eth_transfers c where c.to_addr = coalesce(w.first_funder, fi.from_addr)
                           and c.kind = 'create' limit 1) cr on true
      ), '[]'::jsonb) as fundings
    from launches l ${launchSecondJoins(sql)}
    where l.token = any(${[...tokens]}::text[])
    order by l.ts`;
  return rows.map((r) => ({
    token: r.token,
    name: r.name,
    symbol: r.symbol,
    deployer: r.deployer,
    txFrom: r.txFrom,
    ts: r.ts,
    launchKind: r.launchKind,
    devBuyEth: r.devBuyEth,
    teamWallets: [...(r.teamWallets ?? [])],
    fundings: typeof r.fundings === 'string' ? (JSON.parse(r.fundings) as WalletFunding[]) : r.fundings,
    launchSecond: { teamBuyEth: Number(r.lsTeamEth), teamBuyers: Number(r.lsTeamBuyers), devBuyEth: Number(r.lsDevEth) } satisfies LaunchSecondFacts,
  }));
}

const ETH_PAIR = '0x0000000000000000000000000000000000000000';

/**
 * ETH-paired launches in [sinceTs, untilTs) whose launch-second totals pass a launchSecond rule
 * and that are not blacklisted, pushed down into SQL (the candidate set of a generic
 * fingerprint play such as `team-buy-0.1`: ~270 of ~3,700 launches over 3 days).
 */
export async function launchSecondCandidates(
  sql: Db,
  t: Pick<TriggerLike, 'launchSecond' | 'deployerNotIn' | 'teamWalletsNotIn'>,
  opts: { sinceTs: number; untilTs?: number | undefined; limit?: number | undefined },
): Promise<string[]> {
  const r = t.launchSecond ?? {};
  const num = (x: number | undefined): number | null => (x === undefined ? null : x);
  const rows = await sql<Array<{ token: string }>>`
    select l.token from launches l ${launchSecondJoins(sql)}
    where l.ts >= to_timestamp(${opts.sinceTs}::float8) and l.ts < to_timestamp(${opts.untilTs ?? 4_102_444_800}::float8)
      and coalesce(l.pair_token, ${ETH_PAIR}) = ${ETH_PAIR}
      and (${num(r.minTeamBuyEth)}::float8 is null or coalesce(ls.team_eth, 0) >= ${num(r.minTeamBuyEth)}::float8 - 1e-12)
      and (${num(r.maxTeamBuyEth)}::float8 is null or coalesce(ls.team_eth, 0) <= ${num(r.maxTeamBuyEth)}::float8 + 1e-12)
      and (${num(r.minTeamBuyers)}::int is null or coalesce(ls.team_buyers, 0) >= ${num(r.minTeamBuyers)}::int)
      and (${num(r.minDevBuyEth)}::float8 is null
           or coalesce(l.dev_buy_quote, 0)::float8 / 1e18 + coalesce(ls.dev_eth, 0) >= ${num(r.minDevBuyEth)}::float8 - 1e-12)
      and (${num(r.maxDevBuyEth)}::float8 is null
           or coalesce(l.dev_buy_quote, 0)::float8 / 1e18 + coalesce(ls.dev_eth, 0) <= ${num(r.maxDevBuyEth)}::float8 + 1e-12)
      and (not ${r.requireNoDevBuy === true}::boolean or (coalesce(l.dev_buy_quote, 0) = 0 and coalesce(ls.dev_eth, 0) = 0))
      and not (l.deployer = any(${[...(t.deployerNotIn ?? [])].map((a) => a.toLowerCase())}::text[]))
      and not (coalesce(l.tx_from, '') = any(${[...(t.deployerNotIn ?? [])].map((a) => a.toLowerCase())}::text[]))
      and not (tw.team && ${[...(t.teamWalletsNotIn ?? [])].map((a) => a.toLowerCase())}::text[])
    order by l.ts limit ${Math.min(5000, Math.max(1, opts.limit ?? 2000))}`;
  return rows.map((x) => x.token);
}

/**
 * Launches matching a PlayTrigger in [sinceTs, untilTs) (backtests, the nightly refit): an SQL
 * superset (identity conditions via `triggerCandidates`, or the launch-second filter for a
 * generic fingerprint play), refined with the exact `matchTrigger` semantics, which include the
 * launchSecond fields (team buys = curve_trades in second 0 joined with the launch's exempt set)
 * and the blacklists.
 */
export async function launchesMatchingTrigger(
  sql: Db,
  trigger: TriggerLike,
  opts: { sinceTs: number; untilTs?: number | undefined; limit?: number | undefined },
): Promise<{ tokens: string[]; candidates: number; contexts: LaunchContext[] }> {
  const until = opts.untilTs ?? 4_102_444_800;
  const cands =
    identityConditions(trigger).length > 0
      ? await triggerCandidates(
          sql,
          {
            deployers: [...(trigger.deployerIn ?? [])],
            team: [...(trigger.teamWalletsAny ?? [])],
            funders: [...(trigger.armedWallet?.funders ?? [])],
            nameRegex: trigger.nameRegex ?? null,
            symbolRegex: trigger.symbolRegex ?? null,
          },
          opts.sinceTs,
          opts.limit ?? 2000,
        )
      : trigger.launchSecond
        ? await launchSecondCandidates(sql, trigger, opts)
        : [];
  const ctxs = (await launchContexts(sql, cands)).filter((c) => c.ts === undefined || c.ts === null || c.ts < until);
  const contexts = ctxs.filter((c) => matchTrigger(c, trigger).matched);
  return { tokens: contexts.map((c) => c.token), candidates: cands.length, contexts };
}

/** Launches since `sinceTs` that could match a trigger (SQL superset; refine with matchTrigger). */
export async function triggerCandidates(
  sql: Db,
  t: { deployers: string[]; team: string[]; funders: string[]; nameRegex: string | null; symbolRegex: string | null },
  sinceTs: number,
  limit = 500,
): Promise<string[]> {
  const rows = await sql<Array<{ token: string }>>`
    select l.token from launches l
    where l.ts >= to_timestamp(${sinceTs}::float8) and (
      l.deployer = any(${t.deployers}::text[])
      or coalesce(l.exemptions, '{}'::text[]) && ${t.team}::text[]
      or l.creator_fee_recipient = any(${t.team}::text[])
      or (${t.nameRegex}::text is not null and l.name ~* ${t.nameRegex}::text)
      or (${t.symbolRegex}::text is not null and l.symbol ~* ${t.symbolRegex}::text)
      or exists (
        select 1 from unnest(array[l.deployer, l.creator_fee_recipient] || coalesce(l.exemptions, '{}'::text[])) a(wallet)
        left join wallets w on w.address = a.wallet
        left join lateral (select e.from_addr from eth_transfers e where e.to_addr = a.wallet and e.value > 0
                           order by e.block, e.id limit 1) fi on true
        left join lateral (select c.from_addr from eth_transfers c where c.to_addr = coalesce(w.first_funder, fi.from_addr)
                           and c.kind = 'create' limit 1) cr on true
        where coalesce(w.first_funder, fi.from_addr) = any(${t.funders}::text[]) or cr.from_addr = any(${t.funders}::text[])
      )
    )
    order by l.ts desc limit ${Math.min(2000, limit)}`;
  return rows.map((r) => r.token);
}

// ---------------------------------------------------------------------------
// Backtest data
// ---------------------------------------------------------------------------

/** Launch + full trade path + exempt transfer-outs for each token (pure backtester input). */
export async function loadBacktestItems(sql: Db, tokens: readonly string[], maxSec = 600): Promise<BacktestItem[]> {
  if (tokens.length === 0) return [];
  const launches = await sql<
    Array<{ token: string; ts: number; startPrice: number | null; creatorTaxBps: number | null; name: string | null; symbol: string | null; deployer: string; curve: string; team: string[] }>
  >`
    select l.token, extract(epoch from l.ts)::float8 as ts, l.start_price::float8 as "startPrice", l.creator_tax_bps::int as "creatorTaxBps",
      l.name, l.symbol, l.deployer, l.curve,
      array(select distinct a from unnest(array[l.deployer, l.creator_fee_recipient] || coalesce(l.exemptions, '{}'::text[])) a where a is not null) as team
    from launches l where l.token = any(${[...tokens]}::text[]) order by l.ts`;
  const trades = await sql<Array<BacktestTrade & { token: string }>>`
    select t.token, extract(epoch from t.ts)::float8 as ts, t.block::float8 as block, t.log_index::int as "logIndex", t.side,
      t.price_after::float8 as "priceAfter", (t.quote::float8 / 1e18) as "quoteEth", (t.tokens::float8 / 1e18) as tokens,
      coalesce(t.exempt, false) as exempt, case when t.side = 'buy' then t.recipient else coalesce(t.trader, t.tx_from) end as wallet
    from curve_trades t
    where t.token = any(${[...tokens]}::text[]) and coalesce(t.seconds_since_launch, 0) <= ${maxSec}::int and t.price_after is not null
    order by t.token, t.block, t.log_index`;
  const outs = await sql<Array<BacktestTransfer & { token: string }>>`
    select x.token, extract(epoch from x.ts)::float8 as ts, x.block::float8 as block, x.log_index::int as "logIndex",
      x.from_addr as "from", x.to_addr as "to", (x.value::float8 / 1e18) as tokens
    from token_transfers x join launches l on l.token = x.token
    where x.token = any(${[...tokens]}::text[]) and x.to_addr <> l.curve
      and x.from_addr = any(array[l.deployer, l.creator_fee_recipient] || coalesce(l.exemptions, '{}'::text[]))
      and x.ts <= l.ts + make_interval(secs => ${maxSec}::float8)
    order by x.token, x.block, x.log_index`;
  const byToken = <T extends { token: string }>(xs: readonly T[]): Map<string, Array<Omit<T, 'token'>>> => {
    const m = new Map<string, Array<Omit<T, 'token'>>>();
    for (const { token, ...rest } of xs) {
      const arr = m.get(token) ?? [];
      arr.push(rest);
      m.set(token, arr);
    }
    return m;
  };
  const tradeMap = byToken(trades);
  const outMap = byToken(outs);
  return launches.map((l) => ({
    launch: { token: l.token, ts: l.ts, startPrice: l.startPrice, creatorTaxBps: l.creatorTaxBps, name: l.name, symbol: l.symbol, deployer: l.deployer },
    trades: (tradeMap.get(l.token) ?? []) as BacktestTrade[],
    transfers: (outMap.get(l.token) ?? []) as BacktestTransfer[],
  }));
}

// ---------------------------------------------------------------------------
// CSV sources
// ---------------------------------------------------------------------------

export interface CsvSource {
  token: TokenRow;
  taxFreeBuyers: string[];
  /** deployer funding route, nearest funder first */
  funding: FundingHop[];
  dumpWallets: string[];
}

export async function csvSources(sql: Db, tokens: readonly string[], fundingDepth = 2): Promise<CsvSource[]> {
  const rows = await getTokens(sql, tokens);
  const out: CsvSource[] = [];
  for (const token of rows) {
    const buyers = await sql<Array<{ wallet: string }>>`
      select distinct t.recipient as wallet from curve_trades t
      where t.token = ${token.token} and t.side = 'buy' and coalesce(t.snipe_tax, 0) = 0 and coalesce(t.seconds_since_launch, 0) = 0
      order by 1 limit 20`;
    const dumps = await sql<Array<{ wallet: string }>>`
      select distinct x.to_addr as wallet from token_transfers x
      where x.token = ${token.token} and x.to_addr <> ${token.curve}
        and x.from_addr = any(${[token.deployer, ...(token.creatorFeeRecipient ? [token.creatorFeeRecipient] : []), ...token.exemptions]}::text[])
      order by 1 limit 10`;
    const funding = await fundingPath(sql, token.deployer, fundingDepth + 1);
    out.push({ token, taxFreeBuyers: buyers.map((b) => b.wallet), funding, dumpWallets: dumps.map((d) => d.wallet) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings, runs, plays, events
// ---------------------------------------------------------------------------

/** settings.eth_usd as a number (`3500`, `"3500"` or `{"usd": 3500}`), or null. */
export async function getEthUsdSetting(sql: Db): Promise<number | null> {
  const rows = await sql<Array<{ value: unknown }>>`select value from settings where key = 'eth_usd'`;
  let v: unknown = rows[0]?.value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      /* plain string number */
    }
  }
  if (v && typeof v === 'object' && 'usd' in v) v = (v as { usd: unknown }).usd;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type AgentRunKind = 'play' | 'scout' | 'backtest';

export async function insertAgentRun(sql: Db, kind: AgentRunKind, input: unknown): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    insert into agent_runs (kind, input, cost_usd) values (${kind}, ${JSON.stringify(input)}::jsonb, 0) returning id::float8 as id`;
  return rows[0]!.id;
}

export async function finishAgentRun(
  sql: Db,
  id: number,
  r: { input: unknown; reportMd: string | null; csvPath: string | null; proposedPlay: unknown; costUsd: number },
): Promise<void> {
  await sql`
    update agent_runs set input = ${JSON.stringify(r.input)}::jsonb, report_md = ${r.reportMd}, csv_path = ${r.csvPath},
      proposed_play = ${r.proposedPlay === null || r.proposedPlay === undefined ? null : JSON.stringify(r.proposedPlay)}::jsonb,
      cost_usd = ${r.costUsd}::float8
    where id = ${id}::bigint`;
}

export interface PlayRecord {
  id: number;
  operatorId: number | null;
  operatorName: string | null;
  operatorStatus: string | null;
  name: string;
  enabled: boolean;
  trigger: unknown;
  preset: unknown;
  stats: unknown;
}

const parseJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

export async function getPlay(sql: Db, id: number): Promise<PlayRecord | null> {
  const rows = await sql<PlayRecord[]>`
    select p.id::float8 as id, p.operator_id::float8 as "operatorId", o.name as "operatorName", o.status as "operatorStatus",
      p.name, p.enabled, p.trigger, p.preset, p.stats
    from plays p left join operators o on o.id = p.operator_id where p.id = ${id}::int`;
  const r = rows[0];
  return r ? { ...r, trigger: parseJson(r.trigger), preset: parseJson(r.preset), stats: parseJson(r.stats) } : null;
}

/** Plays of non-retired operators (enabled or candidate) - used to skip already-covered scout clusters. */
export async function activePlays(sql: Db): Promise<PlayRecord[]> {
  const rows = await sql<PlayRecord[]>`
    select p.id::float8 as id, p.operator_id::float8 as "operatorId", o.name as "operatorName", o.status as "operatorStatus",
      p.name, p.enabled, p.trigger, p.preset, p.stats
    from plays p left join operators o on o.id = p.operator_id
    where coalesce(o.status, 'candidate') <> 'retired'`;
  return rows.map((r) => ({ ...r, trigger: parseJson(r.trigger), preset: parseJson(r.preset), stats: parseJson(r.stats) }));
}

export interface ProposedPlayRecord {
  operatorId: number;
  playId: number;
  eventId: number;
}

/**
 * Writes a candidate operator + disabled play + an `events` row for Telegram approval,
 * atomically. The `plays` NOTIFY trigger (migration 0001) announces it on `plays_changed`;
 * the play stays disabled until approved.
 */
export async function insertProposedPlay(
  sql: Db,
  p: { operatorName: string; operatorNotes: string; playName: string; trigger: unknown; preset: unknown; stats: unknown; runId: number; summary: string },
): Promise<ProposedPlayRecord> {
  return sql.begin(async (tx) => {
    const op = await tx<Array<{ id: number }>>`
      insert into operators (name, notes, status, created_by) values (${p.operatorName}, ${p.operatorNotes}, 'candidate', 'agent')
      returning id::float8 as id`;
    const operatorId = op[0]!.id;
    const play = await tx<Array<{ id: number }>>`
      insert into plays (operator_id, name, enabled, trigger, preset, created_by, stats)
      values (${operatorId}::int, ${p.playName}, false, ${JSON.stringify(p.trigger)}::jsonb, ${JSON.stringify(p.preset)}::jsonb, 'agent',
              ${JSON.stringify(p.stats ?? {})}::jsonb)
      returning id::float8 as id`;
    const playId = play[0]!.id;
    const payload = { playId, operatorId, runId: p.runId, name: p.playName, operator: p.operatorName, summary: p.summary, needsApproval: true };
    const ev = await tx<Array<{ id: number }>>`
      insert into events (ts, level, source, type, payload)
      values (now(), 'info', 'agent', 'play_proposed', ${JSON.stringify(payload)}::jsonb) returning id::float8 as id`;
    return { operatorId, playId, eventId: ev[0]!.id };
  }) as Promise<ProposedPlayRecord>;
}

export async function insertEvent(sql: Db, e: { level: 'info' | 'warn' | 'error'; type: string; payload: unknown }): Promise<void> {
  await sql`insert into events (ts, level, source, type, payload) values (now(), ${e.level}, 'agent', ${e.type}, ${JSON.stringify(e.payload)}::jsonb)`;
}

export async function updatePlayStats(sql: Db, playId: number, stats: unknown): Promise<void> {
  await sql`update plays set stats = coalesce(stats, '{}'::jsonb) || ${JSON.stringify(stats)}::jsonb, updated_at = now() where id = ${playId}::int`;
}

/** Enabled plays (the nightly job's work list). */
export async function enabledPlays(sql: Db): Promise<PlayRecord[]> {
  const rows = await sql<PlayRecord[]>`
    select p.id::float8 as id, p.operator_id::float8 as "operatorId", o.name as "operatorName", o.status as "operatorStatus",
      p.name, p.enabled, p.trigger, p.preset, p.stats
    from plays p left join operators o on o.id = p.operator_id
    where p.enabled order by p.id`;
  return rows.map((r) => ({ ...r, trigger: parseJson(r.trigger), preset: parseJson(r.preset), stats: parseJson(r.stats) }));
}

export async function countEnabledPlays(sql: Db): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from plays where enabled`;
  return Number(rows[0]?.n ?? 0);
}

/** Enable a play and activate its operator (what the Telegram approve button does). */
export async function enablePlay(sql: Db, playId: number, operatorId: number | null): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`update plays set enabled = true, updated_at = now() where id = ${playId}::int`;
    if (operatorId !== null) await tx`update operators set status = 'active' where id = ${operatorId}::int`;
  });
}

export async function disablePlay(sql: Db, playId: number): Promise<void> {
  await sql`update plays set enabled = false, updated_at = now() where id = ${playId}::int`;
}

export async function updatePlayPreset(sql: Db, playId: number, preset: unknown): Promise<void> {
  await sql`update plays set preset = ${JSON.stringify(preset)}::jsonb, updated_at = now() where id = ${playId}::int`;
}

export async function updatePlayTrigger(sql: Db, playId: number, trigger: unknown): Promise<void> {
  await sql`update plays set trigger = ${JSON.stringify(trigger)}::jsonb, updated_at = now() where id = ${playId}::int`;
}

/** Realised PnL (ETH) of a play's last `limit` closed snipes, paper or live, newest first. */
export async function recentRealizedPnls(sql: Db, playId: number, limit = 30): Promise<number[]> {
  const rows = await sql<Array<{ pnl: number }>>`
    select realized_pnl_eth::float8 as pnl from snipes
    where play_id = ${playId}::int and status = 'closed' and realized_pnl_eth is not null
    order by closed_at desc nulls last, id desc limit ${Math.max(1, Math.floor(limit))}::int`;
  return rows.map((r) => Number(r.pnl));
}

/** A settings value as stored (jsonb), or null. */
export async function getSettingValue(sql: Db, key: string): Promise<unknown> {
  const rows = await sql<Array<{ value: unknown }>>`select value from settings where key = ${key}`;
  const v = rows[0]?.value;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }
  return v ?? null;
}
