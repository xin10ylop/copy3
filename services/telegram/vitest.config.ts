import { defineConfig } from 'vitest/config';

// store-pg.test.ts boots PGlite (WASM Postgres, ~2 s) once in beforeAll.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
