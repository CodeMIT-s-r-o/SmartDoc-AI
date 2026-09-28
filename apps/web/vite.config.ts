/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Same-origin API in every environment: Vite proxies /api locally, CloudFront routes /api/* in prod.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiProxyTarget, changeOrigin: false },
    },
  },
  test: {
    env: {
      VITE_OIDC_AUTHORITY: 'https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TestPool1',
      VITE_OIDC_CLIENT_ID: 'test-web-client',
      VITE_OIDC_REDIRECT_URI: 'http://localhost:5173/auth/callback',
      VITE_COGNITO_DOMAIN: 'https://smartdoc-test.auth.eu-central-1.amazoncognito.com',
    },
  },
});
