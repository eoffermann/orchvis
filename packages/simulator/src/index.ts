/**
 * `@orchvis/simulator`: fake shims that speak the real wire protocol, a
 * seeded traffic generator, a mock `/ws/ui` feed for the web app, and a
 * client-side state mirror for snapshot-versus-delta checks.
 *
 * @packageDocumentation
 */
export * from './random.js';
export * from './clock.js';
export * from './ulid.js';
export * from './scenario.js';
export * from './text.js';
export * from './media.js';
export * from './traffic.js';
export * from './sim-shim.js';
export * from './fleet.js';
export * from './mock-world.js';
export * from './mock-ui-feed.js';
export * from './ui-mirror.js';
