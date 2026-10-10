/**
 * NBV (NexusBV export): a payload written field by field from the documented
 * wire order (no real file is available), zlib-compressed behind the magic.
 */
import { zlibSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { SIDE_BOTTOM } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { parseBytes } from '../helpers/load';

class W {
  b: number[] = [];
  u8 = (v: number) => (this.b.push(v & 0xff), this);
  bool = (v: boolean) => this.u8(v ? 1 : 0);
  u32 = (v: number) => (this.b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff), this);
  u64 = (v: number) => this.u32(v).u32(0);
  f32 = (v: number) => {
    const t = new DataView(new ArrayBuffer(4));
    t.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) this.b.push(t.getUint8(i));
    return this;
  };
  str = (s: string) => {
    const e = new TextEncoder().encode(s);
    this.u64(e.length);
    this.b.push(...e);
    return this;
  };
  zeros = (n: number) => (this.b.push(...new Array(n).fill(0)), this);
}

function nbv(version: 1 | 2 | 3) {
  const w = new W().str(`NBV_PAYLOAD_${version}`);
  w.str('Test board');
  if (version !== 1) w.str('src');
  w.str('a').str('b').str('c').u64(1).str('x').u32(0).u64(0).u32(0).str('d').zeros(5).u32(0).str('e').str('f').str('g');
  w.u64(1).str('meta').zeros(16 + 3);
  w.u64(2).u32(1).bool(true).str('TOP');
  if (version === 3) w.str('top extra');
  w.u32(2).bool(true).str('BOTTOM');
  if (version === 3) w.str('');
  const comp = (ref: string, value: string, side: string, pins: [number, number, string, string][]) => {
    w.str(ref).str(value).str('').str('MFR').str('').str('');
    w.u64(0).zeros(12).u8(side.charCodeAt(0)).zeros(1 + 8 + 1 + 16 + 4 + 8);
    w.u64(pins.length);
    for (const [x, y, net, name] of pins) w.f32(x).f32(y).f32(5).u8(side.charCodeAt(0)).u32(0).str(net).str(name).zeros(24).u64(0).u64(1).u64(2).zeros(16).zeros(16 + 1 + 8 + 7);
    w.zeros(2 * 71).zeros(8);
  };
  w.u64(2);
  comp('R1', '10K', 'T', [
    [100, 200, 'VCC', '1'],
    [140, 200, 'GND', '2'],
  ]);
  comp('U1', 'LDO', 'B', [[300, 200, 'VCC', '1']]);
  w.u64(1).zeros(13).str('Board Outline').bool(true).f32(0).f32(0).f32(500).f32(0).zeros(37).u64(0).u64(0);
  w.u64(0).u64(0).u64(0).u64(0);
  return new Uint8Array([0x4e, 0x42, 0x56, 0x20, 0x31, 0x2e, 0x30, 0x00, 0x00, ...zlibSync(Uint8Array.from(w.b))]);
}

describe('NBV', () => {
  for (const v of [1, 2, 3] as const)
    test(`payload ${v}`, () => {
      const out = parseBytes('board.nbv', nbv(v));
      expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
      const m = out.model!;
      expect(m.source.formatId).toBe('nbv');
      expect(validateModel(m)).toEqual([]);
      expect(m.parts.name).toEqual(['R1', 'U1']);
      expect(m.parts.value[0]).toBe('10K');
      expect(m.parts.side[1]).toBe(SIDE_BOTTOM);
      expect([...Array(m.pins.count).keys()].map((j) => `${m.pins.x[j]},${m.pins.y[j]} ${m.nets.name[m.pins.net[j]]}`)).toEqual(['100,200 VCC', '140,200 GND', '300,200 VCC']);
      expect(m.outline.source).toBe('file');
    });
  test('a damaged payload is reported', () => {
    const b = nbv(2);
    const out = parseBytes('board.nbv', b.subarray(0, 40));
    expect(out.ok).toBe(false);
  });
});
