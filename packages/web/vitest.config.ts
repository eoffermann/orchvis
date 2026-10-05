import { defineConfig } from 'vitest/config';

/** Unit tests are pure-function and reducer tests; they need no DOM. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
