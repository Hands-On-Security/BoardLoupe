/**
 * Fabmaster FATF and FARC: one hand-written board in both encodings (and the
 * FARC job inside a .faz ZIP next to unrelated tables). Expected positions
 * follow the placement convention checked on real jobs: negate local Y on the
 * bottom side, rotate clockwise by tenths of a degree, translate.
 */
import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import type { BoardModel } from '../../src/model/types';
import { MOUNT_SMD, NO_PROBE, PINKIND_TESTPOINT, SHAPE_RECT, SIDE_BOTTOM, SIDE_TOP } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { parseBytes } from '../helpers/load';

const enc = (s: string) => new TextEncoder().encode(s);

const FATF = `; FATF OUTPUT FILE (synthetic)

:FABMASTER FATF REV 11.2;

:UNITS = 1/100000 INCH;

:BOARD_DATA
1,JOB("TEST BOARD",,01-01-2026,01-01-2026);
2,CONTOUR ((0,0,0),(300000,0,0),(300000,100000,0),
(0,100000,0),(0,0,0));
:EOD

:NOTRACE;

:PARTS
1,"R1","RES|10K","RESISTOR-0402",100000,50000,900,T;
2,"U1","SOT3|LDO","SOT3",200000,50000,0,B;
:EOD

:NETS
1,"SIG",S,
  ((1,1),(2,1));
2,"GND",S,((1,2),(2,3));
:EOD

:PACKAGES
;PACKAGE RESISTOR-0402
1,"RESISTOR-0402",-5000,5000,0,0
 (PINS (1,"1",-5000,0,T)(2,"2",5000,0,T))
 (1,PAD (2 ((-5000,0)))
 2,PAD (2 ((5000,0)))
 0,LAYER (3 (TRACK(500(-8000,3000)(8000,3000)(8000,-3000)(-8000,-3000)(-8000,3000)))));
;PACKAGE SOT3
2,"SOT3",-3000,3000,-4000,4000
 (PINS (1,"1",-3000,-4000,T)(2,"2",3000,-4000,T)(3,"3",0,4000,T))
 (1,PAD (2 ((-3000,-4000)))
 2,PAD (2 ((3000,-4000)))
 3,PAD (2 ((0,4000)))
 1,LAYER(1(BLOCK(-4000,-5000,-2000,-3000))));
:EOD

:PAD_SYMBOLS
1,P_ROUND (2000);
2,P_BLOCK (-1000,-1500,1000,1500);
:EOD

:PAD_STACKS
1,"VIA20",1000,P,((1,1));
2,"SMD20X30",0,B,((2,2));
:EOD

:LAYER_NAMES
1,"COPPER___TOP",TOP,2,ELECTRICAL;
2,"COPPERBOTTOM",BOTTOM,1,ELECTRICAL;
3,"ASSEMB___TOP",TOP,4,ASSEMBLY;
4,"ASSEMBBOTTOM",BOTTOM,3,ASSEMBLY;
:EOD

:LAYER_SETS
1,"ALL",(1,2);
2,"TOP",(1);
:EOD

:LAYERS
1,LAYER (2 (TRACK(800(100000,55000)(150000,55000)(197000,54000))));
:EOD

:PADS
2,1,((150000,20000));
:EOD

:TEST_POINTS
1(197000,54000)B,2,1;
2(250000,20000)B,0,0;
:EOD

:EOF
`;

const FARC = `:SECTION FABMASTER 1
{           - FARC ASCII File - V8.F.2 -         }
:EOSECTION

:SECTION JOBDATA 1
"TEST BOARD"
:EOSECTION

:SECTION FORMAT 1
((TRACK 0.01[]((0 0)(3000 0)(3000 1000)(0 1000)(0 0))))
:EOSECTION

:SECTION PARTS 1
2(
(1"R1"("RES|10K"0 31 0[]())("RESISTOR-0402" "OR-0402"[]())1000 500 900[]0 0 0 0 0 0 0)
(2"U1"("SOT3|LDO"0 31 0[]())("SOT3" "SOT3"[]())2000 500 0[BOTTOM]0 0 0 0 0 0 0)
)
:EOSECTION

:SECTION NETS 1
2(
(1 1"SIG"2[]((1 1)(2 1)))
(2 2"GND"2[]((1 2)(2 3)))
)
:EOSECTION

:SECTION LAYER_NAMES 1
((1"COPPER___TOP"TOP 2 ELECTRICAL)(2"COPPERBOTTOM"BOTTOM 1 ELECTRICAL)(50"ASSEMB___TOP"
TOP 51 ASSEMBLY)(51"ASSEMBBOTTOM"BOTTOM 50 ASSEMBLY))
:EOSECTION

:SECTION LAYER_SETS 1
((1"ALL"(1 2)))
:EOSECTION

:SECTION PAD_SYMBOLS 1
((1 ROUND 20)(2 BLOCK(-10 -15 10 15)))
:EOSECTION

:SECTION PAD_STACKS 1
((1 10((1 1)))(2 0((1 2))))
:EOSECTION

:SECTION TEST_POINTS 1
2((1(1970 540)B 2 1)(2(2500 200)B 0 0))
:EOSECTION

:SECTION PACKAGE 1
(("OR-0402.OTL"(-80 -30 80 30 0 0)(0 0 0 0)
((1 -50 0"1"[TOP])(2 50 0"2"[TOP]))
((1 2 1((-50 0[BURIED NF]))2)
(2 2 1((50 0[BURIED NF]))2)
)
((0 50((TRACK 5[]((-80 30)(80 30)(80 -30)(-80 -30)(-80 30)))))
))
("SOT3.OTL"(-40 -50 40 50 0 0)(0 0 0 0)
((1 -30 -40"1"[TOP])(2 30 -40"2"[TOP])(3 0 40"3"[TOP]))
((1 2 1((-30 -40[NF]))2)(2 2 1((30 -40[NF]))2)(3 2 1((0 40[NF]))2))
((1 1((BLOCK[NF]-40 -50 -20 -30)))
)))
:EOSECTION

:SECTION PADS 1
((2 1 0((1500 200[NF]))1))
:EOSECTION

:SECTION LAYERS 1
((1 2((TRACK 8[NF]((1000 550)(1500 550)(1970 540))))))
:EOSECTION

:SECTION FABXYDATA 1
2(5 2 2 0 0 2[]0 1 (0) () -1 -1)
((1000 550 1 1 1 TPIN 0 0 0[](0) 0 0 0 TPIN 0 0 0 0 0 0 0 1)
(1000 450 2 1 2 TPIN 0 0 0[](0) 0 0 0 TPIN 0 0 0 0 0 0 0 1))
:EOSECTION

:SECTION EOARCHIVE 1
:EOSECTION
`;

const pin = (m: BoardModel, part: string, no: string) => {
  const p = m.parts.name.indexOf(part);
  for (let j = m.parts.pinStart[p]; j < m.parts.pinStart[p] + m.parts.pinCount[p]; j++) if (m.pins.number[j] === no) return j;
  return -1;
};
const xy = (m: BoardModel, j: number) => [+m.pins.x[j].toFixed(3), +m.pins.y[j].toFixed(3)];
const net = (m: BoardModel, j: number) => m.nets.name[m.pins.net[j]] ?? null;

function checkBoard(m: BoardModel) {
  expect(validateModel(m)).toEqual([]);
  expect(m.units).toMatchObject({ unit: 'mil', toMm: 0.0254 });
  expect(m.outline.source).toBe('file');
  expect(m.outline.segs.length / 4).toBe(4);
  expect([m.parts.count, m.nets.count, m.vias.count]).toEqual([2, 2, 1]);
  // Top part rotated 90° clockwise; bottom part with local Y negated.
  expect(xy(m, pin(m, 'R1', '1'))).toEqual([1000, 550]);
  expect(xy(m, pin(m, 'R1', '2'))).toEqual([1000, 450]);
  expect(xy(m, pin(m, 'U1', '1'))).toEqual([1970, 540]);
  expect(xy(m, pin(m, 'U1', '2'))).toEqual([2030, 540]);
  expect(xy(m, pin(m, 'U1', '3'))).toEqual([2000, 460]);
  expect(m.pins.side[pin(m, 'U1', '1')]).toBe(SIDE_BOTTOM);
  expect(m.pins.side[pin(m, 'R1', '1')]).toBe(SIDE_TOP);
  // Nets by (part, pin index); U1.2 is unconnected.
  expect([net(m, pin(m, 'R1', '1')), net(m, pin(m, 'U1', '1')), net(m, pin(m, 'R1', '2')), net(m, pin(m, 'U1', '3')), net(m, pin(m, 'U1', '2'))]).toEqual(['SIG', 'SIG', 'GND', 'GND', null]);
  // Pads: the pin's own copper shape, else its pad stack's symbol.
  const u1 = pin(m, 'U1', '1'),
    r1 = pin(m, 'R1', '1');
  expect([m.pins.shape[u1], m.pins.w[u1], m.pins.h[u1]]).toEqual([SHAPE_RECT, 20, 20]);
  expect([m.pins.w[r1], m.pins.h[r1], m.pins.rot[r1]]).toEqual([20, 30, 270]);
  // Values and devices from "device|value".
  const R1 = m.parts.name.indexOf('R1');
  expect(m.parts.value[R1]).toBe('10K');
  expect(m.parts.attrs[R1]).toEqual([['Device', 'RES']]);
  expect(m.parts.mount[R1]).toBe(MOUNT_SMD);
  // Body from the assembly layer, rotated with the part.
  const b = [...m.parts.bbox.subarray(4 * R1, 4 * R1 + 4)].map((v) => +v.toFixed(3));
  expect(b).toEqual([970, 420, 1030, 580]);
  // Via, copper on the bottom layer, test access.
  expect([m.vias.x[0], m.vias.y[0], m.vias.d[0], m.nets.name[m.vias.net[0]]]).toEqual([1500, 200, 20, 'GND']);
  expect(m.traces.count).toBe(2);
  expect(m.layers[m.traces.layer[0]].kind).toBe('bottom');
  expect(m.nets.name[m.traces.net[0]]).toBe('SIG');
  expect(m.pins.probe[u1]).not.toBe(NO_PROBE);
  expect(m.pins.probe[r1]).toBe(NO_PROBE);
  const tp = [...Array(m.pins.count).keys()].filter((i) => m.pins.kind[i] === PINKIND_TESTPOINT);
  expect(tp.map((i) => xy(m, i))).toEqual([[2500, 200]]);
}

describe('Fabmaster', () => {
  test('FATF', () => {
    const out = parseBytes('board.fatf', enc(FATF));
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(out.model!.source.formatId).toBe('fabmaster');
    expect(out.model!.source.variant).toBe('FATF REV 11.2');
    expect(out.model!.metadata).toContainEqual(['Job', 'TEST BOARD']);
    checkBoard(out.model!);
  });

  test('FARC, matching package names through the 8.3 outline file name', () => {
    const out = parseBytes('board.far', enc(FARC));
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(out.model!.source.variant).toBe('FARC V8.F.2');
    checkBoard(out.model!);
  });

  test('FAZ: the job inside a ZIP of Fabmaster tables', () => {
    const zip = zipSync({ 'iperror.asc': enc('ERROR LIST\n'), 'DEVICE.ASC': enc('DEVICE RES\n'), 'BOARD.FAR': enc(FARC) });
    const out = parseBytes('board.faz', zip);
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    checkBoard(out.model!);
  });

  test('same board, both encodings, same pins', () => {
    const a = parseBytes('a.fatf', enc(FATF)).model!,
      b = parseBytes('b.far', enc(FARC)).model!;
    expect([...a.pins.x]).toEqual([...b.pins.x].map((v) => expect.closeTo(v, 6)));
    expect([...a.pins.y]).toEqual([...b.pins.y].map((v) => expect.closeTo(v, 6)));
  });

  test('a FATF file without :PARTS fails with an explanation', () => {
    const out = parseBytes('x.fatf', enc(':FABMASTER FATF REV 11.2;\n:UNITS = 1/1000 INCH;\n:NETS\n:EOD\n:EOF\n'));
    expect(out.ok).toBe(false);
    expect(out.diagnostics.find((d) => d.level === 'error')?.message).toMatch(/PARTS/);
  });
});
