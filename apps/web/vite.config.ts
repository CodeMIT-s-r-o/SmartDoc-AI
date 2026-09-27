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
});
