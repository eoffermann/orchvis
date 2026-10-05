/**
 * Wire protocol version. Carried as `v` in every frame envelope and checked on
 * both ends. Any change to `packages/protocol` after the `protocol-v1` tag bumps
 * this and updates broker, shim and web app in the same change.
 */
export const PROTOCOL_VERSION = 1 as const;

/** Type of {@link PROTOCOL_VERSION}. */
export type ProtocolVersion = typeof PROTOCOL_VERSION;
