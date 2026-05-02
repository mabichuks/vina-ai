import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

const DAEMON_TARGET = 'http://127.0.0.1:7341';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(root, '../server/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: DAEMON_TARGET, changeOrigin: false },
      '/ws': { target: DAEMON_TARGET, changeOrigin: false, ws: true },
    },
  },
});
