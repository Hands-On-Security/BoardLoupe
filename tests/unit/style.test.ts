import { describe, expect, test } from 'vitest';
import { BoardBuilder } from '../../src/model/builder';
import { SIDE_TOP } from '../../src/model/types';
import { DARK } from '../../src/render/palette';
import { DEFAULT_RENDER_OPTIONS, EMPTY_HIGHLIGHT, computeColors } from '../../src/render/style';
import { buildScene } from '../../src/scene/scene';

const src = { fileName: 't', fileSize: 1, formatId: 'x', formatName: 'X', variant: null, extraFiles: [] };

function model() {
  const b = new BoardBuilder();
  const u1 = b.addPart({ name: 'U1', side: SIDE_TOP });
  const u2 = b.addPart({ name: 'U2', side: SIDE_TOP });
  for (const [k, base] of [[u1, 0], [u2, 10]] as const)
    for (const [net, dy] of [['A', 0], ['B', 1], ['C', 2]] as const) b.addPin({ part: k, x: base, y: dy, net, number: String(dy + 1), w: 1, h: 1 });
  return b.finish(src);
}

const m = model();
const s = buildScene(m);
const A = m.nets.name.indexOf('A'),
  B = m.nets.name.indexOf('B'),
  C = m.nets.name.indexOf('C');
const focal = m.nets.pinIndex[m.nets.pinStart[A]]; // a pin on net A
const mate = m.nets.pinIndex[m.nets.pinStart[A] + 1]; // another pin on net A
const rgba = (a: Uint8Array, i: number) => [a[4 * i], a[4 * i + 1], a[4 * i + 2]];

describe('computeColors highlighting', () => {
  test('single focal pin stays white (selPin); its net is highlighted', () => {
    const h = { ...EMPTY_HIGHLIGHT, pin: focal, nets: [A] };
    const c = computeColors(m, s, DEFAULT_RENDER_OPTIONS, h, DARK);
    expect(rgba(c.pin, focal)).toEqual([DARK.selPin[0], DARK.selPin[1], DARK.selPin[2]]);
    expect(c.pinEmph[focal]).toBe(1);
  });

  test('in a multi-net bus selection the focal pin takes its net colour, not white', () => {
    const h = { ...EMPTY_HIGHLIGHT, pin: focal, nets: [A, B, C] };
    const c = computeColors(m, s, DEFAULT_RENDER_OPTIONS, h, DARK);
    const expected = DARK.busColors[0]; // A is first in h.nets
    expect(rgba(c.pin, focal)).toEqual([expected[0], expected[1], expected[2]]);
    // The focal pin matches its own net-mates.
    expect(rgba(c.pin, focal)).toEqual(rgba(c.pin, mate));
    // It is not the white focal marker.
    expect(rgba(c.pin, focal)).not.toEqual([255, 255, 255]);
    // Other nets get distinct colours.
    const onB = m.nets.pinIndex[m.nets.pinStart[B]];
    expect(rgba(c.pin, onB)).toEqual([DARK.busColors[1][0], DARK.busColors[1][1], DARK.busColors[1][2]]);
    expect(c.pinEmph[focal]).toBe(1);
  });
});
