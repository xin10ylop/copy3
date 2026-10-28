/**
 * STUB - stands in for `@hood/db`'s `createDb(url)` until packages/db lands
 * (owned by another build task). SPEC §2: `createDb(url)` returns `postgres.Sql`.
 * Replace by re-exporting from '@hood/db' in src/deps.ts.
 */
import postgres from 'postgres';

export function createDb(url: string): postgres.Sql {
  return postgres(url, { max: 4, idle_timeout: 30, connect_timeout: 10 });
}
