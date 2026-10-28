/**
 * Test database: in-memory PGlite with the real migrations from packages/db, wrapped
 * exactly like production (`@hood/db` Sql -> the agent's tagged-template `Db`).
 */
import { PGlite } from '@electric-sql/pglite';
import { tagged, type Db } from '../../src/db.js';
import { applyMigrations, fromPglite } from '../../src/deps.js';

export interface TestDb {
  sql: Db;
  pg: PGlite;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  const hood = fromPglite(pg);
  await applyMigrations(hood);
  return { sql: tagged(hood), pg };
}
