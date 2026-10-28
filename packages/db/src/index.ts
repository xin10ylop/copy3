/**
 * @hood/db — Postgres schema, migrations and typed query helpers for HoodSniper.
 *
 * `createDb(url)` returns an `Sql` (our minimal abstraction over postgres.js);
 * the same helpers run against PGlite in tests via the test harness. NOTIFY /
 * LISTEN are first-class so the sniper can mirror config changes into memory
 * without polling (ARCHITECTURE §4).
 */
import postgres from 'postgres';
import { fromPostgres, type PostgresClient, type Sql } from './sql.js';

export type { Sql, Row } from './sql.js';
export { fromPostgres, fromPglite } from './sql.js';
export * from './types.js';
export * from './helpers.js';
export { applyMigrations, loadMigrations, MIGRATIONS_DIR } from './migrate.js';

/** NOTIFY channel names (SPEC §2). */
export const CHANNELS = {
  plays: 'plays_changed',
  armed: 'armed_changed',
  snipes: 'snipe_events',
  settings: 'settings_changed',
} as const;
export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Connect to Postgres and return the `Sql` wrapper. */
export function createDb(url: string, opts: { max?: number } = {}): Sql {
  const client = postgres(url, {
    max: opts.max ?? 10,
    // keep bigints/numerics as strings (lossless for wei); we convert at the edges
    types: {},
  }) as unknown as PostgresClient;
  return fromPostgres(client);
}

/** Run `fn` inside a transaction. */
export function withTx<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(fn);
}

/** NOTIFY a channel with a JSON-serialisable payload. */
export function notify(sql: Sql, channel: string, payload: unknown): Promise<void> {
  return sql.notify(channel, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

/** LISTEN on a channel; the callback receives the raw text payload. Returns an unsubscribe fn. */
export function listen(
  sql: Sql,
  channel: string,
  cb: (payload: string) => void,
): Promise<() => Promise<void>> {
  return sql.listen(channel, cb);
}
