/**
 * TopTest numbered-section BRD with a same-stem .con companion (hand-written
 * from the documented layout; no real file of this dialect is available).
 */
import { describe, expect, test } from 'vitest';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import { PINKIND_TESTPOINT } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';

const enc = (s: string) => new TextEncoder().encode(s);
const BRD = ['0 0 0 0', '0 0', '3.0 0', '3.0 2.0', '0 2.0', '1 1 1 1', 'R1', '1.010 0.990 0.990 1.060', 'U1', '2.1 1.1 1.9 0.9', '2 2 2 2', '3 3 3 3', 'R1 1', '1.0 1.0', 'VCC', 'R1-2', '1.0 1.05', 'GND', 'U1 1', '1.95 0.95', 'VCC', '4 4 4 4', '1.5 1.5', 'x', 'GND', 'TP1', '5 5 5 5', ''].join('\r\n');
const CON = ['0 0 0 0', '1 1 1 1', 'J1', '0.5 0.5 0.6 0.7', '2 2 2 2', '3 3 3 3', 'J1.1', '0.55 0.55', 'VCC', '4 4 4 4', '5 5 5 5'].join('\n');

describe('TopTest numbered-section BRD', () => {
  test('sections, parts, pins, points and the .con companion', () => {
    const out = parseFiles([{ name: 'board.brd', bytes: enc(BRD) }, { name: 'board.con', bytes: enc(CON) }], DEFAULT_OPTIONS);
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    const m = out.model!;
    expect(m.source.formatId).toBe('toptest');
    expect(m.source.variant).toBe('with .con');
    expect(validateModel(m)).toEqual([]);
    expect(m.parts.name).toEqual(['R1', 'U1', 'J1']);
    expect(m.outline.source).toBe('file');
    const pin = (part: string, no: string) => {
      const k = m.parts.name.indexOf(part);
      for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++) if (m.pins.number[j] === no) return j;
      return -1;
    };
    expect([m.pins.x[pin('R1', '2')], m.pins.y[pin('R1', '2')]]).toEqual([1000, 1050]);
    expect(m.nets.name[m.pins.net[pin('J1', '1')]]).toBe('VCC');
    const tp = [...Array(m.pins.count).keys()].filter((i) => m.pins.kind[i] === PINKIND_TESTPOINT);
    expect(tp.map((i) => [m.pins.x[i], m.pins.number[i], m.nets.name[m.pins.net[i]]])).toEqual([[1500, 'TP1', 'GND']]);
    // Part boxes are normalised from any corner order.
    const r1 = m.parts.name.indexOf('R1');
    expect([...m.parts.bbox.subarray(4 * r1, 4 * r1 + 4)].map((v) => Math.round(v))).toEqual([990, 990, 1010, 1060]);
  });

  test('markers out of order are rejected', () => {
    const out = parseFiles([{ name: 'x.brd', bytes: enc('1 1 1 1\n0 0 0 0\n2 2 2 2\n3 3 3 3\n4 4 4 4\n5 5 5 5\n') }], DEFAULT_OPTIONS);
    expect(out.ok).toBe(false);
  });
});
