import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the orchvis web app. The production build lands in
 * `dist/`; the broker copies it into its `public/` directory and serves it.
 *
 * In dev, `/api` and `/ws` are proxied so the app stays same-origin: the
 * Owner cookie is `SameSite=Strict` and the broker accepts `/ws/ui` only from
 * its own Origin. The target is `ORCHVIS_BROKER` when set (a real broker,
 * e.g. `http://127.0.0.1:17801`), otherwise the simulator's mock feed:
 *
 *   pnpm --filter @orchvis/simulator sim -- --mock-ui --port 7811   (Owner token "mock")
 *   pnpm --filter @orchvis/web dev
 */
const target = process.env.ORCHVIS_BROKER ?? 'http://127.0.0.1:7811';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': {
        target,
        ws: true,
        changeOrigin: true,
        // The browser sends the dev server's Origin; present the target's own
        // so a real broker's Origin check passes, as it would in production.
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.setHeader('origin', new URL(target).origin);
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
