import { defineConfig } from 'vitest/config';

// PGlite boots a WASM Postgres (~1.7 s) once per test file in beforeAll; give
// hooks room and keep per-test timeouts generous for slower CI.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
