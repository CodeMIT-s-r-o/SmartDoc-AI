import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  strict: true,
  verbose: true,
  // Only needed by `drizzle-kit studio`/`check` against a live DB; `generate` works offline.
  dbCredentials: { url: process.env.MIGRATE_DATABASE_URL ?? '' },
});
