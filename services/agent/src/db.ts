/**
 * Tagged-template SQL over any `query(text, params)` driver.
 *
 * `@hood/db` exposes a minimal `Sql` ({ query, begin, end, ... }) that runs on both
 * postgres.js and PGlite. The agent writes its queries as postgres.js-style tagged
 * templates (values become $n parameters, nested `sql\`...\`` fragments are inlined),
 * and this module turns those templates into `query(text, params)` calls.
 */
export type Row = Record<string, unknown>;

/** What we need from a driver: `@hood/db`'s Sql satisfies this. */
export interface Queryable {
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  begin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** A SQL fragment: inlined when nested in another template, executed when awaited. */
export class Fragment<T = Row[]> implements PromiseLike<T> {
  constructor(
    private readonly runner: Queryable,
    private readonly strings: readonly string[],
    private readonly values: readonly unknown[],
  ) {}

  /** Appends this fragment's parameters to `params` and returns its text with $n placeholders. */
  build(params: unknown[]): string {
    let text = this.strings[0] ?? '';
    this.values.forEach((v, i) => {
      if (v instanceof Fragment) {
        text += v.build(params);
      } else {
        params.push(v === undefined ? null : v);
        text += `$${params.length}`;
      }
      text += this.strings[i + 1] ?? '';
    });
    return text;
  }

  then<A = T, B = never>(onOk?: ((v: T) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    const params: unknown[] = [];
    const text = this.build(params);
    return this.runner.query(text, params).then((rows) => rows as unknown as T).then(onOk, onErr);
  }
}

export interface Db {
  <T = Row[]>(strings: TemplateStringsArray, ...values: readonly unknown[]): Fragment<T>;
  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  readonly raw: Queryable;
}

/** Wraps a driver (e.g. `createDb(url)` from @hood/db) for the agent's queries. */
export function tagged(q: Queryable): Db {
  const tag = <T = Row[]>(strings: TemplateStringsArray, ...values: readonly unknown[]): Fragment<T> => new Fragment<T>(q, strings, values);
  return Object.assign(tag, {
    begin: <T>(fn: (tx: Db) => Promise<T>): Promise<T> => q.begin((tx) => fn(tagged(tx))),
    end: (): Promise<void> => q.end(),
    raw: q,
  });
}
