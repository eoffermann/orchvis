import { expect, test } from '@playwright/test';
import { nodeFootprint } from '../src/graph/footprint';
import { hullLabelHalfSize } from '../src/graph/hull';

/*
 * P4 layout check (playwright.layout.config.ts): 30 simulated sessions at
 * 1920 × 1080. Measures the rendered labels, not the layout's estimate of
 * them, and the frame rate, and records a Chromium performance trace.
 */

interface DrawnNode {
  name: string;
  host: string;
  /** Screen box of circle, name and host together. */
  box: { left: number; top: number; right: number; bottom: number };
  /** Rendered width of the name and host labels, in layout px. */
  nameWidth: number;
  hostWidth: number;
}

async function drawnNodes(page: import('@playwright/test').Page): Promise<DrawnNode[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<SVGGElement>('g.node')].map((g) => {
      const parts = ['.node-body', '.node-name', '.node-host'].map((s) => g.querySelector<SVGGraphicsElement>(s)!);
      const rects = parts.map((p) => p.getBoundingClientRect());
      const name = parts[1]!;
      const host = parts[2]!;
      return {
        name: name.textContent ?? '',
        host: host.textContent ?? '',
        box: {
          left: Math.min(...rects.map((r) => r.left)),
          top: Math.min(...rects.map((r) => r.top)),
          right: Math.max(...rects.map((r) => r.right)),
          bottom: Math.max(...rects.map((r) => r.bottom)),
        },
        nameWidth: name.getBBox().width,
        hostWidth: host.getBBox().width,
      };
    }),
  );
}

interface DrawnRepoLabel {
  name: string;
  box: DrawnNode['box'];
  /** Rendered text width, in layout px. */
  width: number;
}

async function drawnRepoLabels(page: import('@playwright/test').Page): Promise<DrawnRepoLabel[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<SVGTextElement>('text.hull-label:not(.hull--filtered)')].map((t) => {
      const r = t.getBoundingClientRect();
      return { name: t.textContent ?? '', box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, width: t.getBBox().width };
    }),
  );
}

function overlaps(items: { name: string; box: DrawnNode['box'] }[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!.box;
      const b = items[j]!.box;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) out.push(`${items[i]!.name} / ${items[j]!.name} (${ox.toFixed(0)}×${oy.toFixed(0)} px)`);
    }
  }
  return out;
}

/**
 * What each thread's media icons draw (badges and counts), and what they
 * must stay clear of: each node's circle, name and host line on their own,
 * and each repo label.
 */
async function drawnMediaScene(page: import('@playwright/test').Page): Promise<{
  icons: { name: string; box: DrawnNode['box'] }[];
  others: { name: string; box: DrawnNode['box'] }[];
}> {
  return page.evaluate(() => {
    const boxOf = (els: Element[]) => {
      const rects = els.map((e) => e.getBoundingClientRect());
      return {
        left: Math.min(...rects.map((r) => r.left)),
        top: Math.min(...rects.map((r) => r.top)),
        right: Math.max(...rects.map((r) => r.right)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      };
    };
    const icons = [...document.querySelectorAll<SVGGElement>('g.edge-media')].map((g, i) => ({
      name: `media icons ${i + 1}`,
      box: boxOf([...g.querySelectorAll('.media-badge, .media-count')]),
    }));
    const others = [...document.querySelectorAll<SVGGElement>('g.node')].flatMap((g) => {
      const name = g.querySelector('.node-name')?.textContent ?? '';
      return ['.node-body', '.node-name', '.node-host'].map((s) => ({ name, box: boxOf([g.querySelector(s)!]) }));
    });
    for (const t of document.querySelectorAll<SVGTextElement>('text.hull-label:not(.hull--filtered)')) {
      others.push({ name: t.textContent ?? '', box: boxOf([t]) });
    }
    return { icons, others };
  });
}

/** Threads whose media icons cover a node's drawing, a repo label or another thread's icons. */
async function mediaOverlaps(page: import('@playwright/test').Page): Promise<{ threads: number; covered: string[] }> {
  const { icons, others } = await drawnMediaScene(page);
  const covered: string[] = [];
  icons.forEach((icon, i) => {
    const hits = overlaps([icon, ...others, ...icons.filter((_, j) => j !== i)]).filter((s) => s.startsWith(`${icon.name} /`));
    if (hits.length) covered.push(hits.join('; '));
  });
  return { threads: icons.length, covered };
}

/** Node labels and repo labels together; repo labels draw on top, so any overlap hides text. */
async function allLabels(page: import('@playwright/test').Page): Promise<{ name: string; box: DrawnNode['box'] }[]> {
  return [...(await drawnNodes(page)), ...(await drawnRepoLabels(page))];
}

test('30 sessions: no node or repo label overlaps, few media icon overlaps, frame rate, trace recorded', async ({ page, browser }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Owner token').fill('mock');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /^Open chat with / })).toHaveCount(30, { timeout: 30_000 });

  // Let the first layout cool (about 5 s at 60 fps) and the auto-fit catch up.
  await page.waitForTimeout(10_000);

  // The layout's text estimate must cover the rendered text, or the
  // footprints it keeps apart are smaller than what is drawn.
  const first = await drawnNodes(page);
  let worstRatio = 0;
  let worstLabel = '';
  for (const n of first) {
    const est = nodeFootprint(n.name, n.host).halfWidth * 2 - 8;
    for (const [text, width] of [[n.name, n.nameWidth], [n.host, n.hostWidth]] as const) {
      if (width / est > worstRatio) {
        worstRatio = width / est;
        worstLabel = text;
      }
    }
  }
  for (const r of await drawnRepoLabels(page)) {
    const est = (hullLabelHalfSize(r.name).halfWidth - 2) * 2;
    if (r.width / est > worstRatio) {
      worstRatio = r.width / est;
      worstLabel = r.name;
    }
  }
  testInfo.annotations.push({ type: 'rendered/estimated label width, worst', description: `${worstRatio.toFixed(2)} (${worstLabel})` });

  // Overlaps at rest and through 10 s of live traffic, with the trace and
  // frame count taken over the same window.
  // LAYOUT_TRACE=0 measures without the tracer's own overhead.
  const tracing = process.env.LAYOUT_TRACE !== '0';
  if (tracing) await browser.startTracing(page, { path: testInfo.outputPath('layout-trace.json') });
  const frames = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let n = 0;
        const start = performance.now();
        const step = () => {
          n++;
          if (performance.now() - start < 10_000) requestAnimationFrame(step);
          else resolve(n / ((performance.now() - start) / 1000));
        };
        requestAnimationFrame(step);
      }),
  );
  const seen: string[] = [];
  let mediaThreads = 0;
  let mediaCovered: string[] = [];
  for (let i = 0; i < 5; i++) {
    seen.push(...overlaps(await allLabels(page)));
    const media = await mediaOverlaps(page);
    mediaThreads = Math.max(mediaThreads, media.threads);
    if (media.covered.length > mediaCovered.length) mediaCovered = media.covered;
    await page.waitForTimeout(2_000);
  }
  const fps = await frames;
  if (tracing) await browser.stopTracing();
  testInfo.annotations.push({ type: 'fps', description: fps.toFixed(1) });
  testInfo.annotations.push({ type: 'overlaps seen', description: String(seen.length) });
  console.log(`fps ${fps.toFixed(1)}, worst label width ratio ${worstRatio.toFixed(2)} (${worstLabel}), overlaps ${seen.length}`);
  for (const s of seen) console.log(`  overlap: ${s}`);
  testInfo.annotations.push({ type: 'media threads covered, worst sample', description: `${mediaCovered.length} of ${mediaThreads}` });
  console.log(`media icons: ${mediaCovered.length} of ${mediaThreads} threads covered at worst`);
  for (const s of mediaCovered) console.log(`  media overlap: ${s}`);
  if (seen.length || mediaCovered.length) await page.screenshot({ path: testInfo.outputPath('overlaps.png') });

  expect(worstRatio, 'rendered label wider than the layout estimate').toBeLessThanOrEqual(1);
  expect(seen).toEqual([]);
  expect(mediaThreads, 'the simulator sends media, so some threads carry icons').toBeGreaterThan(0);
  // The layout quality harness gates the same: dense patches can leave no clear spot near an edge.
  expect(mediaCovered.length).toBeLessThanOrEqual(Math.ceil(mediaThreads * 0.2));
  // Headless Chromium renders in software here (no GPU on the shared build
  // machine), and back-to-back runs vary from 47 to 56 fps, so this floor
  // catches gross regressions only. The plan's 60 fps gate needs a real
  // display with a GPU.
  expect(fps).toBeGreaterThanOrEqual(40);
});
