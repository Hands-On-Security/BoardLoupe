import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = 'file://' + resolve(ROOT, 'dist/boardview.html');
const FX = (p: string) => resolve(ROOT, 'fixtures', p);
const SHOTS = resolve(ROOT, 'test-results/screens');

/** Records every request that is not file:, data: or blob: (must stay empty). */
function trackNetwork(page: Page) {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  return external;
}

async function openApp(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(APP);
  await expect(page.getByTestId('dropzone')).toBeVisible();
  return errors;
}

async function load(page: Page, ...files: string[]) {
  await page.setInputFiles('#bs-file-input', files);
  await expect(page.getByTestId('file-name')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('loading')).toHaveCount(0);
}

async function pinScreen(page: Page, part: string, pin: string) {
  return page.evaluate(
    ([part, pin]) => {
      const bs = (window as unknown as { boardscope: { viewer: { model: import('../../src/model/types').BoardModel }; toScreen: (x: number, y: number) => [number, number] } }).boardscope;
      const m = bs.viewer.model;
      const k = m.parts.name.indexOf(part);
      for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++) if (m.pins.number[j] === pin) return bs.toScreen(m.pins.x[j], m.pins.y[j]);
      return null;
    },
    [part, pin],
  );
}

test.describe('BoardScope single-file app', () => {
  test('empty state, offline guarantee and no console errors', async ({ page }, info) => {
    const net = trackNetwork(page);
    const errors = await openApp(page);
    await expect(page.getByRole('button', { name: /Browse files/ })).toBeVisible();
    await expect(page.getByText('Private by design')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-empty.png` });
    expect(net).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('loads a real GenCAD board, renders, and makes no network requests', async ({ page, context }, info) => {
    const net = trackNetwork(page);
    const errors = await openApp(page);
    await context.setOffline(true);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    await expect(page.getByTestId('file-name')).toHaveText('glasgow-kicad10.cad');
    await expect(page.getByText(/272 parts · 1,149 pins · 251 nets/)).toBeVisible();
    // Parsing ran in the inlined Blob worker (not the main-thread fallback).
    expect(await page.evaluate(() => (window as unknown as { boardscope: { store: { get(): { board: { timings: { mode: string } } } } } }).boardscope.store.get().board.timings.mode)).toBe('worker');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-gencad.png` });
    expect(net).toEqual([]);
    expect(errors.filter((e) => !/GPU stall|WebGL/.test(e))).toEqual([]);
    // The canvas actually contains drawn pixels (not just the background).
    const varied = await page.evaluate(() => {
      // Render and read back in the same task (the WebGL buffer is not preserved).
      (window as unknown as { boardscope: { viewer: { renderNow(): void } } }).boardscope.viewer.renderNow();
      const c = document.querySelector('[data-testid="board"] canvas') as HTMLCanvasElement;
      const tmp = document.createElement('canvas');
      tmp.width = 200;
      tmp.height = 200;
      const g = tmp.getContext('2d')!;
      g.drawImage(c, 0, 0, 200, 200);
      const d = g.getImageData(0, 0, 200, 200).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 16) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    });
    expect(varied).toBeGreaterThan(5);
  });

  test('search → focus part → inspector', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    await page.keyboard.press('/');
    await expect(page.locator('#bs-search')).toBeFocused();
    await page.keyboard.type('U30');
    await expect(page.getByRole('option').first()).toContainText('U30');
    await page.keyboard.press('Enter');
    const insp = page.getByTestId('inspector');
    await expect(insp.getByRole('heading', { name: 'U30' })).toBeVisible();
    await expect(insp.getByText('Component')).toBeVisible();
    await expect(insp.getByText(/\d+ pins/).first()).toBeVisible();
  });

  test('click a pin → pin details and net highlight; Esc clears', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    // Zoom onto U1 first so pins are large enough to hit.
    await page.keyboard.press('/');
    await page.keyboard.type('U1');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const p = await pinScreen(page, 'U1', '12');
    expect(p).not.toBeNull();
    const box = (await page.getByTestId('board-canvas').boundingBox())!;
    await page.mouse.click(box.x + p![0], box.y + p![1]);
    const insp = page.getByTestId('inspector');
    await expect(insp.getByRole('heading', { name: 'U1.12' })).toBeVisible();
    await expect(insp.getByText('Net members')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(insp.getByText('Nothing selected.')).toBeVisible();
  });

  test('net → ranked solder / probe points, jump to one', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    await page.keyboard.press('/');
    await page.keyboard.type('SDA');
    await expect(page.getByRole('option').first()).toBeVisible();
    // Select the net result explicitly.
    await page.getByRole('option').filter({ hasText: 'NET' }).first().click();
    const insp = page.getByTestId('inspector');
    await expect(insp.getByText('Solder / probe points')).toBeVisible();
    await expect(insp.getByText('easiest first')).toBeVisible();
    // Jump to the top-ranked point; selection moves to a pin/test point or via.
    const firstPoint = insp.locator('button', { hasText: /test point|via|pad|through-hole|connector/ }).first();
    await expect(firstPoint).toBeVisible();
    await firstPoint.click();
    // Selection moved to an individual point (pin, test point or via).
    await expect(insp.getByText(/^(Pin|Test point|Via \/ hole)$/).first()).toBeVisible();
  });

  test('show only this side: hide / ghost the other side (toolbar and G)', async ({ page }) => {
    await openApp(page);
    await load(page, FX('synthetic/glasgow.tvw')); // has top and bottom parts
    const other = () => page.evaluate(() => (window as unknown as { boardscope: { viewer: { opts: { otherSide: string } } } }).boardscope.viewer.opts.otherSide);
    await expect.poll(other).toBe('ghost');
    // Toolbar control: one click shows only the current side.
    await page.getByRole('button', { name: /only this side/i }).click();
    await expect.poll(other).toBe('hide');
    await page.getByRole('button', { name: /show the other side/i }).click();
    await expect.poll(other).toBe('ghost');
    // Keyboard shortcut (shortcuts are suppressed while an input is focused).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('g');
    await expect.poll(other).toBe('hide');
  });

  test('side switching, mirror, rotate, zoom and fit', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad-boardview.brd'));
    const top = page.getByRole('button', { name: 'Top', exact: true });
    const bottom = page.getByRole('button', { name: 'Bottom', exact: true });
    await expect(top).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('board-canvas').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Space');
    await expect(bottom).toHaveAttribute('aria-pressed', 'true');
    const mirrored = await page.evaluate(() => (window as unknown as { boardscope: { viewer: { view: { mirror: boolean } } } }).boardscope.viewer.view.mirror);
    expect(mirrored).toBe(true);
    const zoomText = page.locator('footer').getByText(/^\d+%$/);
    await expect(zoomText).toHaveText('100%');
    const box = (await page.getByTestId('board-canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await expect(zoomText).not.toHaveText('100%');
    await page.keyboard.press('r');
    expect(await page.evaluate(() => (window as unknown as { boardscope: { viewer: { view: { rot: number } } } }).boardscope.viewer.view.rot)).toBe(90);
    await page.keyboard.press('f');
    await expect(zoomText).toHaveText('100%');
    // drag pans
    const before = await page.evaluate(() => (window as unknown as { boardscope: { viewer: { view: { cx: number } } } }).boardscope.viewer.view.cx);
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 340, { steps: 6 });
    await page.mouse.up();
    const after = await page.evaluate(() => (window as unknown as { boardscope: { viewer: { view: { cx: number; cy: number } } } }).boardscope.viewer.view);
    expect(after.cx !== before).toBe(true);
  });

  test('tables dialog and CSV export', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    await page.keyboard.press('t');
    const dlg = page.getByRole('dialog', { name: 'Tables & export' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('tab', { name: 'nets' }).click();
    await dlg.getByLabel('Filter nets').fill('GND');
    const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: /CSV/ }).click()]);
    const path = await dl.path();
    const csv = readFileSync(path!, 'utf8');
    expect(csv.split('\r\n')[0]).toBe('Net,Pins,Parts');
    expect(csv).toContain('GND,');
    const [dj] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: /JSON/ }).click()]);
    const json = JSON.parse(readFileSync((await dj.path())!, 'utf8'));
    expect(json.schema).toBe('boardscope/board@1');
    expect(json.parts.length).toBe(272);
  });

  test('highlighted pads on a ghosted or hidden side do not show through the board', async ({ page }) => {
    await openApp(page);
    await load(page, FX('synthetic/glasgow.tvw'));
    // Count framebuffer pixels in the single-net highlight colour, rendered and read in one task.
    const counts = await page.evaluate(() => {
      type BS = { store: { set: (p: object) => void }; viewer: { model: import('../../src/model/types').BoardModel; renderNow: () => void; setOptions: (o: object) => void; palette: { selNet: number[] } } };
      const bs = (window as unknown as { boardscope: BS }).boardscope;
      const m = bs.viewer.model;
      // A small net whose pins are all on the top side and which has no vias (vias go through the board).
      let net = -1;
      for (let n = 0; n < m.nets.count && net < 0; n++) {
        const a = m.nets.pinStart[n],
          b = m.nets.pinStart[n + 1];
        if (b - a < 2 || b - a > 10) continue;
        let ok = true;
        for (let j = a; j < b; j++) if (m.pins.side[m.nets.pinIndex[j]] !== 1) ok = false;
        for (let i = 0; i < m.vias.count && ok; i++) if (m.vias.net[i] === n) ok = false;
        if (ok) net = n;
      }
      bs.store.set({ sel: { kind: 'net', index: net, multi: [], nets: [] } });
      const c = document.querySelector('[data-testid=board] canvas') as HTMLCanvasElement;
      const g = c.getContext('webgl2')!;
      const [r0, g0, b0] = bs.viewer.palette.selNet;
      const count = () => {
        bs.viewer.renderNow();
        const px = new Uint8Array(c.width * c.height * 4);
        g.readPixels(0, 0, c.width, c.height, g.RGBA, g.UNSIGNED_BYTE, px);
        let k = 0;
        for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - r0) < 24 && Math.abs(px[i + 1] - g0) < 24 && Math.abs(px[i + 2] - b0) < 24) k++;
        return k;
      };
      bs.viewer.setOptions({ side: 1, otherSide: 'ghost' });
      const top = count();
      bs.viewer.setOptions({ side: 2, otherSide: 'ghost' });
      const ghosted = count();
      bs.viewer.setOptions({ side: 2, otherSide: 'hide' });
      const hidden = count();
      return { net, top, ghosted, hidden };
    });
    expect(counts.net).toBeGreaterThanOrEqual(0);
    expect(counts.top).toBeGreaterThan(20); // beacons visible on their own side
    expect(counts.hidden).toBe(0); // nothing shows through a hidden side
    expect(counts.ghosted).toBeLessThan(counts.top * 0.1); // ghosted, not full-strength
  });

  test('highlight group: add, legend, save and re-apply', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    const insp = page.getByTestId('inspector');
    // Two nets via search, each added to the group.
    for (const q of ['/SDA', '/SCL']) {
      await page.keyboard.press('/');
      await page.keyboard.type(q);
      // Wait for this query's results (search is debounced), then pick the net.
      await page.getByRole('option').filter({ hasText: q }).filter({ hasText: 'net' }).first().click();
      await expect(insp.getByRole('heading', { name: q })).toBeVisible();
      await insp.getByRole('button', { name: /Group/ }).click();
    }
    const legend = page.getByTestId('highlight-legend');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('/SDA');
    await expect(legend).toContainText('/SCL');
    // The group survives clearing the selection.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(legend).toContainText('/SDA');
    // Save it, clear it, re-apply it.
    await page.getByRole('tab', { name: /Groups/ }).click();
    const panel = page.getByTestId('groups-panel');
    await panel.getByLabel('Group name').fill('I2C bus');
    await panel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(panel.getByRole('list', { name: 'Saved groups' })).toContainText('I2C bus');
    await panel.getByRole('button', { name: 'Clear' }).click();
    await expect(legend).toHaveCount(0);
    await panel.getByRole('list', { name: 'Saved groups' }).getByRole('button', { name: /I2C bus/ }).click();
    await expect(page.getByTestId('highlight-legend')).toContainText('/SCL');
    // Saved groups persist in this browser only.
    const stored = await page.evaluate(() => localStorage.getItem('boardscope.groups.v1'));
    expect(stored).toContain('I2C bus');
  });

  test('report: A4 preview with highlighted nets, self-contained HTML without scripts', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    await page.keyboard.press('/');
    await page.keyboard.type('/SDA');
    await page.getByRole('option').filter({ hasText: 'net' }).first().click();
    await page.keyboard.press('a'); // add to group (focus left the search box on click)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    type V = { cx: number; cy: number; scale: number; width: number; height: number };
    const viewNow = () => page.evaluate(() => {
      const v = (window as unknown as { boardscope: { viewer: { view: V } } }).boardscope.viewer.view;
      return [v.cx, v.cy, v.scale, v.width, v.height];
    });
    const before = await viewNow();
    await page.keyboard.press('Control+p');
    const dlg = page.getByRole('dialog', { name: 'Report' });
    await expect(dlg).toBeVisible();
    await dlg.getByPlaceholder(/board analysis/).fill('I2C <script>alert(1)</script> audit');
    const preview = dlg.getByTestId('report-preview');
    await expect.poll(async () => (await preview.getAttribute('srcdoc')) ?? '').toContain('I2C &lt;script&gt;');
    const frame = page.frameLocator('[data-testid=report-preview]');
    await expect(frame.locator('h1')).toHaveText('I2C <script>alert(1)</script> audit');
    await expect(frame.locator('table.data')).toContainText('/SDA');
    await expect(frame.locator('figure img')).toHaveCount(1);
    // The board image fills the report's 184 x 116 mm frame (extended view, no letterbox) ...
    const [iw, ih] = await frame.locator('figure img').evaluate((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight]);
    expect(Math.abs(iw / ih - 184 / 116)).toBeLessThan(0.01);
    // ... and capturing it leaves the on-screen view untouched.
    expect(await viewNow()).toEqual(before);
    const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: /Download HTML/ }).click()]);
    const html = readFileSync((await dl.path())!, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('size: A4 portrait');
    expect(html).toContain('hos.direct/boardscope');
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
  });

  test('unsupported file shows a precise error', async ({ page }) => {
    await openApp(page);
    await page.setInputFiles('#bs-file-input', { name: 'mystery.brd', mimeType: 'application/octet-stream', buffer: Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 2654435761) >>> 24)) });
    await expect(page.getByTestId('error')).toBeVisible();
    await expect(page.getByTestId('error-message')).toContainText('No supported boardview signature');
  });

  test('encrypted FZ without key explains how to proceed', async ({ page }) => {
    await openApp(page);
    await page.setInputFiles('#bs-file-input', FX('synthetic/glasgow-rc6-testkey.fz'));
    await expect(page.getByTestId('error-message')).toContainText('encrypted');
    await expect(page.getByRole('button', { name: 'Enter key' })).toBeVisible();
  });

  test('every verified fixture format opens', async ({ page }) => {
    await openApp(page);
    const files = [
      'synthetic/glasgow.tvw',
      'synthetic/glasgow-testlink-obfuscated.brd',
      'synthetic/glasgow.bdv',
      'synthetic/glasgow-format1.bvr',
      'real/glasgow/glasgow-kicad-boardview.bvr',
      'synthetic/glasgow-zlib.fz',
      'synthetic/glasgow-panel.cad',
      'synthetic/glasgow.fatf',
      'synthetic/glasgow.far',
      'real/glasgow/glasgow.kicad_pcb',
    ];
    for (const f of files) {
      await page.setInputFiles('#bs-file-input', FX(f));
      await expect(page.getByTestId('file-name')).toHaveText(f.split('/').pop()!, { timeout: 30_000 });
      await expect(page.getByText(/\d[\d,]* parts · [\d,]+ pins/)).toBeVisible();
    }
  });

  test('KiCad board: real outline, file bodies, through-hole drills and copper layers', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow.kicad_pcb'));
    const info = await page.evaluate(() => {
      const m = (window as unknown as { boardscope: { viewer: { model: import('../../src/model/types').BoardModel } } }).boardscope.viewer.model;
      let drilled = 0;
      for (let i = 0; i < m.pins.count; i++) if (m.pins.hole[i] > 0) drilled++;
      return { fmt: m.source.formatId, outline: m.outline.source, bodies: m.caps.partBodies, layers: m.layers.length, drilled, traces: m.traces.count };
    });
    expect(info).toMatchObject({ fmt: 'kicad', outline: 'file', bodies: 'file', layers: 4 });
    expect(info.drilled).toBeGreaterThan(100);
    expect(info.traces).toBeGreaterThan(4000);
    await page.keyboard.press('/');
    await page.keyboard.type('U30');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector').getByRole('heading', { name: 'U30' })).toBeVisible();
  });

  test('multi-file ASC set', async ({ page }) => {
    await openApp(page);
    await load(page, FX('synthetic/asc/pins.asc'), FX('synthetic/asc/format.asc'), FX('synthetic/asc/nails.asc'));
    await expect(page.getByText(/264 parts/)).toBeVisible();
  });

  test('theme preference persists (localStorage only for settings)', async ({ page }) => {
    await openApp(page);
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByRole('button', { name: /theme/i }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
    const after = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.reload();
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(after);
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys).toEqual(['boardscope.prefs.v1']);
  });

  test('picking on the mirrored bottom side and selection history', async ({ page }) => {
    await openApp(page);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    // Find a bottom-side part and show it via search (switches to the bottom view).
    const name = (await page.evaluate(`(() => {
      const m = boardscope.viewer.model;
      for (let k = 0; k < m.parts.count; k++) if (m.parts.side[k] === 2 && m.parts.pinCount[k] === 2) return m.parts.name[k];
    })()`)) as string;
    await page.keyboard.press('/');
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Bottom', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(`boardscope.viewer.view.mirror`)).toBe(true);
    const p = await pinScreen(page, name, '2');
    const box = (await page.getByTestId('board-canvas').boundingBox())!;
    await page.mouse.click(box.x + p![0], box.y + p![1]);
    const insp = page.getByTestId('inspector');
    await expect(insp.getByRole('heading', { name: `${name}.2` })).toBeVisible();
    // Back returns to the part, forward to the pin.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(insp.getByRole('heading', { name })).toBeVisible();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(insp.getByRole('heading', { name: `${name}.2` })).toBeVisible();
  });

  test('drill holes are drawn inside their pads, even under overlapping copper', async ({ page }) => {
    await openApp(page);
    await load(page, FX('synthetic/glasgow.tvw'));
    // Hide labels (the refdes sits on the hole centre), zoom to mounting hole MK1:
    // one large drilled pad plus small stitching vias that lie on its copper ring.
    await page.evaluate(`boardscope.store.set({ prefs: { ...boardscope.store.get().prefs, showPartLabels: false, showPinLabels: false, showNetLabels: false } })`);
    const pts = (await page.evaluate(`(() => {
      const v = boardscope.viewer, m = v.model;
      const k = m.parts.name.indexOf('MK1');
      const a = m.parts.pinStart[k], n = m.parts.pinCount[k];
      let big = a, small = a;
      for (let j = a; j < a + n; j++) {
        if (m.pins.hole[j] > m.pins.hole[big]) big = j;
        if (m.pins.hole[j] > 0 && m.pins.hole[j] < m.pins.hole[small]) small = j;
      }
      const r = m.pins.w[big];
      v.focus({ minX: m.pins.x[big] - r, minY: m.pins.y[big] - r, maxX: m.pins.x[big] + r, maxY: m.pins.y[big] + r }, 1000);
      return [boardscope.toScreen(m.pins.x[big], m.pins.y[big]), boardscope.toScreen(m.pins.x[small], m.pins.y[small])];
    })()`)) as [number, number][];
    await page.waitForTimeout(150);
    const box = (await page.getByTestId('board-canvas').boundingBox())!;
    for (const [sx, sy] of pts) {
      // Sample a real screenshot (engine-independent; WebGL buffers are not readable everywhere).
      const png = await page.screenshot({ clip: { x: box.x + sx - 1, y: box.y + sy - 1, width: 3, height: 3 } });
      const rgb = (await page.evaluate(`new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          const d = g.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
          res([d[0], d[1], d[2]]);
        };
        img.src = 'data:image/png;base64,${png.toString('base64')}';
      })`)) as number[];
      // Dark theme hole background is rgb(11,14,19); copper would be far brighter.
      expect(Math.max(...rgb)).toBeLessThan(40);
    }
  });

  test('drag and drop a file onto the window', async ({ page }) => {
    await openApp(page);
    const b64 = readFileSync(FX('synthetic/glasgow.bdv')).toString('base64');
    await page.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.bdv'));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    })()`);
    await expect(page.getByTestId('file-name')).toHaveText('dropped.bdv', { timeout: 30_000 });
    await expect(page.getByText(/264 parts/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('Canvas 2D fallback renderer draws the board', async ({ page }) => {
    await openApp(page);
    await page.evaluate(`boardscope.store.set({ prefs: { ...boardscope.store.get().prefs, forceCanvas2d: true } })`);
    await load(page, FX('real/glasgow/glasgow-kicad10.cad'));
    await expect(page.locator('footer').getByText('Canvas 2D')).toBeVisible();
    const varied = await page.evaluate(`(() => {
      boardscope.viewer.renderNow();
      const c = document.querySelector('[data-testid="board"] canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 64) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    })()`);
    expect(varied).toBeGreaterThan(5);
    // Selection works the same way.
    await page.keyboard.press('/');
    await page.keyboard.type('U5');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector').getByRole('heading', { name: 'U5' })).toBeVisible();
  });

  test('laptop-size layout screenshot', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openApp(page);
    await load(page, FX('synthetic/glasgow.tvw'));
    await page.keyboard.press('/');
    await page.keyboard.type('gnd');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector').getByRole('heading', { name: 'GND' })).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-laptop-tvw-net.png` });
    // No horizontal overflow of the app shell.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
