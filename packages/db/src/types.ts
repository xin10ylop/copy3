/**
 * Row types for the HoodSniper schema (SPEC §2).
 *
 * numeric(78,0) columns come back from both drivers as decimal strings (lossless
 * for wei). We type them as `string` and provide `toWei` / `fromWei` helpers for
 * bigint conversion at the edges. jsonb columns come back as parsed objects.
 */

export type NumericString = string;

export interface LaunchRow {
  token: string;
  curve: string;
  deployer: string;
  launcher: string | null;
  launch_kind: string;
  creator_fee_recipient: string | null;
  creator_tax_bps: number;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  pair_token: string | null;
  launch_config_id: NumericString;
  graduation_threshold: NumericString | null;
  exemptions: string[];
  dev_buy_quote: NumericString;
  block: number | null;
  ts: Date | null;
  tx_hash: string | null;
  tx_from: string | null;
  start_price: number | null;
  start_mcap_eth: number | null;
  graduated: boolean;
  created_at: Date;
}

export interface CurveTradeRow {
  id: string;
  token: string;
  curve: string;
  block: number | null;
  ts: Date | null;
  tx_hash: string;
  log_index: number;
  side: 'buy' | 'sell';
  trader: string | null;
  recipient: string | null;
  tx_from: string | null;
  quote: NumericString;
  tokens: NumericString;
  fee: NumericString;
  /** creator tax */
  tax: NumericString;
  snipe_tax: NumericString;
  price_after: number | null;
  seconds_since_launch: number | null;
  exempt: boolean;
}

export interface TokenMetricsRow {
  token: string;
  first_taxed_buyer: string | null;
  first_taxed_ts: Date | null;
  first_taxed_block: number | null;
  first_taxed_price: number | null;
  first_taxed_mcap_eth: number | null;
  tax_free_buy_count: number;
  tax_free_quote: NumericString;
  ath_price: number | null;
  ath_ts: Date | null;
  ath_mcap_eth: number | null;
  peak2_pct: number | null;
  peak5_pct: number | null;
  peak10_pct: number | null;
  peak30_pct: number | null;
  peak60_pct: number | null;
  mcap2: number | null;
  mcap5: number | null;
  mcap10: number | null;
  mcap30: number | null;
  mcap60: number | null;
  low_after_entry_pct: number | null;
  n_buys_60s: number;
  n_sells_60s: number;
  exempt_sold_within_sec: number | null;
  dump_wallets: string[];
  operator_sell_eth: number;
  updated_at: Date;
}

export interface EthTransferRow {
  id: string;
  block: number | null;
  ts: Date | null;
  tx_hash: string;
  trace_addr: string;
  from_addr: string | null;
  to_addr: string | null;
  value: NumericString;
  kind: 'tx' | 'internal' | 'create';
}

export interface TokenTransferRow {
  id: string;
  token: string;
  block: number | null;
  ts: Date | null;
  tx_hash: string;
  log_index: number;
  from_addr: string | null;
  to_addr: string | null;
  value: NumericString;
}

export interface WalletRow {
  address: string;
  first_seen_block: number | null;
  first_seen_ts: Date | null;
  first_funder: string | null;
  first_funding_value: NumericString | null;
  first_funding_tx: string | null;
  is_contract: boolean;
  tx_count_at_first_funding: number | null;
  labels: Record<string, unknown>;
}

export interface OperatorRow {
  id: number;
  name: string | null;
  notes: string | null;
  status: 'candidate' | 'active' | 'retired';
  created_by: string | null;
  created_at: Date;
}

export interface PlayRow {
  id: number;
  operator_id: number | null;
  name: string | null;
  enabled: boolean;
  trigger: Record<string, unknown>;
  preset: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  stats: Record<string, unknown>;
}

export interface ArmedCandidateRow {
  id: string;
  play_id: number;
  wallet: string;
  source_funder: string | null;
  funded_value: NumericString | null;
  funded_tx: string | null;
  armed_at: Date;
  expires_at: Date | null;
  status: 'armed' | 'fired' | 'expired' | 'disarmed';
}

export interface SnipeRow {
  id: string;
  play_id: number | null;
  token: string;
  curve: string;
  decided_at: Date;
  decision: Record<string, unknown>;
  mode: 'live' | 'paper';
  burst: unknown[];
  buy_block: number | null;
  buy_ts: Date | null;
  quote_in: NumericString | null;
  tokens_out: NumericString | null;
  tax_paid: NumericString | null;
  entry_price: number | null;
  status: 'pending' | 'open' | 'closed' | 'failed' | 'aborted';
  sells: unknown[];
  realized_pnl_eth: number | null;
  closed_at: Date | null;
  notes: string | null;
}

export interface FeedBlockRow {
  block: number;
  ts: Date | null;
  arrival_ms: string | null;
  n_txs: number;
}

export interface AgentRunRow {
  id: string;
  kind: 'play' | 'scout' | 'backtest';
  input: Record<string, unknown>;
  report_md: string | null;
  csv_path: string | null;
  proposed_play: Record<string, unknown> | null;
  cost_usd: number | null;
  created_at: Date;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

export interface EventRow {
  id: string;
  ts: Date;
  level: string;
  source: string | null;
  type: string | null;
  payload: Record<string, unknown>;
}

/** numeric(78,0) string → bigint. */
export function toWei(v: NumericString | null | undefined): bigint {
  return v == null ? 0n : BigInt(v);
}

/** bigint → numeric(78,0) string (for params). */
export function fromWei(v: bigint | number | string | null | undefined): string | null {
  if (v == null) return null;
  return typeof v === 'bigint' ? v.toString() : String(v);
}
