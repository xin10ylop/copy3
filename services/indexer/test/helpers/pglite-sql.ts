/**
 * A postgres.js-shaped `sql` over PGlite (tagged templates, unsafe, begin, listen,
 * end) - enough for the SQL used by PgStore / funding / the tracker store.
 * Used because @hood/db did not ship test/pglite.ts when these tests were written.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Sql } from '../../src/stubs/db.js';
import { STUB_SCHEMA_SQL } from '../../src/stubs/schema.js';

interface Querier {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function makeSql(q: Querier, root: PGlite | null): unknown {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    for (let i = 1; i < strings.length; i++) text += `$${i}${strings[i] ?? ''}`;
    return q.query(text, values).then((r) => r.rows);
  };
  return Object.assign(fn, {
    unsafe: (text: string, params: unknown[] = []) => q.query(text, params).then((r) => r.rows),
    begin: async (cb: (tx: unknown) => Promise<unknown>) =>
      root ? root.transaction((tx) => cb(makeSql(tx, null))) : cb(makeSql(q, null)),
    listen: async (channel: string, cb: (payload: string) => void) => {
      if (!root) throw new Error('listen inside a transaction');
      const unsub = await root.listen(channel, cb);
      return { unlisten: unsub };
    },
    notify: async (channel: string, payload: string) => {
      await q.query('select pg_notify($1, $2)', [channel, payload]);
    },
    end: async () => {},
  });
}

export async function pgliteSql(schema = STUB_SCHEMA_SQL): Promise<{ sql: Sql; db: PGlite }> {
  const db = new PGlite();
  await db.exec(schema);
  return { sql: makeSql(db, db) as Sql, db };
}
