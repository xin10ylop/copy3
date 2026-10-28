/**
 * BotStore on Postgres via `@hood/db` (its driver-neutral `Sql`: postgres.js in production,
 * PGlite in tests) against the SPEC §2 schema in packages/db/migrations.
 *
 * NOTIFY: the migration's row triggers already announce every insert/update on plays,
 * armed_candidates, snipes and settings (`plays_changed`, `armed_changed`, `snipe_events`,
 * `settings_changed`), so writes here do not NOTIFY by hand. Private notifier checkpoints are
 * only written when they change, to keep `settings_changed` quiet.
 */
import { getSetting, insertEvent, setSetting, upsertPlay, type Sql } from '@hood/db';
import {
  parseEthUsd,
  parseKillState,
  SETTINGS,
  type ArmedRow,
  type BotStore,
  type EventRow,
  type NewEvent,
  type NewPlay,
  type PlayRow,
  type PnlBucket,
  type PnlSummary,
  type SnipeRow,
  type StatusSnapshot,
} from './store.js';

type Row = Record<string, unknown>;

const json = (v: unknown): string => JSON.stringify(v ?? null, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const toBig = (v: unknown): bigint | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  const s = String(v);
  if (/^-?\d+$/.test(s)) return BigInt(s);
  if (/^-?\d+\.\d+$/.test(s)) return BigInt(s.split('.')[0]!);
  return null;
};
const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) return new Date(Number(s) > 1e12 ? Number(s) : Number(s) * 1000);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Postgres array literal for integer ids (safe: numbers only). */
const intArray = (ids: number[]): string => `{${ids.filter((i) => Number.isSafeInteger(i)).join(',')}}`;
const textArray = (xs: string[]): string => `{${xs.map((x) => `"${x.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

function playFrom(r: Row): PlayRow {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    enabled: r.enabled === true,
    operatorId: toNum(r.operator_id),
    trigger: r.trigger ?? {},
    preset: r.preset ?? {},
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
    stats: obj(r.stats),
    armedCount: Number(r.armed_count ?? 0),
  };
}

function armedFrom(r: Row): ArmedRow {
  return {
    id: Number(r.id),
    playId: Number(r.play_id),
    playName: (r.play_name as string | null) ?? null,
    wallet: String(r.wallet).toLowerCase(),
    sourceFunder: r.source_funder ? String(r.source_funder).toLowerCase() : null,
    fundedValueWei: toBig(r.funded_value),
    fundedTx: (r.funded_tx as string | null) ?? null,
    armedAt: toDate(r.armed_at),
    expiresAt: toDate(r.expires_at),
    status: String(r.status ?? 'armed'),
  };
}

const SNIPE_STATUSES = new Set(['pending', 'open', 'closed', 'failed', 'aborted']);

function snipeFrom(r: Row): SnipeRow {
  return {
    id: Number(r.id),
    playId: Number(r.play_id ?? 0),
    playName: (r.play_name as string | null) ?? null,
    token: String(r.token).toLowerCase(),
    curve: String(r.curve ?? '').toLowerCase(),
    tokenName: (r.token_name as string | null) ?? null,
    tokenSymbol: (r.token_symbol as string | null) ?? null,
    launchTs: toDate(r.launch_ts),
    mode: r.mode === 'live' ? 'live' : 'paper',
    status: (SNIPE_STATUSES.has(String(r.status)) ? r.status : 'pending') as SnipeRow['status'],
    decidedAt: toDate(r.decided_at),
    decision: obj(r.decision),
    burst: arr(r.burst),
    buyBlock: toNum(r.buy_block),
    buyTs: toDate(r.buy_ts),
    quoteInWei: toBig(r.quote_in),
    tokensOut: toBig(r.tokens_out),
    taxPaidWei: toBig(r.tax_paid),
    entryPrice: toNum(r.entry_price),
    sells: arr(r.sells),
    realizedPnlEth: toNum(r.realized_pnl_eth),
    closedAt: toDate(r.closed_at),
    notes: (r.notes as string | null) ?? null,
    lastPrice: toNum(r.last_price),
  };
}

function emptyBucket(): PnlBucket {
  return { closed: 0, wins: 0, losses: 0, pnlEth: 0, bestEth: null, worstEth: null, aborted: 0, failed: 0, taxPaidWei: 0n, investedWei: 0n };
}

const PLAY_SELECT = `
  SELECT p.id, p.name, p.enabled, p.operator_id, p.trigger, p.preset, p.created_by, p.created_at, p.updated_at, p.stats,
         (SELECT count(*) FROM armed_candidates a
           WHERE a.play_id = p.id AND a.status = 'armed' AND (a.expires_at IS NULL OR a.expires_at > now()))::int AS armed_count
  FROM plays p`;

const ARMED_SELECT = `
  SELECT a.id::text AS id, a.play_id, p.name AS play_name, a.wallet, a.source_funder, a.funded_value::text AS funded_value,
         a.funded_tx, a.armed_at, a.expires_at, a.status
  FROM armed_candidates a LEFT JOIN plays p ON p.id = a.play_id`;

const SNIPE_SELECT = (withPrice: boolean): string => `
  SELECT s.id::text AS id, s.play_id, p.name AS play_name, s.token, s.curve, l.name AS token_name, l.symbol AS token_symbol, l.ts AS launch_ts,
         s.mode, s.status, s.decided_at, s.decision, s.burst, s.buy_block::text AS buy_block, s.buy_ts,
         s.quote_in::text AS quote_in, s.tokens_out::text AS tokens_out, s.tax_paid::text AS tax_paid,
         s.entry_price, s.sells, s.realized_pnl_eth, s.closed_at, s.notes
         ${withPrice ? `, (SELECT ct.price_after FROM curve_trades ct WHERE ct.token = s.token ORDER BY ct.block DESC NULLS LAST, ct.log_index DESC LIMIT 1) AS last_price` : ''}
  FROM snipes s
    LEFT JOIN plays p ON p.id = s.play_id
    LEFT JOIN launches l ON l.token = s.token`;

export class PgStore implements BotStore {
  /** last value written per private key (skip identical writes) */
  private readonly written = new Map<string, string>();

  constructor(
    private readonly sql: Sql,
    private readonly onError: (what: string, err: unknown) => void = () => undefined,
  ) {}

  /** /status reads degrade per field (e.g. no feed_blocks yet) instead of failing the command */
  private async safe(what: string, text: string, params: unknown[] = []): Promise<Row[]> {
    try {
      return await this.sql.query<Row>(text, params);
    } catch (err) {
      this.onError(what, err);
      return [];
    }
  }

  // ------------------------------------------------------------------------------- plays
  async listPlays(): Promise<PlayRow[]> {
    return (await this.sql.query<Row>(`${PLAY_SELECT} ORDER BY p.id`)).map(playFrom);
  }

  async getPlay(id: number): Promise<PlayRow | null> {
    const rows = await this.sql.query<Row>(`${PLAY_SELECT} WHERE p.id = $1`, [id]);
    return rows[0] ? playFrom(rows[0]) : null;
  }

  async insertPlay(p: NewPlay): Promise<number> {
    const row = await upsertPlay(this.sql, {
      operatorId: p.operatorId ?? null,
      name: p.name,
      enabled: p.enabled,
      trigger: obj(JSON.parse(json(p.trigger))),
      preset: obj(JSON.parse(json(p.preset))),
      createdBy: p.createdBy,
      stats: p.stats ?? {},
    });
    return Number(row.id);
  }

  async setPlayEnabled(id: number, enabled: boolean, statsPatch?: Record<string, unknown>): Promise<PlayRow | null> {
    await this.sql.query(
      `UPDATE plays SET enabled = $2, updated_at = now(), stats = coalesce(stats, '{}'::jsonb) || $3::jsonb WHERE id = $1`,
      [id, enabled, json(statsPatch ?? {})],
    );
    return this.getPlay(id);
  }

  async updatePlayPreset(id: number, preset: unknown): Promise<void> {
    await upsertPlay(this.sql, { id, preset: obj(JSON.parse(json(preset))) });
  }

  // ------------------------------------------------------------------------------- armed
  async listArmed(limit: number): Promise<ArmedRow[]> {
    const rows = await this.sql.query<Row>(
      `${ARMED_SELECT} WHERE a.status = 'armed' AND (a.expires_at IS NULL OR a.expires_at > now()) ORDER BY a.armed_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(armedFrom);
  }

  async armedAfter(id: number, limit: number): Promise<ArmedRow[]> {
    return (await this.sql.query<Row>(`${ARMED_SELECT} WHERE a.id > $1 ORDER BY a.id LIMIT $2`, [id, limit])).map(armedFrom);
  }

  async maxArmedId(): Promise<number> {
    const r = await this.sql.query<Row>(`SELECT coalesce(max(id), 0)::text AS id FROM armed_candidates`);
    return Number(r[0]?.id ?? 0);
  }

  // ------------------------------------------------------------------------------- snipes
  async listOpenSnipes(): Promise<SnipeRow[]> {
    return (await this.sql.query<Row>(`${SNIPE_SELECT(true)} WHERE s.status IN ('pending', 'open') ORDER BY s.id DESC LIMIT 50`)).map(snipeFrom);
  }

  async getSnipes(ids: number[]): Promise<SnipeRow[]> {
    if (ids.length === 0) return [];
    return (await this.sql.query<Row>(`${SNIPE_SELECT(false)} WHERE s.id = ANY($1::bigint[]) ORDER BY s.id`, [intArray(ids)])).map(snipeFrom);
  }

  async snipesAfter(id: number, limit: number): Promise<SnipeRow[]> {
    return (await this.sql.query<Row>(`${SNIPE_SELECT(false)} WHERE s.id > $1 ORDER BY s.id LIMIT $2`, [id, limit])).map(snipeFrom);
  }

  async maxSnipeId(): Promise<number> {
    const r = await this.sql.query<Row>(`SELECT coalesce(max(id), 0)::text AS id FROM snipes`);
    return Number(r[0]?.id ?? 0);
  }

  async pnlSummary(since: Date): Promise<PnlSummary> {
    const rows = await this.sql.query<Row>(
      `SELECT mode,
         count(*) FILTER (WHERE status = 'closed' AND closed_at >= $1)::int AS closed,
         count(*) FILTER (WHERE status = 'closed' AND closed_at >= $1 AND realized_pnl_eth > 0)::int AS wins,
         count(*) FILTER (WHERE status = 'closed' AND closed_at >= $1 AND realized_pnl_eth < 0)::int AS losses,
         coalesce(sum(realized_pnl_eth) FILTER (WHERE status = 'closed' AND closed_at >= $1), 0)::float8 AS pnl,
         max(realized_pnl_eth) FILTER (WHERE status = 'closed' AND closed_at >= $1) AS best,
         min(realized_pnl_eth) FILTER (WHERE status = 'closed' AND closed_at >= $1) AS worst,
         count(*) FILTER (WHERE status = 'aborted' AND decided_at >= $1)::int AS aborted,
         count(*) FILTER (WHERE status = 'failed' AND decided_at >= $1)::int AS failed,
         coalesce(sum(tax_paid) FILTER (WHERE status = 'closed' AND closed_at >= $1), 0)::text AS tax,
         coalesce(sum(quote_in) FILTER (WHERE status = 'closed' AND closed_at >= $1), 0)::text AS invested
       FROM snipes
       WHERE closed_at >= $1 OR decided_at >= $1
       GROUP BY mode`,
      [since],
    );
    const out: PnlSummary = { since, live: emptyBucket(), paper: emptyBucket(), byPlay: [] };
    for (const r of rows) {
      const bucket: PnlBucket = {
        closed: Number(r.closed),
        wins: Number(r.wins),
        losses: Number(r.losses),
        pnlEth: Number(r.pnl),
        bestEth: toNum(r.best),
        worstEth: toNum(r.worst),
        aborted: Number(r.aborted),
        failed: Number(r.failed),
        taxPaidWei: toBig(r.tax) ?? 0n,
        investedWei: toBig(r.invested) ?? 0n,
      };
      if (r.mode === 'live') out.live = bucket;
      else out.paper = bucket;
    }
    const byPlay = await this.sql.query<Row>(
      `SELECT s.play_id, p.name, s.mode, count(*)::int AS closed, coalesce(sum(s.realized_pnl_eth), 0)::float8 AS pnl
       FROM snipes s LEFT JOIN plays p ON p.id = s.play_id
       WHERE s.status = 'closed' AND s.closed_at >= $1
       GROUP BY s.play_id, p.name, s.mode
       ORDER BY pnl DESC`,
      [since],
    );
    out.byPlay = byPlay.map((r) => ({
      playId: Number(r.play_id ?? 0),
      name: (r.name as string | null) ?? null,
      mode: r.mode === 'live' ? 'live' : 'paper',
      closed: Number(r.closed),
      pnlEth: Number(r.pnl),
    }));
    return out;
  }

  // ------------------------------------------------------------------------------- status
  async getStatus(dayStart: Date): Promise<StatusSnapshot> {
    const [feed, settings, open, daily, plays, armed, lastError] = await Promise.all([
      this.safe('feed head', `SELECT block::text AS block, ts, arrival_ms::text AS arrival_ms FROM feed_blocks ORDER BY block DESC LIMIT 1`),
      this.safe('settings', `SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [textArray([SETTINGS.killSwitch, SETTINGS.ethUsd, SETTINGS.indexerCheckpoint])]),
      this.safe('open positions', `SELECT mode, count(*)::int AS n FROM snipes WHERE status IN ('pending', 'open') GROUP BY mode`),
      this.safe('daily pnl', `SELECT mode, coalesce(sum(realized_pnl_eth), 0)::float8 AS pnl FROM snipes WHERE status = 'closed' AND closed_at >= $1 GROUP BY mode`, [dayStart]),
      this.safe(
        'plays',
        `SELECT count(*) FILTER (WHERE enabled)::int AS enabled,
                count(*) FILTER (WHERE NOT enabled AND (stats->'review'->>'status' = 'pending'
                                  OR (stats->'review' IS NULL AND (created_by = 'agent' OR stats->>'needsApproval' = 'true'))))::int AS pending
         FROM plays`,
      ),
      this.safe('armed', `SELECT count(*)::int AS n FROM armed_candidates WHERE status = 'armed' AND (expires_at IS NULL OR expires_at > now())`),
      this.safe('last error', `SELECT ts, source, type FROM events WHERE level = 'error' ORDER BY id DESC LIMIT 1`),
    ]);
    const setting = (k: string): unknown => settings.find((r) => r.key === k)?.value ?? null;
    const byMode = (rows: Row[], field: string): { live: number; paper: number } => ({
      live: Number(rows.find((r) => r.mode === 'live')?.[field] ?? 0),
      paper: Number(rows.find((r) => r.mode === 'paper')?.[field] ?? 0),
    });
    const checkpoint = obj(setting(SETTINGS.indexerCheckpoint));
    const f = feed[0];
    const le = lastError[0];
    return {
      feed: f ? { block: Number(f.block), ts: toDate(f.ts), arrivalMs: toNum(f.arrival_ms) } : null,
      indexerBlock: toNum(checkpoint.block),
      kill: parseKillState(setting(SETTINGS.killSwitch)),
      openPositions: byMode(open, 'n'),
      dailyPnl: byMode(daily, 'pnl'),
      enabledPlays: Number(plays[0]?.enabled ?? 0),
      pendingReview: Number(plays[0]?.pending ?? 0),
      armed: Number(armed[0]?.n ?? 0),
      lastError: le ? { ts: toDate(le.ts) ?? new Date(0), source: String(le.source ?? ''), type: String(le.type ?? '') } : null,
      ethUsd: parseEthUsd(setting(SETTINGS.ethUsd)),
    };
  }

  // ------------------------------------------------------------------------------- settings
  async getSetting<T = unknown>(key: string): Promise<T | null> {
    return getSetting<T>(this.sql, key);
  }

  /**
   * Upsert a setting; the settings trigger NOTIFYs `settings_changed {key}`. With
   * `notify: false` (private checkpoints) identical consecutive writes are skipped.
   */
  async setSetting(key: string, value: unknown, opts: { notify?: boolean } = {}): Promise<void> {
    const text = json(value);
    if (opts.notify === false && this.written.get(key) === text) return;
    await setSetting(this.sql, key, JSON.parse(text) as unknown);
    this.written.set(key, text);
  }

  // ------------------------------------------------------------------------------- events
  async insertEvent(e: NewEvent): Promise<void> {
    const payload = e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? (JSON.parse(json(e.payload)) as Record<string, unknown>) : { value: e.payload };
    await insertEvent(this.sql, { level: e.level, source: e.source, type: e.type, payload });
  }

  async eventsAfter(id: number, limit: number): Promise<EventRow[]> {
    const rows = await this.sql.query<Row>(`SELECT id::text AS id, ts, level, source, type, payload FROM events WHERE id > $1 ORDER BY id LIMIT $2`, [id, limit]);
    return rows.map((r) => ({
      id: Number(r.id),
      ts: toDate(r.ts) ?? new Date(0),
      level: String(r.level ?? 'info'),
      source: String(r.source ?? ''),
      type: String(r.type ?? ''),
      payload: r.payload ?? null,
    }));
  }

  async maxEventId(): Promise<number> {
    const r = await this.sql.query<Row>(`SELECT coalesce(max(id), 0)::text AS id FROM events`);
    return Number(r[0]?.id ?? 0);
  }

  async countEventsSince(since: Date, level: string): Promise<number> {
    const r = await this.sql.query<Row>(`SELECT count(*)::int AS n FROM events WHERE ts >= $1 AND level = $2`, [since, level]);
    return Number(r[0]?.n ?? 0);
  }
}
