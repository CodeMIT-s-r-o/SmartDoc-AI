import { defineConfig } from 'vitest/config';

/** Repository tests against a real, migrated Postgres (make test-db), as the app role. */
export default defineConfig({
  test: {
    include: ['test/db/**/*.db-spec.ts'],
    // One database: run files sequentially so tests never observe each other's rows.
    fileParallelism: false,
  },
});
