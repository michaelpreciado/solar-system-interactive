import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end checks.
 *
 * The important ones are not "does a button exist" -- they are the two
 * invariants the architecture rests on and that fail silently otherwise:
 *
 *   1. The scene actually rendered. A shader that fails to compile leaves a
 *      black canvas and a console message nobody reads; reading pixels back
 *      catches it.
 *   2. React does not re-render during animation. That was the defect this
 *      rewrite exists to fix, and nothing about the app *looks* wrong when it
 *      regresses -- it just quietly runs at a third of the frame rate.
 */

const READY_TIMEOUT = 240_000;

/** Numbers are formatted with thin spaces for typography; tests read plain text. */
const plain = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Wait for a value to stop changing.
 *
 * Camera transitions are frame-driven and the per-frame delta is clamped, so on
 * a software renderer a fly-to takes many seconds of wall clock. Polling for
 * stability is correct at any frame rate; a fixed timeout is not.
 */
async function waitUntilStable(
  read: () => Promise<string | null>,
  { settleFor = 1500, timeout = 120_000 } = {}
): Promise<string> {
  const start = Date.now();
  let last = plain(await read());
  let lastChange = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const now = plain(await read());
    if (now !== last) {
      last = now;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > settleFor) {
      return last;
    }
    if (Date.now() - start > timeout) return last;
  }
}

async function boot(page: Page, query = '?tier=high'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('requestfailed', (r) => {
    // Ignore aborted requests from navigation; only real misses matter.
    const err = r.failure()?.errorText ?? '';
    if (!err.includes('ABORTED'))
      errors.push(`request failed: ${r.url()} ${err}`);
  });

  await page.goto(`/${query}`);
  await page.waitForSelector('.loading', {
    state: 'detached',
    timeout: READY_TIMEOUT,
  });
  await page.waitForTimeout(2500);
  return errors;
}

/**
 * Open the inspector's detail section if it is closed.
 *
 * On a phone the panel opens collapsed -- expanded, it plus the rail and the
 * timeline leave almost no room for the planet being described -- so anything
 * asserting on the stats, facts or composition has to open it first. On the
 * desktop project it is already open and this is a no-op, which keeps the two
 * projects running the same test rather than forking it by viewport.
 */
async function expandInspector(page: Page): Promise<void> {
  const toggle = page.locator('.inspector__collapse');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
}

test.describe('Orrery', () => {
  test('boots and renders a non-trivial scene', async ({ page }) => {
    const errors = await boot(page);

    await expect(page).toHaveTitle(/Orrery/);
    await expect(page.locator('canvas')).toBeVisible();

    // Analyse a real screenshot rather than reading the WebGL canvas back
    // directly: without `preserveDrawingBuffer` the drawing buffer is already
    // cleared by the time script runs, so `drawImage` yields solid black and
    // the test would pass or fail for reasons unrelated to the render.
    //
    // Only the left portion is sampled, away from the HUD panels, so the
    // assertion is about the 3D scene rather than about the interface.
    const shot = await page.screenshot({
      clip: { x: 0, y: 60, width: 640, height: 620 },
    });

    const stats = await page.evaluate(async (base64: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();

      const copy = document.createElement('canvas');
      copy.width = img.width;
      copy.height = img.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, copy.width, copy.height);

      let sum = 0;
      let max = 0;
      const seen = new Set<number>();
      for (let i = 0; i < data.length; i += 4) {
        const lum =
          (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
        sum += lum;
        if (lum > max) max = lum;
        // Quantise so sensor-style noise doesn't inflate the count.
        seen.add(
          ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
        );
      }
      return { mean: sum / (data.length / 4), max, distinctColors: seen.size };
    }, shot.toString('base64'));

    expect(stats.max, 'the scene rendered something bright').toBeGreaterThan(
      40
    );
    expect(stats.mean, 'the scene is not a white-out').toBeLessThan(200);
    expect(
      stats.distinctColors,
      'the scene has real tonal range'
    ).toBeGreaterThan(60);

    const shaderErrors = errors.filter((e) => /shader|GLSL|program/i.test(e));
    expect(shaderErrors, 'no shader compile failures').toEqual([]);
    expect(errors, 'clean console').toEqual([]);
  });

  test('does not re-render React while the simulation runs', async ({
    page,
  }) => {
    await boot(page);

    // Count DOM mutations to the 3D-adjacent tree over three seconds of
    // playback. The label layer is mutated imperatively (transform/opacity
    // only) and telemetry writes textContent, so we watch for *structural*
    // changes, which is what a React commit would produce.
    await page.click('.play-button');

    const mutations = await page.evaluate(async () => {
      const target = document.querySelector('.hud')!;
      let structural = 0;
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (
            r.type === 'childList' &&
            (r.addedNodes.length || r.removedNodes.length)
          ) {
            structural++;
          }
        }
      });
      obs.observe(target, { childList: true, subtree: true });
      await new Promise((r) => setTimeout(r, 3000));
      obs.disconnect();
      return structural;
    });

    // Telemetry rewrites text nodes at 10 Hz, which is a characterData change,
    // not a childList one. Any structural churn here means React is committing
    // inside the frame loop.
    expect(mutations, 'no React commits during playback').toBeLessThan(5);
  });

  test('holds its draw-call budget', async ({ page }) => {
    await boot(page);

    // Saturn is the heaviest view: planet, rings, atmosphere shell and moons.
    await page.click('.body-chip:has-text("Saturn")');
    await waitUntilStable(() =>
      page.locator('.inspector__live dd').nth(0).textContent()
    );

    // The performance overlay reads from the telemetry channel.
    await page.keyboard.press('`');
    await expect(page.locator('.debug-hud')).toBeVisible();
    await page.waitForTimeout(1500);

    const hud = (await page.locator('.debug-hud').textContent()) ?? '';
    const calls = Number(
      /Draw calls([\d,]+)/.exec(hud)?.[1]?.replace(/,/g, '') ?? '0'
    );

    expect(calls, 'renderer reported draw calls').toBeGreaterThan(0);
    // A regression past this means something started drawing per-object that
    // should be instanced or culled.
    expect(calls, 'draw calls stay within budget').toBeLessThan(200);
  });

  test('flies to a planet and reports plausible physics', async ({ page }) => {
    await boot(page);

    await page.click('.body-chip:has-text("Jupiter")');
    await expect(page.locator('.inspector__title')).toHaveText('Jupiter');

    // Light-travel time to Jupiter is 35-52 minutes depending on where the two
    // planets are. Anything outside that means the ephemeris or the unit
    // conversion is wrong.
    // The readout is written at 10 Hz by the driver and starts as "--", so
    // under a ~2 fps software renderer it can lag the inspector by seconds.
    await expect
      .poll(
        async () =>
          plain(await page.locator('.inspector__live dd').nth(2).textContent()),
        { timeout: 120_000 }
      )
      .toContain('minutes');
    const light = plain(
      await page.locator('.inspector__live dd').nth(2).textContent()
    );
    const minutes = Number(/([\d.]+)/.exec(light)?.[1] ?? '0');
    expect(light).toContain('minutes');
    expect(minutes).toBeGreaterThan(30);
    expect(minutes).toBeLessThan(56);

    // The camera must actually arrive, not merely re-aim. Jupiter's rendered
    // radius is 8.2 units, framed at 3.6x, so it should settle near 29,500 km.
    // Poll for arrival rather than for stability: at ~2 fps the readout can sit
    // still for seconds mid-flight, which a settle timer mistakes for landing.
    const readKm = async () => {
      const text = plain(
        await page.locator('.inspector__live dd').nth(0).textContent()
      );
      return text.includes('thousand km')
        ? Number(/([\d.]+)/.exec(text)?.[1] ?? '0')
        : 0;
    };
    await expect
      .poll(
        async () => {
          const km = await readKm();
          return km > 20 && km < 45;
        },
        { timeout: 240_000, message: 'camera settles near 29,500 km' }
      )
      .toBe(true);
  });

  test('switches between explorer and scientist voices @dom', async ({
    page,
  }) => {
    await boot(page);
    await expandInspector(page);

    await expect(page.locator('.inspector')).toContainText('How big');

    await page.click('.segmented__item:has-text("Scientist")');
    await expect(page.locator('.inspector')).toContainText('Bond albedo');
    await expect(page.locator('.inspector')).not.toContainText('How big');

    await page.click('.segmented__item:has-text("Explorer")');
    await expect(page.locator('.inspector')).toContainText('How big');
  });

  test('toggles data layers @dom', async ({ page }) => {
    await boot(page);

    await page.click('button[aria-label="Data layers"]');
    await expect(page.locator('.panel')).toBeVisible();
    await expect(page.locator('.panel')).toContainText('Orbit paths');

    // Labels off should hide every label.
    await page.click('.switch-row:has-text("Name labels")');
    await page.waitForTimeout(1200);
    const visible = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('.body-label')].filter(
          (el) => Number(el.style.opacity || '0') > 0.01
        ).length
    );
    expect(visible).toBe(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.panel')).toHaveCount(0);
  });

  test('scrubs time and returns to today @dom', async ({ page }) => {
    await boot(page);

    // `.timeline__date` holds the date *and* the UTC clock. Reading the whole
    // container makes the assertion depend on wall-clock time: "Today" resets
    // to `new Date()`, and a CI run takes long enough that the minute has
    // moved on even though the date has not.
    const readDate = async () =>
      plain(await page.locator('.timeline__date > span').first().textContent());
    const before = await readDate();

    // Keys go to the document; clicking the canvas first is unnecessary and
    // risks landing on a HUD control.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    // Software GL renders ~2 fps in CI, so the readout can take several
    // frames to catch up; poll instead of betting on a fixed delay.
    await expect.poll(readDate).not.toBe(before);

    await page.click('button:has-text("Today")');
    await expect.poll(readDate).toBe(before);
  });

  test('survives a resize mid-animation', async ({ page }) => {
    const errors = await boot(page);
    await page.click('.play-button');
    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForTimeout(2000);
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.waitForTimeout(2000);

    await expect(page.locator('canvas')).toBeVisible();
    const lost = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement;
      return c.getContext('webgl2')?.isContextLost() ?? true;
    });
    expect(lost, 'WebGL context survived the resize').toBe(false);
    expect(errors).toEqual([]);
  });

  test('is usable on a phone viewport @mobile', async ({ page }) => {
    // Both projects run this one, and the desktop project's 1280px viewport is
    // not a phone. Pin the size here so the test means the same thing in both,
    // and the mobile project still contributes touch emulation and a real DPR.
    await page.setViewportSize({ width: 390, height: 844 });

    await boot(page);
    await expect(page.locator('.body-rail')).toBeVisible();
    await expect(page.locator('.timeline')).toBeVisible();

    // The HUD must not push the page into horizontal scroll.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The panel opens closed here, which is what keeps the stack short.
    await expect(page.locator('.inspector__collapse')).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    // The rail, the inspector and the timeline stack along the bottom edge,
    // and every pixel they take is a pixel of planet you cannot see. They ran
    // to 64% of a 390x844 screen before being compacted; this is the guard
    // that keeps them from creeping back. Measured at 37% after.
    const share = await page.evaluate(() => {
      const boxes = ['.body-rail', '.inspector', '.timeline']
        .map((s) => document.querySelector(s)?.getBoundingClientRect())
        .filter((r): r is DOMRect => !!r);
      const top = Math.min(...boxes.map((r) => r.top));
      const bottom = Math.max(...boxes.map((r) => r.bottom));
      return (bottom - top) / window.innerHeight;
    });
    expect(
      share,
      `HUD stack covered ${(share * 100).toFixed(1)}% of the screen`
    ).toBeLessThan(0.45);
  });
});
