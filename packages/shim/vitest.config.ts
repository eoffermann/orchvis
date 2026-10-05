import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Builds dist/shim.cjs once, so integration tests drive the real bundle.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
