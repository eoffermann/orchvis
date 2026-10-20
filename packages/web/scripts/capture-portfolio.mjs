// Captures portfolio media from the `?fake=showcase` scenario with one
// headless Chromium (GPU off): a 1920x1080 still of the graph and a
// 1600x1000 MP4 clip of it under live traffic. Start the dev server first:
//
//   pnpm --filter @orchvis/web exec vite --port 5287 --strictPort --host 127.0.0.1
//   node packages/web/scripts/capture-portfolio.mjs --out <dir> [--url http://127.0.0.1:5287] [--seconds 12]
//
// Playwright records WebM; ffmpeg (on PATH) converts it to H.264 MP4. It checks
// free RAM before launching and stops under 15 GB.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkRam, log, lowestFreeGb } from './lib/guard.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = opt('--url', 'http://127.0.0.1:5287');
const OUT = resolve(opt('--out', '.'));
const SECONDS = Number(opt('--seconds', '12'));
const STILL = { width: 1920, height: 1080 };
const CLIP = { width: 1600, height: 1000 };
mkdirSync(OUT, { recursive: true });

const kb = (path) => `${Math.round(statSync(path).size / 1024)} KB`;

/** Opens the showcase graph and waits for the layout to settle. */
async function openGraph(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`page error: ${e.message}`));
  log(`opening ${BASE}/?fake=showcase`);
  await page.goto(`${BASE}/?fake=showcase`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.node');
  log('graph is up; letting the layout settle (about 10 s)');
  await page.waitForTimeout(10_000);
  return page;
}

checkRam('before launching Chromium');
log('loading Playwright');
const { chromium } = await import('@playwright/test');
log('launching headless Chromium (one instance, GPU off)');
const browser = await chromium.launch({ args: ['--disable-gpu'] });
try {
  const still = await browser.newContext({ viewport: STILL, deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await openGraph(still);
  const pngPath = join(OUT, 'orchvis-graph-1920x1080.png');
  await page.screenshot({ path: pngPath });
  log(`wrote ${pngPath} (${kb(pngPath)})`);
  await still.close();

  checkRam('before the clip');
  const videoDir = join(OUT, 'video-tmp');
  rmSync(videoDir, { recursive: true, force: true });
  const clip = await browser.newContext({
    viewport: CLIP,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    recordVideo: { dir: videoDir, size: CLIP },
  });
  const started = Date.now();
  const clipPage = await openGraph(clip);
  // The settle time is recorded too; the conversion trims it off.
  const trimSeconds = (Date.now() - started) / 1000;
  log(`recording ${SECONDS} s of live traffic`);
  await clipPage.waitForTimeout(SECONDS * 1000);
  await clip.close();
  const webm = join(videoDir, readdirSync(videoDir).find((f) => f.endsWith('.webm')));
  log(`recorded ${webm} (${kb(webm)}); converting to MP4, skipping the first ${trimSeconds.toFixed(1)} s`);
  const mp4Path = join(OUT, 'orchvis-graph-1600x1000.mp4');
  const tmpMp4 = `${mp4Path}.tmp.mp4`;
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-ss', trimSeconds.toFixed(2), '-i', webm, '-t', String(SECONDS),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-movflags', '+faststart', '-an', tmpMp4,
  ], { stdio: 'inherit' });
  renameSync(tmpMp4, mp4Path);
  rmSync(videoDir, { recursive: true, force: true });
  log(`wrote ${mp4Path} (${kb(mp4Path)})`);
} finally {
  await browser.close();
  log(`Chromium closed. Lowest free RAM seen: ${lowestFreeGb} GB`);
}
