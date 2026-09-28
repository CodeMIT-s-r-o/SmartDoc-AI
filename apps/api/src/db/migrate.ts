/**
 * Applies pending migrations as the owner role. Run as a one-shot container before the apps start
 * (`compose run --rm migrate` in prod). A Postgres advisory lock serializes concurrent runners.
 * Self-contained on purpose: no relative imports, so it runs the same under tsx and compiled.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const LOCK_KEY = 'smartdoc-migrate';
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

async function main(): Promise<void> {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error('MIGRATE_DATABASE_URL is required (owner credentials)');
  }

  const client = new pg.Client({ connectionString: url, application_name: 'smartdoc-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log(`migrations applied from ${MIGRATIONS_FOLDER}`);
  } finally {
    // Session-level lock: released explicitly, and in any case when the connection closes.
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error);
  process.exit(1);
});
