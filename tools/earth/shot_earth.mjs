/**
 * Visual verification harness.
 *
 * Drives the built app in headless Chromium and captures screenshots. The
 * sandbox renderer is SwiftShader, so this proves shaders *compile and produce
 * the intended image*; it says nothing about frame rate on real hardware.
 *
 *   URL=... NAME=earth CLICK='text=Earth' WHEEL=-400 node tools/shot.mjs
 */

import { chromium } from '@playwright/test';

const OUT = process.env.OUT || 'shots';
const URL = process.env.URL || 'http://127.0.0.1:4173/?tier=high';
const WAIT = Number(process.env.WAIT || 180000);
const NAME = process.env.NAME || 'shot';
const CLICK = process.env.CLICK || '';
const VIEWPORT = (process.env.VIEWPORT || '1280x800').split('x').map(Number);
const DRAG = process.env.DRAG || '';
const WHEEL = Number(process.env.WHEEL || 0);
const AFTER = Number(process.env.AFTER || 6000);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({
  viewport: { width: VIEWPORT[0], height: VIEWPORT[1] },
  deviceScaleFactor: 1,
});

const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('GPU stall')) return;
  logs.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) =>
  logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`)
);

await page.goto(URL, { waitUntil: 'networkidle', timeout: 120000 });

// Wait for the bake queue to drain rather than guessing a duration. Under
// SwiftShader the procedural bakes take tens of seconds; on real hardware this
// resolves almost immediately.
await page
  .waitForSelector('.loading', { state: 'detached', timeout: WAIT })
  .catch(() => logs.push('[warn] loading screen never cleared'));
await page.waitForTimeout(Number(process.env.SETTLE || 4000));

await page.addStyleTag({
  content:
    '.inspector,.body-rail,.dock,[class*=hud],header{opacity:0!important}',
});
if (CLICK) {
  await page
    .click(CLICK)
    .catch((e) => logs.push(`[click failed] ${e.message}`));
  await page.waitForTimeout(AFTER);
}
if (WHEEL) {
  await page.mouse.move(VIEWPORT[0] / 2, VIEWPORT[1] / 2);
  await page.mouse.wheel(0, WHEEL);
  await page.waitForTimeout(AFTER);
}
if (DRAG) {
  const [dx, dy] = DRAG.split(',').map(Number);
  await page.mouse.move(VIEWPORT[0] / 2, VIEWPORT[1] / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      VIEWPORT[0] / 2 + (dx * i) / 12,
      VIEWPORT[1] / 2 + (dy * i) / 12
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(AFTER);
}

await page.screenshot({ path: `${OUT}/${NAME}.png` });

const info = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const gl = c && c.getContext('webgl2');
  const dd = document.querySelectorAll('.inspector__live dd');
  return {
    canvas: c ? `${c.width}x${c.height}` : 'none',
    glLost: gl ? gl.isContextLost() : 'no-ctx',
    loading: !!document.querySelector('.loading'),
    title: document.querySelector('.inspector__title')?.textContent ?? null,
    camDist: dd[0]?.textContent ?? null,
    sunDist: dd[1]?.textContent ?? null,
  };
});

console.log(JSON.stringify(info));
if (logs.length) {
  console.log('--- console ---');
  console.log(logs.slice(0, 40).join('\n'));
}

await browser.close();
