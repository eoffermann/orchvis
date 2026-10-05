import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the orchvis web app. The production build lands in
 * `dist/`; the broker copies it into its `public/` directory and serves it.
 * In dev, `/api` and `/ws` are proxied to a broker given by
 * `ORCHVIS_BROKER` (for example `http://127.0.0.1:17801`), when set.
 */
const broker = process.env.ORCHVIS_BROKER;

export default defineConfig({
  plugins: [react()],
  server: broker
    ? {
        proxy: {
          '/api': { target: broker, changeOrigin: false },
          '/ws': { target: broker, ws: true, changeOrigin: false },
        },
      }
    : {},
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
