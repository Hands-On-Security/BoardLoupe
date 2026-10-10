/**
 * Native Allegro reader on synthetic 16.6 and 17.2 databases of the Glasgow
 * board (record layouts as measured on real boards; the real boards cannot
 * be redistributed — see FORMAT_MATRIX.md for the comparison with KiCad).
 */
import { describe, expect, test } from 'vitest';
import { SHAPE_CIRCLE, SIDE_BOTTOM } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { loadSource } from '../../tools/fixtures/source';
import { ROOT, parse } from '../helpers/load';

const src = loadSource(ROOT);

describe.each([
  ['16.6', 'fixtures/synthetic/glasgow-allegro16.brd'],
  ['17.2', 'fixtures/synthetic/glasgow-allegro17.brd'],
])('Allegro %s', (release, file) => {
  const out = parse(file);
  const m = out.model!;

  test('parses with integrity and names its release', () => {
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(m.source.formatId).toBe('allegro');
    expect(m.source.variant).toBe(`Allegro ${release}`);
    expect(validateModel(m)).toEqual([]);
    expect(m.units).toMatchObject({ unit: 'mil', assumed: false });
  });

  test('parts, footprints, sides and copper layer names', () => {
    expect(m.parts.count).toBe(src.parts.length);
    const p = src.parts.find((q) => q.side === 'B' && !q.th)!;
    const k = m.parts.name.indexOf(p.name);
    expect(m.parts.side[k]).toBe(SIDE_BOTTOM);
    expect(m.parts.footprint[k]).toBe(p.footprint || null);
    expect(m.layers.map((l) => l.name)).toEqual(['TOP', 'IN1', 'BOTTOM']);
  });

  test('vias, tracks and the board outline', () => {
    expect(m.vias.count).toBe(src.vias.length);
    expect(m.traces.count).toBe(src.traces.filter((t) => t.x1 !== t.x2 || t.y1 !== t.y2).length);
    expect(m.outline.source).toBe('file');
    expect(m.outline.segs.length / 4).toBe(src.outlineSegs.length);
    let drilled = 0;
    for (let i = 0; i < m.pins.count; i++) if (m.pins.hole[i] > 0) drilled++;
    expect(drilled).toBe(src.parts.reduce((n, p) => n + p.pins.filter((q) => q.hole > 0).length, 0));
  });

  test('part body outlines from graphic groups, and round pad shapes', () => {
    // Every part has a silkscreen body, read from the package-geometry graphic groups.
    expect(m.caps.partBodies).toBe('file');
    let withBody = 0;
    for (let k = 0; k < m.parts.count; k++) if (m.parts.bodyStart[k + 1] > m.parts.bodyStart[k]) withBody++;
    expect(withBody).toBe(m.parts.count);
    // Round source pads are read as circles in both 16.x and 17.x.
    const roundInSrc = src.parts.reduce((n, p) => n + p.pins.filter((q) => q.shape === 'round').length, 0);
    let circles = 0;
    for (let i = 0; i < m.pins.count; i++) if (m.pins.shape[i] === SHAPE_CIRCLE) circles++;
    expect(roundInSrc).toBeGreaterThan(0);
    expect(circles).toBe(roundInSrc);
  });
});
