/**
 * TVW-specific regression tests (from a real Lenovo X1 Carbon Gen9 board that
 * cannot be redistributed; the synthetic fixture reproduces both issues):
 *  1. Route-layer arc records (drill code 0x0B) must be decoded as arcs, never
 *     as straight lines — otherwise stray lines cross the board.
 *  2. Part bodies come from the decal outline placed with the pad transform
 *     (rotate CCW by the part angle, mirror X on the bottom side), not from
 *     the part record's text-inflated box.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { placeOutline, readTvw } from '../../src/formats/tvw';
import { buildScene } from '../../src/scene/scene';
import { ROOT, parse } from '../helpers/load';

const FILE = 'fixtures/synthetic/glasgow.tvw';
const m = parse(FILE).model!;

describe('TVW route layer', () => {
  test('arc records are decoded with centre, radius and float angles', () => {
    const b = readTvw(readFileSync(resolve(ROOT, FILE)));
    const route = b.layers.find((l) => l.kind === 'through' && l.type === 12);
    expect(route?.kind).toBe('through');
    if (route?.kind !== 'through') return;
    expect(route.arcs.length).toBe(2);
    expect(route.arcs.map((a) => [a.start, a.sweep])).toEqual([
      [0, 180],
      [0, -180],
    ]);
    expect(route.arcs[0].r).toBeGreaterThan(0);
  });

  test('outline is a set of closed loops (no dangling or stray segments)', () => {
    const o = m.outline.segs;
    const ends = new Map<string, number>();
    const key = (x: number, y: number) => `${Math.round(x * 4)},${Math.round(y * 4)}`;
    for (let i = 0; i < o.length; i += 4)
      for (const [x, y] of [
        [o[i], o[i + 1]],
        [o[i + 2], o[i + 3]],
      ])
        ends.set(key(x, y), (ends.get(key(x, y)) ?? 0) + 1);
    const odd = [...ends.values()].filter((c) => c % 2 === 1).length;
    expect(odd).toBe(0);
    // No segment longer than the board's longest side (a stray diagonal would be).
    const span = Math.max(m.bounds.maxX - m.bounds.minX, m.bounds.maxY - m.bounds.minY);
    for (let i = 0; i < o.length; i += 4) expect(Math.hypot(o[i + 2] - o[i], o[i + 3] - o[i + 1])).toBeLessThanOrEqual(span);
    expect(m.diagnostics.some((d) => d.code === 'tvw.strayoutline')).toBe(false);
  });
});

describe('TVW part bodies', () => {
  test('placeOutline: rotation and bottom-side mirror match the pad transform', () => {
    // Local point (10, 20) raw (= 0.1, 0.2 mil) of a part at the origin.
    const p = (angle: number, bottom: boolean) => placeOutline([10, 20, 10, 20, 0, 0], 0, 0, angle, bottom)!.slice(0, 2);
    expect(p(0, false)).toEqual([0.1, 0.2]);
    expect(p(90, false)).toEqual([-0.2, 0.1]); // (x, y) → (−y, x)
    expect(p(180, false)).toEqual([-0.1, -0.2]);
    expect(p(270, false)).toEqual([0.2, -0.1]); // (x, y) → (y, −x)
    expect(p(0, true)).toEqual([-0.1, 0.2]); // mirror X after rotation
    expect(p(90, true)).toEqual([0.2, 0.1]);
  });

  test('every pin lies inside its part body and bodies come from the file', () => {
    let outside = 0;
    for (let k = 0; k < m.parts.count; k++) {
      const b = m.parts.bbox.subarray(4 * k, 4 * k + 4);
      for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++)
        if (m.pins.x[j] < b[0] - 0.5 || m.pins.x[j] > b[2] + 0.5 || m.pins.y[j] < b[1] - 0.5 || m.pins.y[j] > b[3] + 0.5) outside++;
    }
    expect(outside).toBe(0);
    expect(m.caps.partBodies).toBe('file');
    // Every part whose decal has a non-degenerate outline uses it; only
    // zero-size decals (fiducials in this fixture) fall back to pin extents.
    const b = readTvw(readFileSync(resolve(ROOT, FILE)));
    const s = buildScene(m);
    for (let k = 0; k < m.parts.count; k++) {
      const p = b.parts.find((x) => x.name === m.parts.name[k])!;
      const o = b.decals[p.decal].outline;
      const degenerate = o.every((v) => v === 0);
      expect(s.bodyDerived[k], m.parts.name[k]).toBe(degenerate ? 1 : 0);
    }
  });

  test('the text-inflated part box from the record is not used as the body', () => {
    // The fixture writes record boxes enlarged by 60×25 mil; bodies must match the decal instead.
    const k = m.parts.name.indexOf('U30');
    const s = buildScene(m);
    let x1 = -Infinity;
    for (let j = s.bodyStart[k] * 4; j < s.bodyStart[k + 1] * 4; j += 2) x1 = Math.max(x1, s.bodySegs[j]);
    let pinMax = -Infinity;
    for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++) pinMax = Math.max(pinMax, m.pins.x[j]);
    expect(x1 - pinMax).toBeLessThan(40);
  });
});

describe('TVW drills and mechanical parts', () => {
  const gencad = parse('fixtures/real/glasgow/glasgow-kicad10.cad').model!;

  test('drill records of through-hole pins are not duplicated as vias', () => {
    let drilledPins = 0;
    for (let i = 0; i < m.pins.count; i++) if (m.pins.hole[i] > 0) drilledPins++;
    expect(drilledPins).toBeGreaterThan(40);
    const d = m.diagnostics.find((x) => x.code === 'tvw.pindrills');
    expect(d?.message).toContain(`${drilledPins} drill record`);
    // Only the real vias of the source board remain as vias.
    expect(m.vias.count).toBe(gencad.vias.count);
  });

  test('drill sizes keep their file values (mil), so holes stay inside their copper', () => {
    const k = m.parts.name.indexOf('MK1');
    const g = gencad.parts.name.indexOf('MK1');
    const i = m.parts.pinStart[k],
      j = gencad.parts.pinStart[g];
    expect(m.pins.hole[i]).toBeCloseTo(Math.round(gencad.pins.hole[j]), 0);
    expect(m.pins.hole[i]).toBeLessThan(m.pins.w[i]);
  });

  test('mounting holes and fiducials are mechanical and drawn dashed', () => {
    const s = buildScene(m);
    for (let k = 0; k < m.parts.count; k++) {
      const mech = /^(MK|FID)\d/.test(m.parts.name[k]);
      expect(m.parts.flags[k] & 1, m.parts.name[k]).toBe(mech ? 1 : 0);
      expect(s.bodyDashed[k], m.parts.name[k]).toBe(mech ? 1 : 0);
    }
  });
});
