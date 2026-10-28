/**
 * Test harness: boot an in-memory PGlite, apply the real migrations, and return
 * a postgres.js-compatible `Sql` client. The helpers are written against `Sql`
 * so they run unchanged here; this is the thin adapter the SPEC asks for.
 */
import { PGlite } from '@electric-sql/pglite';
import { fromPglite, type PgliteClient, type Sql } from '../src/sql.js';
import { applyMigrations } from '../src/migrate.js';

export interface TestDb {
  sql: Sql;
  /** raw PGlite instance (for listen() which must be on the live connection). */
  pg: PGlite;
  close(): Promise<void>;
}

/** Boot a fresh in-memory database with migrations applied. */
export async function makeTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.waitReady;
  const sql = fromPglite(pg as unknown as PgliteClient);
  await applyMigrations(sql);
  return {
    sql,
    pg,
    async close() {
      await pg.close();
    },
  };
}

/** App data tables (everything except schema_migrations). */
const DATA_TABLES = [
  'curve_trades', 'token_transfers', 'eth_transfers', 'token_metrics', 'armed_candidates',
  'snipes', 'launches', 'plays', 'operators', 'wallets', 'feed_blocks', 'agent_runs',
  'settings', 'events',
];

/**
 * Truncate all data tables (restart identities) so a booted instance can be
 * reused across tests — PGlite boot is ~1.7 s, truncate is ~ms.
 */
export async function reset(db: TestDb): Promise<void> {
  await db.sql.exec(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE;`);
}
