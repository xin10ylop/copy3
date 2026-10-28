/**
 * ============================================================================
 * STUB - stands in for `@hood/db`'s `createDb(url)` / `listen(...)` (docs/SPEC.md §2).
 * ============================================================================
 * packages/db exported nothing when this service was written. These are the SPEC'd names
 * implemented directly on postgres.js; `src/db.ts` is the only importer, so switching to
 * @hood/db is a one-line change there.
 */
import postgres from 'postgres';

export type Sql = postgres.Sql;

/** SPEC: createDb(url) → postgres.Sql */
export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, { max: opts.max ?? 5, idle_timeout: 30, connect_timeout: 10, onnotice: () => undefined });
}

/** SPEC: listen(sql, channel, onPayload) – postgres.js keeps a dedicated, auto-reconnecting connection. */
export async function listen(sql: Sql, channel: string, onPayload: (payload: string) => void): Promise<{ unlisten: () => Promise<void> }> {
  const sub = await sql.listen(channel, onPayload);
  return { unlisten: () => sub.unlisten() };
}
