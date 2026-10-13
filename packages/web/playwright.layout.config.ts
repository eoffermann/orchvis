import { defineConfig, devices } from '@playwright/test';

/**
 * Layout and performance check at the plan's P4 scale: 30 simulated sessions
 * on a 1920 × 1080 display, against the simulator's mock `/ws/ui` feed.
 * Launches a browser, so on the shared build machine it needs the machine
 * coordinator's approval first:
 *
 *   pnpm --filter @orchvis/web exec playwright test -c playwright.layout.config.ts
 *
 * Ports: the mock feed on 7813 and Vite on 5200, clear of the overlay
 * suite's 7812/5199. Never 7801. Builds the app into
 * node_modules/.cache/layout-dist and serves it with `vite preview`; the
 * performance trace lands beside the test's results as layout-trace.json.
 */
const MOCK_PORT = 7813;
const WEB_PORT = 5200;
const BUILD_DIR = 'node_modules/.cache/layout-dist';

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'layout.check.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1920, height: 1080 },
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
  },
  webServer: [
    {
      command: `pnpm --filter @orchvis/simulator sim -- --mock-ui --port ${MOCK_PORT} --sessions 30 --rate 4 --media-rate 0.3`,
      url: `http://127.0.0.1:${MOCK_PORT}/healthz`,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The production build, as the broker serves it: dev-mode React costs a
      // quarter of the frame budget and would hide what the Owner sees.
      command: `pnpm exec vite build --outDir ${BUILD_DIR} --emptyOutDir && pnpm exec vite preview --outDir ${BUILD_DIR} --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { ORCHVIS_BROKER: `http://127.0.0.1:${MOCK_PORT}` },
    },
  ],
});
