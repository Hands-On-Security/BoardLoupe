/**
 * Browser benchmark on the built single file (file://):
 *  - load time (file input → board ready), parse/index in the worker
 *  - frame intervals during continuous pan+zoom (requestAnimationFrame)
 * Run `npm run bench` first (creates bench/boards). Then:
 *   npx tsx tools/bench-browser.ts [chromium|firefox|webkit] [--gpu]
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const which = (process.argv[2] ?? 'chromium') as 'chromium' | 'firefox' | 'webkit';
const gpu = process.argv.includes('--gpu');
const files = ['synthetic-10k.brd', 'synthetic-50k.tvw', 'synthetic-100k.brd', 'synthetic-200k.tvw'];

const bt = { chromium, firefox, webkit }[which];
const browser = await bt.launch(which === 'chromium' && gpu ? { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-unsafe-swiftshader=false'] } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file://' + resolve(root, 'dist/boardloupe.html'));
const renderer = (await page.evaluate(`(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'none';
})()`)) as string;
const out: Record<string, unknown>[] = [];
for (const f of files) {
  const t0 = Date.now();
  await page.setInputFiles('#bs-file-input', resolve(root, 'bench/boards', f));
  await page.waitForFunction(`document.querySelector('[data-testid="file-name"]')?.textContent === ${JSON.stringify(f)}`, undefined, { timeout: 120_000 });
  const loadMs = Date.now() - t0;
  // Passed as a string: tsx would otherwise inject helpers that do not exist in the page.
  const r = (await page.evaluate(`(async () => {
    const bs = window.boardloupe;
    const v = bs.viewer;
    v.fit();
    const frames = [];
    await new Promise((done) => {
      let last = performance.now();
      let i = 0;
      function step() {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        if (i < 90) v.zoomBy(1.035, 600, 400);
        else if (i < 180) v.panBy(6, 3);
        else v.zoomBy(1 / 1.05, 700, 450);
        if (++i < 240) requestAnimationFrame(step); else done();
      }
      requestAnimationFrame(step);
    });
    frames.shift();
    const sorted = frames.slice().sort((a, b) => a - b);
    const t = bs.store.get().board.timings;
    return {
      avgFrameMs: +(frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(1),
      p95FrameMs: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
      cpuRenderMs: +v.stats.avgMs.toFixed(2),
      parseMs: Math.round(t.parseMs),
      indexMs: Math.round(t.sceneMs),
      mode: t.mode,
    };
  })()`)) as Record<string, unknown>;
  const row = { browser: which, gpu: renderer, file: f, loadMs, ...r };
  out.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(resolve(root, `bench/results-${which}${gpu ? '-gpu' : ''}.json`), JSON.stringify({ date: new Date().toISOString(), renderer, results: out }, null, 2) + '\n');
await browser.close();
