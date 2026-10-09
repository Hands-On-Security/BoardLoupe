import { describe, expect, test } from 'vitest';
import { csvCell, modelToJson, toCsv } from '../../src/app/export';
import { BoardBuilder, classifyNet } from '../../src/model/builder';
import { NETFLAG_GROUND, NETFLAG_NOCONNECT, NETFLAG_POWER, PINKIND_TESTPOINT, SIDE_BOTTOM, SIDE_TOP } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { buildScene } from '../../src/scene/scene';
import { ratsnest } from '../../src/scene/ratsnest';

const src = { fileName: 't', fileSize: 1, formatId: 'x', formatName: 'X', variant: null, extraFiles: [] };

function small() {
  const b = new BoardBuilder();
  const u1 = b.addPart({ name: 'U1', side: SIDE_TOP });
  const r1 = b.addPart({ name: 'R1', side: SIDE_BOTTOM, value: '10k' });
  // Interleaved on purpose: the builder must group pins by part.
  b.addPin({ part: r1, x: 10, y: 0, net: 'GND', number: '1' });
  b.addPin({ part: u1, x: 0, y: 0, net: 'GND', number: '1' });
  b.addPin({ part: u1, x: 0, y: 5, net: '+3V3', number: '2' });
  b.addPin({ part: r1, x: 10, y: 5, net: 'SIG', number: '2' });
  b.addPin({ part: -1, x: 20, y: 20, net: 'SIG', kind: PINKIND_TESTPOINT, number: '7' });
  b.addPin({ part: u1, x: 0, y: 10, net: null, number: '3' });
  return b;
}

describe('BoardBuilder', () => {
  test('groups pins by part and builds net membership', () => {
    const m = small().finish(src);
    expect(validateModel(m)).toEqual([]);
    expect(m.parts.count).toBe(2);
    expect(m.parts.pinCount[0]).toBe(3);
    expect(m.parts.pinCount[1]).toBe(2);
    expect(Array.from({ length: 3 }, (_, j) => m.pins.number[m.parts.pinStart[0] + j])).toEqual(['1', '2', '3']);
    expect(m.pins.part[m.pins.count - 1]).toBe(-1); // unowned pins last
    const gnd = m.nets.name.indexOf('GND');
    expect(m.nets.pinStart[gnd + 1] - m.nets.pinStart[gnd]).toBe(2);
    const sig = m.nets.name.indexOf('SIG');
    expect(m.nets.pinStart[sig + 1] - m.nets.pinStart[sig]).toBe(2);
    expect(m.pins.net[m.parts.pinStart[0] + 2]).toBe(-1);
    // Pins inherit their part's side.
    expect(m.pins.side[m.parts.pinStart[1]]).toBe(SIDE_BOTTOM);
  });

  test('derives a dashed outline when the file has none, and reports it', () => {
    const m = small().finish(src);
    expect(m.outline.source).toBe('derived');
    expect(m.caps.outline).toBe('derived');
    expect(m.diagnostics.some((d) => d.code === 'outline.derived')).toBe(true);
  });

  test('keeps file outline and does not derive', () => {
    const b = small();
    b.addOutlinePolyline([-5, -5, 30, -5, 30, 30, -5, 30], true);
    const m = b.finish(src);
    expect(m.outline.source).toBe('file');
    expect(m.outline.segs.length / 4).toBe(4);
  });

  test('drops non-finite pins and invalid part references with diagnostics', () => {
    const b = small();
    b.addPin({ part: 0, x: NaN, y: 1, net: 'X' });
    b.addPin({ part: 99, x: 1, y: 1, net: 'X' });
    const m = b.finish(src);
    expect(validateModel(m)).toEqual([]);
    expect(m.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['pin.nonfinite', 'pin.badpart']));
    expect(m.pins.count).toBe(7);
  });

  test('aggregates repeated diagnostics with a count', () => {
    const b = small();
    for (let i = 0; i < 1000; i++) b.warn('x.bad', 'bad line', { line: i + 1 });
    const m = b.finish(src);
    const d = m.diagnostics.find((x) => x.code === 'x.bad')!;
    expect(d.count).toBe(1000);
    expect(d.line).toBe(1);
  });

  test('preserves duplicate and empty identifiers', () => {
    const b = new BoardBuilder();
    const a = b.addPart({ name: 'R1' });
    const c = b.addPart({ name: 'R1' });
    const e = b.addPart({ name: '' });
    for (const p of [a, c, e]) b.addPin({ part: p, x: p, y: 0, net: '' });
    const m = b.finish(src);
    expect(m.parts.name).toEqual(['R1', 'R1', '']);
    expect(m.nets.count).toBe(0);
    expect(validateModel(m)).toEqual([]);
  });

  test('validateModel detects corruption', () => {
    const m = small().finish(src);
    m.pins.net[0] = 999;
    m.parts.pinCount[0] = 50;
    const p = validateModel(m);
    expect(p.length).toBeGreaterThan(0);
  });
});

describe('net classification', () => {
  test.each([
    ['GND', NETFLAG_GROUND],
    ['AGND', NETFLAG_GROUND],
    ['GND_USB', NETFLAG_GROUND],
    ['+3V3', NETFLAG_POWER],
    ['PP3V3_S0', NETFLAG_POWER],
    ['VCC_CORE', NETFLAG_POWER],
    ['NC', NETFLAG_NOCONNECT],
    ['UNCONNECTED_12', NETFLAG_NOCONNECT],
    ['USB_D+', 0],
    ['SDA', 0],
  ])('%s', (name, flag) => {
    expect(classifyNet(name)).toBe(flag);
  });
});

describe('scene and ratsnest', () => {
  test('scene derives pin sizes, bodies and indexes', () => {
    const m = small().finish(src);
    const s = buildScene(m);
    expect(s.pinHW.length).toBe(m.pins.count);
    for (const v of s.pinHW) expect(v).toBeGreaterThan(0);
    expect(s.bodyStart[m.parts.count]).toBeGreaterThan(0);
    expect(s.pinIndex).not.toBeNull();
    expect(s.bodyDerived[0]).toBe(1);
  });
  test('ratsnest is a spanning tree (n-1 edges) and skips no-connect nets', () => {
    const b = new BoardBuilder();
    const p = b.addPart({ name: 'U1' });
    for (let i = 0; i < 10; i++) b.addPin({ part: p, x: i * 3, y: (i * 7) % 5, net: 'N1' });
    for (let i = 0; i < 4; i++) b.addPin({ part: p, x: i, y: 100, net: 'NC' });
    const m = b.finish(src);
    const r = ratsnest(m, [m.nets.name.indexOf('N1'), m.nets.name.indexOf('NC')]);
    expect(r.segs.length / 4).toBe(9);
  });
});

describe('export', () => {
  test('CSV escaping and formula-injection guard', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=CMD()')).toBe("'=CMD()");
    expect(csvCell('+3V3')).toBe('+3V3');
    expect(csvCell("+cmd|' /C calc'!A0")).toBe(`'+cmd|' /C calc'!A0`);
    expect(toCsv(['a', 'b'], [[1, null]])).toBe('a,b\r\n1,\r\n');
  });
  test('JSON export is complete and serialisable', () => {
    const m = small().finish(src);
    const j = modelToJson(m);
    expect(j.parts).toHaveLength(2);
    expect(j.pins).toHaveLength(m.pins.count);
    expect(j.parts[1].value).toBe('10k');
    expect(JSON.parse(JSON.stringify(j)).nets.length).toBe(m.nets.count);
  });
});
