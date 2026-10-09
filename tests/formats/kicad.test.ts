/**
 * KiCad PCB reader. The real Glasgow board (0BSD) is checked pin by pin against
 * KiCad's own GenCAD export of the same file (an independent writer); small
 * inline boards cover KiCad 5 and KiCad 10 syntax, including the duplicate
 * "${REFERENCE}" property that KiCad's Allegro importer emits.
 */
import { describe, expect, test } from 'vitest';
import type { BoardModel } from '../../src/model/types';
import { SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { parse, parseBytes } from '../helpers/load';

const enc = (s: string) => new TextEncoder().encode(s);
// KiCad's GenCAD writer names unnamed pads "none".
const pinKey = (m: BoardModel, i: number) => `${m.parts.name[m.pins.part[i]]}|${m.pins.number[i] === 'none' ? '' : m.pins.number[i]}`;
const pinsByKey = (m: BoardModel) => {
  const out = new Map<string, number[]>();
  for (let i = 0; i < m.pins.count; i++) (out.get(pinKey(m, i)) ?? out.set(pinKey(m, i), []).get(pinKey(m, i))!).push(i);
  return out;
};

describe('KiCad: real Glasgow board (KiCad 7 file)', () => {
  const k = parse('fixtures/real/glasgow/glasgow.kicad_pcb');
  const m = k.model!;
  const g = parse('fixtures/real/glasgow/glasgow-kicad10.cad').model!; // GenCAD written by KiCad from the same board

  test('parses with integrity, units and counts', () => {
    expect(k.ok).toBe(true);
    expect(m.source.formatId).toBe('kicad');
    expect(validateModel(m)).toEqual([]);
    expect(m.units).toMatchObject({ unit: 'mm', toMm: 1, assumed: false });
    // 1149 pads, minus 8 paste-only stencil apertures that carry no copper.
    expect([m.parts.count, m.pins.count, m.nets.count, m.vias.count]).toEqual([272, 1141, 251, 416]);
    expect(m.diagnostics.find((d) => d.code === 'kicad.nocopper')?.message).toMatch(/^8 pad/);
    expect(m.layers.map((l) => l.kind)).toEqual(['top', 'inner', 'inner', 'bottom']);
    expect(m.traces.count).toBeGreaterThan(4000);
  });

  test('every copper pad matches KiCad’s GenCAD export: position (≤0.001 mm) and net', () => {
    const toMm = g.units.toMm!;
    const gp = pinsByKey(g);
    let compared = 0;
    for (const [key, ours] of pinsByKey(m)) {
      const theirs = gp.get(key);
      expect(theirs, key).toBeDefined();
      for (const i of ours) {
        // nearest counterpart (pads may share a number, e.g. shield tabs)
        let best = Infinity,
          bj = -1;
        for (const j of theirs!) {
          const d = Math.hypot(m.pins.x[i] - g.pins.x[j] * toMm, m.pins.y[i] - g.pins.y[j] * toMm);
          if (d < best) {
            best = d;
            bj = j;
          }
        }
        expect(best, key).toBeLessThan(0.001);
        const n1 = m.pins.net[i] >= 0 ? m.nets.name[m.pins.net[i]] : '';
        const n2 = g.pins.net[bj] >= 0 ? g.nets.name[g.pins.net[bj]] : '';
        expect(n1, key).toBe(n2);
        compared++;
      }
    }
    expect(compared).toBe(1141);
  });

  test('Edge.Cuts outline is closed; bodies come from the file; through-hole pads are on both sides', () => {
    expect(m.outline.source).toBe('file');
    const ends = new Map<string, number>();
    const o = m.outline.segs;
    for (let i = 0; i < o.length; i += 2) {
      const key = `${Math.round(o[i] * 1000)},${Math.round(o[i + 1] * 1000)}`;
      ends.set(key, (ends.get(key) ?? 0) + 1);
    }
    expect([...ends.values()].filter((c) => c % 2).length).toBe(0);
    expect(m.caps.partBodies).toBe('file');
    for (let i = 0; i < m.pins.count; i++) if (m.pins.hole[i] > 0) expect(m.pins.side[i]).toBe(SIDE_BOTH);
  });
});

describe('KiCad 10 syntax (nets by name, Allegro-import quirks)', () => {
  const src = `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
  (layers (0 "F.Cu" signal "TOP") (4 "In1.Cu" signal "GND1") (2 "B.Cu" signal "BOTTOM") (25 "Edge.Cuts" user))
  (footprint "" (layer "F.Cu") (uuid "u") (at 10 20 90)
    (property "Reference" "R7" (at 0 0 90) (layer "F.SilkS") (effects (font (size 1 1))))
    (property "Value" "10k" (at 0 0 90) (layer "F.Fab"))
    (property "Reference" "\${REFERENCE}" (at 0 1 90) (layer "F.Fab"))
    (fp_rect (start -1 -0.5) (end 1 0.5) (layer "F.Fab") (stroke (width 0.1) (type solid)))
    (pad "1" smd roundrect (at -1 0 90) (size 0.6 0.5) (layers "F.Cu" "F.Mask") (net "VCC") (uuid "a"))
    (pad "2" smd roundrect (at 1 0 90) (size 0.6 0.5) (layers "F.Cu" "F.Mask") (net "SPI_CLK") (uuid "b")))
  (footprint "" (layer "B.Cu") (at 30 20 0)
    (property "Reference" "U3" (at 0 0 0) (layer "B.SilkS"))
    (pad "1" smd rect (at 0.5 0) (size 0.3 0.3) (layers "B.Cu") (net "SPI_CLK"))
    (pad "" np_thru_hole circle (at 3 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask")))
  (via (at 5 5) (size 0.45) (drill 0.2) (layers "F.Cu" "B.Cu") (net "GND"))
  (segment (start 0 0) (end 2 0) (width 0.2) (layer "In1.Cu") (net "GND"))
  (arc (start 0 0) (mid 1 1) (end 2 0) (width 0.2) (layer "F.Cu") (net "GND"))
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (stroke (width 0.1)))
  (zone (net "GND") (layer "F.Cu") (filled_polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
)`;
  const out = parseBytes('mini.kicad_pcb', enc(src));
  const m = out.model!;
  const pin = (part: string, num: string) => {
    for (let i = 0; i < m.pins.count; i++) if (m.parts.name[m.pins.part[i]] === part && m.pins.number[i] === num) return i;
    return -1;
  };

  test('reference skips the unresolved "${REFERENCE}" variable; value is kept', () => {
    expect(out.ok).toBe(true);
    expect(validateModel(m)).toEqual([]);
    expect(m.parts.name).toEqual(['R7', 'U3']);
    expect(m.parts.value[0]).toBe('10k');
  });

  test('footprint rotation and Y flip: local (−1,0) at 90° → (10, −21) in Y-up world', () => {
    const i = pin('R7', '1');
    expect(m.pins.x[i]).toBeCloseTo(10, 9);
    expect(m.pins.y[i]).toBeCloseTo(-21, 9);
    expect(m.pins.side[i]).toBe(SIDE_TOP);
    expect(m.nets.name[m.pins.net[i]]).toBe('VCC');
    expect(m.pins.rot[i]).toBe(90);
  });

  test('bottom footprint, nets shared by name, non-plated hole without net', () => {
    const a = pin('R7', '2'),
      b = pin('U3', '1'),
      h = pin('U3', '');
    expect(m.pins.side[b]).toBe(SIDE_BOTTOM);
    expect(m.pins.net[a]).toBe(m.pins.net[b]);
    expect(m.pins.net[h]).toBe(-1);
    expect(m.pins.hole[h]).toBe(1);
    expect(m.pins.side[h]).toBe(SIDE_BOTH);
  });

  test('vias, straight and arc tracks on copper layers; outline; zones skipped with a note', () => {
    expect(m.vias.count).toBe(1);
    expect(m.layers.map((l) => l.name)).toEqual(['TOP', 'GND1', 'BOTTOM']);
    expect(m.traces.count).toBeGreaterThan(2); // the arc is tessellated
    expect(Array.from(m.traces.layer)).toContain(1); // In1.Cu → index 1
    expect(m.outline.segs.length / 4).toBe(4);
    expect(m.diagnostics.some((d) => d.code === 'kicad.zones')).toBe(true);
  });
});

describe('KiCad 5 syntax (module, fp_text, net table, centre-based arcs)', () => {
  const src = `(kicad_pcb (version 20171130) (host pcbnew 5.1.9)
  (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
  (net 0 "") (net 1 GND) (net 2 +3V3)
  (module Resistor_SMD:R_0603 (layer B.Cu) (tedit 5F68FEEE) (tstamp 1) (at 5 5 180)
    (fp_text reference R1 (at 0 0) (layer B.SilkS) (effects (font (size 1 1) (thickness 0.15)) (justify mirror)))
    (fp_text value 4k7 (at 0 0) (layer B.Fab))
    (fp_line (start -1 -1) (end 1 -1) (layer B.Fab) (width 0.1))
    (pad 01 smd rect (at -1 0 180) (size 1 1) (layers B.Cu B.Paste B.Mask) (net 2 +3V3))
    (pad 2 smd rect (at 1 0 180) (size 1 1) (layers B.Cu B.Paste B.Mask) (net 1 GND)))
  (gr_arc (start 0 0) (end 10 0) (angle 90) (layer Edge.Cuts) (width 0.05))
)`;
  const out = parseBytes('v5.kicad_pcb', enc(src));
  const m = out.model!;

  test('reads module, fp_text reference/value and keeps "+3V3" and pad "01" as text', () => {
    expect(out.ok).toBe(true);
    expect(validateModel(m)).toEqual([]);
    expect(m.parts.name[0]).toBe('R1');
    expect(m.parts.value[0]).toBe('4k7');
    expect(m.parts.side[0]).toBe(SIDE_BOTTOM);
    expect(m.pins.number.slice(0, 2).sort()).toEqual(['01', '2']);
    expect([...m.nets.name].sort()).toEqual(['+3V3', 'GND']);
  });

  test('centre-based arc: 90° sweep of radius 10 around the origin', () => {
    const o = m.outline.segs;
    expect(o.length).toBeGreaterThan(8);
    for (let i = 0; i < o.length; i += 2) expect(Math.hypot(o[i], o[i + 1])).toBeCloseTo(10, 6);
  });
});

describe('KiCad robustness', () => {
  const real = parse('fixtures/real/glasgow/glasgow.kicad_pcb');
  const bytes = enc(`(kicad_pcb (version 1) (footprint "x" (layer "F.Cu") (at 0 0) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A"))))`);

  test('truncated or unbalanced input fails with a message, never hangs', () => {
    expect(real.ok).toBe(true);
    for (const cut of [10, 40, 60, bytes.length - 1]) {
      const out = parseBytes('t.kicad_pcb', bytes.subarray(0, cut));
      expect(out.ok).toBe(false);
      expect(out.diagnostics.find((d) => d.level === 'error')?.message.length).toBeGreaterThan(10);
    }
  });

  test('garbage after the header and deep nesting are handled', () => {
    const deep = '(kicad_pcb ' + '('.repeat(2000) + ')'.repeat(2000) + ')';
    const t0 = performance.now();
    const out = parseBytes('deep.kicad_pcb', enc(deep));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(out.ok || out.diagnostics.length > 0).toBe(true);
    const junk = parseBytes('j.kicad_pcb', enc('(kicad_pcb (footprint "a" (at x y z) (pad) (pad "1" smd) ) )'));
    expect(junk.ok).toBe(true);
    expect(validateModel(junk.model!)).toEqual([]);
  });
});
