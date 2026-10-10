/**
 * Mentor Graphics neutral file: a small hand-written board covering the record
 * grammar (continuation lines, quoted strings), the NET section preceding the
 * components (as in real files), footprint bodies placed with rotation and
 * bottom-side mirroring, references containing "-", test access and holes.
 */
import { describe, expect, test } from 'vitest';
import type { BoardModel } from '../../src/model/types';
import { MOUNT_SMD, MOUNT_TH, NO_PROBE, PINKIND_TESTPOINT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { parseBytes } from '../helpers/load';

const enc = (s: string) => new TextEncoder().encode(s);

const NEUTRAL = `# synthetic Mentor neutral file
B_UNITS Inches
B_ATTR 'BOARD_PLACEMENT_OUTLINE' ''  0.0 0.0 3.0 0.0 3.0 2.0 -
 0.0 2.0 0.0 0.0
PAD PIN SMD_R Surf 0.0
P_SHAPE SMD_R SIG1_TOP RECTANGLE 0.03 0.02
PAD PIN TH_RD Thru 0.03
P_SHAPE TH_RD SIG1_TOP CIRCLE 0.06
P_SHAPE TH_RD SIG4_BOT CIRCLE 0.06
PAD VIA VIA_RD Thru 0.012
P_SHAPE VIA_RD SIG1_TOP CIRCLE 0.024
GEOM R0402
G_PIN 1 -0.02 0.0 SMD_R Surf 0.0
G_PIN 2 0.02 0.0 SMD_R Surf 0.0
G_ATTR 'COMPONENT_PLACEMENT_OUTLINE' ''  -0.04 -0.015 0.04 -0.015 0.04 0.015 -0.04 0.015 -0.04 -0.015
GEOM HDR2
G_PIN 1 0.0 0.0 TH_RD Thru 0.03
G_PIN 2 0.1 0.0 TH_RD Thru 0.03
G_ATTR 'COMPONENT_PLACEMENT_OUTLINE' ''  -0.05 -0.05 0.15 -0.05 0.15 0.05 -0.05 0.05 -0.05 -0.05
NET /VCC
N_PIN R1-1 1.0 0.98 SMD_R   1
N_PIN J-1-1 0.5 1.5 TH_RD   1
N_VIA 1.5 1.5 VIA_RD   1   4
N_TEST PIN 0.5 1.5 BOT TH_RD J-1-1
NET GND
N_PIN R1-2 1.0 1.02 SMD_R   1
N_PIN R2-1 2.02 1.0 SMD_R   4
N_TEST VIA 2.5 0.5 BOT VIA_RD
NET /N$5
N_PIN R2-2 1.98 1.0 SMD_R   4
N_PIN J-1-2 0.6 1.5 TH_RD   1
COMP R1 PN-100 RES R0402  1.0 1.0 1 90
C_PROP (INSTPAR,"10k") (DESC,"Resistor, 1%")
C_PIN R1-1 1.0 0.98  1  1 90 SMD_R /VCC
C_PIN R1-2 1.0 1.02  1  1 90 SMD_R GND
COMP R2 PN-100 RES R0402  2.0 1.0 2 0
C_PIN R2-1 2.02 1.0  4  2 0 SMD_R GND
C_PIN R2-2 1.98 1.0  4  2 0 SMD_R /N$5
COMP J-1 PN-200 'HEADER 2' HDR2  0.5 1.5 1 0
C_PIN J-1-1 0.5 1.5  1  1 0 TH_RD /VCC
C_PIN J-1-2 0.6 1.5  1  1 0 TH_RD /N$5
HOLE NPTH  0.1 0.1 0.125
`;

const pinOf = (m: BoardModel, part: string, no: string) => {
  const p = m.parts.name.indexOf(part);
  for (let j = m.parts.pinStart[p]; j < m.parts.pinStart[p] + m.parts.pinCount[p]; j++) if (m.pins.number[j] === no) return j;
  return -1;
};
const netOf = (m: BoardModel, pin: number) => m.nets.name[m.pins.net[pin]];

describe('Mentor neutral file', () => {
  const out = parseBytes('board.neu', enc(NEUTRAL));
  const m = out.model!;

  test('detects and parses with integrity, units and outline', () => {
    expect(out.ok).toBe(true);
    expect(m.source.formatId).toBe('cad-panel');
    expect(m.source.variant).toBe('Mentor neutral file');
    expect(validateModel(m)).toEqual([]);
    expect(m.units).toMatchObject({ unit: 'inch', toMm: 25.4, assumed: false });
    expect(m.outline.source).toBe('file');
    expect(m.outline.segs.length / 4).toBe(4); // continuation line joined into one polyline
    expect([m.parts.count, m.vias.count]).toEqual([3, 2]); // N_VIA + unplated hole
  });

  test('components, values, attributes and references containing "-"', () => {
    const r1 = m.parts.name.indexOf('R1');
    expect(m.parts.value[r1]).toBe('10k');
    expect(m.parts.attrs[r1]).toEqual([
      ['Part number', 'PN-100'],
      ['Device', 'RES'],
      ['Description', 'Resistor, 1%'],
    ]);
    expect(m.parts.side[m.parts.name.indexOf('R2')]).toBe(SIDE_BOTTOM);
    const j = m.parts.name.indexOf('J-1');
    expect(m.parts.pinCount[j]).toBe(2);
    expect(m.parts.mount[j]).toBe(MOUNT_TH);
    expect(m.parts.mount[r1]).toBe(MOUNT_SMD);
    expect(m.parts.attrs[j]?.find((a) => a[0] === 'Device')?.[1]).toBe('HEADER 2');
  });

  test('pins: nets (leading "/" removed), pad shapes, drills, sides', () => {
    expect(netOf(m, pinOf(m, 'R1', '1'))).toBe('VCC');
    expect(netOf(m, pinOf(m, 'R2', '2'))).toBe('N$5');
    expect(netOf(m, pinOf(m, 'J-1', '2'))).toBe('N$5');
    const r = pinOf(m, 'R1', '1');
    expect([m.pins.w[r], m.pins.h[r], m.pins.hole[r]]).toEqual([expect.closeTo(0.03, 6), expect.closeTo(0.02, 6), 0]);
    const th = pinOf(m, 'J-1', '1');
    expect(m.pins.side[th]).toBe(SIDE_BOTH);
    expect(m.pins.hole[th]).toBeCloseTo(0.03, 6);
    expect(m.pins.side[pinOf(m, 'R1', '1')]).toBe(SIDE_TOP);
  });

  test('test access: N_TEST on a pin marks it; N_TEST on a via adds a test point', () => {
    expect(m.pins.probe[pinOf(m, 'J-1', '1')]).not.toBe(NO_PROBE);
    expect(m.pins.probe[pinOf(m, 'R1', '1')]).toBe(NO_PROBE);
    const tps = [...Array(m.pins.count).keys()].filter((i) => m.pins.kind[i] === PINKIND_TESTPOINT);
    expect(tps).toHaveLength(1);
    expect([m.pins.x[tps[0]], m.pins.y[tps[0]], m.pins.side[tps[0]], netOf(m, tps[0])]).toEqual([2.5, 0.5, SIDE_BOTTOM, 'GND']);
  });

  test('bodies: rotated counter-clockwise, mirrored in X on the bottom side, enclosing their pins', () => {
    for (const name of ['R1', 'R2', 'J-1']) {
      const k = m.parts.name.indexOf(name);
      expect(m.parts.bodyStart[k + 1]).toBeGreaterThan(m.parts.bodyStart[k]);
      const [x0, y0, x1, y1] = m.parts.bbox.subarray(4 * k, 4 * k + 4);
      for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++) {
        expect(m.pins.x[j]).toBeGreaterThanOrEqual(x0);
        expect(m.pins.x[j]).toBeLessThanOrEqual(x1);
        expect(m.pins.y[j]).toBeGreaterThanOrEqual(y0);
        expect(m.pins.y[j]).toBeLessThanOrEqual(y1);
      }
    }
    // R1 is rotated 90°: its 0.08 × 0.03 body stands upright.
    const k = m.parts.name.indexOf('R1');
    const b = m.parts.bbox.subarray(4 * k, 4 * k + 4);
    expect(b[2] - b[0]).toBeCloseTo(0.03, 6);
    expect(b[3] - b[1]).toBeCloseTo(0.08, 6);
  });

  test('without B_UNITS the file is not mistaken for a neutral file', () => {
    const plain = parseBytes('x.txt', enc('COMP R1 a b c 1 1 1 0\nNET A\n'));
    expect(plain.model?.source.formatId).not.toBe('cad-panel');
  });
});
