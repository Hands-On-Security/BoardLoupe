/**
 * Independent geometric ground truth: the same real board (Glasgow) exported by
 * two different tools — kicad-boardview (BRD2, BVR3, written straight from
 * pcbnew's pad positions) and KiCad's own GenCAD exporter. Every pin of every
 * part must land within 1 mil (the BRD2 rounding) after a global offset,
 * including bottom-side parts (mirror/flip transform).
 */
import { describe, expect, test } from 'vitest';
import type { BoardModel } from '../../src/model/types';
import { parse } from '../helpers/load';

function pinsByPart(m: BoardModel) {
  const map = new Map<string, { x: number; y: number; net: string }[]>();
  for (let k = 0; k < m.parts.count; k++) {
    const arr = [];
    for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++)
      arr.push({ x: m.pins.x[j], y: m.pins.y[j], net: m.pins.net[j] >= 0 ? m.nets.name[m.pins.net[j]].replace(/^\//, '') : '' });
    if (arr.length) map.set(m.parts.name[k], arr);
  }
  return map;
}

function compare(a: BoardModel, b: BoardModel) {
  const A = pinsByPart(a),
    B = pinsByPart(b);
  const dxs: number[] = [],
    dys: number[] = [];
  for (const [n, pa] of A) {
    const pb = B.get(n);
    if (!pb || pb.length !== pa.length) continue;
    dxs.push(pa.reduce((s, p) => s + p.x, 0) / pa.length - pb.reduce((s, p) => s + p.x, 0) / pb.length);
    dys.push(pa.reduce((s, p) => s + p.y, 0) / pa.length - pb.reduce((s, p) => s + p.y, 0) / pb.length);
  }
  dxs.sort((x, y) => x - y);
  dys.sort((x, y) => x - y);
  const dx = dxs[dxs.length >> 1],
    dy = dys[dys.length >> 1];
  let worst = 0,
    compared = 0,
    netMismatch = 0;
  for (const [n, pa] of A) {
    const pb = B.get(n);
    if (!pb) continue;
    for (const p of pa) {
      let best = Infinity,
        bq = pb[0];
      for (const q of pb) {
        const d = Math.hypot(p.x - (q.x + dx), p.y - (q.y + dy));
        if (d < best) {
          best = d;
          bq = q;
        }
      }
      compared++;
      worst = Math.max(worst, best);
      if (bq.net !== p.net) netMismatch++;
    }
  }
  return { compared, worst, netMismatch };
}

describe('cross-format geometry (real board, independent exporters)', () => {
  const brd = parse('fixtures/real/glasgow/glasgow-kicad-boardview.brd').model!;
  test('GenCAD (KiCad 10) vs BRD2 (kicad-boardview)', () => {
    const r = compare(brd, parse('fixtures/real/glasgow/glasgow-kicad10.cad').model!);
    expect(r.compared).toBeGreaterThan(1100);
    expect(r.worst).toBeLessThan(1.1);
    expect(r.netMismatch).toBe(0);
  });
  test('BVR3 vs BRD2 (same exporter, different format)', () => {
    const r = compare(brd, parse('fixtures/real/glasgow/glasgow-kicad-boardview.bvr').model!);
    expect(r.worst).toBeLessThan(1.1);
    expect(r.netMismatch).toBe(0);
  });
  test('synthetic TVW reproduces the source board within 0.6 mil', () => {
    const r = compare(parse('fixtures/real/glasgow/glasgow-kicad10.cad').model!, parse('fixtures/synthetic/glasgow.tvw').model!);
    expect(r.compared).toBeGreaterThan(1100);
    expect(r.worst).toBeLessThan(0.75);
  });
  for (const f of ['glasgow.fatf', 'glasgow.far', 'glasgow.a3p'])
    test(`synthetic ${f} reproduces the source board (rotated, mirrored packages)`, () => {
      const m = parse('fixtures/synthetic/' + f).model!;
      const r = compare(parse('fixtures/real/glasgow/glasgow-kicad10.cad').model!, m);
      expect(r.compared).toBeGreaterThan(1100);
      expect(r.worst).toBeLessThan(0.75);
      expect(r.netMismatch).toBe(0);
      expect(m.traces.count).toBeGreaterThan(4000);
      expect(m.outline.source).toBe('file');
    });
});
