/**
 * Manual helper, not a test: starts the in-test fake broker on an ephemeral
 * port and prints its URL, for rehearsing `orchvis-sim --broker` without the
 * real broker. Run with `pnpm --filter @orchvis/simulator exec tsx test/run-fake-broker.ts`.
 */
import { startFakeBroker } from './fake-broker.js';

const broker = await startFakeBroker();
process.stdout.write(`fake broker at ${broker.url} token ${broker.token}\n`);
setInterval(() => {
  process.stdout.write(`fake broker: ${broker.frames.length} frames, ${broker.invalid.length} invalid, ${broker.connections()} connections\n`);
}, 5000);
