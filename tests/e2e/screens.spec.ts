/**
 * Visual review captures (Chromium only): dark theme at desktop and laptop
 * sizes in the main states. Not a pixel-diff test; images are written to
 * test-results/screens for inspection and for the README.
 */
import { resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = 'file://' + resolve(ROOT, 'dist/boardloupe.html');
const FX = (p: string) => resolve(ROOT, 'fixtures', p);
const SHOTS = resolve(ROOT, 'docs/screenshots');

test.skip(({ browserName }) => browserName !== 'chromium', 'captured once');
test.use({ colorScheme: 'dark' });

async function open(page: Page, file?: string) {
  await page.goto(APP);
  await expect(page.getByTestId('dropzone')).toBeVisible();
  if (file) {
    await page.setInputFiles('#bs-file-input', FX(file));
    await expect(page.getByTestId('file-name')).toBeVisible({ timeout: 30_000 });
  }
}
const bs = (page: Page, js: string) => page.evaluate(js);

test('dark: empty state', async ({ page }) => {
  await open(page);
  // The Hands-On Security logo is an inline image: capture once it is decoded.
  await page.locator('img.hos-logo').first().evaluate((img) => (img as HTMLImageElement).decode());
  // Let the fade-in finish (a capture mid-animation looks dimmed).
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.screenshot({ path: `${SHOTS}/dark-empty.png` });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: `${SHOTS}/dark-empty-laptop.png` });
});

test('dark: TVW board, part selected', async ({ page }) => {
  await open(page, 'synthetic/glasgow.tvw');
  await page.keyboard.press('/');
  await page.keyboard.type('U30');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/dark-part.png` });
});

test('dark: net highlighted with air wires', async ({ page }) => {
  await open(page, 'real/glasgow/glasgow-kicad10.cad');
  await bs(page, `boardloupe.store.set({ prefs: { ...boardloupe.store.get().prefs, showRatsnest: true } })`);
  await page.keyboard.press('/');
  await page.keyboard.type('SDA');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/dark-net.png` });
});

test('dark: bottom side with copper traces', async ({ page }) => {
  await open(page, 'synthetic/glasgow.tvw');
  await bs(page, `boardloupe.store.set({ prefs: { ...boardloupe.store.get().prefs, showTraces: true } })`);
  await page.getByTestId('board-canvas').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/dark-bottom-traces.png` });
});

test('dark: zoomed pins with labels', async ({ page }) => {
  await open(page, 'real/glasgow/glasgow-kicad10.cad');
  await page.keyboard.press('/');
  await page.keyboard.type('U1.12');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/dark-pin.png` });
});

test('dark: tables and layers menu', async ({ page }) => {
  await open(page, 'real/glasgow/glasgow-kicad10.cad');
  await page.keyboard.press('t');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/dark-tables.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Layers & display' }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${SHOTS}/dark-layers.png` });
});

test('dark: file info and error', async ({ page }) => {
  await open(page, 'real/glasgow/glasgow-kicad-boardview.brd');
  await page.getByRole('tab', { name: 'File' }).click();
  await page.screenshot({ path: `${SHOTS}/dark-info.png` });
  await page.setInputFiles('#bs-file-input', FX('synthetic/glasgow-testkey.pcb'));
  await expect(page.getByTestId('error')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dark-error.png` });
});

test('dark: laptop 1366x768 measure tool', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await open(page, 'real/glasgow/glasgow-kicad10.cad');
  await page.keyboard.press('m');
  const box = (await page.getByTestId('board-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.55);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/dark-measure-laptop.png` });
});

test('dark: highlight group with legend', async ({ page }) => {
  await open(page, 'synthetic/glasgow.tvw');
  await bs(
    page,
    `(() => { const b = window.boardloupe, m = b.store.get().board.model;
      const nets = []; for (let i = 0; i < m.nets.count && nets.length < 6; i++) if (/IO_Banks\\/DA\\d$/.test(m.nets.name[i])) nets.push(i);
      b.store.set({ group: { nets, parts: [] }, panel: 'groups' }); b.viewer.fit(); b.viewer.zoomBy(1.6); })()`,
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/dark-group.png` });
});

test('dark: report dialog', async ({ page }) => {
  await open(page, 'synthetic/glasgow.tvw');
  await bs(
    page,
    `(() => { const b = window.boardloupe, m = b.store.get().board.model;
      const nets = []; for (let i = 0; i < m.nets.count && nets.length < 4; i++) if (/IO_Banks\\/DA\\d$/.test(m.nets.name[i])) nets.push(i);
      b.store.set({ group: { nets, parts: [] } }); b.viewer.fit(); b.store.set({ dialog: 'report' }); })()`,
  );
  await page.getByPlaceholder(/board analysis/).fill('Glasgow — FPGA I/O bank A');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/dark-report.png` });
});
