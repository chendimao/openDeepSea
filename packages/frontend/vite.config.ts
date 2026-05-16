import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const backendUrl = process.env.VITE_BACKEND_URL ?? 'http://localhost:7330';
const backendWsUrl = backendUrl.replace(/^http/, 'ws');

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
      '/api': backendUrl,
      '/uploads': backendUrl,
      '/ws': { target: backendWsUrl, ws: true },
    },
  },
});
