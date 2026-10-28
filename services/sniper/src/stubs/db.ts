/**
 * ============================================================================
 * STUB — replace with the real helpers of `@hood/db` (docs/SPEC.md §2).
 * ============================================================================
 * packages/db had no exports when the sniper was written. These are working
 * postgres.js implementations of the SPEC'd names against the SPEC §2 tables:
 *   createDb, listen, notify, listEnabledPlays, listArmed, getSettings,
 *   insertSnipe, updateSnipe, insertEvent, insertFeedBlocks, snipeStats.
 * ONLY `src/store-db.ts` imports this file; switching to @hood/db means changing
 * that one import (and adapting shapes there if the real signatures differ).
 */
import { parsePlay, type ArmedCandidate, type Play } from '@hood/core';
import postgres from 'postgres';

export type Sql = postgres.Sql;

const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/** SPEC: createDb(url) */
export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, { max: opts.max ?? 4, onnotice: () => undefined });
}

/** SPEC: listen(sql, channel, onPayload) */
export async function listen(sql: Sql, channel: string, onPayload: (payload: string) => void): Promise<{ unlisten: () => Promise<void> }> {
  const sub = await sql.listen(channel, onPayload);
  return { unlisten: () => sub.unlisten() };
}

/** SPEC: notify(sql, channel, payload) */
export async function notify(sql: Sql, channel: string, payload: string): Promise<void> {
  await sql`select pg_notify(${channel}, ${payload})`;
}

/** SPEC: listEnabledPlays(sql) */
export async function listEnabledPlays(sql: Sql): Promise<Play[]> {
  const rows = await sql<{ id: number; operator_id: number | null; name: string; enabled: boolean; trigger: unknown; preset: unknown }[]>`
    select id, operator_id, name, enabled, trigger, preset from plays where enabled order by id`;
  return rows.map((r) =>
    parsePlay({ id: r.id, ...(r.operator_id !== null ? { operatorId: r.operator_id } : {}), name: r.name, enabled: r.enabled, trigger: r.trigger, preset: r.preset }),
  );
}

/** SPEC: listArmed(sql) — live candidates only */
export async function listArmed(sql: Sql): Promise<ArmedCandidate[]> {
  const rows = await sql<
    { id: number; play_id: number; wallet: string; source_funder: string | null; funded_value: string | null; funded_tx: string | null; armed_at: Date | null; expires_at: Date | null }[]
  >`select id, play_id, wallet, source_funder, funded_value::text, funded_tx, armed_at, expires_at
    from armed_candidates where status = 'armed' and (expires_at is null or expires_at > now())`;
  return rows.map((r) => ({
    id: Number(r.id),
    playId: r.play_id,
    wallet: r.wallet.toLowerCase() as `0x${string}`,
    ...(r.source_funder ? { sourceFunder: r.source_funder.toLowerCase() as `0x${string}` } : {}),
    ...(r.funded_value ? { fundedValue: BigInt(r.funded_value) } : {}),
    ...(r.funded_tx ? { fundedTx: r.funded_tx.toLowerCase() as `0x${string}` } : {}),
    ...(r.armed_at ? { armedAt: r.armed_at } : {}),
    ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
    status: 'armed' as const,
  }));
}

/** settings(key, value jsonb) → object */
export async function getSettings(sql: Sql): Promise<Record<string, unknown>> {
  const rows = await sql<{ key: string; value: unknown }[]>`select key, value from settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export interface SnipeRow {
  playId: number;
  token: string;
  curve: string;
  decidedAt: Date;
  decision: unknown;
  mode: 'live' | 'paper';
  burst: unknown;
  buyBlock?: number | null;
  buyTs?: Date | null;
  quoteIn?: bigint | null;
  tokensOut?: bigint | null;
  taxPaid?: bigint | null;
  entryPrice?: number | null;
  status: string;
  sells: unknown;
  realizedPnlEth?: number | null;
  closedAt?: Date | null;
  notes?: string | null;
}

const n = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

/** SPEC: insertSnipe(sql, snipe) → id */
export async function insertSnipe(sql: Sql, s: SnipeRow): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into snipes (play_id, token, curve, decided_at, decision, mode, burst, buy_block, buy_ts, quote_in, tokens_out,
                        tax_paid, entry_price, status, sells, realized_pnl_eth, closed_at, notes)
    values (${s.playId}, ${s.token}, ${s.curve}, ${s.decidedAt}, ${json(s.decision)}::jsonb, ${s.mode}, ${json(s.burst)}::jsonb,
            ${s.buyBlock ?? null}, ${s.buyTs ?? null}, ${n(s.quoteIn)}, ${n(s.tokensOut)}, ${n(s.taxPaid)}, ${s.entryPrice ?? null},
            ${s.status}, ${json(s.sells)}::jsonb, ${s.realizedPnlEth ?? null}, ${s.closedAt ?? null}, ${s.notes ?? null})
    returning id`;
  return Number(row!.id);
}

/** SPEC: updateSnipe(sql, id, patch) */
export async function updateSnipe(sql: Sql, id: number, p: Partial<SnipeRow>): Promise<void> {
  const cols: Record<string, unknown> = {};
  if (p.token !== undefined) cols.token = p.token;
  if (p.curve !== undefined) cols.curve = p.curve;
  if (p.decision !== undefined) cols.decision = sql.json(JSON.parse(json(p.decision)) as postgres.JSONValue);
  if (p.burst !== undefined) cols.burst = sql.json(JSON.parse(json(p.burst)) as postgres.JSONValue);
  if (p.buyBlock !== undefined) cols.buy_block = p.buyBlock;
  if (p.buyTs !== undefined) cols.buy_ts = p.buyTs;
  if (p.quoteIn !== undefined) cols.quote_in = n(p.quoteIn);
  if (p.tokensOut !== undefined) cols.tokens_out = n(p.tokensOut);
  if (p.taxPaid !== undefined) cols.tax_paid = n(p.taxPaid);
  if (p.entryPrice !== undefined) cols.entry_price = p.entryPrice;
  if (p.status !== undefined) cols.status = p.status;
  if (p.sells !== undefined) cols.sells = sql.json(JSON.parse(json(p.sells)) as postgres.JSONValue);
  if (p.realizedPnlEth !== undefined) cols.realized_pnl_eth = p.realizedPnlEth;
  if (p.closedAt !== undefined) cols.closed_at = p.closedAt;
  if (p.notes !== undefined) cols.notes = p.notes;
  if (Object.keys(cols).length === 0) return;
  await sql`update snipes set ${sql(cols as Record<string, postgres.ParameterOrJSON<never>>)} where id = ${id}`;
}

/** events(ts, level, source, type, payload) */
export async function insertEvent(sql: Sql, e: { level: string; source: string; type: string; payload: unknown }): Promise<void> {
  await sql`insert into events (ts, level, source, type, payload) values (now(), ${e.level}, ${e.source}, ${e.type}, ${json(e.payload)}::jsonb)`;
}

/** feed_blocks(block pk, ts, arrival_ms, n_txs) — clock calibration stats */
export async function insertFeedBlocks(sql: Sql, rows: { block: number; ts: number; arrivalMs: number; nTxs: number }[]): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map((r) => ({ block: r.block, ts: new Date(r.ts * 1000), arrival_ms: Math.round(r.arrivalMs), n_txs: r.nTxs }));
  await sql`insert into feed_blocks ${sql(values)} on conflict (block) do nothing`;
}

/** Aggregates the risk module needs at startup. */
export async function snipeStats(sql: Sql, since: Date): Promise<{
  countsByPlay: Record<number, number>;
  openCount: number;
  realizedPnlSince: number;
  tokens: string[];
  playDeployers: { playId: number; deployer: string }[];
}> {
  const counts = await sql<{ play_id: number; n: string }[]>`
    select play_id, count(*)::text as n from snipes where mode = 'live' and status in ('open','closed','pending') group by play_id`;
  const [open] = await sql<{ n: string }[]>`select count(*)::text as n from snipes where status in ('open','pending')`;
  const [pnl] = await sql<{ s: number | null }[]>`
    select sum(realized_pnl_eth) as s from snipes where mode = 'live' and closed_at >= ${since}`;
  const toks = await sql<{ token: string }[]>`select distinct token from snipes where status in ('open','closed','pending')`;
  const pd = await sql<{ play_id: number; deployer: string | null }[]>`
    select distinct play_id, decision->'launch'->'event'->>'deployer' as deployer from snipes where status <> 'aborted'`;
  return {
    countsByPlay: Object.fromEntries(counts.map((c) => [c.play_id, Number(c.n)])),
    openCount: Number(open?.n ?? 0),
    realizedPnlSince: Number(pnl?.s ?? 0),
    tokens: toks.map((t) => t.token),
    playDeployers: pd.filter((r) => r.deployer).map((r) => ({ playId: r.play_id, deployer: r.deployer! })),
  };
}
