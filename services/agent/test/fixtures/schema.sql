-- Test copy of docs/SPEC.md §2 (+ indexer additions: curve_trades.snipe_tax, token_transfers).
-- The real migrations live in packages/db/migrations (owned by the db task); this file only
-- exists so the agent's SQL can be exercised on PGlite without depending on that package.
create table launches (
  token text primary key, curve text not null, deployer text not null, launcher text, launch_kind text,
  creator_fee_recipient text, creator_tax_bps int, name text, symbol text, logo text, pair_token text,
  launch_config_id numeric, graduation_threshold numeric, exemptions text[] default '{}', dev_buy_quote numeric(78,0),
  block bigint, ts timestamptz, tx_hash text, tx_from text, start_price double precision, start_mcap_eth double precision,
  graduated bool default false, created_at timestamptz default now()
);
create table curve_trades (
  id bigserial primary key, token text, curve text, block bigint, ts timestamptz, tx_hash text, log_index int,
  side text check (side in ('buy','sell')), trader text, recipient text, tx_from text,
  quote numeric(78,0), tokens numeric(78,0), fee numeric(78,0), tax numeric(78,0), snipe_tax numeric(78,0) default 0,
  price_after double precision, seconds_since_launch int, exempt bool, unique (tx_hash, log_index)
);
create table token_metrics (
  token text primary key, first_taxed_buyer text, first_taxed_ts timestamptz, first_taxed_block bigint,
  first_taxed_price double precision, first_taxed_mcap_eth double precision, tax_free_buy_count int, tax_free_quote numeric(78,0),
  ath_price double precision, ath_ts timestamptz, ath_mcap_eth double precision,
  peak2_pct double precision, peak5_pct double precision, peak10_pct double precision, peak30_pct double precision, peak60_pct double precision,
  mcap2 double precision, mcap5 double precision, mcap10 double precision, mcap30 double precision, mcap60 double precision,
  low_after_entry_pct double precision, n_buys_60s int, n_sells_60s int, exempt_sold_within_sec int, updated_at timestamptz
);
create table eth_transfers (
  id bigserial primary key, block bigint, ts timestamptz, tx_hash text, trace_addr text, from_addr text, to_addr text,
  value numeric(78,0), kind text check (kind in ('tx','internal','create')), unique (tx_hash, trace_addr)
);
create table token_transfers (
  id bigserial primary key, token text, block bigint, ts timestamptz, tx_hash text, log_index int,
  from_addr text, to_addr text, value numeric(78,0), unique (tx_hash, log_index)
);
create table wallets (
  address text primary key, first_seen_block bigint, first_seen_ts timestamptz, first_funder text,
  first_funding_value numeric(78,0), first_funding_tx text, is_contract bool, tx_count_at_first_funding int,
  labels jsonb default '{}'
);
create table operators (id serial primary key, name text, notes text, status text check (status in ('candidate','active','retired')),
  created_by text, created_at timestamptz default now());
create table plays (id serial primary key, operator_id int references operators(id), name text, enabled bool, trigger jsonb, preset jsonb,
  created_by text, created_at timestamptz default now(), updated_at timestamptz default now(), stats jsonb default '{}');
create table agent_runs (id bigserial primary key, kind text check (kind in ('play','scout','backtest')), input jsonb, report_md text,
  csv_path text, proposed_play jsonb, cost_usd double precision, created_at timestamptz default now());
create table settings (key text primary key, value jsonb);
create table events (id bigserial primary key, ts timestamptz default now(), level text, source text, type text, payload jsonb);
