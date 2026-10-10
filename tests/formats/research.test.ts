/**
 * Opt-in run over a research corpus that cannot be committed (vendor files):
 *
 *   BS_RESEARCH=/path/to/research-corpus npm test
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
import { parseKeyfile } from '../../src/app/keystore';
import { parseKey44 } from '../../src/formats/fz';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import { validateModel } from '../../src/model/validate';

const ROOT = process.env.BS_RESEARCH;
const MANIFEST = ROOT ? join(ROOT, 'fixtures/manifest.jsonl') : '';

/** Research format id → BoardLoupe readers expected to open every sample of it. */
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
const SETS = new Set(['asc-split', 'con-companion', 'cst-companion', 'cst', 'f2b']);

interface Row {
  format: string;
  file: string;
}
const rows: Row[] = ROOT && existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : [];
const KEYFILE = process.env.BS_RESEARCH_KEYFILE;

const realKeys = KEYFILE && existsSync(KEYFILE) ? parseKeyfile(readFileSync(KEYFILE, 'utf8')).entries : [];
const realKey = (format: string) => realKeys.find((e) => e.format === format)?.key;
const realOptions = {
  ...DEFAULT_OPTIONS,
  fzKey: realKey('fz') ? parseKey44(realKey('fz')!) : undefined,
  caeKey: realKey('cae') ? parseKey44(realKey('cae')!) : undefined,
  xzzKey: realKey('xzz'),
};

describe.skipIf(!rows.length)('research corpus (BS_RESEARCH)', () => {
  const seen = new Set<string>();
  for (const r of rows) {
    const p = join(ROOT!, r.file);
    if (basename(p).startsWith('._')) continue;
    const key = SETS.has(r.format) ? dirname(p) : p;
    if (seen.has(key) || !existsSync(p)) continue;
    seen.add(key);
    test(`${r.format}: ${basename(p)}`, () => {
      const paths = SETS.has(r.format)
        ? readdirSync(dirname(p))
            .filter((f) => !f.startsWith('.') && statSync(join(dirname(p), f)).isFile())
            .map((f) => join(dirname(p), f))
        : [p];
      const out = parseFiles(paths.map((x) => ({ name: basename(x), bytes: new Uint8Array(readFileSync(x)) })), realOptions);
      const encrypted = r.format === 'fz' || r.format === 'cae' || r.format === 'xzz-pcb';
      const want = encrypted && KEYFILE ? [r.format === 'xzz-pcb' ? 'xzz' : r.format] : OPENS[r.format];
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

const allegro15 = rows.find((r) => r.format === 'allegro-brd' && /LA-7201PR10-0221/.test(r.file));
const allegro15Cad = rows.find((r) => r.format === 'gencad' && /LA-7201PR10-0221/.test(r.file));
describe.skipIf(!allegro15 || !allegro15Cad)('Allegro 15.5 against the matching GenCAD export (BS_RESEARCH)', () => {
  test('parts, numbered pads and nets match; copper and outline are present', () => {
    const read = (r: Row) => parseFiles([{ name: basename(r.file), bytes: new Uint8Array(readFileSync(join(ROOT!, r.file))) }], DEFAULT_OPTIONS);
    const native = read(allegro15!).model!;
    const cad = read(allegro15Cad!).model!;
    expect(native.source.variant).toBe('Allegro 15.5');
    expect(validateModel(native)).toEqual([]);
    expect(native.parts.count).toBe(cad.parts.count);
    expect(native.pins.count).toBe(cad.pins.count);
    expect(new Set(native.parts.name)).toEqual(new Set(cad.parts.name));
    const pins = new Map(native.pins.number.map((number, i) => [`${native.parts.name[native.pins.part[i]]}\0${number}`, i]));
    let exactPosition = 0;
    for (let i = 0; i < cad.pins.count; i++) {
      const key = `${cad.parts.name[cad.pins.part[i]]}\0${cad.pins.number[i]}`;
      const j = pins.get(key);
      expect(j, key).toBeDefined();
      const net = (m: typeof native, p: number) => m.pins.net[p] < 0 ? null : m.nets.name[m.pins.net[p]];
      expect(net(native, j!), key).toBe(net(cad, i));
      if (Math.hypot(native.pins.x[j!] - cad.pins.x[i], native.pins.y[j!] - cad.pins.y[i]) < 0.05) exactPosition++;
    }
    // 74 exported pin anchors are offset from the native pad bounding-box centre.
    expect(exactPosition).toBeGreaterThanOrEqual(8394);
    expect(native.layers.map((l) => l.name)).toEqual(['TOP', 'VCC', 'IN1', 'IN2', 'GND', 'BOTTOM']);
    expect(native.vias.count).toBeGreaterThan(6400);
    expect(native.traces.count).toBeGreaterThan(20000);
    expect(native.outline.source).toBe('file');
  });
});

const xzzCopper = rows.find((r) => r.format === 'xzz-pcb' && /RedmiBook 14/.test(r.file));
describe.skipIf(!xzzCopper || !KEYFILE)('XZZ copper layers (BS_RESEARCH_KEYFILE)', () => {
  test('preserves net-associated tracks and vias on their physical layers', () => {
    const out = parseFiles([{ name: basename(xzzCopper!.file), bytes: new Uint8Array(readFileSync(join(ROOT!, xzzCopper!.file))) }], realOptions);
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    const m = out.model!;
    expect(validateModel(m)).toEqual([]);
    expect(m.traces.count).toBe(37948); // 38,146 lines minus 176 outline and 22 silkscreen lines
    expect(m.vias.count).toBe(4342);
    expect(m.layers).toHaveLength(16);
    expect(new Set(m.traces.layer)).toContain(0);
    expect(new Set(m.traces.layer)).toContain(15);
    expect(m.traces.net.filter((n) => n >= 0).length).toBeGreaterThan(35000);
  });
});

const caeGraphics = rows.filter((r) => r.format === 'cae' && !basename(r.file).startsWith('._'));
describe.skipIf(!KEYFILE || caeGraphics.length < 2)('CAE graphic geometry (BS_RESEARCH_KEYFILE)', () => {
  test('both real boards supply outlines and component bodies', () => {
    for (const row of caeGraphics) {
      const out = parseFiles([{ name: basename(row.file), bytes: new Uint8Array(readFileSync(join(ROOT!, row.file))) }], realOptions);
      expect(out.ok).toBe(true);
      const m = out.model!;
      expect(validateModel(m)).toEqual([]);
      expect(m.outline.source).toBe('file');
      expect(m.outline.segs.length / 4).toBeGreaterThanOrEqual(40);
      let bodies = 0;
      for (let i = 0; i < m.parts.count; i++) if (m.parts.bodyStart[i + 1] > m.parts.bodyStart[i]) bodies++;
      expect(bodies).toBeGreaterThan(m.parts.count * 0.99);
      expect(m.traces.count).toBe(0); // these files contain artwork, not net-associated routes
    }
  });
});
