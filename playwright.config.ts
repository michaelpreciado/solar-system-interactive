import { defineConfig, devices } from '@playwright/test';

/**
 * WebGL tests run on Chromium only.
 *
 * Firefox and WebKit have flaky-to-absent WebGL2 in headless CI, so a
 * GL-dependent suite would fail there for reasons unrelated to this code.
 * DOM-only checks still run on mobile via the `@dom` tag.
 *
 * Procedural surfaces are baked on the GPU at startup. Under SwiftShader that
 * takes tens of seconds, which is why the timeouts here are generous.
 */
// E2E_PORT lets the suite avoid a stale server already bound to 4173.
const PORT = Number(process.env.E2E_PORT || 4173);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    launchOptions: {
      // SwiftShader gives us real WebGL2 in headless CI. Without these the
      // canvas silently fails to get a context and every visual test is
      // meaningless rather than red.
      args: [
        '--enable-unsafe-swiftshader',
        '--use-gl=angle',
        '--ignore-gpu-blocklist',
      ],
      // Escape hatch for environments that ship a Chromium build Playwright
      // did not download itself.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] }, grep: /@dom|@mobile/ },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
