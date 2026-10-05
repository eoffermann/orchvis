/**
 * `@orchvis/shim`: the stdio MCP server that bridges one Claude Code session to
 * the orchvis broker. The runnable artifact is the bundle `dist/shim.cjs`; this
 * module exports the pieces for tests and for other packages' tooling.
 *
 * @packageDocumentation
 */
export * from './app.js';
export * from './broker.js';
export * from './channel.js';
export * from './config.js';
export * from './identity.js';
export * from './inbox.js';
export * from './log.js';
export * from './media.js';
export * from './tools.js';
export * from './version.js';
