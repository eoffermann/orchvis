import { isMainThread } from 'node:worker_threads';

// Guards the `pool: 'threads'` setting in vitest.shared.ts where it matters: in
// the test worker itself. A package whose config does not spread `sharedTest`
// runs in a forked process, and fails here instead of crashing intermittently.
if (isMainThread) {
  throw new Error("tests are not running in a worker thread: spread sharedTest from vitest.shared.ts into this package's vitest.config.ts");
}
