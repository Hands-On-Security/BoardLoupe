import { describe, expect, test } from 'vitest';
import { BoardBuilder } from '../../src/model/builder';
import { solderPoints } from '../../src/model/solder';
import { MOUNT_TH, SIDE_BOTTOM, SIDE_TOP } from '../../src/model/types';
import { buildScene } from '../../src/scene/scene';

const src = { fileName: 't', fileSize: 1, formatId: 'x', formatName: 'X', variant: null, extraFiles: [] };

/**
 * One signal net SPI_CLK reached at five kinds of point, plus a via. The finder
 * must rank the accessible points (test point, through-hole, connector, large
 * pad) ahead of the fine-pitch BGA ball.
 */
function board() {
  const b = new BoardBuilder();
  // Fine-pitch IC: 30 small pads, one of them on SPI_CLK.
  const u1 = b.addPart({ name: 'U1', side: SIDE_TOP });
  for (let i = 0; i < 30; i++) b.addPin({ part: u1, x: i * 0.5, y: 0, net: i === 0 ? 'SPI_CLK' : `N${i}`, number: `A${i}`, w: 0.3, h: 0.3 });
  // Test point.
  const tp = b.addPart({ name: 'TP7', side: SIDE_TOP });
  b.addPin({ part: tp, x: 40, y: 10, net: 'SPI_CLK', number: '1', w: 1.2, h: 1.2 });
  // Resistor terminal (passive).
  const r1 = b.addPart({ name: 'R12', side: SIDE_TOP });
  b.addPin({ part: r1, x: 20, y: 10, net: 'SPI_CLK', number: '1', w: 1, h: 1 });
  b.addPin({ part: r1, x: 22, y: 10, net: 'OTHER', number: '2', w: 1, h: 1 });
  // Through-hole connector pin (drilled).
  const j1 = b.addPart({ name: 'J2', side: SIDE_BOTTOM, mount: MOUNT_TH });
  b.addPin({ part: j1, x: 30, y: 10, net: 'SPI_CLK', number: '8', w: 1.5, h: 1.5, hole: 0.8 });
  // A via on the net.
  b.addVia(35, 10, 0.6, 'SPI_CLK');
  return b;
}

describe('solderPoints', () => {
  const m = board().finish(src);
  const s = buildScene(m);
  const n = m.nets.name.indexOf('SPI_CLK');
  const pts = solderPoints(m, s.pinHW, s.pinHH, s.typicalPin, n);

  test('finds every point on the net (4 pins + 1 via)', () => {
    expect(n).toBeGreaterThanOrEqual(0);
    expect(pts.filter((p) => p.kind === 'pin').length).toBe(4);
    expect(pts.filter((p) => p.kind === 'via').length).toBe(1);
  });

  test('ranks a test point first and the fine-pitch IC ball last', () => {
    expect(pts[0].label).toBe('TP7'); // single-pin part: refdes only
    expect(pts[0].reasons).toContain('test point');
    const last = pts[pts.length - 1];
    expect(last.label).toBe('U1.A0');
    expect(last.reasons).toContain('fine pitch');
  });

  test('the through-hole connector and passive terminal outrank the BGA ball', () => {
    const rank = (lbl: string) => pts.findIndex((p) => p.label === lbl);
    expect(rank('J2')).toBeLessThan(rank('U1.A0'));
    expect(rank('R12.1')).toBeLessThan(rank('U1.A0'));
    expect(pts.find((p) => p.label === 'J2')!.reasons).toContain('through-hole');
  });

  test('is deterministic (stable ordering)', () => {
    const again = solderPoints(m, s.pinHW, s.pinHH, s.typicalPin, n);
    expect(again.map((p) => p.label + p.kind)).toEqual(pts.map((p) => p.label + p.kind));
  });
});

describe('solderPoints: test access on a component pin', () => {
  test('a pin the file marks with a probe outranks other component pads', () => {
    const b = new BoardBuilder();
    const r = b.addPart({ name: 'R5', side: SIDE_TOP });
    b.addPin({ part: r, x: 0, y: 0, net: 'LPC_AD0', number: '1', w: 1, h: 1, probe: 17 });
    b.addPin({ part: r, x: 2, y: 0, net: 'X', number: '2', w: 1, h: 1 });
    const c = b.addPart({ name: 'C9', side: SIDE_TOP });
    b.addPin({ part: c, x: 5, y: 0, net: 'LPC_AD0', number: '1', w: 1, h: 1 });
    b.addPin({ part: c, x: 7, y: 0, net: 'Y', number: '2', w: 1, h: 1 });
    const m = b.finish(src);
    const s = buildScene(m);
    const pts = solderPoints(m, s.pinHW, s.pinHH, s.typicalPin, m.nets.name.indexOf('LPC_AD0'));
    expect(pts[0].label).toBe('R5.1');
    expect(pts[0].reasons).toContain('test access');
  });
});
