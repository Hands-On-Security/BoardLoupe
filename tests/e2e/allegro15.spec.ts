import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = 'file://' + resolve(ROOT, 'dist/boardloupe.html');
const FILE = process.env.BS_RESEARCH
  ? resolve(process.env.BS_RESEARCH, 'fixtures/vinafix/files/4cc7f8a85cf1c01f/LA-7201PR10-0221.brd-156_final.brd')
  : '';

test('Allegro 15.5 opens from the local corpus with copper and outline', async ({ page }) => {
  test.skip(!FILE || !existsSync(FILE), 'requires the local research corpus');
  test.setTimeout(90_000);
  await page.goto(APP);
  await expect(page.getByTestId('dropzone')).toBeVisible();
  await page.setInputFiles('#bs-file-input', FILE);
  await expect(page.getByTestId('file-name')).toContainText('LA-7201PR10-0221', { timeout: 60_000 });
  await expect(page.getByText('1,945 parts · 8,468 pins')).toBeVisible();
  await expect(page.getByTestId('error-message')).toHaveCount(0);
});
