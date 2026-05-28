import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const backendUrl = process.env.VITE_BACKEND_URL ?? 'http://localhost:7330';
const backendWsUrl = backendUrl.replace(/^http/, 'ws');
const localAccessToken = process.env.OPENDEEPSEA_LOCAL_TOKEN?.trim();

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backendUrl,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (!localAccessToken) return;
            const path = req.url ?? '';
            if (/^\/api\/projects\/[^/]+\/workspace\/.+/.test(path) || path.startsWith('/api/platform-skills')) {
              proxyReq.setHeader('X-OpenDeepSea-Local-Token', localAccessToken);
            }
          });
        },
      },
      '/uploads': backendUrl,
      '/ws': { target: backendWsUrl, ws: true },
    },
  },
});
