/**
 * GenCAM (IPC-2511) grammar details on a small hand-written board: qualified
 * references, "" escapes, polygon pads with arcs, MIRROR placement on the
 * bottom side, probes on a pin and on a via, arcs in the outline.
 */
import { describe, expect, test } from 'vitest';
import type { BoardModel } from '../../src/model/types';
import { MOUNT_TH, NO_PROBE, PINKIND_TESTPOINT, SIDE_BOTH, SIDE_BOTTOM } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { parseBytes } from '../helpers/load';

const G = (k: string) => `"(${k}).B"`;
const A3P = `$HEADER
  GENCAM: "1.5";
  UNITS: THOU;
  ANGLEUNITS: DEGREES;
  ATTRIBUTE: "/X/","PROJECT_NAME","Board ""A""",;
  BOARD: "B","B","B","1";
$ENDHEADER
$PRIMITIVES
  GROUP: ${G('primitives')};
    CIRCLEDEF: "C20",20;
    CIRCLEDEF: "H10",10;
    RECTCORNERDEF: "R",(-10,-5),(10,5);
    POLYGONDEF: "OB";
      STARTAT: (5,10);
      CIRCARCTO: (-5,10),(0,10),CCLKW;
      LINETO: (-5,-10);
      CIRCARCTO: (5,-10),(0,-10),CCLKW;
      ENDLINE: (5,10);
    LINEDESC: "LD",6,ROUND,,SOLID,,,NONE,BOTH,,,;
$ENDPRIMITIVES
$LAYERS
  GROUP: ${G('layers')};
    LAYERSINGLE: "TOP",TOP,CONDUCTOR,,,,,;
    LAYERSINGLE: "BOT",BOTTOM,CONDUCTOR,,,,,;
    LAYERSINGLE: "COMPONENT TOP",TOP,COMPONENT,,,,,;
    LAYERSINGLE: "COMPONENT BOTTOM",BOTTOM,COMPONENT,,,,,;
    LAYERSINGLE: "PROBE BOTTOM",BOTTOM,PROBE,,,,,;
    LAYERSINGLE: "OUT",ALL,BOARDOUTLINE,,,,,;
$ENDLAYERS
$PADSTACKS
  GROUP: ${G('padstacks')};
    HOLEDEF: "HOLE10",ELECTRICAL,${G('primitives')}."H10",,,,;
    PADSTACK: "SMD";
      PAD: ${G('layers')}."TOP",${G('primitives')}."R",,,,,(0,0),0;
      PAD: ${G('layers')}."BOT",${G('primitives')}."R",,,,,(0,0),0;
    PADSTACK: "OVAL";
      PAD: ${G('layers')}."TOP",${G('primitives')}."OB",,,,,(0,0),0;
    PADSTACK: "TH";
      PAD: ${G('layers')}."TOP",${G('primitives')}."C20",,,,,(0,0),0;
      HOLEREF: ${G('padstacks')}."HOLE10",(0,0),0;
$ENDPADSTACKS
$PATTERNS
  GROUP: ${G('patterns')};
    PATTERNDEF: "SOT",;
      PADSTACKREF: ${G('padstacks')}."SMD","1",(-30,-40),0;
      PADSTACKREF: ${G('padstacks')}."SMD","2",(30,-40),0;
      PADSTACKREF: ${G('padstacks')}."OVAL","3",(0,40),0;
    PATTERNDEF: "HDR",;
      PADSTACKREF: ${G('padstacks')}."TH","1",(0,0),0;
      PADSTACKREF: ${G('padstacks')}."TH","2",(100,0),0;
$ENDPATTERNS
$DEVICES
  GROUP: ${G('devices')};
    DEVICE: "LDO",OTHER,,;
      PART: "acme","LDO-3V3",;
      VALUE: 3.3,VOLT,,;
$ENDDEVICES
$COMPONENTS
  GROUP: ${G('components')};
    COMPONENT: "U1",${G('layers')}."COMPONENT TOP",(1000,500),90,;
      ATTRIBUTE: "/GRA3/","BOM_Description","LDO ""3V3"" 1A",;
      DEVICEREF: ${G('devices')}."LDO",ASSEMBLED,;
      PATTERNREF: ${G('patterns')}."SOT",;
    COMPONENT: "U2",${G('layers')}."COMPONENT BOTTOM",(2000,500),0,MIRROR;
      DEVICEREF: ${G('devices')}."LDO",ASSEMBLED,;
      PATTERNREF: ${G('patterns')}."SOT",;
    COMPONENT: "J1",${G('layers')}."COMPONENT TOP",(500,800),0,;
      PATTERNREF: ${G('patterns')}."HDR",;
$ENDCOMPONENTS
$ROUTES
  GROUP: ${G('routes')};
    ROUTE: "VIN",SIGNAL;
      COMPPIN: ${G('components')}."U1","1",,;
      COMPPIN: ${G('components')}."U2","1",,;
      COMPPIN: ${G('components')}."J1","1",,;
      VIA: "V1",${G('padstacks')}."TH",,,(1500,200),0;
      PATH: ${G('layers')}."BOT",${G('primitives')}."LD",;
        POLYLINE: ${G('primitives')}."LD";
          STARTAT: (1040,470);
          LINETO: (1500,200);
          LINETO: (1970,460);
    ROUTE: "GND",SIGNAL;
      COMPPIN: ${G('components')}."U1","3",,;
      COMPPIN: ${G('components')}."J1","2",,;
$ENDROUTES
$TESTCONNECTS
  GROUP: ${G('testconnects')};
    TESTPROBE: "F1",ICT,90,0,0,${G('layers')}."PROBE BOTTOM",CROWN,MATING,(1970,460);
      COMPPINREF: ${G('components')}."U2","1";
    TESTPROBE: "F2",ICT,90,0,0,${G('layers')}."PROBE BOTTOM",CROWN,MATING,(1500,200);
      VIAREF: ${G('routes')}."V1","VIN";
$ENDTESTCONNECTS
$BOARDS
  BOARD: "B";
    OUTLINE: "B",${G('layers')}."OUT",;
      POLYLINE: ;
        STARTAT: (0,0);
        LINETO: (2900,0);
        CIRCARCTO: (3000,100),(2900,100),CCLKW;
        LINETO: (3000,1000);
        LINETO: (0,1000);
        LINETO: (0,0);
$ENDBOARDS
`;

const pin = (m: BoardModel, part: string, no: string) => {
  const p = m.parts.name.indexOf(part);
  for (let j = m.parts.pinStart[p]; j < m.parts.pinStart[p] + m.parts.pinCount[p]; j++) if (m.pins.number[j] === no) return j;
  return -1;
};
const xy = (m: BoardModel, j: number) => [+m.pins.x[j].toFixed(3), +m.pins.y[j].toFixed(3)];
const net = (m: BoardModel, j: number) => m.nets.name[m.pins.net[j]] ?? null;

describe('GenCAM', () => {
  const out = parseBytes('board.a3p', new TextEncoder().encode(A3P));
  const m = out.model!;

  test('parses with integrity, units and an outline with arcs', () => {
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(m.source.formatId).toBe('gencam');
    expect(validateModel(m)).toEqual([]);
    expect(m.units).toMatchObject({ unit: 'mil', assumed: false });
    expect(m.outline.source).toBe('file');
    expect(m.outline.segs.length / 4).toBeGreaterThan(5); // the corner arc is flattened
  });

  test('placement: rotate counter-clockwise; MIRROR negates X before rotating', () => {
    expect(xy(m, pin(m, 'U1', '1'))).toEqual([1040, 470]);
    expect(xy(m, pin(m, 'U1', '3'))).toEqual([960, 500]);
    expect(xy(m, pin(m, 'U2', '1'))).toEqual([2030, 460]);
    expect(xy(m, pin(m, 'U2', '2'))).toEqual([1970, 460]);
    expect(m.parts.side[m.parts.name.indexOf('U2')]).toBe(SIDE_BOTTOM);
  });

  test('nets, pads, drills, devices and "" escapes', () => {
    expect([net(m, pin(m, 'U1', '1')), net(m, pin(m, 'U2', '1')), net(m, pin(m, 'J1', '2')), net(m, pin(m, 'U2', '2'))]).toEqual(['VIN', 'VIN', 'GND', null]);
    const oval = pin(m, 'U1', '3');
    expect([m.pins.w[oval], m.pins.h[oval]]).toEqual([10, 30]); // polygon pad: bounding box including its arcs
    const th = pin(m, 'J1', '1');
    expect([m.pins.hole[th], m.pins.side[th], m.parts.mount[m.parts.name.indexOf('J1')]]).toEqual([10, SIDE_BOTH, MOUNT_TH]);
    const u1 = m.parts.name.indexOf('U1');
    expect(m.parts.value[u1]).toBe('3.3 volt');
    expect(m.parts.attrs[u1]).toEqual([
      ['Part number', 'LDO-3V3'],
      ['Description', 'LDO "3V3" 1A'],
    ]);
  });

  test('copper, vias and probes on a pin and on a via', () => {
    expect([m.vias.count, m.traces.count]).toEqual([1, 2]);
    expect(m.layers[m.traces.layer[0]].kind).toBe('bottom');
    expect(m.pins.probe[pin(m, 'U2', '1')]).not.toBe(NO_PROBE);
    const tp = [...Array(m.pins.count).keys()].filter((i) => m.pins.kind[i] === PINKIND_TESTPOINT);
    expect(tp.map((i) => [...xy(m, i), net(m, i)])).toEqual([[1500, 200, 'VIN']]);
  });
});
