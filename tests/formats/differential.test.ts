/**
 * Differential tests: every manifest fixture is parsed by BoardLoupe and the
 * result is compared with the output of the reference C++ parsers
 * (OpenBoardView + eagleview TVW reader) stored in fixtures/golden.
 *
 * Intentional, documented convention differences are normalised here:
 *  - The reference stores coordinates as integer mils; BoardLoupe keeps the
 *    file's native unit (inch for ASC/BDV/BVR1/CAD) and fractional values.
 *  - The reference models test points/vias as pins of dummy "..." parts;
 *    BoardLoupe keeps them as unowned test-point pins or vias.
 *  - "UNCONNECTED", "NC@n" (GenCAD) and empty net names all mean "no net".
 *  - GenCAD: the reference rounds part placement and pin offsets to integer
 *    mils separately (up to ~2 mil drift); BoardLoupe keeps full precision,
 *    which matches KiCad's own BRD export to <1 mil (see cross-format test).
 *  - TVW: the reference adapter ignores drill holes; BoardLoupe exposes them
 *    as vias, so vias are excluded from the TVW test-point comparison.
 *  - TVW: the reference reads route-layer arc records (drill code 0x0B) as
 *    straight slots, producing stray lines (on a real Lenovo board: long
 *    diagonals to the origin). BoardLoupe decodes them as arcs, so only the
 *    straight route edges are compared; closure is tested in tvw.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseKey44 } from '../../src/formats/fz';
import { readTvw } from '../../src/formats/tvw';
import { validateModel } from '../../src/model/validate';
import { type BoardModel, PINKIND_TESTPOINT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP } from '../../src/model/types';
import type { ManifestEntry } from '../../tools/gen-fixtures';
import { ROOT, parse } from '../helpers/load';

interface GPart {
  name: string;
  side: 'top' | 'bottom' | 'both';
  type: 'smd' | 'th';
}
interface GPin {
  x: number;
  y: number;
  part: number;
  side: string;
  net: string | null;
  snum: string | null;
  name: string | null;
}
interface Golden {
  valid: boolean;
  parts: GPart[];
  pins: GPin[];
  nails: { probe: number; x: number; y: number; side: string; net: string }[];
  format: [number, number][];
  outline_segments: [number, number, number, number][];
}

const manifest: ManifestEntry[] = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/manifest.json'), 'utf8'));
const INCH_FORMATS = new Set(['bdv', 'asc', 'bvr1', 'cad-panel']);
/** Position tolerance in reference units (mils). */
const TOLERANCE: Record<string, number> = { gencad: 2.5 };
/** Formats whose reference implementation maps vias/drills to nails. */
const REF_HAS_VIAS = new Set(['gencad', 'cad-panel']);

const normNet = (n: string | null | undefined) => (!n || n === 'UNCONNECTED' || /^NC@\d+$/.test(n) ? '' : n);
const sideOf = (s: number) => (s === SIDE_TOP ? 'top' : s === SIDE_BOTTOM ? 'bottom' : s === SIDE_BOTH ? 'both' : 'none');

function optionsFor(e: ManifestEntry) {
  if (!e.key) return {};
  if (e.format === 'fz') return { fzKey: parseKey44(e.key) };
  if (e.format === 'cae') return { caeKey: parseKey44(e.key) };
  if (e.format === 'xzz') return { xzzKey: e.key };
  return {};
}

function compare(e: ManifestEntry, m: BoardModel, g: Golden): string[] {
  const errs: string[] = [];
  const f = INCH_FORMATS.has(e.format) ? 1000 : 1;
  const tol = TOLERANCE[e.format] ?? 1.01;
  const close = (a: number, b: number) => Math.abs(a * f - b) <= tol;

  // Real parts (reference dummies "..." hold test points / vias / orphans).
  const gParts = g.parts.map((p, i) => ({ ...p, idx: i + 1 })).filter((p) => !p.name?.startsWith('...'));
  const gPinsByPart = new Map<number, GPin[]>();
  for (const p of g.pins) {
    const l = gPinsByPart.get(p.part);
    if (l) l.push(p);
    else gPinsByPart.set(p.part, [p]);
  }
  if (gParts.length !== m.parts.count) errs.push(`part count: ours ${m.parts.count}, reference ${gParts.length}`);
  const n = Math.min(gParts.length, m.parts.count);
  let pinChecks = 0;
  for (let k = 0; k < n && errs.length < 25; k++) {
    const gp = gParts[k];
    if (gp.name !== m.parts.name[k]) {
      errs.push(`part ${k}: name ours "${m.parts.name[k]}" vs "${gp.name}"`);
      continue;
    }
    // Side: the reference marks through-hole parts "both" in some formats only.
    const ours = sideOf(m.parts.side[k]);
    if (ours !== gp.side && !(gp.side === 'both' && ours !== 'none') && !(ours === 'both' && gp.type === 'th'))
      errs.push(`part ${gp.name}: side ours ${ours} vs ${gp.side}`);
    const gpins = gPinsByPart.get(gp.idx) ?? [];
    const c = m.parts.pinCount[k];
    if (gpins.length !== c) {
      errs.push(`part ${gp.name}: pin count ours ${c} vs ${gpins.length}`);
      continue;
    }
    for (let j = 0; j < c; j++) {
      const i = m.parts.pinStart[k] + j;
      const q = gpins[j];
      pinChecks++;
      if (!close(m.pins.x[i], q.x) || !close(m.pins.y[i], q.y)) errs.push(`pin ${gp.name}#${j}: pos ours (${m.pins.x[i] * f}, ${m.pins.y[i] * f}) vs (${q.x}, ${q.y})`);
      const net = m.pins.net[i] >= 0 ? m.nets.name[m.pins.net[i]] : '';
      if (normNet(net) !== normNet(q.net)) errs.push(`pin ${gp.name}#${j}: net ours "${net}" vs "${q.net}"`);
      if (q.snum !== null && q.snum !== undefined) {
        const want = (q.snum === '0' || q.snum === '') && q.name ? q.name : q.snum;
        if (m.pins.number[i] !== want) errs.push(`pin ${gp.name}#${j}: number ours "${m.pins.number[i]}" vs "${want}"`);
      }
    }
  }
  expect(pinChecks, 'pins compared').toBeGreaterThan(0);

  // Test points / nails / vias.
  const gPoints = [...g.nails.map((x) => ({ x: x.x, y: x.y, net: normNet(x.net) })), ...g.pins.filter((p) => g.parts[p.part - 1]?.name?.startsWith('...')).map((p) => ({ x: p.x, y: p.y, net: normNet(p.net) }))];
  const ours: { x: number; y: number; net: string }[] = [];
  for (let i = 0; i < m.pins.count; i++) if (m.pins.part[i] < 0 || m.pins.kind[i] === PINKIND_TESTPOINT) ours.push({ x: m.pins.x[i] * f, y: m.pins.y[i] * f, net: normNet(m.pins.net[i] >= 0 ? m.nets.name[m.pins.net[i]] : '') });
  if (REF_HAS_VIAS.has(e.format)) for (let i = 0; i < m.vias.count; i++) ours.push({ x: m.vias.x[i] * f, y: m.vias.y[i] * f, net: normNet(m.vias.net[i] >= 0 ? m.nets.name[m.vias.net[i]] : '') });
  // BRD/BRD2 nails duplicate as pins of dummy parts in the reference.
  const uniq = (l: { x: number; y: number; net: string }[]) => {
    const s = new Map<string, { x: number; y: number; net: string }>();
    for (const p of l) s.set(`${Math.round(p.x)}|${Math.round(p.y)}|${p.net}`, p);
    return [...s.values()];
  };
  const A = uniq(gPoints),
    B = uniq(ours);
  if (Math.abs(A.length - B.length) > 0) errs.push(`test point/via count: ours ${B.length} vs reference ${A.length}`);
  else {
    // Nearest-neighbour match within tolerance (bucketed grid).
    const cell = 8;
    const grid = new Map<string, { x: number; y: number }[]>();
    for (const p of B) {
      const k = `${Math.floor(p.x / cell)}|${Math.floor(p.y / cell)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
    }
    const missing = A.filter((p) => {
      const cx = Math.floor(p.x / cell),
        cy = Math.floor(p.y / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const q of grid.get(`${cx + dx}|${cy + dy}`) ?? []) if (Math.abs(q.x - p.x) <= tol + 0.5 && Math.abs(q.y - p.y) <= tol + 0.5) return false;
      return true;
    });
    if (missing.length) errs.push(`${missing.length} test points/vias not matched, e.g. (${missing[0]?.x}, ${missing[0]?.y})`);
  }

  // Outline: reference keeps polylines in `format` and segments in `outline_segments`.
  const gSegs = g.outline_segments.length;
  const gPts = g.format.length;
  const ourSegs = m.outline.segs.length / 4;
  if (m.outline.source === 'file' && e.format === 'tvw') {
    // Straight route edges only (see header comment); each must exist in ours.
    const board = readTvw(readFileSync(resolve(ROOT, e.files[0])));
    const arcRecords = board.layers.reduce((n, l) => n + (l.kind === 'through' ? l.arcs.length : 0), 0);
    const straight = g.outline_segments.length - arcRecords;
    const ours = new Set<string>();
    for (let i = 0; i < m.outline.segs.length; i += 4) ours.add(m.outline.segs.slice(i, i + 4).map((v) => Math.round(v)).join(','));
    const found = g.outline_segments.filter((sg) => ours.has(sg.join(','))).length;
    if (found < straight) errs.push(`only ${found} of ${straight} straight route edges found`);
  } else if (m.outline.source === 'file') {
    const want = gSegs || Math.max(0, gPts - 1);
    if (Math.abs(ourSegs - want) > Math.max(2, want * 0.02)) errs.push(`outline segments: ours ${ourSegs} vs reference ${want}`);
  }
  return errs;
}

describe('differential: BoardLoupe vs reference parsers', () => {
  for (const e of manifest) {
    test(`${e.id} (${e.format}, ${e.origin})`, () => {
      const out = parse(e.files, optionsFor(e));
      expect(out.ok, JSON.stringify(out.diagnostics.slice(0, 3))).toBe(true);
      const m = out.model!;
      expect(m.source.formatId).toBe(e.format);
      expect(validateModel(m)).toEqual([]);
      expect(m.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
      if (!e.obv) return;
      const g: Golden = JSON.parse(readFileSync(resolve(ROOT, `fixtures/golden/${e.id}.obv.json`), 'latin1'));
      expect(g.valid).toBe(true);
      const errs = compare(e, m, g);
      expect(errs.slice(0, 12)).toEqual([]);
    });
  }
});
