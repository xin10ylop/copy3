/**
 * ============================================================================
 * STUB - the DDL this service assumes (docs/SPEC.md §2 + coordinator additions).
 * The real migrations live in packages/db; this copy is only used by tests
 * (PGlite) when @hood/db does not provide its own PGlite helper yet.
 * ============================================================================
 */
export const STUB_SCHEMA_SQL = `
create table if not exists launches (
  token text primary key, curve text not null, deployer text not null, launcher text, launch_kind text,
  creator_fee_recipient text, creator_tax_bps int, name text, symbol text, logo text, pair_token text,
  launch_config_id numeric, graduation_threshold numeric, exemptions text[] not null default '{}',
  dev_buy_quote numeric(78,0), block bigint not null, ts timestamptz not null, tx_hash text, tx_from text,
  start_price double precision, start_mcap_eth double precision, graduated bool not null default false,
  created_at timestamptz not null default now());
create index if not exists launches_curve on launches(curve);
create index if not exists launches_deployer on launches(deployer);
create table if not exists curve_trades (
  id bigserial primary key, token text not null, curve text not null, block bigint not null, ts timestamptz not null,
  tx_hash text not null, log_index int not null, side text not null, trader text, recipient text, tx_from text,
  quote numeric(78,0), tokens numeric(78,0), fee numeric(78,0), tax numeric(78,0), snipe_tax numeric(78,0) default 0,
  price_after double precision, seconds_since_launch int, exempt bool, unique (tx_hash, log_index));
create index if not exists curve_trades_token on curve_trades(token, block, log_index);
create table if not exists token_transfers (
  id bigserial primary key, token text not null, block bigint not null, ts timestamptz not null, tx_hash text not null,
  log_index int not null, from_addr text not null, to_addr text not null, value numeric(78,0), unique (tx_hash, log_index));
create index if not exists token_transfers_token on token_transfers(token, block, log_index);
create table if not exists token_metrics (
  token text primary key, first_taxed_buyer text, first_taxed_ts timestamptz, first_taxed_block bigint,
  first_taxed_price double precision, first_taxed_mcap_eth double precision, tax_free_buy_count int,
  tax_free_quote numeric(78,0), ath_price double precision, ath_ts timestamptz, ath_mcap_eth double precision,
  peak2_pct double precision, peak5_pct double precision, peak10_pct double precision, peak30_pct double precision,
  peak60_pct double precision, mcap2 double precision, mcap5 double precision, mcap10 double precision,
  mcap30 double precision, mcap60 double precision, low_after_entry_pct double precision, n_buys_60s int,
  n_sells_60s int, exempt_sold_within_sec int, dump_wallets text[] default '{}', operator_sell_eth double precision,
  updated_at timestamptz);
create table if not exists eth_transfers (
  id bigserial primary key, block bigint not null, ts timestamptz not null, tx_hash text not null,
  trace_addr text not null default '', from_addr text not null, to_addr text not null, value numeric(78,0) not null,
  kind text not null, unique (tx_hash, trace_addr));
create index if not exists eth_transfers_to on eth_transfers(to_addr, block);
create index if not exists eth_transfers_from on eth_transfers(from_addr, block);
create table if not exists wallets (
  address text primary key, first_seen_block bigint, first_seen_ts timestamptz, first_funder text,
  first_funding_value numeric(78,0), first_funding_tx text, is_contract bool, tx_count_at_first_funding int,
  labels jsonb not null default '{}');
create table if not exists settings (key text primary key, value jsonb);
create table if not exists plays (
  id serial primary key, operator_id int, name text, enabled bool not null default false, trigger jsonb not null,
  preset jsonb not null, created_by text, created_at timestamptz default now(), updated_at timestamptz default now(),
  stats jsonb not null default '{}');
create table if not exists armed_candidates (
  id bigserial primary key, play_id int not null, wallet text not null, source_funder text, funded_value numeric(78,0),
  funded_tx text, armed_at timestamptz not null default now(), expires_at timestamptz, status text not null default 'armed',
  unique (play_id, wallet));
create table if not exists events (
  id bigserial primary key, ts timestamptz not null default now(), level text, source text, type text, payload jsonb);
`;
