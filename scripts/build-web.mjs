// Builds the web app (@orchvis/web, `vite build`) and copies its dist/ into
// packages/broker/public, which the broker serves at `/`.
//
//   node scripts/build-web.mjs              build and copy
//   node scripts/build-web.mjs --if-stale   only when the web sources are newer than the copy
//
// Skips with a message (exit 0) when packages/web is not in this checkout.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, fail, isMain, log, runPnpm } from './lib/project.mjs';

/** Where the web package lives. */
export const WEB_DIR = join(REPO_ROOT, 'packages', 'web');
/** Where the broker serves static files from. */
export const PUBLIC_DIR = join(REPO_ROOT, 'packages', 'broker', 'public');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'coverage', '.vite', 'playwright-report', 'test-results']);

/** Newest modification time (ms) of any file under `path`, skipping build output and tests. 0 if absent. */
export function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

/**
 * Whether the copy in `publicDir` is missing or older than the sources it is
 * built from: the web package and the protocol package it imports.
 */
export function isStale(webDir = WEB_DIR, publicDir = PUBLIC_DIR, protocolDir = join(REPO_ROOT, 'packages', 'protocol')) {
  const index = join(publicDir, 'index.html');
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  return Math.max(newestMtime(webDir), newestMtime(join(protocolDir, 'src'))) > built;
}

/** Replaces `to` with a copy of `from`. */
export function copyBuild(from, to) {
  if (!existsSync(join(from, 'index.html'))) throw new Error(`${from} has no index.html; did the web build fail?`);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

/** Runs the build; returns a process exit code. */
export function main(argv = process.argv.slice(2)) {
  if (!existsSync(join(WEB_DIR, 'package.json'))) {
    log('web app: packages/web is not in this checkout yet; skipping the web build. The broker serves its placeholder page at /.');
    return 0;
  }
  if (argv.includes('--if-stale') && !isStale()) {
    log('web app: packages/broker/public is up to date; skipping the build.');
    return 0;
  }
  log('web app: building @orchvis/web with vite (usually 10-30 s)...');
  const t0 = Date.now();
  const r = runPnpm(['--filter', '@orchvis/web', 'build']);
  if (r.status !== 0) {
    fail(`web build failed (exit ${r.status ?? r.signal ?? r.error?.message}).`);
    return 1;
  }
  log(`web app: built in ${((Date.now() - t0) / 1000).toFixed(1)} s; copying dist to packages/broker/public...`);
  try {
    copyBuild(join(WEB_DIR, 'dist'), PUBLIC_DIR);
  } catch (err) {
    fail(`could not copy the web build: ${err.message}`);
    return 1;
  }
  log('web app: ready in packages/broker/public.');
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
