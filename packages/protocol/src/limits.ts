import { z } from 'zod';

/** Default TCP port the broker listens on for HTTP and WebSocket. */
export const DEFAULT_BROKER_PORT = 7801;

/** Interval at which the broker sweeps the media store for expired files. */
export const MEDIA_SWEEP_INTERVAL_MS = 30_000;

/**
 * Operational limits. They live in `orchvis.config.json` beside the broker, can
 * be overridden by environment variables, and are sent to every shim in
 * `welcome` and to every web app in `snapshot`.
 */
export const LimitsSchema = z.object({
  /** Maximum message body size, in UTF-8 bytes. */
  maxBodyBytes: z.number().int().positive(),
  /** Maximum media caption size, in UTF-8 bytes. */
  maxCaptionBytes: z.number().int().positive(),
  /** Messages kept per thread in the broker's ring buffer. */
  ringBufferPerThread: z.number().int().positive(),
  /** Maximum size of one media file, in bytes. */
  maxMediaBytes: z.number().int().positive(),
  /** Total media store size, in bytes. Oldest files are evicted first beyond it. */
  mediaStoreBytes: z.number().int().positive(),
  /** Lifetime of an uploaded media file, in milliseconds. */
  mediaTtlMs: z.number().int().positive(),
  /** Messages allowed per sender, per thread, per rolling minute. */
  sendRatePerMinute: z.number().int().positive(),
  /** Edge weight decay time constant τ, in milliseconds. */
  edgeTauMs: z.number().int().positive(),
  /** Interval between heartbeat pings, in milliseconds. */
  heartbeatIntervalMs: z.number().int().positive(),
  /** Silence after which a node is marked disconnected, in milliseconds. */
  disconnectAfterMs: z.number().int().positive(),
  /**
   * How long after disconnect the broker queues messages for a node and keeps
   * it in the registry, in milliseconds. After that, sends to it are rejected
   * with `recipient_gone` and the node is removed.
   */
  offlineRetentionMs: z.number().int().positive(),
  /** Time a shim waits for `confirm_channel` before falling back to poll mode. */
  channelProbeTimeoutMs: z.number().int().positive(),
});

/** Operational limits shared by broker, shim and web app. */
export type Limits = z.infer<typeof LimitsSchema>;

/** Default limits, as specified in the implementation plan. */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxBodyBytes: 16 * 1024,
  maxCaptionBytes: 2 * 1024,
  ringBufferPerThread: 500,
  maxMediaBytes: 200 * 1024 * 1024,
  mediaStoreBytes: 2 * 1024 * 1024 * 1024,
  mediaTtlMs: 45 * 60_000,
  sendRatePerMinute: 30,
  edgeTauMs: 10 * 60_000,
  heartbeatIntervalMs: 15_000,
  disconnectAfterMs: 45_000,
  offlineRetentionMs: 10 * 60_000,
  channelProbeTimeoutMs: 60_000,
});

/** Size of a string in UTF-8 bytes, for checking against byte limits. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
