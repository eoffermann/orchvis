import { expect, test } from '@playwright/test';
import { nodeFootprint } from '../src/graph/footprint';

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

function overlaps(nodes: DrawnNode[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!.box;
      const b = nodes[j]!.box;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) out.push(`${nodes[i]!.name} / ${nodes[j]!.name} (${ox.toFixed(0)}×${oy.toFixed(0)} px)`);
    }
  }
  return out;
}

test('30 sessions: no label overlaps, frame rate, trace recorded', async ({ page, browser }, testInfo) => {
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
  for (let i = 0; i < 5; i++) {
    seen.push(...overlaps(await drawnNodes(page)));
    await page.waitForTimeout(2_000);
  }
  const fps = await frames;
  if (tracing) await browser.stopTracing();
  testInfo.annotations.push({ type: 'fps', description: fps.toFixed(1) });
  testInfo.annotations.push({ type: 'overlaps seen', description: String(seen.length) });
  console.log(`fps ${fps.toFixed(1)}, worst label width ratio ${worstRatio.toFixed(2)} (${worstLabel}), overlaps ${seen.length}`);
  for (const s of seen) console.log(`  overlap: ${s}`);

  expect(worstRatio, 'rendered label wider than the layout estimate').toBeLessThanOrEqual(1);
  expect(seen).toEqual([]);
  // Headless Chromium renders in software here (no GPU on the shared build
  // machine), and back-to-back runs vary from 47 to 56 fps, so this floor
  // catches gross regressions only. The plan's 60 fps gate needs a real
  // display with a GPU.
  expect(fps).toBeGreaterThanOrEqual(40);
});
