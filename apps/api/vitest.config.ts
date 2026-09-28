import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits the decorator metadata that Nest's dependency injection relies on.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      AI_URL: 'http://ai.test:8000',
      INTERNAL_TOKEN: 'test-internal-token-0123456789',
      APP_VERSION: 'test',
      // Mirrored in test/support/tokens.ts.
      COGNITO_USER_POOL_ID: 'eu-central-1_TestPool1',
      COGNITO_CLIENT_ID: 'test-web-client',
      COGNITO_DOMAIN: 'https://smartdoc-test.auth.eu-central-1.amazoncognito.com',
      THROTTLE_LIMIT_PER_MINUTE: '5',
    },
  },
});
