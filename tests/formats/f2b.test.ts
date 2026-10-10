/**
 * Unisoft F2B: the synthetic Glasgow archive exercises MFC object references
 * (first pin carries its component), the component map, BGA labels stored as
 * negative keys into the net dictionary, vias as owner-less pins and trace
 * lists per layer with net keys.
 */
import { describe, expect, test } from 'vitest';
import { SIDE_BOTH, SIDE_BOTTOM } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { loadSource } from '../../tools/fixtures/source';
import { ROOT, parse } from '../helpers/load';

describe('F2B', () => {
  const src = loadSource(ROOT);
  const out = parse('fixtures/synthetic/glasgow.f2b');
  const m = out.model!;

  test('parses with integrity and the source counts', () => {
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(m.source.formatId).toBe('f2b');
    expect(validateModel(m)).toEqual([]);
    expect(m.units).toMatchObject({ unit: 'mil', assumed: false });
    expect([m.parts.count, m.vias.count, m.traces.count]).toEqual([src.parts.length, src.vias.length, src.traces.filter((t) => t.x1 !== t.x2 || t.y1 !== t.y2).length]);
    expect(m.diagnostics.some((d) => d.code === 'f2b.pincount')).toBe(false);
  });

  test('alphanumeric pin labels and sides', () => {
    const alpha = src.parts.flatMap((p) => p.pins.map((q) => q.number)).filter((n) => n && !/^\d+$/.test(n));
    expect(alpha.length).toBeGreaterThan(0);
    const names = new Set(m.pins.number);
    for (const a of alpha.slice(0, 50)) expect(names.has(a)).toBe(true);
    const bottomPart = src.parts.find((p) => p.side === 'B' && !p.th)!;
    const k = m.parts.name.indexOf(bottomPart.name);
    expect(m.parts.side[k]).toBe(SIDE_BOTTOM);
    const thPart = src.parts.find((p) => p.th)!;
    const t = m.parts.name.indexOf(thPart.name);
    expect(m.pins.side[m.parts.pinStart[t]]).toBe(SIDE_BOTH);
  });

  test('copper keeps its nets', () => {
    let named = 0;
    for (let i = 0; i < m.traces.count; i++) if (m.traces.net[i] >= 0) named++;
    expect(named).toBe(src.traces.filter((t) => t.net && (t.x1 !== t.x2 || t.y1 !== t.y2)).length);
  });
});
