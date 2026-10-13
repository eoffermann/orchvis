/*
 * Layout tuning report: runs the layout quality harness over fleet sizes and
 * seeds for one or more parameter variants, and prints one row per variant
 * and size. Headless; no browser, no ports.
 *
 *   pnpm --filter @orchvis/web exec tsx scripts/layout-report.ts
 *   ... --sizes 10,20,30 --seeds 1,2,3,4 --rate 2 --variant base= --variant wide=collideRadius:70,manyBodyStrength:-500
 */
import { makeScenario, runScenario, type RunResult } from '../test/layoutQuality';
import type { LayoutParams } from '../src/graph/layout';

const t0 = performance.now();
const log = (msg: string) => process.stdout.write(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}\n`);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const sizes = arg('sizes', '10,20,30').split(',').map(Number);
const seeds = arg('seeds', '1,2,3,4').split(',').map(Number);
const rate = Number(arg('rate', '2'));
const trafficMs = Number(arg('traffic', '120')) * 1000;

const variants: { name: string; params: Partial<LayoutParams> }[] = [];
process.argv.forEach((a, i) => {
  if (a !== '--variant') return;
  const spec = process.argv[i + 1] ?? '';
  const [name, rest = ''] = spec.split('=');
  const params: Record<string, number> = {};
  for (const kv of rest.split(',').filter(Boolean)) {
    const [k, v] = kv.split(':');
    params[k as string] = Number(v);
  }
  variants.push({ name: name || 'base', params: params as Partial<LayoutParams> });
});
if (variants.length === 0) variants.push({ name: 'base', params: {} });

log(`${variants.length} variant(s) × sizes ${sizes.join('/')} × ${seeds.length} seeds, ${rate} msg/s for ${trafficMs / 1000}s each`);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rows: string[] = [];
for (const v of variants) {
  for (const n of sizes) {
    const results: RunResult[] = [];
    for (const seed of seeds) {
      const started = performance.now();
      results.push(runScenario(makeScenario(n, seed), { seed, rate, trafficMs, params: v.params }));
      log(`  ${v.name} n=${n} seed=${seed} done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    }
    const f = (sel: (r: RunResult) => number, d = 1) => mean(results.map(sel)).toFixed(d);
    rows.push(
      [
        v.name.padEnd(14),
        String(n).padStart(3),
        f((r) => r.settled.labelOverlaps).padStart(7),
        f((r) => r.final.labelOverlaps).padStart(7),
        f((r) => r.worst.labelOverlaps).padStart(7),
        f((r) => r.final.nodesOverlapped).padStart(7),
        f((r) => r.final.intrusions).padStart(6),
        f((r) => r.worst.intrusions).padStart(6),
        f((r) => r.final.fitScale1080, 2).padStart(6),
        f((r) => r.final.proximity, 2).padStart(6),
        f((r) => r.meanSpeed).padStart(6),
        f((r) => r.p95Step).padStart(6),
        f((r) => r.settleFrames, 0).padStart(6),
        f((r) => r.stillFraction, 2).padStart(6),
      ].join(' '),
    );
  }
}
log('done');
console.log(
  ['variant'.padEnd(14), '  n', 'ovl@set', 'ovl@end', 'ovl^max', 'nodeOvl', 'intr', 'intr^', ' fit', ' prox', 'speed', 'p95/s', 'settle', 'still'].join(' '),
);
for (const r of rows) console.log(r);
