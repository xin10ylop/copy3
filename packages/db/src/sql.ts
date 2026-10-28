/**
 * Minimal SQL abstraction so the typed helpers run against both postgres.js
 * (production) and PGlite (tests) unchanged. Everything in helpers.ts is written
 * against this `Sql` interface; the two adapters below map it onto each driver.
 */
export interface Sql {
  /** Parameterised query ($1, $2, …) returning rows as plain objects. */
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run a raw multi-statement SQL blob (no params) — for migrations. */
  exec(text: string): Promise<void>;
  /** Run `fn` inside a transaction; the passed Sql is transaction-scoped. */
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** LISTEN on a channel; resolves to an unsubscribe function. */
  listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
  /** NOTIFY a channel with a text payload. */
  notify(channel: string, payload: string): Promise<void>;
  /** Close the underlying connection(s). */
  end(): Promise<void>;
}

export type Row = Record<string, unknown>;

/** postgres.js client surface we depend on (kept narrow for typing). */
export interface PostgresClient {
  unsafe(
    query: string,
    params?: readonly unknown[],
  ): Promise<readonly Row[]> & { simple(): Promise<readonly Row[]> };
  begin<T>(fn: (sql: PostgresClient) => Promise<T>): Promise<T>;
  listen(channel: string, onnotify: (payload: string) => void): Promise<{ unlisten: () => Promise<void> }>;
  notify(channel: string, payload: string): Promise<unknown>;
  end(opts?: { timeout?: number }): Promise<void>;
}

/** Wrap a postgres.js client as `Sql`. */
export function fromPostgres(client: PostgresClient): Sql {
  const wrap = (c: PostgresClient): Sql => ({
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = await c.unsafe(text, params as unknown[]);
      return rows as unknown as T[];
    },
    async exec(text: string): Promise<void> {
      // simple query protocol runs multiple statements (incl. plpgsql $$…$$)
      await c.unsafe(text).simple();
    },
    begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return c.begin((inner) => fn(wrap(inner)));
    },
    async listen(channel, cb) {
      const sub = await c.listen(channel, cb);
      return () => sub.unlisten();
    },
    async notify(channel, payload) {
      await c.notify(channel, payload);
    },
    async end() {
      await c.end({ timeout: 5 });
    },
  });
  return wrap(client);
}

/** PGlite client surface we depend on. */
export interface PgliteClient {
  query<T = Row>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(query: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteTx) => Promise<T>): Promise<T>;
  listen(channel: string, cb: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
export interface PgliteTx {
  query<T = Row>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Wrap a PGlite instance as `Sql`. PGlite is single-connection in-process, so
 * LISTEN/NOTIFY deliver within the same instance. Transactions use PGlite's own
 * `transaction()`; `notify` goes through `pg_notify` so triggers and manual
 * notifies share one path.
 */
export function fromPglite(db: PgliteClient): Sql {
  const txWrap = (tx: PgliteTx): Sql => ({
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await tx.query<T>(text, params as unknown[])).rows;
    },
    async exec(text: string): Promise<void> {
      await tx.query(text);
    },
    // nested transactions not supported inside PGlite tx — reuse the same scope
    begin<T>(fn: (s: Sql) => Promise<T>): Promise<T> {
      return fn(txWrap(tx));
    },
    async listen() {
      throw new Error('listen() is not available inside a transaction');
    },
    async notify(channel, payload) {
      await tx.query('SELECT pg_notify($1, $2)', [channel, payload]);
    },
    async end() {
      /* no-op inside tx */
    },
  });

  return {
    async query<T = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await db.query<T>(text, params as unknown[])).rows;
    },
    async exec(text: string): Promise<void> {
      await db.exec(text);
    },
    begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(txWrap(tx)));
    },
    async listen(channel, cb) {
      return db.listen(channel, cb);
    },
    async notify(channel, payload) {
      await db.query('SELECT pg_notify($1, $2)', [channel, payload]);
    },
    async end() {
      await db.close();
    },
  };
}
