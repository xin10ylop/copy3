/** PGlite with the real packages/db migrations, via @hood/db's own test harness. */
import type { PGlite } from '@electric-sql/pglite';
import type { Sql } from '@hood/db';
import { makeTestDb } from '../../../../packages/db/test/pglite.js';

export async function pgliteSql(extraSql = ''): Promise<{ sql: Sql; db: PGlite }> {
  const t = await makeTestDb();
  if (extraSql) await t.sql.exec(extraSql);
  return { sql: t.sql, db: t.pg };
}
