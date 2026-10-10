/**
 * RAR/7z end-to-end on the built file over file://: opening a boardview that
 * lives inside a 7-Zip archive expands it in-browser (libarchive WebAssembly,
 * instantiated lazily) and parses the member, with no network access.
 *
 * The committed fixture is a 7z wrapping the shareable Glasgow GenCAD export.
 * RAR is exercised locally against real VinaFix .rar archives (RAR4); those
 * samples are not committed, so no RAR case runs in CI. See REPORT.md.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = 'file://' + resolve(ROOT, 'dist/boardview.html');
const SEVENZIP = resolve(ROOT, 'fixtures/real/archives/glasgow.7z');

// A real VinaFix RAR4 archive, used only when the research corpus is present
// (BS_RESEARCH). It is never committed; CI skips this case.
const RAR = process.env.BS_RESEARCH ? resolve(process.env.BS_RESEARCH, 'fixtures/vinafix/archives/QUANTA BY7D - BOARDVIEW.rar') : '';

function trackNetwork(page: Page) {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  return external;
}

test('open a boardview from inside a 7z archive, offline', async ({ page }) => {
  const net = trackNetwork(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP);
  await expect(page.getByTestId('dropzone')).toBeVisible();

  await page.setInputFiles('#bs-file-input', SEVENZIP);

  // The GenCAD member is expanded and parsed: same board as opening it directly.
  await expect(page.getByTestId('file-name')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('loading')).toHaveCount(0);
  await expect(page.getByText(/272 parts · 1,149 pins · 251 nets/)).toBeVisible();

  // The lazily-instantiated decoder fetched nothing over the network.
  expect(net).toEqual([]);
  expect(errors).toEqual([]);
});

test('open a boardview from inside a real RAR4 archive, offline', async ({ page }) => {
  test.skip(!RAR || !existsSync(RAR), 'research corpus not present (set BS_RESEARCH)');
  const net = trackNetwork(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP);
  await expect(page.getByTestId('dropzone')).toBeVisible();

  await page.setInputFiles('#bs-file-input', RAR);

  await expect(page.getByTestId('file-name')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('loading')).toHaveCount(0);
  await expect(page.getByText(/[\d,]+ parts · [\d,]+ pins · [\d,]+ nets/)).toBeVisible();

  expect(net).toEqual([]);
  expect(errors).toEqual([]);
});
