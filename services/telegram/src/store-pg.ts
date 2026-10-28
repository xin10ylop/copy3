/**
 * BotStore on Postgres (SPEC §2 tables). Writes that change what the sniper/tracker hold in
 * memory NOTIFY the matching channel in the same transaction (`plays_changed`,
 * `settings_changed`). Reads normalise postgres.js types: int8/numeric arrive as strings.
 */
import type { Sql } from './db.js';
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
  return /^-?\d+$/.test(s) ? BigInt(s) : /^-?\d+\.\d+$/.test(s) ? BigInt(s.split('.')[0]!) : null;
};
const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) return new Date(Number(s) > 1e12 ? Number(s) : Number(s) * 1000);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type Row = Record<string, unknown>;

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

function snipeFrom(r: Row): SnipeRow {
  return {
    id: Number(r.id),
    playId: Number(r.play_id),
    playName: (r.play_name as string | null) ?? null,
    token: String(r.token).toLowerCase(),
    curve: String(r.curve ?? '').toLowerCase(),
    tokenName: (r.token_name as string | null) ?? null,
    tokenSymbol: (r.token_symbol as string | null) ?? null,
    launchTs: toDate(r.launch_ts),
    mode: r.mode === 'live' ? 'live' : 'paper',
    status: (['pending', 'open', 'closed', 'failed', 'aborted'].includes(String(r.status)) ? r.status : 'pending') as SnipeRow['status'],
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

export class PgStore implements BotStore {
  constructor(
    private readonly sql: Sql,
    private readonly onError: (what: string, err: unknown) => void = () => undefined,
  ) {}

  /** status reads degrade per field (e.g. no feed_blocks yet) instead of failing /status */
  private async safe(what: string, fn: () => Promise<Row[]>): Promise<Row[]> {
    try {
      return await fn();
    } catch (err) {
      this.onError(what, err);
      return [];
    }
  }

  // ------------------------------------------------------------------------------- plays
  private playSelect(where: ReturnType<Sql>, order = this.sql`order by p.id`) {
    return this.sql<Row[]>`
      select p.id, p.name, p.enabled, p.operator_id, p.trigger, p.preset, p.created_by, p.created_at, p.updated_at, p.stats,
             (select count(*) from armed_candidates a
               where a.play_id = p.id and a.status = 'armed' and (a.expires_at is null or a.expires_at > now()))::int as armed_count
      from plays p ${where} ${order}`;
  }

  async listPlays(): Promise<PlayRow[]> {
    return (await this.playSelect(this.sql``)).map(playFrom);
  }

  async getPlay(id: number): Promise<PlayRow | null> {
    const rows = await this.playSelect(this.sql`where p.id = ${id}`);
    return rows[0] ? playFrom(rows[0]) : null;
  }

  async insertPlay(p: NewPlay): Promise<number> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<Row[]>`
        insert into plays (operator_id, name, enabled, trigger, preset, created_by, stats, created_at, updated_at)
        values (${p.operatorId ?? null}, ${p.name}, ${p.enabled}, ${json(p.trigger)}::jsonb, ${json(p.preset)}::jsonb,
                ${p.createdBy}, ${json(p.stats ?? {})}::jsonb, now(), now())
        returning id`;
      const id = Number(rows[0]!.id);
      await tx`select pg_notify('plays_changed', ${json({ op: 'insert', playId: id })})`;
      return id;
    }) as Promise<number>;
  }

  async setPlayEnabled(id: number, enabled: boolean, statsPatch?: Record<string, unknown>): Promise<PlayRow | null> {
    await this.sql.begin(async (tx) => {
      await tx`
        update plays set enabled = ${enabled}, updated_at = now(),
               stats = coalesce(stats, '{}'::jsonb) || ${json(statsPatch ?? {})}::jsonb
        where id = ${id}`;
      await tx`select pg_notify('plays_changed', ${json({ op: enabled ? 'enable' : 'disable', playId: id })})`;
    });
    return this.getPlay(id);
  }

  async updatePlayPreset(id: number, preset: unknown): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`update plays set preset = ${json(preset)}::jsonb, updated_at = now() where id = ${id}`;
      await tx`select pg_notify('plays_changed', ${json({ op: 'preset', playId: id })})`;
    });
  }

  // ------------------------------------------------------------------------------- armed
  private armedSelect(where: ReturnType<Sql>, order: ReturnType<Sql>, limit: number) {
    return this.sql<Row[]>`
      select a.id, a.play_id, p.name as play_name, a.wallet, a.source_funder, a.funded_value::text as funded_value,
             a.funded_tx, a.armed_at, a.expires_at, a.status
      from armed_candidates a left join plays p on p.id = a.play_id
      ${where} ${order} limit ${limit}`;
  }

  async listArmed(limit: number): Promise<ArmedRow[]> {
    const rows = await this.armedSelect(
      this.sql`where a.status = 'armed' and (a.expires_at is null or a.expires_at > now())`,
      this.sql`order by a.armed_at desc nulls last`,
      limit,
    );
    return rows.map(armedFrom);
  }

  async armedAfter(id: number, limit: number): Promise<ArmedRow[]> {
    return (await this.armedSelect(this.sql`where a.id > ${id}`, this.sql`order by a.id`, limit)).map(armedFrom);
  }

  async maxArmedId(): Promise<number> {
    const r = await this.sql<Row[]>`select coalesce(max(id), 0)::text as id from armed_candidates`;
    return Number(r[0]?.id ?? 0);
  }

  // ------------------------------------------------------------------------------- snipes
  private snipeSelect(where: ReturnType<Sql>, order: ReturnType<Sql>, limit: number, withPrice = false) {
    const price = withPrice
      ? this.sql`, (select ct.price_after from curve_trades ct where ct.token = s.token order by ct.block desc, ct.log_index desc limit 1) as last_price`
      : this.sql``;
    return this.sql<Row[]>`
      select s.id, s.play_id, p.name as play_name, s.token, s.curve, l.name as token_name, l.symbol as token_symbol, l.ts as launch_ts,
             s.mode, s.status, s.decided_at, s.decision, s.burst, s.buy_block, s.buy_ts,
             s.quote_in::text as quote_in, s.tokens_out::text as tokens_out, s.tax_paid::text as tax_paid,
             s.entry_price, s.sells, s.realized_pnl_eth, s.closed_at, s.notes ${price}
      from snipes s
        left join plays p on p.id = s.play_id
        left join launches l on l.token = s.token
      ${where} ${order} limit ${limit}`;
  }

  async listOpenSnipes(): Promise<SnipeRow[]> {
    return (await this.snipeSelect(this.sql`where s.status in ('pending', 'open')`, this.sql`order by s.id desc`, 50, true)).map(snipeFrom);
  }

  async getSnipes(ids: number[]): Promise<SnipeRow[]> {
    if (ids.length === 0) return [];
    return (await this.snipeSelect(this.sql`where s.id in ${this.sql(ids)}`, this.sql`order by s.id`, ids.length)).map(snipeFrom);
  }

  async snipesAfter(id: number, limit: number): Promise<SnipeRow[]> {
    return (await this.snipeSelect(this.sql`where s.id > ${id}`, this.sql`order by s.id`, limit)).map(snipeFrom);
  }

  async maxSnipeId(): Promise<number> {
    const r = await this.sql<Row[]>`select coalesce(max(id), 0)::text as id from snipes`;
    return Number(r[0]?.id ?? 0);
  }

  async pnlSummary(since: Date): Promise<PnlSummary> {
    const rows = await this.sql<Row[]>`
      select mode,
        count(*) filter (where status = 'closed' and closed_at >= ${since})::int as closed,
        count(*) filter (where status = 'closed' and closed_at >= ${since} and realized_pnl_eth > 0)::int as wins,
        count(*) filter (where status = 'closed' and closed_at >= ${since} and realized_pnl_eth < 0)::int as losses,
        coalesce(sum(realized_pnl_eth) filter (where status = 'closed' and closed_at >= ${since}), 0)::float8 as pnl,
        max(realized_pnl_eth) filter (where status = 'closed' and closed_at >= ${since}) as best,
        min(realized_pnl_eth) filter (where status = 'closed' and closed_at >= ${since}) as worst,
        count(*) filter (where status = 'aborted' and decided_at >= ${since})::int as aborted,
        count(*) filter (where status = 'failed' and decided_at >= ${since})::int as failed,
        coalesce(sum(tax_paid) filter (where status = 'closed' and closed_at >= ${since}), 0)::text as tax,
        coalesce(sum(quote_in) filter (where status = 'closed' and closed_at >= ${since}), 0)::text as invested
      from snipes
      where closed_at >= ${since} or decided_at >= ${since}
      group by mode`;
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
    const byPlay = await this.sql<Row[]>`
      select s.play_id, p.name, s.mode, count(*)::int as closed, coalesce(sum(s.realized_pnl_eth), 0)::float8 as pnl
      from snipes s left join plays p on p.id = s.play_id
      where s.status = 'closed' and s.closed_at >= ${since}
      group by s.play_id, p.name, s.mode
      order by pnl desc`;
    out.byPlay = byPlay.map((r) => ({
      playId: Number(r.play_id),
      name: (r.name as string | null) ?? null,
      mode: r.mode === 'live' ? 'live' : 'paper',
      closed: Number(r.closed),
      pnlEth: Number(r.pnl),
    }));
    return out;
  }

  // ------------------------------------------------------------------------------- status
  async getStatus(dayStart: Date): Promise<StatusSnapshot> {
    const sql = this.sql;
    const [feed, settings, open, daily, plays, armed, lastError] = await Promise.all([
      this.safe('feed head', () => sql<Row[]>`select block::text as block, ts, arrival_ms::text as arrival_ms from feed_blocks order by block desc limit 1`),
      this.safe(
        'settings',
        () => sql<Row[]>`select key, value from settings where key in ${sql([SETTINGS.killSwitch, SETTINGS.ethUsd, SETTINGS.indexerCheckpoint])}`,
      ),
      this.safe('open positions', () => sql<Row[]>`select mode, count(*)::int as n from snipes where status in ('pending', 'open') group by mode`),
      this.safe('daily pnl', () => sql<Row[]>`select mode, coalesce(sum(realized_pnl_eth), 0)::float8 as pnl from snipes where status = 'closed' and closed_at >= ${dayStart} group by mode`),
      this.safe(
        'plays',
        () => sql<Row[]>`
          select count(*) filter (where enabled)::int as enabled,
                 count(*) filter (where not enabled and (stats->'review'->>'status' = 'pending'
                                   or (stats->'review' is null and (created_by = 'agent' or stats->>'needsApproval' = 'true'))))::int as pending
          from plays`,
      ),
      this.safe('armed', () => sql<Row[]>`select count(*)::int as n from armed_candidates where status = 'armed' and (expires_at is null or expires_at > now())`),
      this.safe('last error', () => sql<Row[]>`select ts, source, type from events where level = 'error' order by id desc limit 1`),
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
      lastError: le ? { ts: toDate(le.ts) ?? new Date(0), source: String(le.source), type: String(le.type) } : null,
      ethUsd: parseEthUsd(setting(SETTINGS.ethUsd)),
    };
  }

  // ------------------------------------------------------------------------------- settings
  async getSetting<T = unknown>(key: string): Promise<T | null> {
    const r = await this.sql<Row[]>`select value from settings where key = ${key}`;
    return r[0] ? (r[0].value as T) : null;
  }

  async setSetting(key: string, value: unknown, opts: { notify?: boolean } = {}): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`insert into settings (key, value) values (${key}, ${json(value)}::jsonb)
               on conflict (key) do update set value = excluded.value`;
      if (opts.notify !== false) await tx`select pg_notify('settings_changed', ${json({ key })})`;
    });
  }

  // ------------------------------------------------------------------------------- events
  async insertEvent(e: NewEvent): Promise<void> {
    await this.sql`insert into events (ts, level, source, type, payload) values (now(), ${e.level}, ${e.source}, ${e.type}, ${json(e.payload)}::jsonb)`;
  }

  async eventsAfter(id: number, limit: number): Promise<EventRow[]> {
    const rows = await this.sql<Row[]>`select id::text as id, ts, level, source, type, payload from events where id > ${id} order by id limit ${limit}`;
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
    const r = await this.sql<Row[]>`select coalesce(max(id), 0)::text as id from events`;
    return Number(r[0]?.id ?? 0);
  }

  async countEventsSince(since: Date, level: string): Promise<number> {
    const r = await this.sql<Row[]>`select count(*)::int as n from events where ts >= ${since} and level = ${level}`;
    return Number(r[0]?.n ?? 0);
  }
}
