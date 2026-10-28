/**
 * The single import point for database plumbing. Switch to `export { createDb, listen } from
 * '@hood/db'` once packages/db exports them with these signatures.
 */
export { createDb, listen, type Sql } from './stubs/db.js';
