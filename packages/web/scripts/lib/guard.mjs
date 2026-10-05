// Shared helpers for the showcase scripts: flushed, timestamped progress
// lines, and a free-RAM guard for the shared build machine.
import { execFileSync } from 'node:child_process';

const T0 = Date.now();

/** Prints one progress line with seconds since start. stdout is flushed per line. */
export function log(msg) {
  process.stdout.write(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${msg}\n`);
}

/** Free physical RAM in GB on Windows, or null where it cannot be measured. */
export function freeRamGb() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Minimum free RAM, in GB, below which the scripts stop. */
export const MIN_FREE_GB = 15;

/** Lowest free-RAM reading seen so far. */
export let lowestFreeGb = Infinity;

/**
 * Logs free RAM and throws if it is under {@link MIN_FREE_GB}, so the
 * caller can close the browser and stop.
 */
export function checkRam(where) {
  const gb = freeRamGb();
  if (gb === null) {
    log(`free RAM (${where}): unknown on this platform`);
    return;
  }
  lowestFreeGb = Math.min(lowestFreeGb, gb);
  log(`free RAM (${where}): ${gb} GB`);
  if (gb < MIN_FREE_GB) throw new Error(`free RAM ${gb} GB is under ${MIN_FREE_GB} GB; stopping`);
}
