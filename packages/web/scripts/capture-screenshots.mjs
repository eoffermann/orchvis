// Captures the README screenshots from the `?fake=showcase` scenario with one
// headless Chromium (GPU off). Start the dev server first, on a high port:
//
//   pnpm --filter @orchvis/web exec vite --port 5287 --strictPort --host 127.0.0.1
//   node packages/web/scripts/capture-screenshots.mjs [--url http://127.0.0.1:5287] [--out docs/images] [--only hero-graph,node-chat]
//
// Shots: hero-graph, node-chat, thread-cross-repo, media-browser, and (only
// when named in --only) lightbox. It checks free RAM before launching and
// between shots, and stops under 15 GB.
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRam, log, lowestFreeGb } from './lib/guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = opt('--url', 'http://127.0.0.1:5287');
const OUT = resolve(opt('--out', join(here, '..', '..', '..', 'docs', 'images')));
const ONLY = opt('--only', '');
mkdirSync(OUT, { recursive: true });

const want = (name) => (ONLY ? ONLY.split(',').includes(name) : name !== 'lightbox');

/** Viewport per shot: wide for the graph, tighter for overlays so they fill the frame. */
const VIEWPORTS = {
  'hero-graph': { width: 1600, height: 1080 },
  'node-chat': { width: 1600, height: 1000 },
  'thread-cross-repo': { width: 1440, height: 1000 },
  lightbox: { width: 1440, height: 900 },
  'media-browser': { width: 1280, height: 700 },
};

async function viewport(page, name) {
  await page.setViewportSize(VIEWPORTS[name]);
  await page.waitForTimeout(1200);
}

async function shot(page, name, { ramChecked = false } = {}) {
  if (!ramChecked) checkRam(`before ${name}`);
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  log(`wrote ${path} (${Math.round(statSync(path).size / 1024)} KB)`);
}

/** Activates a moving SVG button from the keyboard; the live layout never holds still for a click. */
async function activate(locator) {
  await locator.focus();
  await locator.press('Enter');
}

async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** Waits (up to `ms`) for a frame with at least `n` pulses in flight. */
async function waitForPulses(page, n, ms) {
  const deadline = Date.now() + ms;
  let best = 0;
  while (Date.now() < deadline) {
    const count = await page.locator('.pulse[visibility="visible"]').count();
    best = Math.max(best, count);
    if (count >= n) return count;
    await page.waitForTimeout(40);
  }
  return best;
}

checkRam('before launching Chromium');
log('loading Playwright');
const { chromium } = await import('@playwright/test');
log('launching headless Chromium (one instance, GPU off)');
const browser = await chromium.launch({ args: ['--disable-gpu'] });
try {
  const page = await browser.newPage({ viewport: VIEWPORTS['hero-graph'], deviceScaleFactor: 1, colorScheme: 'dark' });
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  log(`opening ${BASE}/?fake=showcase`);
  await page.goto(`${BASE}/?fake=showcase`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.node');
  log('graph is up; letting the layout settle (about 10 s)');
  await page.waitForTimeout(10_000);

  if (want('hero-graph')) {
    // The RAM check takes about a second, so do it before catching the pulses.
    checkRam('before hero-graph');
    log('waiting for a frame with several pulses in flight (up to 15 s)');
    const pulses = await waitForPulses(page, 5, 15_000);
    log(`pulses in flight: ${pulses}`);
    await shot(page, 'hero-graph', { ramChecked: true });
  }

  if (want('node-chat') || want('thread-cross-repo') || want('lightbox')) {
    await viewport(page, 'node-chat');
    log('opening the node chat with WEB-CHECKOUT');
    await activate(page.locator('[aria-label="Open chat with WEB-CHECKOUT on atlas-win"]'));
    await page.waitForSelector('.overlay--chat');
    await page.waitForTimeout(1500);
    if (want('node-chat')) await shot(page, 'node-chat');

    log('opening the WEB-CHECKOUT / PAY-SCHEMA thread from the side list');
    await page.locator('.chat-side .side-item', { hasText: 'PAY-SCHEMA' }).click();
    await page.waitForSelector('.overlay--thread');
    await viewport(page, 'thread-cross-repo');
    // From the top: the expired attachment's tombstone, then the first thumbnails.
    await page.locator('.overlay--thread .msg-list').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(800);
    if (want('thread-cross-repo')) await shot(page, 'thread-cross-repo');

    if (want('lightbox')) {
      await viewport(page, 'lightbox');
      log('enlarging the first image');
      await page.locator('.overlay--thread .thumb-button').first().click();
      await page.waitForSelector('.overlay--viewer');
      await page.waitForTimeout(800);
      await shot(page, 'lightbox');
    }
    await closeOverlays(page);
  }

  if (want('media-browser')) {
    await viewport(page, 'media-browser');
    log('opening the media browser for the 3 images on WEB-CHECKOUT / PAY-SCHEMA');
    await activate(page.locator('[aria-label="Browse 3 images"]').first());
    await page.waitForSelector('.overlay--media');
    await page.waitForTimeout(1500);
    await shot(page, 'media-browser');
    await closeOverlays(page);
  }
} finally {
  await browser.close();
  log(`Chromium closed. Lowest free RAM seen: ${lowestFreeGb} GB`);
}
