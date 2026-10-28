import { defineConfig } from 'vitest/config';

// Several suites boot an in-memory PGlite (WASM Postgres); give them room and cap parallelism.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**', 'node_modules/**'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    maxWorkers: 4,
  },
});
