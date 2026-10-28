/**
 * Postgres-backed store on the real @hood/db helpers. Works on any `Sql` (postgres.js in
 * production via `createDb`, PGlite in tests via `fromPglite`).
 *
 * Notes on @hood/db semantics:
 *  - the `snipes` table has a NOTIFY trigger (snipe_events {op,id,play_id,token,status}); our
 *    richer snipe notifications therefore go to the `events` table (telegram tails it) instead
 *    of a second NOTIFY;
 *  - `updateSnipe` does not touch token/curve (unknown at decision time on a CREATE2
 *    launchpad), so those are set with one targeted UPDATE.
 */
import { parsePlay, type ArmedCandidate, type Play } from '@hood/core';
import {
  CHANNELS,
  createDb,
  fromWei,
  insertEvent,
  insertSnipe,
  listArmed,
  listEnabledPlays,
  listen,
  updateSnipe,
  type Sql,
} from '@hood/db';
import type { ActiveSnipe, ChangeChannel, EventRecord, FeedBlockRow, SnipeRecord, SnipeStats, SniperStore } from './store.js';

const json = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v ?? null, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)));

export class PgStore implements SniperStore {
  constructor(private readonly sql: Sql) {}

  static fromUrl(url: string): PgStore {
    return new PgStore(createDb(url, { max: 4 }));
  }

  async loadPlays(): Promise<Play[]> {
    const rows = await listEnabledPlays(this.sql);
    return rows.map((r) =>
      parsePlay({
        id: r.id,
        ...(r.operator_id !== null ? { operatorId: r.operator_id } : {}),
        name: r.name ?? '',
        enabled: r.enabled,
        trigger: r.trigger,
        preset: r.preset,
        stats: r.stats ?? {},
      }),
    );
  }

  async loadArmed(): Promise<ArmedCandidate[]> {
    const now = Date.now();
    const rows = await listArmed(this.sql, 'armed');
    return rows
      .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now)
      .map((r) => ({
        id: Number(r.id),
        playId: r.play_id,
        wallet: r.wallet.toLowerCase() as `0x${string}`,
        ...(r.source_funder ? { sourceFunder: r.source_funder.toLowerCase() as `0x${string}` } : {}),
        ...(r.funded_value !== null ? { fundedValue: BigInt(r.funded_value) } : {}),
        ...(r.funded_tx ? { fundedTx: r.funded_tx.toLowerCase() as `0x${string}` } : {}),
        armedAt: new Date(r.armed_at),
        ...(r.expires_at ? { expiresAt: new Date(r.expires_at) } : {}),
        status: 'armed' as const,
      }));
  }

  async loadSettings(): Promise<Record<string, unknown>> {
    const rows = await this.sql.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async loadSnipeStats(since: Date, mode: 'live' | 'paper'): Promise<SnipeStats> {
    const counts = await this.sql.query<{ play_id: number; n: string }>(
      `SELECT play_id, count(*)::text AS n FROM snipes
       WHERE mode = $1 AND status IN ('pending','open','closed') AND play_id IS NOT NULL GROUP BY play_id`,
      [mode],
    );
    const open = await this.sql.query<{ n: string }>(`SELECT count(*)::text AS n FROM snipes WHERE mode = $1 AND status IN ('pending','open')`, [mode]);
    const pnl = await this.sql.query<{ s: number | null }>(`SELECT sum(realized_pnl_eth) AS s FROM snipes WHERE mode = $1 AND closed_at >= $2`, [mode, since]);
    const total = await this.sql.query<{ s: number | null }>(`SELECT sum(realized_pnl_eth) AS s FROM snipes WHERE mode = $1`, [mode]);
    // token cap / firstBuyOnly: launches that were played (open/closed) or receipt-confirmed (H1:
    // a spoofed, never-confirmed launch must not block the real one after a restart)
    const toks = await this.sql.query<{ token: string }>(
      `SELECT DISTINCT token FROM snipes WHERE mode = $1 AND token <> ''
       AND (status IN ('open','closed') OR decision->>'confirmed' = 'true')`,
      [mode],
    );
    const pd = await this.sql.query<{ play_id: number; deployer: string | null }>(
      `SELECT DISTINCT play_id, decision->'launch'->'event'->>'deployer' AS deployer FROM snipes
       WHERE mode = $1 AND play_id IS NOT NULL AND (status IN ('open','closed') OR decision->>'confirmed' = 'true')`,
      [mode],
    );
    return {
      countsByPlay: Object.fromEntries(counts.map((c) => [c.play_id, Number(c.n)])),
      openCount: Number(open[0]?.n ?? 0),
      realizedPnlSince: Number(pnl[0]?.s ?? 0),
      realizedPnlTotal: Number(total[0]?.s ?? 0),
      tokens: toks.map((t) => t.token),
      playDeployers: pd.filter((r) => r.deployer).map((r) => ({ playId: r.play_id, deployer: r.deployer! })),
    };
  }

  async loadActiveSnipes(mode: 'live' | 'paper'): Promise<ActiveSnipe[]> {
    const rows = await this.sql.query<{
      id: string;
      play_id: number | null;
      token: string;
      curve: string;
      mode: 'live' | 'paper';
      status: 'pending' | 'open';
      decided_at: Date;
      decision: unknown;
      quote_in: string | null;
      tokens_out: string | null;
      entry_price: number | null;
      buy_block: string | number | null;
      sells: unknown;
    }>(`SELECT * FROM snipes WHERE mode = $1 AND status IN ('pending','open') ORDER BY id`, [mode]);
    return rows.map((r) => ({
      id: Number(r.id),
      playId: r.play_id ?? 0,
      token: r.token,
      curve: r.curve,
      mode: r.mode,
      status: r.status,
      decidedAt: new Date(r.decided_at),
      decision: r.decision,
      quoteIn: r.quote_in === null ? null : BigInt(r.quote_in),
      tokensOut: r.tokens_out === null ? null : BigInt(r.tokens_out),
      entryPrice: r.entry_price,
      buyBlock: r.buy_block === null ? null : Number(r.buy_block),
      sells: r.sells,
    }));
  }

  async onChange(cb: (channel: ChangeChannel, payload: string) => void): Promise<() => Promise<void>> {
    const channels: ChangeChannel[] = [CHANNELS.plays, CHANNELS.armed, CHANNELS.settings];
    const offs = await Promise.all(channels.map((c) => listen(this.sql, c, (p) => cb(c, p))));
    return async () => {
      await Promise.all(offs.map((off) => off()));
    };
  }

  async insertSnipe(s: SnipeRecord): Promise<number> {
    const row = await insertSnipe(this.sql, {
      playId: s.playId > 0 ? s.playId : null,
      token: s.token,
      curve: s.curve,
      decision: json(s.decision) as Record<string, unknown>,
      mode: s.mode,
      burst: json(s.burst) as unknown[],
      status: s.status,
    });
    const id = Number(row.id);
    const { token: _token, curve: _curve, ...rest } = s; // already inserted
    await this.updateSnipe(id, rest);
    return id;
  }

  async updateSnipe(id: number, p: Partial<SnipeRecord>): Promise<void> {
    if ((p.token !== undefined && p.token !== '') || (p.curve !== undefined && p.curve !== '')) {
      await this.sql.query(
        `UPDATE snipes SET token = COALESCE(NULLIF($2, ''), token), curve = COALESCE(NULLIF($3, ''), curve) WHERE id = $1`,
        [String(id), (p.token ?? '').toLowerCase(), (p.curve ?? '').toLowerCase()],
      );
    }
    const f: Record<string, unknown> = {};
    if (p.decision !== undefined) f.decision = json(p.decision);
    if (p.burst !== undefined) f.burst = json(p.burst);
    if (p.buyBlock !== undefined) f.buy_block = p.buyBlock;
    if (p.buyTs !== undefined) f.buy_ts = p.buyTs;
    if (p.quoteIn !== undefined) f.quote_in = fromWei(p.quoteIn);
    if (p.tokensOut !== undefined) f.tokens_out = fromWei(p.tokensOut);
    if (p.taxPaid !== undefined) f.tax_paid = fromWei(p.taxPaid);
    if (p.entryPrice !== undefined) f.entry_price = p.entryPrice;
    if (p.status !== undefined) f.status = p.status;
    if (p.sells !== undefined) f.sells = json(p.sells);
    if (p.realizedPnlEth !== undefined) f.realized_pnl_eth = p.realizedPnlEth;
    if (p.closedAt !== undefined) f.closed_at = p.closedAt;
    if (p.notes !== undefined) f.notes = p.notes;
    if (Object.keys(f).length) await updateSnipe(this.sql, id, f);
  }

  async insertEvent(e: EventRecord): Promise<void> {
    await insertEvent(this.sql, { level: e.level, source: e.source, type: e.type, payload: json(e.payload) as Record<string, unknown> });
  }

  /** The snipes trigger already NOTIFYs snipe_events; the typed detail goes to `events`. */
  async notifySnipeEvent(payload: string): Promise<void> {
    const p = JSON.parse(payload) as Record<string, unknown>;
    await insertEvent(this.sql, { level: 'info', source: 'sniper', type: String(p.type ?? 'snipe_event'), payload: p });
  }

  async insertFeedBlocks(rows: FeedBlockRow[]): Promise<void> {
    if (rows.length === 0) return;
    const params: unknown[] = [];
    const values = rows.map((r, i) => {
      params.push(r.block, new Date(r.ts * 1000), Math.round(r.arrivalMs), r.nTxs);
      return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
    });
    await this.sql.query(`INSERT INTO feed_blocks (block, ts, arrival_ms, n_txs) VALUES ${values.join(',')} ON CONFLICT (block) DO NOTHING`, params);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
