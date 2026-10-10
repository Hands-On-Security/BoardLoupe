import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const APP = 'file://' + resolve(import.meta.dirname, '../../dist/boardloupe.html');
const FILE = `A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!
J!board.brd!0!mils!
S!VCC!R1!1!SUPPLY!
A!REFDES!SYM_NAME!SYM_X!SYM_Y!
J!board.brd!0!mils!
S!R1!R0402!100!200!
A!SYM_NAME!PIN_NUMBER!PIN_X!PIN_Y!REFDES!
J!board.brd!0!mils!
S!R0402!1!90!200!R1!
`;

test('Extracta separate position and connectivity tables open in the browser', async ({ page }) => {
  await page.goto(APP);
  await page.setInputFiles('#bs-file-input', { name: 'separate-tables.fil', mimeType: 'text/plain', buffer: Buffer.from(FILE) });
  await expect(page.getByTestId('file-name')).toHaveText('separate-tables.fil');
  await expect(page.getByTestId('error-message')).toHaveCount(0);
  const net = await page.evaluate(() => {
    const m = (window as unknown as { boardloupe: { viewer: { model: import('../../src/model/types').BoardModel } } }).boardloupe.viewer.model;
    return m.nets.name[m.pins.net[0]];
  });
  expect(net).toBe('VCC');
});
