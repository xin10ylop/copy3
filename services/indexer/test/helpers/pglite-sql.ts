/**
 * `Sql` (packages/db/src/sql.ts shape) over an in-process PGlite. Applies the real
 * packages/db migrations when present, else the stub DDL in src/stubs/schema.ts.
 * (@hood/db's own fromPglite/test helper was not exported yet when written.)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Row, Sql } from '../../src/stubs/db.js';
import { STUB_SCHEMA_SQL } from '../../src/stubs/schema.js';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/migrations/', import.meta.url));

export function schemaSql(): { sql: string; source: 'packages/db' | 'stub' } {
  if (existsSync(MIGRATIONS)) {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    if (files.length) return { sql: files.map((f) => readFileSync(MIGRATIONS + f, 'utf8')).join('\n'), source: 'packages/db' };
  }
  return { sql: STUB_SCHEMA_SQL, source: 'stub' };
}

function txSql(tx: Transaction): Sql {
  return {
    async query<T = Row>(text: string, params: readonly unknown[] = []) {
      return (await tx.query<T>(text, [...params])).rows;
    },
    async exec(text: string) {
      await tx.exec(text);
    },
    begin: (fn) => fn(txSql(tx)),
    async listen() {
      throw new Error('listen() inside a transaction');
    },
    async notify(channel, payload) {
      await tx.query('select pg_notify($1, $2)', [channel, payload]);
    },
    async end() {},
  };
}

export async function pgliteSql(extraSql = ''): Promise<{ sql: Sql; db: PGlite; source: string }> {
  const db = new PGlite();
  const schema = schemaSql();
  await db.exec(schema.sql);
  if (extraSql) await db.exec(extraSql);
  const sql: Sql = {
    async query<T = Row>(text: string, params: readonly unknown[] = []) {
      return (await db.query<T>(text, [...params])).rows;
    },
    async exec(text: string) {
      await db.exec(text);
    },
    begin: (fn) => db.transaction((tx) => fn(txSql(tx))),
    listen: (channel, cb) => db.listen(channel, cb),
    async notify(channel, payload) {
      await db.query('select pg_notify($1, $2)', [channel, payload]);
    },
    end: () => db.close(),
  };
  return { sql, db, source: schema.source };
}
