/**
 * Applies pending migrations as the owner role. Run as a one-shot container before the apps start
 * (`compose run --rm migrate` in prod). A Postgres advisory lock serializes concurrent runners.
 * Self-contained on purpose: no relative imports, so it runs the same under tsx and compiled.
 *
 * MIGRATE_DATABASE_URL may list several databases separated by commas (dev: app + test).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const LOCK_KEY = 'smartdoc-migrate';
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

async function migrateDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: 'smartdoc-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log(`migrations applied to ${new URL(url).pathname.slice(1)}`);
  } finally {
    // Session-level lock: released explicitly, and in any case when the connection closes.
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}

async function main(): Promise<void> {
  const urls = (process.env.MIGRATE_DATABASE_URL ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    throw new Error('MIGRATE_DATABASE_URL is required (owner credentials)');
  }
  for (const url of urls) {
    await migrateDatabase(url);
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error);
  process.exit(1);
});
