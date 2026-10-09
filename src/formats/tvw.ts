/**
 * Tebo-ICT View boardview (.tvw).
 *
 * Structural port of Pavel Kovalenko's reverse-engineered reader (eagleview,
 * MIT; adapted in OpenBoardView PR #366 by "MARCEBELE" with the
 * empty-through-layer fix). Every read is bounds-checked and every structural
 * constant the reference asserts on is verified, so an unknown variant fails
 * with the exact offset and expectation instead of producing garbage.
 *
 * Coordinates are 2-decimal fixed point in mils (raw / 100 = mil).
 * Pins reference pads on their part's copper layer by handle / 8.
 */
import { ByteReader, ParseError, startsWithBytes } from '../io/bytes';
import { BoardBuilder } from '../model/builder';
import {
  MOUNT_SMD,
  MOUNT_TH,
  SHAPE_CIRCLE,
  SHAPE_RECT,
  SHAPE_ROUNDRECT,
  SIDE_BOTTOM,
  SIDE_TOP,
  type LayerInfo,
  type PadShape,
} from '../model/types';
import type { FormatModule } from './types';

// ---------------------------------------------------------------------------
// Raw structures (only the fields that are used are kept)

export const enum TvwLayerType {
  Document = 0,
  Top = 1,
  Bottom = 2,
  Signal = 3,
  Plane = 4,
  SolderTop = 5,
  SolderBottom = 6,
  SilkTop = 7,
  SilkBottom = 8,
  PasteTop = 9,
  PasteBottom = 10,
  Drill = 11,
  Roul = 12,
}

const LAYER_TYPE_NAMES = ['Document', 'Top', 'Bottom', 'Signal', 'Plane', 'SolderTop', 'SolderBottom', 'SilkTop', 'SilkBottom', 'PasteTop', 'PasteBottom', 'Drill', 'Route'];

export interface TvwShape {
  type: number; // 0 round, 1 rect, 3 roundrect, 5 poly
  sx: number;
  sy: number;
  turn: number;
  name?: string;
}
export interface TvwPad {
  net: number;
  dcode: number;
  x: number;
  y: number;
  hasHole: boolean;
  holeX: number;
  holeY: number;
}
export interface TvwLine {
  net: number;
  dcode: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface TvwArc {
  net: number;
  dcode: number;
  x: number;
  y: number;
  r: number;
  start: number;
  sweep: number;
}
export interface TvwLogicLayer {
  kind: 'logic';
  name: string;
  type: number;
  shapes: TvwShape[];
  pads: TvwPad[];
  lines: TvwLine[];
  arcs: TvwArc[];
  surfaces: number;
}
export interface TvwThroughLayer {
  kind: 'through';
  name: string;
  type: number;
  tools: number[]; // tool sizes (raw)
  /** Full tool records (flags and the five words the reference leaves unnamed). */
  toolInfo: { flag1: boolean; flag2: boolean; size: number; data: number[]; color: number[] }[];
  holes: { net: number; tool: number; x: number; y: number }[];
  /** Straight slots (drill code 0x0A): routed line from (x1,y1) to (x2,y2). */
  slots: { net: number; tool: number; x1: number; y1: number; x2: number; y2: number }[];
  /**
   * Arc slots (drill code 0x0B): centre, radius and float32 start/sweep angles
   * in degrees (negative sweep = clockwise). Same record size as a straight
   * slot; the reference reader misreads these as lines, which produces long
   * stray outline segments (e.g. towards the origin when the start angle is 0).
   */
  arcs: { net: number; tool: number; cx: number; cy: number; r: number; start: number; sweep: number }[];
}
export type TvwLayer = TvwLogicLayer | TvwThroughLayer;

export interface TvwPin {
  handle: number;
  id: number;
  name: string;
}
export interface TvwPart {
  name: string;
  bbox: [number, number, number, number];
  x: number;
  y: number;
  angle: number;
  decal: number;
  type: number;
  height: number;
  value: string;
  tolP: string;
  tolN: string;
  desc: string;
  serial: string;
  layer: number;
  pins: TvwPin[];
}
export interface TvwDecal {
  name: string;
  /** Body outline polygon in decal-local raw units (x0,y0,x1,y1,…). */
  outline: number[];
  /** Up to three local layers (pads in decal-local coordinates). */
  layers: (TvwLayer | null)[];
}
export interface TvwBoard {
  header: { type: string; customer: string; date: string; layerCount: number };
  layers: TvwLayer[];
  nets: string[];
  parts: TvwPart[];
  decals: TvwDecal[];
}

/** The fixed 20-byte prefix: length 0x13 + ciphered "Tebo-ictview files.". */
export const TVW_SIGNATURE = [0x13, ...Array.from('O95w-28ps49m 02v9o.', (c) => c.charCodeAt(0))];

/** Character cipher used for header strings (exact port, char arithmetic). */
export function tvwDecodeString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 106) {
      let x = c - (i % 3) - 4;
      if (x < 97) x += 10;
      out += String.fromCharCode(154 - x);
    } else if (c >= 107 && c <= 122) {
      let x = c - (i % 10) - 5;
      if (x < 107) x += 16;
      out += String.fromCharCode(x);
    } else if (c >= 65 && c <= 90) {
      let x = c + (i % 10) + 5;
      if (x > 90) x -= 26;
      out += String.fromCharCode(x);
    } else if (c >= 48 && c <= 57) {
      let x = c + (i % 3) + 4;
      if (x > 57) x -= 10;
      out += String.fromCharCode(x + 49);
    } else out += s[i];
  }
  return out;
}

/** Inverse of tvwDecodeString (for building fixtures). */
export function tvwEncodeString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let found = -1;
    // Brute-force the inverse over the same alphabet classes (strings are short).
    for (const range of [
      [97, 106],
      [107, 122],
      [65, 90],
      [48, 57],
    ]) {
      for (let e = range[0]; e <= range[1]; e++) {
        if (tvwDecodeString(' '.repeat(i) + String.fromCharCode(e)).charCodeAt(i) === c) {
          found = e;
          break;
        }
      }
      if (found >= 0) break;
    }
    out += found >= 0 ? String.fromCharCode(found) : s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reader

class TvwReader {
  r: ByteReader;
  constructor(bytes: Uint8Array) {
    this.r = new ByteReader(bytes);
  }
  fail(what: string, at = this.r.pos): never {
    throw new ParseError('tvw.structure', `${what} (offset 0x${at.toString(16)})`, { offset: at });
  }
  eq(v: number, want: number, what: string) {
    if (v !== want) this.fail(`Unexpected ${what}: got ${v}, expected ${want}`, this.r.pos - 4);
  }
  count(v: number, what: string, minBytesEach: number) {
    // A count can never exceed what the remaining bytes could hold.
    if (v * minBytesEach > this.r.remaining) this.fail(`Implausible ${what} count ${v}`, this.r.pos - 4);
    return v;
  }
  vec(): [number, number] {
    return [this.r.s32('x'), this.r.s32('y')];
  }

  shape(): TvwShape {
    const r = this.r;
    this.eq(r.u32('shape tag'), 1, 'shape tag');
    const [sx, sy] = this.vec();
    const type = r.u32('shape type');
    switch (type) {
      case 0:
        this.vec();
        return { type, sx, sy, turn: 0 };
      case 1: {
        const turn = r.f32('rect turn');
        r.s32();
        return { type, sx, sy, turn };
      }
      case 3: {
        const turn = r.f32('roundrect turn');
        r.s32('corner radius');
        return { type, sx, sy, turn };
      }
      case 5: {
        r.u32();
        const name = r.str8('poly shape name');
        this.vec();
        this.vec();
        const n = this.count(r.u32('poly subobject count'), 'poly subobject', 4);
        let hasPoly = false;
        for (let i = 0; i < n; i++) {
          const st = r.u32('poly subobject type');
          if (st === 2) {
            if (hasPoly) this.fail('Poly shape has two vertex lists');
            hasPoly = true;
            r.skip(12, 'poly flags');
            const vc = this.count(r.u32('vertex count'), 'vertex', 8);
            r.skip(vc * 8, 'vertices');
          } else if (st === 5) {
            this.eq(r.u32(), 1, 'poly line param1');
            this.eq(r.u32(), 0, 'poly line param2');
            this.eq(r.u32(), 0, 'poly line param3');
            r.skip(20, 'poly line');
          } else this.fail(`Unrecognized poly subobject type ${st}`, r.pos - 4);
        }
        return { type, sx, sy, turn: 0, name };
      }
      default:
        this.fail(`Unrecognized pad shape type ${type}`, r.pos - 4);
    }
  }

  objectHeader(): { name: string; type: number } {
    const r = this.r;
    const m0 = r.u32('object magic'),
      m1 = r.u32('object magic');
    if (m0 !== 2 || m1 !== 1) this.fail(`Unexpected object magic ${m0},${m1} (expected 2,1)`, r.pos - 8);
    const name = r.str8('layer name');
    r.str8('initial name');
    r.str8('initial path');
    const type = r.u32('layer type');
    r.u32('pad color');
    r.u32('line color');
    return { name, type };
  }

  lines(L: TvwLogicLayer) {
    const r = this.r;
    const n = r.u32('line count');
    if (!n) return;
    this.eq(r.u32(), 0, 'line table tag');
    this.count(n, 'line', 24);
    for (let i = 0; i < n; i++) {
      const net = r.s32(),
        dcode = r.u32();
      if (dcode - 10 >= L.shapes.length || dcode < 10) this.fail(`Line references undefined D-code ${dcode}`, r.pos - 4);
      const [x1, y1] = this.vec();
      const [x2, y2] = this.vec();
      L.lines.push({ net, dcode, x1, y1, x2, y2 });
    }
  }

  arcs(L: TvwLogicLayer) {
    const r = this.r;
    const n = r.u32('arc count');
    if (!n) return;
    this.eq(r.u32(), 0, 'arc table tag');
    this.count(n, 'arc', 28);
    for (let i = 0; i < n; i++) {
      const net = r.s32(),
        dcode = r.u32();
      if (dcode - 10 >= L.shapes.length || dcode < 10) this.fail(`Arc references undefined D-code ${dcode}`, r.pos - 4);
      const [x, y] = this.vec();
      const rad = r.s32();
      const start = r.f32(),
        sweep = r.f32();
      L.arcs.push({ net, dcode, x, y, r: rad, start, sweep });
    }
  }

  logic(): TvwLogicLayer {
    const r = this.r;
    const h = this.objectHeader();
    const L: TvwLogicLayer = { kind: 'logic', name: h.name, type: h.type, shapes: [], pads: [], lines: [], arcs: [], surfaces: 0 };
    let maxD = r.u32('shape count');
    if (maxD) {
      if (maxD < 10) this.fail(`Invalid D-code table size ${maxD}`, r.pos - 4);
      maxD -= 10;
      this.count(maxD, 'shape', 16);
      for (let i = 0; i < maxD; i++) L.shapes.push(this.shape());
    }
    if (L.shapes.length) {
      const order = r.u32('data order');
      if (order !== 1 && order !== 2) this.fail(`Unrecognized data order ${order}`, r.pos - 4);
      this.eq(r.u32(), 0, 'layer tag');
      this.eq(r.u32(), 1, 'layer tag');
      // pads
      const np = r.u32('pad count');
      if (np) {
        this.eq(r.u32(), 2, 'pad table tag');
        this.count(np, 'pad', 19);
        for (let i = 0; i < np; i++) {
          const net = r.s32(),
            dcode = r.u32();
          const [x, y] = this.vec();
          const exposed = r.bool8('pad exposed'),
            copper = r.bool8('pad copper');
          const tp = r.u8('pad testpoint param');
          if (dcode - 10 >= L.shapes.length || dcode < 10) this.fail(`Pad references undefined D-code ${dcode}`, r.pos - 1);
          let hasHole = false,
            holeX = 0,
            holeY = 0;
          if (copper) {
            const something = r.bool8('pad flag');
            if (tp === 1) r.skip(12, 'testpoint data');
            if (exposed || something) r.skip(16, 'exposed area');
            hasHole = r.bool8('pad has hole');
            r.u8('pad tail');
            if (hasHole) {
              r.skip(7, 'hole data');
              [holeX, holeY] = this.vec();
              r.u8('hole param');
            }
          } else if (exposed || tp === 1) this.fail('Non-copper pad with exposed/testpoint data', r.pos - 1);
          L.pads.push({ net, dcode, x, y, hasHole, holeX, holeY });
        }
      }
      this.lines(L);
      this.arcs(L);
      // surfaces (copper pours) – parsed for structure, not kept
      const ns = r.u32('surface count');
      if (ns) {
        this.eq(r.u32(), 2, 'surface table tag');
        this.count(ns, 'surface', 16);
        for (let i = 0; i < ns; i++) {
          r.s32('surface net');
          const ec = this.count(r.u32('surface edges'), 'surface edge', 8);
          r.skip(ec * 8, 'surface vertices');
          r.s32('surface line width');
          const nv = this.count(r.u32('surface voids'), 'surface void', 8);
          if (nv) {
            for (let v = 0; v < nv; v++) {
              const tag = r.u32('void tag');
              if (tag > 1) this.fail(`Unexpected void tag ${tag}`, r.pos - 4);
              const vc = this.count(r.u32('void edges'), 'void edge', 8);
              r.skip(vc * 8, 'void vertices');
            }
            r.u32('void flags');
          }
        }
        L.surfaces = ns;
      }
      if (order === 2) {
        r.skip(16, 'extra data');
        this.lines(L);
        this.arcs(L);
        this.eq(r.u32(), 0, 'extra data tail');
      }
    }
    // unknown items
    const nu = r.u32('unknown item count');
    r.u32('unknown item param');
    if (nu) {
      this.count(nu, 'unknown item', 39);
      for (let i = 0; i < nu; i++) {
        r.str8('item name');
        r.skip(8 + 24, 'item data');
        r.bool8();
        r.bool8();
        r.bool8();
        r.s32();
      }
      this.eq(r.u32(), 0, 'unknown items tail');
    }
    this.eq(r.u32(), 7, 'testpoint section tag');
    // test points
    const tc = this.count(r.u32('testpoint count'), 'testpoint', 42);
    for (let i = 0; i < tc; i++) {
      r.bool8();
      r.skip(16 + 8 + 4);
      r.bool8();
      r.skip(12);
    }
    this.eq(r.u32(), 0, 'testpoint tail');
    this.eq(r.u32(), 4, 'testpoint tail');
    for (let k = 0; k < 2; k++) {
      const n = this.count(r.u32('testpoint2 count'), 'testpoint2', 49);
      r.u32('testpoint2 param');
      for (let i = 0; i < n; i++) {
        r.skip(12 + 24);
        r.bool8();
        r.bool8();
        r.bool8();
        r.skip(8);
        r.bool8();
        r.bool8();
        r.bool8();
        r.skip(4);
      }
    }
    const ts = this.count(r.u32('test sequence count'), 'test node', 9);
    const tsp = r.u32('test sequence param');
    for (let i = 0; i < ts; i++) {
      r.skip(8);
      r.bool8();
    }
    if (tsp === 1) {
      this.eq(r.u32(), 0, 'test sequence tail');
      this.eq(r.u32(), 0, 'test sequence tail');
      this.eq(r.u32(), 0, 'test sequence tail');
    }
    return L;
  }

  through(): TvwThroughLayer {
    const r = this.r;
    const h = this.objectHeader();
    const T: TvwThroughLayer = { kind: 'through', name: h.name, type: h.type, tools: [], toolInfo: [], holes: [], slots: [], arcs: [] };
    this.eq(r.u32(), 0, 'through-layer tag');
    this.eq(r.u32(), 0, 'through-layer tag');
    let tc = r.u32('tool count');
    if (tc === 0) return T; // empty through-layer (common on Lenovo/LCFC boards)
    tc--;
    this.count(tc, 'tool', 29);
    for (let i = 0; i < tc; i++) {
      const flag1 = r.bool8(),
        flag2 = r.bool8();
      const size = r.u32('tool size');
      const data = [r.s32(), r.s32(), r.s32(), r.s32(), r.s32()];
      const color = [r.u8(), r.u8(), r.u8()];
      T.tools.push(size);
      T.toolInfo.push({ flag1, flag2, size, data, color });
    }
    this.eq(r.u8(), 0, 'drill table tag');
    const dc = this.count(r.u32('drill count'), 'drill', 17);
    r.u32();
    for (let i = 0; i < 4; i++) this.eq(r.u32(), 0, 'drill table padding');
    for (let i = 0; i < dc; i++) {
      const code = r.u8('drill code');
      if (code === 0x08) {
        const net = r.s32(),
          tool = r.u32();
        const [x, y] = this.vec();
        T.holes.push({ net, tool, x, y });
      } else if (code === 0x0a) {
        const net = r.s32(),
          tool = r.u32();
        const [x1, y1] = this.vec();
        const [x2, y2] = this.vec();
        r.u32();
        T.slots.push({ net, tool, x1, y1, x2, y2 });
      } else if (code === 0x0b) {
        const net = r.s32(),
          tool = r.u32();
        const [cx, cy] = this.vec();
        const rad = r.s32('arc radius');
        const start = r.f32('arc start angle'),
          sweep = r.f32('arc sweep angle');
        T.arcs.push({ net, tool, cx, cy, r: rad, start, sweep });
      } else this.fail(`Unrecognized drill code 0x${code.toString(16)}`, r.pos - 1);
    }
    return T;
  }

  object(): TvwLayer {
    const r = this.r;
    let type = 0;
    for (let i = 0; i < 4 && !type; i++) type = r.u32('object type');
    if (type === 3) return this.logic();
    if (type === 1) return this.through();
    this.fail(`Unrecognized object type ${type}`, r.pos - 4);
  }

  fixtureData() {
    const r = this.r;
    r.u32();
    r.skip(24);
    r.bool8();
    r.bool8();
    r.bool8();
    const items = this.count(r.u32('fixture item count'), 'fixture item', 1);
    if (items === 0) this.fail('Fixture data without items', r.pos - 4);
    for (let i = 0; i < items; i++) if (r.bool8('fixture item present')) r.skip(4 + 20 + 4);
    const boxes = r.u32('probe box count');
    r.u32();
    r.skip(16);
    this.count(boxes, 'probe box', 17);
    r.skip(boxes * 17, 'probe boxes');
  }

  probeBox32() {
    this.r.skip(4 + 16);
  }

  probes() {
    const r = this.r;
    this.eq(r.u32(), 0, 'probe registry tag');
    this.eq(r.u32(), 0, 'probe registry tag');
    this.eq(r.u32(), 4, 'probe registry param');
    r.str8('probe registry name');
    r.u32('default probe size');
    const packs = this.count(r.u32('probe pack count'), 'probe pack', 4);
    if (!packs) this.fail('Probe registry without packs', r.pos - 4);
    for (let p = 0; p < packs; p++) {
      const n = this.count(r.u32('probe count'), 'probe', 60);
      for (let i = 0; i < n; i++) {
        r.bool8();
        r.u32();
        r.str8('probe name');
        r.skip(4 * 15, 'probe header');
        if (r.bool8('probe has body')) {
          this.fixtureData();
          r.skip(16);
          const b2 = this.count(r.u32('double box count'), 'double box', 44);
          r.skip(b2 * 44, 'double boxes');
        }
        r.u32();
        r.bool8();
        r.bool8();
        r.bool8();
        r.u8();
        r.skip(12);
        this.probeBox32();
        this.probeBox32();
      }
    }
  }

  fixtures() {
    const r = this.r;
    this.eq(r.u32(), 0, 'fixture registry tag');
    this.eq(r.u32(), 7874, 'fixture registry tag');
    for (let i = 0; i < 8; i++) r.str8('grid name');
    for (let s = 0; s < 2; s++) {
      this.eq(r.u32(), 3, 'fixture setting tag');
      r.str8('fixture setting name');
      this.eq(r.u32(), 0, 'fixture setting param');
      const nv = this.count(r.u32('fixture variant count'), 'fixture variant', 8);
      for (let i = 0; i < nv; i++) {
        r.str8();
        r.str8();
        r.bool8();
        r.bool8();
        this.fixtureData();
      }
      r.skip(8, 'workspace size');
    }
  }

  mysteriousBlock() {
    const r = this.r;
    r.skip(8 + 8 + 8);
    r.bool8();
    r.bool8();
    r.u8();
    r.u8();
    r.skip(16);
    for (let i = 0; i < 6; i++) r.bool8();
    r.skip(16 + 2);
  }

  part(): TvwPart {
    const r = this.r;
    const name = r.str8('part name');
    const [x0, y0] = this.vec();
    const [x1, y1] = this.vec();
    const [x, y] = this.vec();
    const angle = r.s32('part angle');
    const decal = r.u32('part decal');
    const type = r.u32('part type');
    this.eq(r.u32(), 0, 'part tag');
    const height = r.s32('part height');
    const flag0 = r.bool8('part flag');
    const value = r.str8('part value');
    const tolP = r.str8();
    const tolN = r.str8();
    const desc = r.str8('part description');
    let serial = '';
    if (flag0) {
      serial = r.str8('part serial');
      this.eq(r.u32(), 0, 'part serial tag');
    }
    const pc = this.count(r.u32('pin count'), 'pin', 17);
    const layer = r.u32('part layer');
    this.eq(r.u32(), 0, 'part tail');
    const pins: TvwPin[] = [];
    for (let i = 0; i < pc; i++) {
      const handle = r.u32('pin handle');
      this.eq(r.u32(), 0, 'pin tag');
      const id = r.u32('pin id');
      const pname = r.str8('pin name');
      this.eq(r.u32(), 0, 'pin tail');
      pins.push({ handle, id, name: pname });
    }
    return { name, bbox: [x0, y0, x1, y1], x, y, angle, decal, type, height, value, tolP, tolN, desc, serial, layer, pins };
  }

  decal(): TvwDecal {
    const r = this.r;
    if (!r.bool8('decal flag')) this.fail('Decal record flag is not set', r.pos - 1);
    const name = r.str8('decal name');
    r.skip(12);
    r.bool8();
    const layers: (TvwLayer | null)[] = [];
    for (let i = 0; i < 3; i++) layers.push(r.bool8('decal layer present') ? this.object() : null);
    if (!r.bool8('decal outline flag')) this.fail('Decal outline flag is not set', r.pos - 1);
    r.u32();
    r.s32();
    const vc = this.count(r.u32('decal outline vertex count'), 'decal vertex', 8);
    const outline: number[] = [];
    for (let i = 0; i < vc; i++) outline.push(r.s32(), r.s32());
    r.skip(8, 'decal outline tail');
    return { name, outline, layers };
  }

  read(progress?: (f: number) => void): TvwBoard {
    const r = this.r;
    const type = tvwDecodeString(r.str8('header type'));
    r.u32();
    const customer = tvwDecodeString(r.str8('customer'));
    r.u8();
    const date = tvwDecodeString(r.str8('date'));
    r.skip(3 + 12);
    const layerCount = r.u32('layer count');
    if (layerCount > 1000) this.fail(`Implausible layer count ${layerCount}`, r.pos - 4);
    const layers: TvwLayer[] = [];
    for (let i = 0; i < layerCount; i++) {
      layers.push(this.object());
      progress?.((0.7 * r.pos) / r.end);
    }
    for (let i = 0; i < 4; i++) this.eq(r.u32(), 0, 'net list padding');
    const nc = r.u32('net count'),
      nc2 = r.u32('net count');
    if (!(nc > 0 && nc === nc2)) this.fail(`Inconsistent net counts ${nc}/${nc2}`, r.pos - 8);
    this.count(nc, 'net', 1);
    const nets: string[] = [];
    for (let i = 0; i < nc; i++) nets.push(r.str8('net name'));
    this.probes();
    this.fixtures();
    this.mysteriousBlock();
    const pc = this.count(r.u32('part count'), 'part', 60);
    r.u32();
    const parts: TvwPart[] = [];
    for (let i = 0; i < pc; i++) parts.push(this.part());
    progress?.(0.9);
    const decals: TvwDecal[] = [];
    try {
      this.eq(r.u32(), 3, 'decal section tag');
      const dc = this.count(r.u32('decal count'), 'decal', 30);
      for (let i = 0; i < dc; i++) decals.push(this.decal());
    } catch {
      // Decals only provide footprint names; everything needed is already read.
      decals.length = 0;
    }
    return { header: { type, customer, date, layerCount }, layers, nets, parts, decals };
  }
}

export function readTvw(bytes: Uint8Array, progress?: (f: number) => void): TvwBoard {
  return new TvwReader(bytes).read(progress);
}

// ---------------------------------------------------------------------------
// Mapping to the normalized model

const PART_TYPES: Record<number, string> = {
  0: 'Chip',
  1: 'Diode',
  2: 'Transistor',
  3: 'Resistor',
  5: 'Capacitor',
  9: 'Jumper',
  13: 'Fuse',
  14: 'Choke',
  15: 'Oscillator',
  16: 'Switch',
  17: 'Connector',
  18: 'Test point',
  21: 'Mechanical',
  29: 'Fiducial',
};

const U = 1 / 100; // raw → mil

/**
 * Places a decal-local outline polygon (raw units) on the board: rotate by
 * `angle` degrees counter-clockwise, mirror X for bottom-side parts, translate
 * to the part position. Returns closed-polygon segments in mils, or null.
 */
export function placeOutline(outline: number[], px: number, py: number, angle: number, bottom: boolean): number[] | null {
  const n = Math.floor(outline.length / 2);
  if (n < 2) return null;
  const a = (angle * Math.PI) / 180;
  // Snap exact quarter turns so axis-aligned bodies stay exactly axis-aligned.
  const c = Math.abs(Math.cos(a)) < 1e-12 ? 0 : Math.cos(a),
    s = Math.abs(Math.sin(a)) < 1e-12 ? 0 : Math.sin(a);
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = outline[2 * i],
      y = outline[2 * i + 1];
    let u = x * c - y * s;
    const v = x * s + y * c;
    if (bottom) u = -u;
    pts.push((px + u) * U, (py + v) * U);
  }
  const segs: number[] = [];
  const closed = n > 2;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    if (pts[2 * i] === pts[2 * j] && pts[2 * i + 1] === pts[2 * j + 1]) continue;
    segs.push(pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]);
  }
  return segs.length ? segs : null;
}

function padShape(s: TvwShape): { shape: PadShape; w: number; h: number; rot: number } {
  const w = Math.abs(s.sx) * U,
    h = Math.abs(s.sy) * U;
  switch (s.type) {
    case 0:
      return { shape: SHAPE_CIRCLE, w: w || h, h: h || w, rot: 0 };
    case 1:
      return { shape: SHAPE_RECT, w, h, rot: s.turn || 0 };
    case 3:
      return { shape: SHAPE_ROUNDRECT, w, h, rot: s.turn || 0 };
    default:
      return { shape: SHAPE_RECT, w, h, rot: 0 };
  }
}

export function tvwToModel(board: TvwBoard, b: BoardBuilder) {
  let topIdx = -1,
    botIdx = -1;
  board.layers.forEach((l, i) => {
    if (l.kind !== 'logic') return;
    if (l.type === TvwLayerType.Top) topIdx = i;
    else if (l.type === TvwLayerType.Bottom) botIdx = i;
  });
  if (topIdx < 0 && botIdx < 0) throw new ParseError('tvw.nocopper', 'The TVW file has no top or bottom copper layer');

  const layerInfos: LayerInfo[] = board.layers.map((l, i) => ({
    id: i,
    name: l.name || LAYER_TYPE_NAMES[l.type] || `Layer ${i}`,
    kind: l.type === TvwLayerType.Top ? 'top' : l.type === TvwLayerType.Bottom ? 'bottom' : l.type === TvwLayerType.Signal ? 'inner' : l.type === TvwLayerType.Plane ? 'plane' : 'other',
  }));

  const netName = (n: number) => (n >= 0 && n < board.nets.length ? board.nets[n] : '');
  let skipped = 0,
    missingPad = 0,
    noDecal = 0;
  const xs: number[] = [],
    ys: number[] = [];
  // Drilled pin positions (0.1 mil grid): the drill table repeats every pin's
  // own hole, which must not be drawn again as a separate via.
  const pinHoles = new Set<string>();
  const holeKey = (x: number, y: number) => `${Math.round(x / 10)},${Math.round(y / 10)}`;
  for (const part of board.parts) {
    const layer = part.layer === topIdx ? (board.layers[topIdx] as TvwLogicLayer) : part.layer === botIdx ? (board.layers[botIdx] as TvwLogicLayer) : null;
    if (!layer) {
      skipped++;
      continue;
    }
    const top = part.layer === topIdx;
    let th = false;
    for (const pin of part.pins) {
      const pad = layer.pads[Math.floor(pin.handle / 8)];
      if (pad?.hasHole) th = true;
    }
    const attrs: [string, string][] = [];
    if (PART_TYPES[part.type]) attrs.push(['Type', PART_TYPES[part.type]]);
    if (part.desc) attrs.push(['Description', part.desc]);
    if (part.tolP || part.tolN) attrs.push(['Tolerance', `+${part.tolP || '?'} / -${part.tolN || '?'}`]);
    if (part.serial) attrs.push(['Serial', part.serial]);
    if (part.height) attrs.push(['Height', `${(part.height * U).toFixed(2)} mil`]);
    // Body outline: the decal (footprint) outline placed like the pads are —
    // rotated by the part angle (CCW) and, on the bottom side, mirrored in X
    // after the rotation. Verified on a real board where this reproduces every
    // pad of every part from the decal's local pads. The part record's own
    // "Bbox" is not used: it includes the reference-designator text and is
    // offset from the body for rotated parts.
    const decal = board.decals[part.decal];
    const body = decal ? placeOutline(decal.outline, part.x, part.y, part.angle, !top) : null;
    if (!body) noDecal++;
    const idx = b.addPart({
      name: part.name,
      side: top ? SIDE_TOP : SIDE_BOTTOM,
      mount: th ? MOUNT_TH : MOUNT_SMD,
      x: part.x * U,
      y: part.y * U,
      rot: part.angle,
      body,
      // Mechanical (mounting holes, standoffs) and fiducials have no electrical function.
      mechanical: part.type === 21 || part.type === 29,
      value: part.value || null,
      footprint: board.decals[part.decal]?.name ?? null,
      attrs,
    });
    for (const pin of part.pins) {
      const pad = layer.pads[Math.floor(pin.handle / 8)];
      if (!pad) {
        missingPad++;
        b.addPin({ part: idx, x: part.x * U, y: part.y * U, net: null, number: pin.name });
        xs.push(part.x * U);
        ys.push(part.y * U);
        continue;
      }
      const sh = padShape(layer.shapes[pad.dcode - 10]);
      if (pad.hasHole) pinHoles.add(holeKey(pad.x, pad.y));
      const x = pad.x * U,
        y = pad.y * U;
      xs.push(x);
      ys.push(y);
      b.addPin({
        part: idx,
        x,
        y,
        net: netName(pad.net),
        number: pin.name,
        shape: sh.shape,
        w: sh.w,
        h: sh.h,
        rot: sh.rot,
        hole: pad.hasHole ? Math.max(pad.holeX, pad.holeY) * U : 0,
      });
    }
  }
  if (noDecal) b.info('tvw.nodecal', `${noDecal} part(s) have no decal outline; their bodies are derived from pin positions`);
  if (skipped) b.info('tvw.innerparts', `${skipped} part(s) are not placed on the top/bottom copper layers and are not shown`);
  if (missingPad) b.warn('tvw.missingpad', `${missingPad} pin(s) reference a pad that does not exist; placed at the part origin without a net`);

  // Board outline: route-layer slots, filtered against the populated area (reference behaviour).
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    bx0 = Math.min(bx0, xs[i]);
    bx1 = Math.max(bx1, xs[i]);
    by0 = Math.min(by0, ys[i]);
    by1 = Math.max(by1, ys[i]);
  }
  let outlineSegs = 0,
    strays = 0;
  const near = (x: number, y: number) => {
    if (!Number.isFinite(bx0)) return true;
    const mx = Math.max(2000, (bx1 - bx0) / 2),
      my = Math.max(2000, (by1 - by0) / 2);
    return x >= bx0 - mx && x <= bx1 + mx && y >= by0 - my && y <= by1 + my;
  };
  for (const l of board.layers) {
    if (l.kind !== 'through' || l.type !== TvwLayerType.Roul) continue;
    for (const s of l.slots) {
      const x1 = s.x1 * U,
        y1 = s.y1 * U,
        x2 = s.x2 * U,
        y2 = s.y2 * U;
      if (!near(x1, y1) || !near(x2, y2)) {
        strays++;
        continue;
      }
      b.addOutlineSeg(x1, y1, x2, y2);
      outlineSegs++;
    }
    for (const a of l.arcs) {
      const cx = a.cx * U,
        cy = a.cy * U,
        rad = Math.abs(a.r) * U;
      if (!near(cx, cy) || !Number.isFinite(a.start) || !Number.isFinite(a.sweep) || Math.abs(a.sweep) > 720) {
        strays++;
        continue;
      }
      const n = Math.max(2, Math.min(64, Math.ceil(Math.abs(a.sweep) / 7.5)));
      const s0 = (a.start * Math.PI) / 180,
        sw = (a.sweep * Math.PI) / 180;
      let px = cx + rad * Math.cos(s0),
        py = cy + rad * Math.sin(s0);
      for (let k = 1; k <= n; k++) {
        const t = s0 + (sw * k) / n;
        const x = cx + rad * Math.cos(t),
          y = cy + rad * Math.sin(t);
        b.addOutlineSeg(px, py, x, y);
        px = x;
        py = y;
      }
      outlineSegs++;
    }
  }
  if (strays) b.info('tvw.strayoutline', `${strays} route segment(s) far outside the populated area were ignored`);
  if (outlineSegs > 0 && outlineSegs < 3) b.warn('tvw.thinoutline', 'Route layer has fewer than 3 segments; outline may be incomplete');

  // Copper traces (real geometry from the file) and drill holes.
  board.layers.forEach((l, li) => {
    if (l.kind === 'logic' && (l.type === TvwLayerType.Top || l.type === TvwLayerType.Bottom || l.type === TvwLayerType.Signal || l.type === TvwLayerType.Plane)) {
      for (const ln of l.lines) {
        const s = l.shapes[ln.dcode - 10];
        b.addTrace(ln.x1 * U, ln.y1 * U, ln.x2 * U, ln.y2 * U, s ? Math.abs(s.sx) * U : 0, li, netName(ln.net));
      }
      for (const a of l.arcs) {
        const s = l.shapes[a.dcode - 10];
        const w = s ? Math.abs(s.sx) * U : 0;
        const n = Math.max(2, Math.min(32, Math.ceil(Math.abs(a.sweep) / 10)));
        const r = a.r * U;
        const cx = a.x * U,
          cy = a.y * U;
        const s0 = (a.start * Math.PI) / 180,
          sw = (a.sweep * Math.PI) / 180;
        let px = cx + r * Math.cos(s0),
          py = cy + r * Math.sin(s0);
        for (let k = 1; k <= n; k++) {
          const t = s0 + (sw * k) / n;
          const x = cx + r * Math.cos(t),
            y = cy + r * Math.sin(t);
          b.addTrace(px, py, x, y, w, li, netName(a.net));
          px = x;
          py = y;
        }
      }
    } else if (l.kind === 'through' && l.type === TvwLayerType.Drill) {
      let pinDrills = 0;
      for (const h of l.holes) {
        if (pinHoles.has(holeKey(h.x, h.y))) {
          pinDrills++;
          continue;
        }
        const size = l.tools[h.tool - 1];
        b.addVia(h.x * U, h.y * U, size !== undefined ? size * U : 0, netName(h.net));
      }
      if (pinDrills) b.info('tvw.pindrills', `${pinDrills} drill record(s) are the holes of through-hole pins; they are drawn as holes in those pads, not as separate vias`);
    }
  });
  b.layers = layerInfos;
}

export const tvwFormat: FormatModule = {
  id: 'tvw',
  name: 'Tebo-ICT View (TVW)',
  extensions: ['tvw'],
  status: 'verified',
  summary: 'Teboview binary: parts, pins, nets, pads, outline, copper traces, drills',
  detect(s) {
    if (startsWithBytes(s.head, TVW_SIGNATURE)) return { confidence: 0.99, reason: 'Ciphered "Tebo-ictview files." header' };
    if (s.ext === 'tvw') return { confidence: 0.35, reason: '.tvw extension, but the standard Teboview header is missing' };
    return null;
  },
  parse(ctx) {
    if (!startsWithBytes(ctx.file.bytes, TVW_SIGNATURE)) {
      throw new ParseError('tvw.variant', 'This .tvw file does not start with the standard "Tebo-ictview files." header. It may be a different Teboview variant that is not supported yet.');
    }
    ctx.progress('Reading TVW structure', 0);
    const board = readTvw(ctx.file.bytes, (f) => ctx.progress('Reading TVW structure', f));
    const b = new BoardBuilder();
    b.units = { unit: 'mil', toMm: 0.0254, assumed: false, note: 'TVW stores 1/100 mil fixed point' };
    b.metadata.push(['Header', board.header.type]);
    if (board.header.customer) b.metadata.push(['Customer', board.header.customer]);
    if (board.header.date) b.metadata.push(['Date', board.header.date]);
    b.metadata.push(['Layers', String(board.layers.length)]);
    tvwToModel(board, b);
    if (b.partCount === 0) throw new ParseError('tvw.noparts', 'No parts found on the top/bottom copper layers');
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: null, extraFiles: [] });
  },
};
