/**
 * ============================================================================
 * STUB - replace with the real helpers of `@hood/db` (docs/SPEC.md §2).
 * ============================================================================
 * Working SQL implementations of the SPEC'd tracker helpers against
 * packages/db/migrations/0001_init.sql, on the driver-neutral `Sql` interface.
 */
import type { Sql } from '@hood/indexer';

export interface PlayDbRow {
  id: number;
  name: string | null;
  enabled: boolean;
  trigger: unknown;
  preset: unknown;
}

/** SPEC: listEnabledPlays(sql) */
export async function listEnabledPlays(sql: Sql): Promise<PlayDbRow[]> {
  return sql.query<PlayDbRow>(`select id, name, enabled, trigger, preset from plays where enabled order by id`);
}

export interface ArmInput {
  playId: number;
  wallet: string;
  sourceFunder: string;
  fundedValue: bigint;
  fundedTx: string;
  expiresAt: Date;
}

/** SPEC: armCandidate(sql, c) - returns the new id, or null if (play, wallet) already exists. */
export async function armCandidate(sql: Sql, c: ArmInput): Promise<number | null> {
  const rows = await sql.query<{ id: number }>(
    `insert into armed_candidates (play_id, wallet, source_funder, funded_value, funded_tx, expires_at, status)
     values ($1, $2, $3, $4, $5, to_timestamp($6), 'armed')
     on conflict (play_id, wallet) do nothing
     returning id::float8 as id`,
    [c.playId, c.wallet, c.sourceFunder, c.fundedValue.toString(), c.fundedTx, c.expiresAt.getTime() / 1000],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export interface ArmedDbRow {
  id: number;
  play_id: number;
  wallet: string;
  source_funder: string | null;
  expires_at: number | null;
  status: string;
}

/** SPEC: listArmed(sql) - status 'armed' */
export async function listArmed(sql: Sql): Promise<ArmedDbRow[]> {
  return sql.query<ArmedDbRow>(
    `select id::float8 as id, play_id, wallet, source_funder, extract(epoch from expires_at)::float8 as expires_at, status
     from armed_candidates where status = 'armed' order by id`,
  );
}

/** SPEC: expireArmed(sql, now) - armed candidates past expires_at -> 'expired' */
export async function expireArmed(sql: Sql, now: Date): Promise<ArmedDbRow[]> {
  return sql.query<ArmedDbRow>(
    `update armed_candidates set status = 'expired'
     where status = 'armed' and expires_at <= to_timestamp($1)
     returning id::float8 as id, play_id, wallet, source_funder, extract(epoch from expires_at)::float8 as expires_at, status`,
    [now.getTime() / 1000],
  );
}

/** SPEC: insertEvent(sql, e) */
export async function insertEvent(
  sql: Sql,
  e: { level?: 'debug' | 'info' | 'warn' | 'error'; source: string; type: string; payload: unknown },
): Promise<void> {
  await sql.query(`insert into events (level, source, type, payload) values ($1, $2, $3, $4::jsonb)`, [
    e.level ?? 'info',
    e.source,
    e.type,
    JSON.stringify(e.payload, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}
