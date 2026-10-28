-- HoodSniper schema (SPEC §2). Postgres 16 / PGlite compatible.
-- Conventions: addresses text lower-case; wei amounts numeric(78,0);
-- prices double precision (ETH units); timestamps timestamptz.

-- ---------------------------------------------------------------------------
-- launches: one row per Pons V2 launch
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS launches (
  token                 text PRIMARY KEY,
  curve                 text NOT NULL,
  deployer              text NOT NULL,
  launcher              text,                              -- tx.to (factory or router)
  launch_kind           text NOT NULL,                     -- launchToken | launchAndBuy | launchTokenFor
  creator_fee_recipient text,
  creator_tax_bps       int NOT NULL DEFAULT 0,
  name                  text,
  symbol                text,
  logo                  text,
  pair_token            text,
  launch_config_id      numeric(78,0) NOT NULL DEFAULT 0,
  graduation_threshold  numeric(78,0),
  exemptions            text[] NOT NULL DEFAULT '{}',
  dev_buy_quote         numeric(78,0) NOT NULL DEFAULT 0,
  block                 bigint,
  ts                    timestamptz,
  tx_hash               text,
  tx_from               text,
  start_price           double precision,
  start_mcap_eth        double precision,
  graduated             boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS launches_deployer_idx ON launches (deployer);
CREATE INDEX IF NOT EXISTS launches_curve_idx ON launches (curve);
CREATE INDEX IF NOT EXISTS launches_ts_idx ON launches (ts);

-- ---------------------------------------------------------------------------
-- curve_trades: CurveBuy / CurveSell events
--   tax       = CREATOR tax (CurveBuy.tax / CurveSell.tax)
--   snipe_tax = SnipeTaxCharged amount joined in from the same tx (0 if exempt)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS curve_trades (
  id                  bigserial PRIMARY KEY,
  token               text NOT NULL,
  curve               text NOT NULL,
  block               bigint,
  ts                  timestamptz,
  tx_hash             text NOT NULL,
  log_index           int NOT NULL,
  side                text NOT NULL,                       -- buy | sell
  trader              text,                                -- CurveBuy.buyer / CurveSell.seller (may be router)
  recipient           text,
  tx_from             text,
  quote               numeric(78,0) NOT NULL DEFAULT 0,
  tokens              numeric(78,0) NOT NULL DEFAULT 0,
  fee                 numeric(78,0) NOT NULL DEFAULT 0,
  tax                 numeric(78,0) NOT NULL DEFAULT 0,     -- creator tax
  snipe_tax           numeric(78,0) NOT NULL DEFAULT 0,     -- SnipeTaxCharged
  price_after         double precision,
  seconds_since_launch int,
  exempt              boolean NOT NULL DEFAULT false,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS curve_trades_token_ts_idx ON curve_trades (token, ts);
CREATE INDEX IF NOT EXISTS curve_trades_recipient_idx ON curve_trades (recipient);

-- ---------------------------------------------------------------------------
-- token_metrics: per-token peaks relative to the first taxed buyer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_metrics (
  token                 text PRIMARY KEY,
  first_taxed_buyer     text,
  first_taxed_ts        timestamptz,
  first_taxed_block     bigint,
  first_taxed_price     double precision,
  first_taxed_mcap_eth  double precision,
  tax_free_buy_count    int NOT NULL DEFAULT 0,
  tax_free_quote        numeric(78,0) NOT NULL DEFAULT 0,
  ath_price             double precision,
  ath_ts                timestamptz,
  ath_mcap_eth          double precision,
  peak2_pct             double precision,
  peak5_pct             double precision,
  peak10_pct            double precision,
  peak30_pct            double precision,
  peak60_pct            double precision,
  mcap2                 double precision,
  mcap5                 double precision,
  mcap10                double precision,
  mcap30                double precision,
  mcap60                double precision,
  low_after_entry_pct   double precision,                  -- max drawdown within 60 s
  n_buys_60s            int NOT NULL DEFAULT 0,
  n_sells_60s           int NOT NULL DEFAULT 0,
  exempt_sold_within_sec int,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- eth_transfers: plain txs + traced internal transfers + contract creations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eth_transfers (
  id         bigserial PRIMARY KEY,
  block      bigint,
  ts         timestamptz,
  tx_hash    text NOT NULL,
  trace_addr text NOT NULL DEFAULT '',                     -- '' for top-level tx
  from_addr  text,
  to_addr    text,
  value      numeric(78,0) NOT NULL DEFAULT 0,
  kind       text NOT NULL,                                -- tx | internal | create
  UNIQUE (tx_hash, trace_addr)
);
CREATE INDEX IF NOT EXISTS eth_transfers_to_idx ON eth_transfers (to_addr);
CREATE INDEX IF NOT EXISTS eth_transfers_from_idx ON eth_transfers (from_addr);

-- ---------------------------------------------------------------------------
-- token_transfers: ERC-20 Transfer logs (dump detection — exempt wallets move
-- tokens to a fresh dump wallet which then sells; no CurveSell from the exempt)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_transfers (
  id        bigserial PRIMARY KEY,
  token     text NOT NULL,
  block     bigint,
  ts        timestamptz,
  tx_hash   text NOT NULL,
  log_index int NOT NULL,
  from_addr text,
  to_addr   text,
  value     numeric(78,0) NOT NULL DEFAULT 0,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS token_transfers_token_idx ON token_transfers (token);
CREATE INDEX IF NOT EXISTS token_transfers_from_idx ON token_transfers (from_addr);
CREATE INDEX IF NOT EXISTS token_transfers_to_idx ON token_transfers (to_addr);

-- ---------------------------------------------------------------------------
-- wallets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  address                   text PRIMARY KEY,
  first_seen_block          bigint,
  first_seen_ts             timestamptz,
  first_funder              text,
  first_funding_value       numeric(78,0),
  first_funding_tx          text,
  is_contract               boolean NOT NULL DEFAULT false,
  tx_count_at_first_funding int,
  labels                    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS wallets_first_funder_idx ON wallets (first_funder);

-- ---------------------------------------------------------------------------
-- operators / plays
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operators (
  id         serial PRIMARY KEY,
  name       text,
  notes      text,
  status     text NOT NULL DEFAULT 'candidate',            -- candidate | active | retired
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plays (
  id          serial PRIMARY KEY,
  operator_id int REFERENCES operators (id),
  name        text,
  enabled     boolean NOT NULL DEFAULT false,
  trigger     jsonb NOT NULL DEFAULT '{}',
  preset      jsonb NOT NULL DEFAULT '{}',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  stats       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS plays_enabled_idx ON plays (enabled);

-- ---------------------------------------------------------------------------
-- armed_candidates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS armed_candidates (
  id            bigserial PRIMARY KEY,
  play_id       int NOT NULL REFERENCES plays (id),
  wallet        text NOT NULL,
  source_funder text,
  funded_value  numeric(78,0),
  funded_tx     text,
  armed_at      timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  status        text NOT NULL DEFAULT 'armed',             -- armed | fired | expired | disarmed
  UNIQUE (play_id, wallet)
);
CREATE INDEX IF NOT EXISTS armed_candidates_wallet_idx ON armed_candidates (wallet);
CREATE INDEX IF NOT EXISTS armed_candidates_status_idx ON armed_candidates (status);

-- ---------------------------------------------------------------------------
-- snipes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snipes (
  id              bigserial PRIMARY KEY,
  play_id         int REFERENCES plays (id),
  token           text NOT NULL,
  curve           text NOT NULL,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  decision        jsonb NOT NULL DEFAULT '{}',
  mode            text NOT NULL DEFAULT 'paper',           -- live | paper
  burst           jsonb NOT NULL DEFAULT '[]',             -- [{nonce,hash,sentAt,endpoint,status,block,ts}]
  buy_block       bigint,
  buy_ts          timestamptz,
  quote_in        numeric(78,0),
  tokens_out      numeric(78,0),
  tax_paid        numeric(78,0),
  entry_price     double precision,
  status          text NOT NULL DEFAULT 'pending',         -- pending|open|closed|failed|aborted
  sells           jsonb NOT NULL DEFAULT '[]',
  realized_pnl_eth double precision,
  closed_at       timestamptz,
  notes           text
);
CREATE INDEX IF NOT EXISTS snipes_token_idx ON snipes (token);
CREATE INDEX IF NOT EXISTS snipes_status_idx ON snipes (status);

-- ---------------------------------------------------------------------------
-- feed_blocks: clock calibration + latency stats
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_blocks (
  block      bigint PRIMARY KEY,
  ts         timestamptz,
  arrival_ms bigint,
  n_txs      int NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- agent_runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,                             -- play | scout | backtest
  input         jsonb NOT NULL DEFAULT '{}',
  report_md     text,
  csv_path      text,
  proposed_play jsonb,
  cost_usd      double precision,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- settings: kill switch, daily loss, eth_usd, …
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- events: everything notable; telegram tails this
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  level   text NOT NULL DEFAULT 'info',
  source  text,
  type    text,
  payload jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);

-- ---------------------------------------------------------------------------
-- NOTIFY triggers: push small JSON payloads to in-memory listeners (SPEC §2).
-- Channels: plays_changed, armed_changed, snipe_events, settings_changed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hood_notify_plays() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('plays_changed', json_build_object(
    'op', TG_OP, 'id', NEW.id, 'enabled', NEW.enabled, 'operator_id', NEW.operator_id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hood_notify_armed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('armed_changed', json_build_object(
    'op', TG_OP, 'id', NEW.id, 'play_id', NEW.play_id, 'wallet', NEW.wallet, 'status', NEW.status
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hood_notify_snipes() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('snipe_events', json_build_object(
    'op', TG_OP, 'id', NEW.id, 'play_id', NEW.play_id, 'token', NEW.token, 'status', NEW.status
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hood_notify_settings() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('settings_changed', json_build_object(
    'op', TG_OP, 'key', NEW.key
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plays_notify ON plays;
CREATE TRIGGER plays_notify AFTER INSERT OR UPDATE ON plays
  FOR EACH ROW EXECUTE FUNCTION hood_notify_plays();

DROP TRIGGER IF EXISTS armed_notify ON armed_candidates;
CREATE TRIGGER armed_notify AFTER INSERT OR UPDATE ON armed_candidates
  FOR EACH ROW EXECUTE FUNCTION hood_notify_armed();

DROP TRIGGER IF EXISTS snipes_notify ON snipes;
CREATE TRIGGER snipes_notify AFTER INSERT OR UPDATE ON snipes
  FOR EACH ROW EXECUTE FUNCTION hood_notify_snipes();

DROP TRIGGER IF EXISTS settings_notify ON settings;
CREATE TRIGGER settings_notify AFTER INSERT OR UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION hood_notify_settings();
