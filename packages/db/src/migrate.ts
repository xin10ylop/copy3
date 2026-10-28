/**
 * Migration runner. Applies migrations/*.sql in filename order, recording each
 * in a `schema_migrations` table so re-runs are idempotent.
 *
 * CLI: `pnpm --filter @hood/db migrate` (uses DATABASE_URL).
 * Programmatic: `applyMigrations(sql, dir?)` — used by the PGlite test harness.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Sql } from './sql.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** default migrations dir: packages/db/migrations (src/ is one level under the package root). */
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

export interface Migration {
  name: string;
  sql: string;
}

/** Read and sort the .sql migrations from a directory. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/** Ensure the bookkeeping table exists. */
async function ensureTable(sql: Sql): Promise<void> {
  await sql.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );
}

/** Apply all pending migrations; returns the names applied this run. */
export async function applyMigrations(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await ensureTable(sql);
  const done = new Set(
    (await sql.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
  );
  const applied: string[] = [];
  for (const m of loadMigrations(dir)) {
    if (done.has(m.name)) continue;
    await sql.exec(m.sql);
    await sql.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
    applied.push(m.name);
  }
  return applied;
}

/** CLI entry: connect via DATABASE_URL, migrate, report, exit. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const { createDb } = await import('./index.js');
  const db = createDb(url);
  try {
    const applied = await applyMigrations(db);
    if (applied.length === 0) console.log('migrations: up to date');
    else console.log(`migrations applied: ${applied.join(', ')}`);
  } finally {
    await db.end();
  }
}

// run only when invoked directly (not when imported by the test harness)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
