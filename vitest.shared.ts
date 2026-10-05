import { fileURLToPath } from 'node:url';
import type { ViteUserConfig } from 'vitest/config';

/**
 * Test settings every package's `vitest.config.ts` spreads into its `test`
 * block, so they live in one place.
 *
 * `pool: 'threads'`: on Windows the default `forks` pool lost a worker
 * process roughly once in ten runs (exit 0xC0000409, a Node abort with no
 * message) while other suites ran on the machine. Threads ran 40 times
 * clean under the same load. `vitest.setup.ts` fails any run that is not in a
 * worker thread.
 */
export const sharedTest = {
  pool: 'threads',
  setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
} satisfies NonNullable<ViteUserConfig['test']>;
