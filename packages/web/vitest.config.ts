import { defineConfig } from 'vitest/config';

/**
 * Unit tests run in Node by default. Component tests (`*.test.tsx`) opt into
 * jsdom with a `// @vitest-environment jsdom` comment at the top of the file.
 * Playwright specs live in `e2e/` and are not run by Vitest.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
