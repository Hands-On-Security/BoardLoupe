/**
 * Opt-in run over a research corpus that cannot be committed (vendor files):
 *
 *   BS_RESEARCH=/path/to/boardscope-research npm test
 *
 * The corpus has fixtures/manifest.jsonl with one {format, file} row per
 * sample. Rows of a format listed in OPENS must open with integrity; every
 * other row must at least fail with an explanation. Set-like formats (split
 * ASC tables, companion files) are opened as a whole directory, like a folder
 * drop.
 */
import { unzipSync } from 'fflate';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { _fab, placePoint } from '../../src/formats/fabmaster';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import { validateModel } from '../../src/model/validate';

const ROOT = process.env.BS_RESEARCH;
const MANIFEST = ROOT ? join(ROOT, 'fixtures/manifest.jsonl') : '';

/** Research format id → BoardScope readers expected to open every sample of it. */
const OPENS: Record<string, string[]> = {
  brd2: ['brd2-brdout'],
  'landrex-brd': ['brd-testlink'],
  gr: ['brd2-brdout'],
  'con-companion': ['brd2-brdout', 'brd-testlink'],
  bvr3: ['bvr3'],
  bdv: ['bdv'],
  cst: ['cst'],
  'asc-split': ['asc'],
  'mentor-neutral': ['cad-panel'],
  'fabmaster-fatf': ['fabmaster'],
  faz: ['fabmaster'],
  'gencam-a3p': ['gencam'],
  tvw: ['tvw'],
  f2b: ['f2b'],
  'bv-jet': ['bv'],
  'allegro-brd': ['allegro'],
};
/** Samples that are expected not to open (with an explanation). */
const EXPLAINED = [/LA-7201PR10-0221\.brd-156_final\.brd$/]; // Allegro 15.5: pre-16 record layout
const SETS = new Set(['asc-split', 'con-companion', 'cst-companion', 'cst', 'f2b']);

interface Row {
  format: string;
  file: string;
}
const rows: Row[] = ROOT && existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : [];

describe.skipIf(!rows.length)('research corpus (BS_RESEARCH)', () => {
  const seen = new Set<string>();
  for (const r of rows) {
    const p = join(ROOT!, r.file);
    const key = SETS.has(r.format) ? dirname(p) : p;
    if (seen.has(key) || !existsSync(p)) continue;
    seen.add(key);
    test(`${r.format}: ${basename(p)}`, () => {
      const paths = SETS.has(r.format)
        ? readdirSync(dirname(p))
            .filter((f) => !f.startsWith('.') && statSync(join(dirname(p), f)).isFile())
            .map((f) => join(dirname(p), f))
        : [p];
      const out = parseFiles(paths.map((x) => ({ name: basename(x), bytes: new Uint8Array(readFileSync(x)) })), DEFAULT_OPTIONS);
      const want = EXPLAINED.some((re) => re.test(r.file)) ? undefined : OPENS[r.format];
      if (!want) {
        if (out.ok) return; // a format that started opening: add it to OPENS
        expect(out.diagnostics[0]?.message.length ?? 0).toBeGreaterThan(20);
        return;
      }
      expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
      const m = out.model!;
      expect(want).toContain(m.source.formatId);
      expect(validateModel(m)).toEqual([]);
      expect(m.pins.count).toBeGreaterThan(0);
    });
  }
});

// Fabmaster placement: every FABXYDATA pin position of a real FARC job.
const faz = rows.find((r) => r.format === 'faz' && /H61M/.test(r.file));
describe.skipIf(!faz)('Fabmaster FARC placement against FABXYDATA (BS_RESEARCH)', () => {
  test('every pin lands on its absolute position', () => {
    const files = unzipSync(new Uint8Array(readFileSync(join(ROOT!, faz!.file))));
    const far = Object.entries(files).find(([n]) => /\.far$/i.test(n))!;
    const job = _fab.readFarc(new TextDecoder('latin1').decode(far[1]));
    const parts = new Map(job.parts.map((p) => [p.id, p]));
    let ok = 0,
      total = 0;
    for (const [key, [x, y]] of job.xy) {
      const [id, idx] = key.split(':').map(Number);
      const p = parts.get(id)!;
      const pin = (job.packages.get(p.pkgKey ?? p.pkg) ?? job.packages.get(p.pkg))?.pins.get(idx);
      if (!pin) continue;
      total++;
      const [px, py] = placePoint(p, pin.x, pin.y);
      if (Math.hypot(px - x, py - y) < 0.02) ok++;
    }
    expect(total).toBeGreaterThan(6000);
    expect(ok).toBe(total);
  });
});
