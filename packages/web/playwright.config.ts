import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright suite for the web app, run against the simulator's mock
 * `/ws/ui` feed through the Vite dev server's same-origin proxy. Running it
 * launches a browser, which on the shared build machine needs the machine
 * coordinator's approval first:
 *
 *   pnpm --filter @orchvis/web exec playwright test
 *
 * Ports: the mock feed on 7812 and Vite on 5199, so a developer's own
 * `--mock-ui --port 7811` and `vite` keep running alongside. Never 7801.
 */
const MOCK_PORT = 7812;
const WEB_PORT = 5199;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'touch', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: `pnpm --filter @orchvis/simulator sim -- --mock-ui --port ${MOCK_PORT} --sessions 12 --rate 4 --media-rate 0.3 --media-ttl 120`,
      url: `http://127.0.0.1:${MOCK_PORT}/healthz`,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { ORCHVIS_BROKER: `http://127.0.0.1:${MOCK_PORT}` },
    },
  ],
});
