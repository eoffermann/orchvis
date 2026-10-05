import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    ...sharedTest,
    // Builds dist/shim.cjs once, so integration tests drive the real bundle.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
