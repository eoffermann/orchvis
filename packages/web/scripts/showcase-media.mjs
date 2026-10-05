// Renders the synthetic media for the `?fake=showcase` scenario: UI mockups
// and charts as PNG (headless Chromium), plus a short audio clip and video
// clip (ffmpeg). Output: packages/web/src/dev/showcase-media/.
//
//   node packages/web/scripts/showcase-media.mjs
//
// Needs Playwright's Chromium (`pnpm --filter @orchvis/web exec playwright
// install chromium`) and ffmpeg on PATH (for the audio and video only).
// Everything shown is invented; no real product, company or person.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRam, log } from './lib/guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'src', 'dev', 'showcase-media');
mkdirSync(OUT, { recursive: true });

const FONT = `font-family: 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif;`;
const MONO = `font-family: 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace;`;

// ---------- Mockups ----------

function checkoutPage({ total, broken }) {
  const rows = [
    ['Trailhead 28L backpack', 'Slate · ×1', '$89.00'],
    ['Merino crew socks', 'Charcoal · ×2', '$24.00'],
    ['Insulated bottle 750 ml', 'Moss · ×1', '$15.40'],
  ];
  const err = broken
    ? `<div class="console">
        <div class="tabs"><span class="on">Console</span><span>Network</span><span>Sources</span></div>
        <div class="line err">✖ TypeError: Cannot read properties of undefined (reading 'amount')<br>
        &nbsp;&nbsp;&nbsp;at formatTotal (src/checkout/OrderSummary.tsx:88:31)<br>
        &nbsp;&nbsp;&nbsp;at OrderSummary (src/checkout/OrderSummary.tsx:41:18)</div>
        <div class="line warn">⚠ POST /v2/payment_intents 200 · response has amount_minor, expected amount</div>
      </div>`
    : `<div class="toast">✓ Payment intent created · pi_3QxK9v2LmT · amount_minor 12840 USD</div>`;
  return `<!doctype html><html><head><style>
  body{margin:0;${FONT}background:#f4f5f7;color:#1d2430;width:1100px;height:700px;overflow:hidden}
  .bar{height:38px;background:#dfe3e8;display:flex;align-items:center;gap:8px;padding:0 14px}
  .dot{width:12px;height:12px;border-radius:50%}
  .url{margin-left:18px;background:#fff;border-radius:6px;padding:5px 12px;font-size:13px;color:#4a5566;width:520px}
  header{background:#fff;border-bottom:1px solid #e3e6ea;padding:14px 40px;display:flex;align-items:center;gap:30px}
  .logo{font-weight:800;font-size:20px;color:#1b4d3e}
  nav span{margin-right:20px;color:#5b6676;font-size:14px}
  main{display:flex;gap:28px;padding:26px 40px}
  .card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:20px 22px}
  .left{flex:1.25}.right{flex:1}
  h2{margin:0 0 14px;font-size:18px}
  label{display:block;font-size:12px;color:#6b7686;margin:10px 0 4px}
  .in{border:1px solid #cfd5dc;border-radius:6px;height:34px;padding:0 10px;display:flex;align-items:center;font-size:14px;color:#334}
  .row2{display:flex;gap:12px}.row2>div{flex:1}
  .item{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f2f4;font-size:14px}
  .item small{display:block;color:#8a94a3;font-size:12px}
  .total{display:flex;justify-content:space-between;font-size:20px;font-weight:700;margin-top:14px;padding:10px;border-radius:8px}
  .total.bad{background:#fdecec;color:#c62828;outline:2px solid #ef5350}
  .total.ok{background:#e9f7ef;color:#1b6e3a}
  .pay{margin-top:16px;background:${broken ? '#9aa7b4' : '#1b4d3e'};color:#fff;border-radius:8px;text-align:center;padding:12px;font-weight:600}
  .console{position:absolute;left:0;right:0;bottom:0;height:120px;background:#202124;color:#e8eaed;${MONO}font-size:13px}
  .tabs{background:#292a2d;padding:6px 14px;font-size:12px;color:#9aa0a6}.tabs span{margin-right:18px}.tabs .on{color:#8ab4f8}
  .line{padding:6px 14px;border-bottom:1px solid #3c4043}
  .err{color:#f28b82;background:#290000}.warn{color:#fdd663;background:#332b00}
  .toast{position:absolute;right:40px;bottom:28px;background:#1b4d3e;color:#fff;padding:12px 18px;border-radius:8px;font-size:14px;box-shadow:0 6px 18px rgba(0,0,0,.18)}
  </style></head><body>
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
  <span class="url">https://staging.storefront.acme.test/checkout</span></div>
  <header><span class="logo">acme outdoors</span><nav><span>Shop</span><span>Trail</span><span>Camp</span><span>Sale</span></nav></header>
  <main>
    <div class="card left"><h2>Shipping</h2>
      <div class="row2"><div><label>First name</label><div class="in">Jordan</div></div><div><label>Last name</label><div class="in">Rivera</div></div></div>
      <label>Address</label><div class="in">123 Example Lane, Apt 4</div>
      <div class="row2"><div><label>City</label><div class="in">Springfield</div></div><div><label>ZIP</label><div class="in">00000</div></div></div>
      <h2 style="margin-top:18px">Payment</h2><div class="in">•••• •••• •••• 4242 &nbsp; 08/29</div>
    </div>
    <div class="card right"><h2>Order summary</h2>
      ${rows.map(([n, s, p]) => `<div class="item"><span>${n}<small>${s}</small></span><span>${p}</span></div>`).join('')}
      <div class="item"><span>Shipping</span><span>Free</span></div>
      <div class="total ${broken ? 'bad' : 'ok'}"><span>Total</span><span>${total}</span></div>
      <div class="pay">Place order</div>
    </div>
  </main>${err}</body></html>`;
}

function schemaDiff() {
  const lines = [
    [' ', 'components:'],
    [' ', '  schemas:'],
    [' ', '    PaymentIntent:'],
    [' ', '      type: object'],
    [' ', '      required: [id, currency, status]'],
    [' ', '      properties:'],
    [' ', '        id: { type: string, example: pi_3QxK9v2LmT }'],
    ['-', '        amount:'],
    ['-', '          type: number'],
    ['-', '          description: Amount in major units (e.g. 128.40)'],
    ['+', '        amount_minor:'],
    ['+', '          type: integer'],
    ['+', '          description: Amount in minor units (e.g. 12840)'],
    ['+', '        currency_exponent:'],
    ['+', '          type: integer'],
    ['+', '          example: 2'],
    [' ', '        currency: { type: string, example: usd }'],
    [' ', '        status:'],
    [' ', '          enum: [requires_payment_method, processing, succeeded]'],
  ];
  return `<!doctype html><html><head><style>
  body{margin:0;background:#0d1117;color:#c9d1d9;${MONO}font-size:15px;width:1000px;height:620px;overflow:hidden}
  .head{${FONT}background:#161b22;border-bottom:1px solid #30363d;padding:12px 18px;font-size:14px;display:flex;gap:14px;align-items:center}
  .pill{background:#8957e5;color:#fff;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
  .file{color:#e6edf3;font-weight:600}.stat{margin-left:auto}.add{color:#3fb950}.del{color:#f85149}
  .l{display:flex;line-height:26px}.n{width:46px;text-align:right;color:#6e7681;padding-right:12px}
  .s{width:20px}.l.minus{background:#3a1d22}.l.plus{background:#12301d}
  .minus .s,.minus .t{color:#ffa198}.plus .s,.plus .t{color:#7ee787}
  </style></head><body>
  <div class="head"><span class="pill">BREAKING</span><span class="file">openapi/payment_intent.yaml</span><span>feat/intents-v2 · a91f3c2</span><span class="stat"><span class="add">+6</span> <span class="del">−3</span></span></div>
  <div style="padding-top:8px">
  ${lines
    .map(([s, t], i) => `<div class="l ${s === '-' ? 'minus' : s === '+' ? 'plus' : ''}"><span class="n">${i + 41}</span><span class="s">${s === ' ' ? '' : s}</span><span class="t">${t.replace(/ /g, '&nbsp;')}</span></div>`)
    .join('')}
  </div></body></html>`;
}

function iosCart() {
  return `<!doctype html><html><head><style>
  body{margin:0;background:radial-gradient(circle at 30% 20%,#2b3446,#11151c);width:900px;height:640px;display:flex;align-items:center;justify-content:center;gap:50px;${FONT}overflow:hidden}
  .phone{width:300px;height:600px;border-radius:44px;background:#000;padding:12px;box-shadow:0 20px 50px rgba(0,0,0,.5)}
  .screen{width:100%;height:100%;border-radius:34px;background:#f2f2f7;overflow:hidden;position:relative;color:#111}
  .notch{width:110px;height:30px;background:#000;border-radius:0 0 18px 18px;margin:0 auto}
  .title{font-weight:700;font-size:26px;padding:10px 18px 6px}
  .it{background:#fff;margin:8px 12px;border-radius:12px;padding:10px 12px;display:flex;justify-content:space-between;font-size:14px}
  .it small{display:block;color:#8e8e93;font-size:12px}
  .tot{margin:14px 12px;background:#fff;border-radius:12px;padding:12px;font-size:17px;font-weight:700;display:flex;justify-content:space-between;outline:3px solid #ff3b30}
  .tot span:last-child{color:#ff3b30}
  .ap{position:absolute;bottom:26px;left:14px;right:14px;background:#000;color:#fff;border-radius:12px;text-align:center;padding:13px;font-weight:600;font-size:17px}
  .note{color:#e8eef7;width:380px}
  .note h1{font-size:22px;margin:0 0 10px}
  .note p{color:#a9b6c8;font-size:15px;line-height:1.5;margin:0 0 10px}
  code{${MONO}background:#232b39;color:#ffd479;padding:2px 6px;border-radius:5px;font-size:13px}
  </style></head><body>
  <div class="phone"><div class="screen"><div class="notch"></div>
    <div class="title">Cart</div>
    <div class="it"><span>Trailhead 28L backpack<small>Slate · 1</small></span><span>$89.00</span></div>
    <div class="it"><span>Merino crew socks<small>Charcoal · 2</small></span><span>$24.00</span></div>
    <div class="it"><span>Insulated bottle<small>Moss · 1</small></span><span>$15.40</span></div>
    <div class="tot"><span>Total</span><span>$12,840.00</span></div>
    <div class="ap">Pay $12,840.00</div>
  </div></div>
  <div class="note"><h1>iOS 4.12 (build 812) · staging</h1>
  <p>Cart total is 100× too high after switching to <code>/v2/payment_intents</code>.</p>
  <p>The app still formats <code>amount_minor</code> as major units: <code>12840</code> → <code>$12,840.00</code>.</p>
  <p>Apple Pay sheet shows the same total. Repro on iPhone 16 simulator, iOS 19.1.</p></div>
  </body></html>`;
}

/** A Grafana-style dark panel with time series. */
function chartPanel({ title, subtitle, unit, yMax, series, threshold, annotation, width = 1100, height = 560 }) {
  const L = 70, R = 30, T = 90, B = 60;
  const w = width - L - R, h = height - T - B;
  const n = series[0].values.length;
  const x = (i) => L + (w * i) / (n - 1);
  const y = (v) => T + h - (h * v) / yMax;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="${L}" x2="${L + w}" y1="${y(yMax * f)}" y2="${y(yMax * f)}" stroke="#2c3240"/><text x="${L - 10}" y="${y(yMax * f) + 4}" text-anchor="end" fill="#8e99ab" font-size="12">${Math.round(yMax * f)}${unit}</text>`)
    .join('');
  const times = [];
  for (let i = 0; i < 7; i++) {
    const idx = Math.round(((n - 1) * i) / 6);
    const mins = 13 * 60 + 30 + Math.round((60 * idx) / (n - 1));
    times.push(`<text x="${x(idx)}" y="${T + h + 22}" text-anchor="middle" fill="#8e99ab" font-size="12">${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}</text>`);
  }
  const paths = series
    .map((s) => {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const area = `${d} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
      return `<path d="${area}" fill="${s.color}" opacity="0.08"/><path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2"/>`;
    })
    .join('');
  const thr = threshold
    ? `<line x1="${L}" x2="${L + w}" y1="${y(threshold.value)}" y2="${y(threshold.value)}" stroke="#f2495c" stroke-dasharray="6 5" stroke-width="1.6"/><text x="${L + w - 4}" y="${y(threshold.value) - 6}" text-anchor="end" fill="#f2495c" font-size="12">${threshold.label}</text>`
    : '';
  const ann = annotation
    ? `<line x1="${x(annotation.at)}" x2="${x(annotation.at)}" y1="${T}" y2="${T + h}" stroke="#5794f2" stroke-width="1.5" stroke-dasharray="3 3"/><rect x="${x(annotation.at) + 6}" y="${T + 6}" width="${annotation.label.length * 7 + 14}" height="22" rx="4" fill="#1f3b63"/><text x="${x(annotation.at) + 13}" y="${T + 21}" fill="#cfe1ff" font-size="12">${annotation.label}</text>`
    : '';
  const legend = series
    .map((s, i) => `<g transform="translate(${L + i * 210},${height - 18})"><rect width="14" height="4" y="-4" fill="${s.color}"/><text x="20" fill="#c7d0dc" font-size="13">${s.name}</text></g>`)
    .join('');
  return `<!doctype html><html><head><style>body{margin:0;background:#111217;${FONT}}</style></head><body>
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="${FONT}">
  <rect width="${width}" height="${height}" fill="#181b1f"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#2c3240"/>
  <text x="${L - 50}" y="36" fill="#e6e9ef" font-size="19" font-weight="600">${title}</text>
  <text x="${L - 50}" y="60" fill="#8e99ab" font-size="13">${subtitle}</text>
  ${grid}${times}${ann}${paths}${thr}${legend}
  </svg></body></html>`;
}

function seriesFrom(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

function noise(i, k) {
  return Math.sin(i * 0.9 + k) * 0.5 + Math.sin(i * 2.3 + k * 1.7) * 0.3 + Math.sin(i * 5.1 + k * 0.3) * 0.2;
}

function ciMemory() {
  const n = 61;
  const at = 32;
  const pool = (base, k, oomAt) =>
    seriesFrom(n, (i) => {
      if (i < at) return base + noise(i, k) * 0.6;
      const v = base + (i - at) * 0.42 + noise(i, k) * 0.5;
      return i >= oomAt ? Math.max(1.5, (v % 14.2) + 0.8) : Math.min(v, 14.6);
    });
  return chartPanel({
    title: 'CI runners · memory working set',
    subtitle: 'ci-linux-xl pool · per-runner max · ci-runner-01 … 12',
    unit: ' GiB',
    yMax: 16,
    series: [
      { name: 'ci-linux-xl (p95)', color: '#ff9830', values: pool(6.1, 1, 52) },
      { name: 'ci-linux-xl (median)', color: '#73bf69', values: pool(4.4, 2, 99) },
      { name: 'ci-macos (p95)', color: '#5794f2', values: seriesFrom(n, (i) => 5.2 + noise(i, 3) * 0.5) },
    ],
    threshold: { value: 14, label: 'OOM kill at 14 GiB' },
    annotation: { at, label: 'deploy: shared pnpm store cache (platform-infra#412)' },
  });
}

function ledgerLatency() {
  const n = 61;
  return chartPanel({
    title: 'payments-api · /v2/ledger/reconcile latency',
    subtitle: 'p50 / p95 / p99 · staging · 1 min resolution',
    unit: ' ms',
    yMax: 1600,
    series: [
      { name: 'p99', color: '#f2495c', values: seriesFrom(n, (i) => (i > 38 && i < 50 ? 1350 + noise(i, 1) * 120 : 520 + noise(i, 1) * 90)) },
      { name: 'p95', color: '#ff9830', values: seriesFrom(n, (i) => (i > 38 && i < 50 ? 980 + noise(i, 2) * 80 : 310 + noise(i, 2) * 50)) },
      { name: 'p50', color: '#73bf69', values: seriesFrom(n, (i) => 120 + noise(i, 3) * 20) },
    ],
    threshold: { value: 800, label: 'SLO p95 800 ms' },
    annotation: { at: 39, label: 'k6 ramp to 2k rps' },
  });
}

const IMAGES = [
  { file: 'checkout-total-zero.png', html: checkoutPage({ total: '$0.00', broken: true }), size: [1100, 700] },
  { file: 'checkout-fixed.png', html: checkoutPage({ total: '$128.40', broken: false }), size: [1100, 700] },
  { file: 'intent-v2-diff.png', html: schemaDiff(), size: [1000, 620] },
  { file: 'ios-cart-total.png', html: iosCart(), size: [900, 640] },
  { file: 'ci-runner-memory.png', html: ciMemory(), size: [1100, 560] },
  { file: 'ledger-latency.png', html: ledgerLatency(), size: [1100, 560] },
];

async function renderImages() {
  checkRam('before launching Chromium');
  log('loading Playwright');
  const { chromium } = await import('@playwright/test');
  log('launching headless Chromium (one instance, GPU off)');
  const browser = await chromium.launch({ args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const img of IMAGES) {
      const [width, height] = img.size;
      await page.setViewportSize({ width, height });
      await page.setContent(img.html, { waitUntil: 'load' });
      const path = join(OUT, img.file);
      await page.screenshot({ path, clip: { x: 0, y: 0, width, height } });
      log(`wrote ${img.file} (${Math.round(statSync(path).size / 1024)} KB)`);
    }
    checkRam('after rendering images');
  } finally {
    await browser.close();
    log('Chromium closed');
  }
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function renderAv() {
  // Audio: a 6 s synthetic "voice note": a few soft tones, Opus in Ogg.
  const audio = join(OUT, 'voiceover-total.ogg');
  log('ffmpeg: rendering the audio clip');
  ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6',
    '-filter_complex', '[0][1]amix=inputs=2,volume=0.4,tremolo=f=3:d=0.7,afade=t=in:d=0.3,afade=t=out:st=5.5:d=0.5',
    '-c:a', 'libopus', '-b:a', '24k', audio,
  ]);
  log(`wrote voiceover-total.ogg (${Math.round(statSync(audio).size / 1024)} KB)`);
  // Video: 5 s pan over the broken checkout mockup, VP9 in WebM.
  const video = join(OUT, 'checkout-e2e-timeout.webm');
  log('ffmpeg: rendering the video clip (a few seconds)');
  ffmpeg([
    '-loop', '1', '-framerate', '12', '-t', '5', '-i', join(OUT, 'checkout-total-zero.png'),
    '-vf', "scale=880:-2,crop=640:400:'(in_w-640)*t/5':'(in_h-400)*t/5'",
    '-c:v', 'libvpx-vp9', '-b:v', '220k', '-pix_fmt', 'yuv420p', video,
  ]);
  log(`wrote checkout-e2e-timeout.webm (${Math.round(statSync(video).size / 1024)} KB)`);
}

log(`output: ${OUT}`);
await renderImages();
renderAv();
log('done');
