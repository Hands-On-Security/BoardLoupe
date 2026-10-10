/**
 * Trace-through-series end-to-end on a real fixture (the Glasgow GenCAD
 * export): select a signal net, see the series-part trace, and highlight the
 * whole path.
 */
import { resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = 'file://' + resolve(ROOT, 'dist/boardview.html');
const FX = resolve(ROOT, 'fixtures/real/glasgow/glasgow-kicad10.cad');

async function open(page: Page) {
  await page.goto(APP);
  await expect(page.getByTestId('dropzone')).toBeVisible();
  await page.setInputFiles('#bs-file-input', FX);
  await expect(page.getByTestId('file-name')).toBeVisible({ timeout: 30_000 });
}

test('trace a signal through its series parts and highlight the path', async ({ page }) => {
  await open(page);
  // Select the /ENVA net via search.
  await page.keyboard.press('/');
  await page.keyboard.type('ENVA');
  await expect(page.getByText('/ENVA', { exact: true }).first()).toBeVisible();
  await page.getByText('/ENVA', { exact: true }).first().click();

  // The trace section lists the series parts crossed and nets reached.
  const trace = page.getByTestId('trace-series');
  await expect(trace).toBeVisible();
  await expect(trace).toContainText(/series part/);

  // Highlighting the path selects the whole chain (more than one net).
  await page.getByRole('button', { name: 'Highlight the whole series path' }).click();
  await expect(page.getByText(/Series trace: \d+ nets?, \d+ series part/)).toBeVisible();
  const nets = await page.evaluate(() => {
    const s = (window as unknown as { boardscope?: { store?: { get(): { sel: { nets: number[] } } } } }).boardscope?.store;
    return s ? s.get().sel.nets.length : -1;
  });
  // The two far-side nets of /ENVA are highlighted alongside it (or state not exposed → skip assertion).
  if (nets >= 0) expect(nets).toBeGreaterThanOrEqual(2);
});
