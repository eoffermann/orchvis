// Bundles the shim (@orchvis/shim, esbuild) and copies dist/shim.cjs to
// plugin/bin/shim.cjs, the path plugin/.mcp.json runs.
//
//   node scripts/build-plugin.mjs           build and copy
//   node scripts/build-plugin.mjs --check   build, then fail if plugin/bin/shim.cjs differs
//
// Skips with a message (exit 0) when packages/shim is not in this checkout.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, fail, isMain, log, runPnpm } from './lib/project.mjs';

/** The shim bundle as the shim package builds it. */
export const SHIM_DIST = join(REPO_ROOT, 'packages', 'shim', 'dist', 'shim.cjs');
/** The shim bundle as the plugin ships it. */
export const PLUGIN_SHIM = join(REPO_ROOT, 'plugin', 'bin', 'shim.cjs');

/** Whether two files exist and have identical bytes. */
export function sameBytes(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/** Runs the build; returns a process exit code. */
export function main(argv = process.argv.slice(2)) {
  if (!existsSync(join(REPO_ROOT, 'packages', 'shim', 'package.json'))) {
    log('plugin: packages/shim is not in this checkout yet; skipping the shim bundle.');
    return 0;
  }
  log('plugin: bundling the shim with esbuild (a few seconds)...');
  const t0 = Date.now();
  const r = runPnpm(['--filter', '@orchvis/shim', 'build']);
  if (r.status !== 0) {
    fail(`shim build failed (exit ${r.status ?? r.signal ?? r.error?.message}).`);
    return 1;
  }
  log(`plugin: shim bundled in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  if (argv.includes('--check')) {
    if (sameBytes(SHIM_DIST, PLUGIN_SHIM)) {
      log('plugin: plugin/bin/shim.cjs matches a fresh build.');
      return 0;
    }
    fail('plugin/bin/shim.cjs is missing or stale. Run `pnpm build:plugin` and commit plugin/bin/shim.cjs.');
    return 1;
  }
  mkdirSync(dirname(PLUGIN_SHIM), { recursive: true });
  copyFileSync(SHIM_DIST, PLUGIN_SHIM);
  log('plugin: copied to plugin/bin/shim.cjs.');
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
