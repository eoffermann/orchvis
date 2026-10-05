// Bundles the shim into one CommonJS file, dist/shim.cjs, runnable as
// `node dist/shim.cjs` with no node_modules beside it.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Builds the bundle; returns its path and size. */
export async function buildShim({ outfile = join(root, 'dist', 'shim.cjs'), quiet = false } = {}) {
  const started = Date.now();
  if (!quiet) console.log(`[build] bundling shim to ${outfile} ...`);
  await build({
    entryPoints: [join(root, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // ws loads these native accelerators optionally; they are not needed.
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  const bytes = statSync(outfile).size;
  if (!quiet) console.log(`[build] done in ${Date.now() - started} ms, ${(bytes / 1024).toFixed(0)} KiB`);
  return { outfile, bytes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildShim();
}
