/**
 * Test-only adapter: runs the agent's postgres.js tagged-template SQL on PGlite.
 * Supports the subset src/queries.ts uses - `sql\`...${v}...\``, nested fragments,
 * `sql.begin(fn)` and `sql.end()`.
 */
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db } from '../../src/queries.js';

type Queryable = Pick<PGlite, 'query'> | Transaction;

class Fragment implements PromiseLike<unknown[]> {
  constructor(
    private readonly runner: Queryable,
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  build(params: unknown[]): string {
    let text = this.strings[0] ?? '';
    this.values.forEach((v, i) => {
      if (v instanceof Fragment) text += v.build(params);
      else {
        params.push(v === undefined ? null : v);
        text += `$${params.length}`;
      }
      text += this.strings[i + 1] ?? '';
    });
    return text;
  }

  then<A = unknown[], B = never>(onOk?: ((v: unknown[]) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    const params: unknown[] = [];
    const text = this.build(params);
    return this.runner.query(text, params).then((r) => r.rows as unknown[]).then(onOk, onErr);
  }
}

function makeSql(runner: Queryable, root?: PGlite): Db {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Fragment => new Fragment(runner, strings, values);
  Object.assign(tag, {
    begin: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      if (!root) return fn(makeSql(runner));
      return root.transaction(async (tx) => fn(makeSql(tx)));
    },
    end: async (): Promise<void> => {
      if (root) await root.close();
    },
  });
  return tag as unknown as Db;
}

export interface TestDb {
  sql: Db;
  pg: PGlite;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL('../fixtures/schema.sql', import.meta.url), 'utf8'));
  return { sql: makeSql(pg, pg), pg };
}
