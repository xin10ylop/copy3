/**
 * Typed query helpers (SPEC §2). All are written against the minimal `Sql`
 * interface so they work on postgres.js and PGlite. jsonb values are bound as
 * JSON text with an explicit `::jsonb` cast; arrays as `::text[]`; wei as
 * numeric strings — portable across both drivers.
 */
import type { Sql } from './sql.js';
import type {
  LaunchRow,
  CurveTradeRow,
  TokenMetricsRow,
  EthTransferRow,
  TokenTransferRow,
  WalletRow,
  PlayRow,
  ArmedCandidateRow,
  SnipeRow,
  AgentRunRow,
  EventRow,
} from './types.js';
import { fromWei } from './types.js';

const J = (v: unknown): string => JSON.stringify(v ?? null);

// ---------------------------------------------------------------------------
// launches
// ---------------------------------------------------------------------------

export interface LaunchInput {
  token: string;
  curve: string;
  deployer: string;
  launcher?: string | null;
  launchKind: string;
  creatorFeeRecipient?: string | null;
  creatorTaxBps?: number;
  name?: string | null;
  symbol?: string | null;
  logo?: string | null;
  pairToken?: string | null;
  launchConfigId?: bigint | number | string;
  graduationThreshold?: bigint | number | string | null;
  exemptions?: string[];
  devBuyQuote?: bigint | number | string;
  block?: number | null;
  ts?: Date | null;
  txHash?: string | null;
  txFrom?: string | null;
  startPrice?: number | null;
  startMcapEth?: number | null;
}

/** Insert or update a launch (keyed by token). */
export async function upsertLaunch(sql: Sql, l: LaunchInput): Promise<LaunchRow> {
  const rows = await sql.query<LaunchRow>(
    `INSERT INTO launches
       (token, curve, deployer, launcher, launch_kind, creator_fee_recipient, creator_tax_bps,
        name, symbol, logo, pair_token, launch_config_id, graduation_threshold, exemptions,
        dev_buy_quote, block, ts, tx_hash, tx_from, start_price, start_mcap_eth)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (token) DO UPDATE SET
       curve = EXCLUDED.curve, deployer = EXCLUDED.deployer, launcher = EXCLUDED.launcher,
       launch_kind = EXCLUDED.launch_kind, creator_fee_recipient = EXCLUDED.creator_fee_recipient,
       creator_tax_bps = EXCLUDED.creator_tax_bps, name = EXCLUDED.name, symbol = EXCLUDED.symbol,
       logo = EXCLUDED.logo, pair_token = EXCLUDED.pair_token, launch_config_id = EXCLUDED.launch_config_id,
       graduation_threshold = EXCLUDED.graduation_threshold, exemptions = EXCLUDED.exemptions,
       dev_buy_quote = EXCLUDED.dev_buy_quote, block = EXCLUDED.block, ts = EXCLUDED.ts,
       tx_hash = EXCLUDED.tx_hash, tx_from = EXCLUDED.tx_from, start_price = EXCLUDED.start_price,
       start_mcap_eth = EXCLUDED.start_mcap_eth
     RETURNING *`,
    [
      l.token.toLowerCase(),
      l.curve.toLowerCase(),
      l.deployer.toLowerCase(),
      l.launcher?.toLowerCase() ?? null,
      l.launchKind,
      l.creatorFeeRecipient?.toLowerCase() ?? null,
      l.creatorTaxBps ?? 0,
      l.name ?? null,
      l.symbol ?? null,
      l.logo ?? null,
      l.pairToken?.toLowerCase() ?? null,
      fromWei(l.launchConfigId ?? 0n),
      fromWei(l.graduationThreshold ?? null),
      (l.exemptions ?? []).map((a) => a.toLowerCase()),
      fromWei(l.devBuyQuote ?? 0n),
      l.block ?? null,
      l.ts ?? null,
      l.txHash?.toLowerCase() ?? null,
      l.txFrom?.toLowerCase() ?? null,
      l.startPrice ?? null,
      l.startMcapEth ?? null,
    ],
  );
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// curve_trades
// ---------------------------------------------------------------------------

export interface TradeInput {
  token: string;
  curve: string;
  block?: number | null;
  ts?: Date | null;
  txHash: string;
  logIndex: number;
  side: 'buy' | 'sell';
  trader?: string | null;
  recipient?: string | null;
  txFrom?: string | null;
  quote?: bigint | number | string;
  tokens?: bigint | number | string;
  fee?: bigint | number | string;
  /** creator tax */
  tax?: bigint | number | string;
  snipeTax?: bigint | number | string;
  priceAfter?: number | null;
  secondsSinceLaunch?: number | null;
  exempt?: boolean;
}

/** Insert a curve trade; duplicates (tx_hash, log_index) are ignored. Returns the row or null if duplicate. */
export async function insertTrade(sql: Sql, t: TradeInput): Promise<CurveTradeRow | null> {
  const rows = await sql.query<CurveTradeRow>(
    `INSERT INTO curve_trades
       (token, curve, block, ts, tx_hash, log_index, side, trader, recipient, tx_from,
        quote, tokens, fee, tax, snipe_tax, price_after, seconds_since_launch, exempt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING *`,
    [
      t.token.toLowerCase(),
      t.curve.toLowerCase(),
      t.block ?? null,
      t.ts ?? null,
      t.txHash.toLowerCase(),
      t.logIndex,
      t.side,
      t.trader?.toLowerCase() ?? null,
      t.recipient?.toLowerCase() ?? null,
      t.txFrom?.toLowerCase() ?? null,
      fromWei(t.quote ?? 0n),
      fromWei(t.tokens ?? 0n),
      fromWei(t.fee ?? 0n),
      fromWei(t.tax ?? 0n),
      fromWei(t.snipeTax ?? 0n),
      t.priceAfter ?? null,
      t.secondsSinceLaunch ?? null,
      t.exempt ?? false,
    ],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// token_metrics
// ---------------------------------------------------------------------------

const METRIC_COLUMNS = new Set([
  'first_taxed_buyer', 'first_taxed_ts', 'first_taxed_block', 'first_taxed_price', 'first_taxed_mcap_eth',
  'tax_free_buy_count', 'tax_free_quote', 'ath_price', 'ath_ts', 'ath_mcap_eth',
  'peak2_pct', 'peak5_pct', 'peak10_pct', 'peak30_pct', 'peak60_pct',
  'mcap2', 'mcap5', 'mcap10', 'mcap30', 'mcap60',
  'low_after_entry_pct', 'n_buys_60s', 'n_sells_60s', 'exempt_sold_within_sec',
]);

/** Upsert a subset of token_metrics columns (snake_case keys). numeric columns accept bigint. */
export async function upsertTokenMetrics(
  sql: Sql,
  token: string,
  fields: Partial<Record<string, unknown>>,
): Promise<TokenMetricsRow> {
  const keys = Object.keys(fields).filter((k) => METRIC_COLUMNS.has(k));
  const cols = ['token', ...keys, 'updated_at'];
  const vals: unknown[] = [token.toLowerCase(), ...keys.map((k) => normValue(fields[k]))];
  const placeholders = vals.map((_, i) => `$${i + 1}`);
  placeholders.push('now()');
  const updates = [...keys.map((k) => `${k} = EXCLUDED.${k}`), 'updated_at = now()'].join(', ');
  const rows = await sql.query<TokenMetricsRow>(
    `INSERT INTO token_metrics (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
     ON CONFLICT (token) DO UPDATE SET ${updates} RETURNING *`,
    vals,
  );
  return rows[0]!;
}

function normValue(v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

// ---------------------------------------------------------------------------
// eth_transfers / token_transfers
// ---------------------------------------------------------------------------

export interface EthTransferInput {
  block?: number | null;
  ts?: Date | null;
  txHash: string;
  traceAddr?: string;
  fromAddr?: string | null;
  toAddr?: string | null;
  value?: bigint | number | string;
  kind: 'tx' | 'internal' | 'create';
}

/** Insert an ETH transfer; duplicates (tx_hash, trace_addr) ignored. */
export async function insertTransfer(sql: Sql, t: EthTransferInput): Promise<EthTransferRow | null> {
  const rows = await sql.query<EthTransferRow>(
    `INSERT INTO eth_transfers (block, ts, tx_hash, trace_addr, from_addr, to_addr, value, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, trace_addr) DO NOTHING RETURNING *`,
    [
      t.block ?? null,
      t.ts ?? null,
      t.txHash.toLowerCase(),
      t.traceAddr ?? '',
      t.fromAddr?.toLowerCase() ?? null,
      t.toAddr?.toLowerCase() ?? null,
      fromWei(t.value ?? 0n),
      t.kind,
    ],
  );
  return rows[0] ?? null;
}

export interface TokenTransferInput {
  token: string;
  block?: number | null;
  ts?: Date | null;
  txHash: string;
  logIndex: number;
  fromAddr?: string | null;
  toAddr?: string | null;
  value?: bigint | number | string;
}

/** Insert an ERC-20 token transfer; duplicates (tx_hash, log_index) ignored. */
export async function insertTokenTransfer(sql: Sql, t: TokenTransferInput): Promise<TokenTransferRow | null> {
  const rows = await sql.query<TokenTransferRow>(
    `INSERT INTO token_transfers (token, block, ts, tx_hash, log_index, from_addr, to_addr, value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING *`,
    [
      t.token.toLowerCase(),
      t.block ?? null,
      t.ts ?? null,
      t.txHash.toLowerCase(),
      t.logIndex,
      t.fromAddr?.toLowerCase() ?? null,
      t.toAddr?.toLowerCase() ?? null,
      fromWei(t.value ?? 0n),
    ],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// wallets
// ---------------------------------------------------------------------------

export interface WalletInput {
  address: string;
  firstSeenBlock?: number | null;
  firstSeenTs?: Date | null;
  firstFunder?: string | null;
  firstFundingValue?: bigint | number | string | null;
  firstFundingTx?: string | null;
  isContract?: boolean;
  txCountAtFirstFunding?: number | null;
  labels?: Record<string, unknown>;
}

/**
 * Upsert a wallet. First-seen / first-funding fields are set only on insert
 * (COALESCE keeps the earliest); labels are merged; is_contract is OR-updated.
 */
export async function upsertWallet(sql: Sql, w: WalletInput): Promise<WalletRow> {
  const rows = await sql.query<WalletRow>(
    `INSERT INTO wallets
       (address, first_seen_block, first_seen_ts, first_funder, first_funding_value, first_funding_tx,
        is_contract, tx_count_at_first_funding, labels)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (address) DO UPDATE SET
       first_seen_block = COALESCE(wallets.first_seen_block, EXCLUDED.first_seen_block),
       first_seen_ts = COALESCE(wallets.first_seen_ts, EXCLUDED.first_seen_ts),
       first_funder = COALESCE(wallets.first_funder, EXCLUDED.first_funder),
       first_funding_value = COALESCE(wallets.first_funding_value, EXCLUDED.first_funding_value),
       first_funding_tx = COALESCE(wallets.first_funding_tx, EXCLUDED.first_funding_tx),
       tx_count_at_first_funding = COALESCE(wallets.tx_count_at_first_funding, EXCLUDED.tx_count_at_first_funding),
       is_contract = wallets.is_contract OR EXCLUDED.is_contract,
       labels = wallets.labels || EXCLUDED.labels
     RETURNING *`,
    [
      w.address.toLowerCase(),
      w.firstSeenBlock ?? null,
      w.firstSeenTs ?? null,
      w.firstFunder?.toLowerCase() ?? null,
      fromWei(w.firstFundingValue ?? null),
      w.firstFundingTx?.toLowerCase() ?? null,
      w.isContract ?? false,
      w.txCountAtFirstFunding ?? null,
      J(w.labels ?? {}),
    ],
  );
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// plays
// ---------------------------------------------------------------------------

/** All enabled plays (for the sniper to mirror into memory). */
export function listEnabledPlays(sql: Sql): Promise<PlayRow[]> {
  return sql.query<PlayRow>('SELECT * FROM plays WHERE enabled = true ORDER BY id');
}

export interface PlayInput {
  id?: number;
  operatorId?: number | null;
  name?: string | null;
  enabled?: boolean;
  trigger?: Record<string, unknown>;
  preset?: Record<string, unknown>;
  createdBy?: string | null;
  stats?: Record<string, unknown>;
}

/** Insert a new play or update an existing one (by id). */
export async function upsertPlay(sql: Sql, p: PlayInput): Promise<PlayRow> {
  if (p.id !== undefined) {
    const rows = await sql.query<PlayRow>(
      `UPDATE plays SET
         operator_id = COALESCE($2, operator_id),
         name = COALESCE($3, name),
         enabled = COALESCE($4, enabled),
         trigger = COALESCE($5::jsonb, trigger),
         preset = COALESCE($6::jsonb, preset),
         stats = COALESCE($7::jsonb, stats),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        p.id,
        p.operatorId ?? null,
        p.name ?? null,
        p.enabled ?? null,
        p.trigger ? J(p.trigger) : null,
        p.preset ? J(p.preset) : null,
        p.stats ? J(p.stats) : null,
      ],
    );
    if (!rows[0]) throw new Error(`play ${p.id} not found`);
    return rows[0];
  }
  const rows = await sql.query<PlayRow>(
    `INSERT INTO plays (operator_id, name, enabled, trigger, preset, created_by, stats)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb) RETURNING *`,
    [
      p.operatorId ?? null,
      p.name ?? null,
      p.enabled ?? false,
      J(p.trigger ?? {}),
      J(p.preset ?? {}),
      p.createdBy ?? null,
      J(p.stats ?? {}),
    ],
  );
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// armed_candidates
// ---------------------------------------------------------------------------

export interface ArmInput {
  playId: number;
  wallet: string;
  sourceFunder?: string | null;
  fundedValue?: bigint | number | string | null;
  fundedTx?: string | null;
  expiresAt?: Date | null;
  status?: 'armed' | 'fired' | 'expired' | 'disarmed';
}

/** Arm a candidate (idempotent on (play_id, wallet); re-arms refresh the funding + status). */
export async function armCandidate(sql: Sql, a: ArmInput): Promise<ArmedCandidateRow> {
  const rows = await sql.query<ArmedCandidateRow>(
    `INSERT INTO armed_candidates (play_id, wallet, source_funder, funded_value, funded_tx, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (play_id, wallet) DO UPDATE SET
       source_funder = EXCLUDED.source_funder, funded_value = EXCLUDED.funded_value,
       funded_tx = EXCLUDED.funded_tx, expires_at = EXCLUDED.expires_at,
       status = EXCLUDED.status, armed_at = now()
     RETURNING *`,
    [
      a.playId,
      a.wallet.toLowerCase(),
      a.sourceFunder?.toLowerCase() ?? null,
      fromWei(a.fundedValue ?? null),
      a.fundedTx?.toLowerCase() ?? null,
      a.expiresAt ?? null,
      a.status ?? 'armed',
    ],
  );
  return rows[0]!;
}

/** List armed candidates, optionally filtered by status (default 'armed'). */
export function listArmed(sql: Sql, status: string | null = 'armed'): Promise<ArmedCandidateRow[]> {
  if (status === null) return sql.query<ArmedCandidateRow>('SELECT * FROM armed_candidates ORDER BY id');
  return sql.query<ArmedCandidateRow>('SELECT * FROM armed_candidates WHERE status = $1 ORDER BY id', [status]);
}

/** Mark armed candidates whose expiry has passed as 'expired'. Returns the count. */
export async function expireArmed(sql: Sql, now: Date = new Date()): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `UPDATE armed_candidates SET status = 'expired'
     WHERE status = 'armed' AND expires_at IS NOT NULL AND expires_at < $1 RETURNING id`,
    [now],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// snipes
// ---------------------------------------------------------------------------

export interface SnipeInput {
  playId?: number | null;
  token: string;
  curve: string;
  decision?: Record<string, unknown>;
  mode?: 'live' | 'paper';
  burst?: unknown[];
  status?: 'pending' | 'open' | 'closed' | 'failed' | 'aborted';
}

/** Insert a new snipe decision. */
export async function insertSnipe(sql: Sql, s: SnipeInput): Promise<SnipeRow> {
  const rows = await sql.query<SnipeRow>(
    `INSERT INTO snipes (play_id, token, curve, decision, mode, burst, status)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7) RETURNING *`,
    [
      s.playId ?? null,
      s.token.toLowerCase(),
      s.curve.toLowerCase(),
      J(s.decision ?? {}),
      s.mode ?? 'paper',
      J(s.burst ?? []),
      s.status ?? 'pending',
    ],
  );
  return rows[0]!;
}

const SNIPE_NUMERIC = new Set(['quote_in', 'tokens_out', 'tax_paid']);
const SNIPE_JSON = new Set(['decision', 'burst', 'sells']);
const SNIPE_COLUMNS = new Set([
  'play_id', 'decision', 'mode', 'burst', 'buy_block', 'buy_ts', 'quote_in', 'tokens_out',
  'tax_paid', 'entry_price', 'status', 'sells', 'realized_pnl_eth', 'closed_at', 'notes',
]);

/** Update arbitrary snipe columns (snake_case). jsonb/numeric handled automatically. */
export async function updateSnipe(
  sql: Sql,
  id: bigint | number | string,
  fields: Partial<Record<string, unknown>>,
): Promise<SnipeRow> {
  const keys = Object.keys(fields).filter((k) => SNIPE_COLUMNS.has(k));
  if (keys.length === 0) {
    const rows = await sql.query<SnipeRow>('SELECT * FROM snipes WHERE id = $1', [String(id)]);
    if (!rows[0]) throw new Error(`snipe ${id} not found`);
    return rows[0];
  }
  const sets: string[] = [];
  const vals: unknown[] = [String(id)];
  for (const k of keys) {
    const idx = vals.length + 1;
    if (SNIPE_JSON.has(k)) {
      sets.push(`${k} = $${idx}::jsonb`);
      vals.push(J(fields[k]));
    } else if (SNIPE_NUMERIC.has(k)) {
      sets.push(`${k} = $${idx}`);
      vals.push(normValue(fields[k]));
    } else {
      sets.push(`${k} = $${idx}`);
      vals.push(fields[k] ?? null);
    }
  }
  const rows = await sql.query<SnipeRow>(
    `UPDATE snipes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new Error(`snipe ${id} not found`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** Read a setting's value (parsed jsonb), or null if absent. */
export async function getSetting<T = unknown>(sql: Sql, key: string): Promise<T | null> {
  const rows = await sql.query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

/** Upsert a setting's value. */
export async function setSetting(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, J(value)],
  );
}

// ---------------------------------------------------------------------------
// events / agent_runs
// ---------------------------------------------------------------------------

export interface EventInput {
  level?: string;
  source?: string | null;
  type?: string | null;
  payload?: Record<string, unknown>;
}

/** Append an event row (telegram tails this table). */
export async function insertEvent(sql: Sql, e: EventInput): Promise<EventRow> {
  const rows = await sql.query<EventRow>(
    `INSERT INTO events (level, source, type, payload) VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
    [e.level ?? 'info', e.source ?? null, e.type ?? null, J(e.payload ?? {})],
  );
  return rows[0]!;
}

export interface AgentRunInput {
  kind: 'play' | 'scout' | 'backtest';
  input?: Record<string, unknown>;
  reportMd?: string | null;
  csvPath?: string | null;
  proposedPlay?: Record<string, unknown> | null;
  costUsd?: number | null;
}

/** Record an agent run. */
export async function insertAgentRun(sql: Sql, r: AgentRunInput): Promise<AgentRunRow> {
  const rows = await sql.query<AgentRunRow>(
    `INSERT INTO agent_runs (kind, input, report_md, csv_path, proposed_play, cost_usd)
     VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6) RETURNING *`,
    [
      r.kind,
      J(r.input ?? {}),
      r.reportMd ?? null,
      r.csvPath ?? null,
      r.proposedPlay ? J(r.proposedPlay) : null,
      r.costUsd ?? null,
    ],
  );
  return rows[0]!;
}
