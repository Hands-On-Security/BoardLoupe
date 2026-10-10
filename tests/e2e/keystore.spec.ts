/**
 * Keystore end-to-end on the built file over file://: import a keyfile of
 * DISPOSABLE test keys, open encrypted fixtures with them, save them encrypted
 * with a passphrase, reload, unlock (wrong then right passphrase), open again,
 * and remove. An opt-in test also uses a local private keyfile with real files.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = 'file://' + resolve(ROOT, 'dist/boardloupe.html');
const FX = (p: string) => resolve(ROOT, 'fixtures', p);
const KEYFILE = FX('synthetic/test-keys.json');
const FZ = FX('synthetic/glasgow-rc6-testkey.fz');
const CAE = FX('synthetic/glasgow-rc6-testkey.cae');
const XZZ = FX('synthetic/glasgow-testkey.pcb');
const RESEARCH = process.env.BS_RESEARCH;
const RESEARCH_KEYFILE = process.env.BS_RESEARCH_KEYFILE;

async function openApp(page: Page) {
  await page.goto(APP);
  await expect(page.getByTestId('dropzone')).toBeVisible();
}
const openSettings = (page: Page) => page.getByRole('button', { name: 'Settings' }).click();
async function load(page: Page, file: string) {
  await page.setInputFiles('#bs-file-input', file);
}

test('an encrypted file with no key explains that a key is required', async ({ page }) => {
  await openApp(page);
  await load(page, FZ);
  await expect(page.getByTestId('error-message')).toContainText(/encrypted|key/i);
  await expect(page.getByRole('button', { name: 'Enter key' })).toBeVisible();
});

test('import a keyfile, then encrypted FZ/CAE/XZZ fixtures open', async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await page.getByTestId('ks-import-input').setInputFiles(KEYFILE);
  // Every format shows a loaded key, none shows the material.
  await expect(page.getByTestId('ks-manage').getByText('key loaded')).toHaveCount(3);
  const html = await page.getByTestId('ks-manage').innerHTML();
  expect(html).not.toContain('f59e4e1e'); // no FZ key material on screen
  expect(html).not.toContain('1F2E3C4B'); // no XZZ key material on screen
  await page.keyboard.press('Escape');

  for (const [file, parts] of [
    [FZ, true],
    [CAE, true],
    [XZZ, true],
  ] as const) {
    await load(page, file);
    await expect(page.getByTestId('file-name')).toHaveText(basename(file), { timeout: 30_000 });
    await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 30_000 });
    if (parts) await expect(page.getByText(/\d[\d,]* parts · [\d,]+ pins/)).toBeVisible();
  }
});

test('save with a passphrase, reload, unlock (wrong then right), open, remove', async ({ page }) => {
  await openApp(page);
  const hasCrypto = await page.evaluate(() => !!(globalThis.crypto && globalThis.crypto.subtle));
  test.skip(!hasCrypto, 'no Web Crypto in this browser over file://');

  // Import and save encrypted.
  await openSettings(page);
  await page.getByTestId('ks-import-input').setInputFiles(KEYFILE);
  await page.getByTestId('ks-save-passphrase').fill('open sesame 42');
  await page.getByTestId('ks-save').click();
  // Wait until the save actually persisted (the Remove affordance appears).
  await expect(page.getByTestId('ks-remove')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => !!localStorage.getItem('boardloupe.keystore.v1')))
    .toBe(true);

  // Reload: keystore is present but locked. Opening an encrypted file asks for a key.
  await page.reload();
  await expect(page.getByTestId('dropzone')).toBeVisible();
  await load(page, FZ);
  await expect(page.getByRole('button', { name: 'Enter key' })).toBeVisible();
  await page.getByRole('button', { name: 'Enter key' }).click();
  await expect(page.getByTestId('ks-locked')).toBeVisible();

  // Wrong passphrase is rejected.
  await page.getByTestId('ks-passphrase').fill('nope');
  await page.getByTestId('ks-unlock').click();
  await expect(page.getByTestId('ks-error')).toContainText(/wrong passphrase/i);
  await expect(page.getByTestId('ks-locked')).toBeVisible();

  // Right passphrase unlocks, and the pending FZ file opens automatically.
  await page.getByTestId('ks-passphrase').fill('open sesame 42');
  await page.getByTestId('ks-unlock').click();
  await expect(page.getByTestId('file-name')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/\d[\d,]* parts · [\d,]+ pins/)).toBeVisible();

  // Remove the saved keystore; after reload it is gone and nothing is stored.
  await openSettings(page);
  await page.getByTestId('ks-remove').click();
  const stored = await page.evaluate(() => {
    try {
      return localStorage.getItem('boardloupe.keystore.v1');
    } catch {
      return null;
    }
  });
  expect(stored).toBeNull();
  await page.reload();
  await openSettings(page);
  await expect(page.getByTestId('ks-manage')).toBeVisible();
  await expect(page.getByTestId('ks-manage').getByText('key loaded')).toHaveCount(0);
});

test('local encrypted research files open after keyfile import', async ({ page }) => {
  test.skip(!RESEARCH || !RESEARCH_KEYFILE || !existsSync(RESEARCH_KEYFILE), 'requires a local corpus and private keyfile');
  test.setTimeout(180_000);
  const rows = readFileSync(join(RESEARCH!, 'fixtures/manifest.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { format: string; file: string })
    .filter((row) => ['fz', 'cae', 'xzz-pcb'].includes(row.format) && !basename(row.file).startsWith('._'));
  expect(rows.length).toBeGreaterThanOrEqual(5);
  await openApp(page);
  await openSettings(page);
  await page.getByTestId('ks-import-input').setInputFiles(RESEARCH_KEYFILE!);
  await expect(page.getByTestId('ks-manage').getByText('key loaded')).toHaveCount(3);
  await page.keyboard.press('Escape');
  for (const row of rows) {
    await load(page, join(RESEARCH!, row.file));
    await expect(page.getByTestId('file-name')).toContainText(basename(row.file), { timeout: 30_000 });
    await expect(page.getByText(/\d[\d,]* parts · [\d,]+ pins/)).toBeVisible();
    await expect(page.getByTestId('error-message')).toHaveCount(0);
  }
});

test('saved local keyfile unlocks and opens a real encrypted board', async ({ page }) => {
  test.skip(!RESEARCH || !RESEARCH_KEYFILE || !existsSync(RESEARCH_KEYFILE), 'requires a local corpus and private keyfile');
  test.setTimeout(120_000);
  await openApp(page);
  test.skip(!(await page.evaluate(() => !!globalThis.crypto?.subtle)), 'no Web Crypto over file://');
  const row = readFileSync(join(RESEARCH!, 'fixtures/manifest.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { format: string; file: string })
    .find((item) => item.format === 'fz' && !basename(item.file).startsWith('._'))!;
  await openSettings(page);
  await page.getByTestId('ks-import-input').setInputFiles(RESEARCH_KEYFILE!);
  await expect(page.getByTestId('ks-manage').getByText('key loaded')).toHaveCount(3);
  await page.getByTestId('ks-save-passphrase').fill('local corpus check');
  await page.getByTestId('ks-save').click();
  await expect(page.getByTestId('ks-remove')).toBeVisible();
  await page.reload();
  await load(page, join(RESEARCH!, row.file));
  await expect(page.getByRole('button', { name: 'Enter key' })).toBeVisible();
  await page.getByRole('button', { name: 'Enter key' }).click();
  await page.getByTestId('ks-passphrase').fill('local corpus check');
  await page.getByTestId('ks-unlock').click();
  await expect(page.getByTestId('file-name')).toContainText(basename(row.file));
  await expect(page.getByTestId('error-message')).toHaveCount(0);
});
