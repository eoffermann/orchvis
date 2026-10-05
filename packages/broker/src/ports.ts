import { createServer } from 'node:net';

/**
 * Resolves when `port` on `host` can be bound, and rejects with the bind
 * error (`EADDRINUSE` when taken) otherwise. The probe socket is closed before
 * resolving.
 */
export function checkPortFree(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve()));
  });
}
