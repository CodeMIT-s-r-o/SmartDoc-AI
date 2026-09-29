import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Repository tests against a real, migrated Postgres (make test-db), as the app role. */
export default defineConfig({
  // Tests use the contract's source directly, so they never depend on a stale build.
  resolve: {
    alias: {
      '@smartdoc/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/db/**/*.db-spec.ts'],
    // One database: run files sequentially so tests never observe each other's rows.
    fileParallelism: false,
    // The full app runs in the chat tests: same auth setup as vitest.config.ts, real database,
    // and the fake AI service from test/support/fake-ai-server.ts.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      AI_URL: 'http://127.0.0.1:18765',
      INTERNAL_TOKEN: 'test-internal-token-0123456789',
      APP_VERSION: 'test',
      COGNITO_USER_POOL_ID: 'eu-central-1_TestPool1',
      COGNITO_CLIENT_ID: 'test-web-client',
      COGNITO_DOMAIN: 'https://smartdoc-test.auth.eu-central-1.amazoncognito.com',
      THROTTLE_LIMIT_PER_MINUTE: '1000',
      AWS_REGION: 'eu-central-1',
      S3_DOCS_BUCKET: 'smartdoc-test-docs',
    },
  },
});
