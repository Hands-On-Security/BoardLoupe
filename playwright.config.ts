import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the BUILT single file (dist/boardloupe.html)
// opened through file:// — exactly how users run it.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: process.env.CI ? 90_000 : 60_000,
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: { viewport: { width: 1440, height: 900 }, acceptDownloads: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
    // Opt-in: the locally installed Google Chrome (BS_CHROME=1 npx playwright test --project=chrome).
    ...(process.env.BS_CHROME ? [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } } }] : []),
  ],
});
