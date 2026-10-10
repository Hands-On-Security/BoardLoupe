/**
 * Cadence Allegro board database (.brd), read natively.
 *
 * Layout (little-endian): a header with the magic (release), the string
 * count (u32 @0x194) and a 256-entry layer map; a string table at 0x1200
 * (u32 id, NUL-terminated text, padded to 4); then a stream of typed
 * records. Each record starts with u8 tag, u8, u8 class, u8 subclass, u32
 * key (unique id), and most continue with u32 next (linked lists). Records
 * refer to each other by key; strings by id. Record sizes depend on the
 * release; variable-length records carry their own counts.
 *
 * What is read (16.x layout shown; 17.x moves most fields by 4–8 bytes, see
 * the Fields tables; offsets in bytes from the record start):
 *   0x2d placed footprint  +12 → 0x07 refdes (+20 string), +24 rotation (m°),
 *                          +28/+32 origin, +40 → first pad, class byte bit 0 = bottom
 *   0x32 placed pad        +12 → 0x04 net assignment (+12 → 0x1b net, +12 name),
 *                          +20 next pad of the footprint, +32 → 0x0d pad definition
 *                          (+8 pin number, +16/+20 local offset, +24 → 0x1c padstack),
 *                          +60..+72 copper bounding box
 *   0x1c padstack          +16 drill, +88 first-layer pad type (2 circle, 6 oblong)
 *   0x33 via               +12 net assignment, +24/+28 position, +56..+68 box
 *   0x05 track             class 6 (etch), subclass = copper layer; +12 net assignment,
 *                          +48 → first segment (0x15/0x16/0x17 lines, 0x01 arcs; +8 next,
 *                          +20 width, +24..+36 endpoints; arcs add centre and radius as
 *                          doubles at +40/+48/+56, subclass bit 0x40 = clockwise)
 *   0x28 shape             class 1 (board geometry); +32 → first segment. The outline is
 *                          subclass OUTLINE (0xFD), else DESIGN_OUTLINE (0xEA), else a user
 *                          subclass named like an outline (names in the 0x2a lists)
 *
 * Coordinates are 1/100 mil, Y up. Pins are placed from the pad definition:
 * negate local X on the bottom side, rotate counter-clockwise, translate —
 * on real Allegro 16.6 and 17.2 boards this reproduces every pin of KiCad's
 * own import exactly. Copper zones, text and silkscreen are not read.
 */
import { ParseError } from '../io/bytes';
import { BoardBuilder } from '../model/builder';
import { type LayerInfo, MOUNT_SMD, MOUNT_TH, SHAPE_CIRCLE, SHAPE_OBLONG, SHAPE_RECT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP } from '../model/types';
import type { FormatModule } from './types';

/** Header magic (low byte masked) → release. */
export const ALLEGRO_RELEASES: Record<number, string> = {
  0x00120000: '15.x',
  0x00120100: '15.5',
  0x00120200: '15.7',
  0x00130000: '16.0',
  0x00130400: '16.2',
  0x00130c00: '16.4',
  0x00131000: '16.5',
  0x00131500: '16.6',
  0x00140400: '17.2',
  0x00140900: '17.4',
  0x00141500: '17.5',
  0x00150000: '18.0',
  0x00150200: '18.0',
  0x00160100: '18.x',
};

/** Fixed record sizes of the 16.x layout. */
const SIZE16: Record<number, number> = {
  0x01: 80, 0x02: 36, 0x04: 20, 0x05: 60, 0x06: 36, 0x07: 40, 0x08: 24, 0x09: 44, 0x0a: 68, 0x0c: 56, 0x0d: 40, 0x0e: 60, 0x0f: 56,
  0x10: 32, 0x11: 24, 0x12: 28, 0x14: 32, 0x15: 40, 0x16: 40, 0x17: 40, 0x1b: 56, 0x1e: 24, 0x20: 40, 0x22: 40, 0x23: 84,
  0x24: 52, 0x26: 20, 0x28: 68, 0x2b: 72, 0x2c: 36, 0x2d: 64, 0x2e: 36, 0x2f: 32, 0x30: 44, 0x32: 76, 0x33: 72, 0x34: 32, 0x35: 124, 0x37: 428,
  0x38: 52, 0x39: 60, 0x3a: 16,
};
/** Fixed record sizes of the 17.x layout (measured on a real 17.2 board). */
const SIZE17: Record<number, number> = {
  0x01: 84, 0x02: 72, 0x04: 20, 0x05: 68, 0x06: 40, 0x07: 48, 0x08: 32, 0x09: 48, 0x0a: 72, 0x0b: 72, 0x0c: 64, 0x0d: 44, 0x0e: 68, 0x0f: 60,
  0x10: 36, 0x11: 24, 0x12: 28, 0x14: 36, 0x15: 44, 0x16: 44, 0x17: 44, 0x1b: 60, 0x1e: 28, 0x20: 40, 0x22: 44, 0x23: 84,
  0x24: 56, 0x26: 24, 0x28: 76, 0x2b: 76, 0x2c: 44, 0x2d: 72, 0x2e: 40, 0x2f: 32, 0x30: 56, 0x32: 84, 0x33: 80, 0x34: 36, 0x35: 124, 0x37: 428,
  0x38: 52, 0x39: 60, 0x3a: 16,
};
/** Entry size of 0x36 tables by subtype. */
const TABLE36_16: Record<number, number> = { 0x02: 100, 0x03: 32, 0x06: 208, 0x08: 32, 0x0b: 1016, 0x0f: 20 };
const TABLE36_17: Record<number, number> = { 0x02: 108, 0x06: 8, 0x08: 64, 0x0b: 1016, 0x0c: 232, 0x0d: 200, 0x0f: 20, 0x10: 108 };

/** Field offsets of the records that are read. */
interface Fields {
  /** 0x2d placed footprint: rotation, origin x/y, → 0x07, → first pad. */
  fpRot: number;
  fpX: number;
  fpY: number;
  fpRef: number;
  fpPad: number;
  /** 0x07: refdes string. */
  refStr: number;
  /** 0x32 placed pad: → net assignment, → next pad, → pad definition, copper box. */
  padNet: number;
  padNext: number;
  padDef: number;
  padBox: number;
  /** 0x33 via: → net assignment, x/y, box. */
  viaNet: number;
  viaX: number;
  viaBox: number;
  /** 0x05 track: → net assignment, → first segment. */
  trkNet: number;
  trkSeg: number;
  /** 0x28 shape: → first segment, bounding box. */
  shpSeg: number;
  shpBox: number;
  /** Segments: width, then x1 y1 x2 y2; arcs: centre/radius doubles after the endpoints. */
  segW: number;
  arcD: number;
  /** 0x1c padstack: drill, first-layer pad type (0 = unknown). */
  psDrill: number;
  psType: number;
}
const F16: Fields = { fpRot: 24, fpX: 28, fpY: 32, fpRef: 12, fpPad: 40, refStr: 20, padNet: 12, padNext: 20, padDef: 32, padBox: 60, viaNet: 12, viaX: 24, viaBox: 56, trkNet: 12, trkSeg: 48, shpSeg: 32, shpBox: 52, segW: 20, arcD: 40, psDrill: 16, psType: 88 };
const F17: Fields = { fpRot: 28, fpX: 32, fpY: 36, fpRef: 40, fpPad: 48, refStr: 28, padNet: 12, padNext: 24, padDef: 36, padBox: 68, viaNet: 12, viaX: 32, viaBox: 64, trkNet: 12, trkSeg: 56, shpSeg: 40, shpBox: 60, segW: 24, arcD: 44, psDrill: 64, psType: 0 };

export interface Layout {
  v17: boolean;
  sizes: Record<number, number>;
  table36: Record<number, number>;
  f: Fields;
}
const LAYOUT16: Layout = { v17: false, sizes: SIZE16, table36: TABLE36_16, f: F16 };
const LAYOUT17: Layout = { v17: true, sizes: SIZE17, table36: TABLE36_17, f: F17 };

interface Walk {
  /** Parallel arrays: tag and offset of every record, in file order. */
  tags: Uint8Array;
  offs: Uint32Array;
  count: number;
  /** key → record index. */
  byKey: Map<number, number>;
  resyncs: number;
}

class AllegroFile {
  readonly b: Uint8Array;
  readonly v: DataView;
  readonly strings = new Map<number, string>();
  readonly L: Layout;
  constructor(bytes: Uint8Array) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.L = bytes.length >= 4 && bytes[2] >= 0x14 ? LAYOUT17 : LAYOUT16;
  }
  u8 = (o: number) => this.b[o];
  u16 = (o: number) => this.v.getUint16(o, true);
  u32 = (o: number) => this.v.getUint32(o, true);
  i32 = (o: number) => this.v.getInt32(o, true);
  /** IEEE double stored as two big-endian-ordered 32-bit words (high word first). */
  f64(o: number) {
    const t = new DataView(new ArrayBuffer(8));
    t.setUint32(0, this.u32(o));
    t.setUint32(4, this.u32(o + 4));
    return t.getFloat64(0);
  }

  readStrings(): number {
    const n = this.u32(0x194);
    if (n > this.b.length / 5) throw new ParseError('allegro.strings', `Implausible string count ${n}`, { offset: 0x194 });
    let p = 0x1200;
    for (let i = 0; i < n; i++) {
      if (p + 4 > this.b.length) throw new ParseError('allegro.strings', 'String table runs past the end of the file', { offset: p });
      const id = this.u32(p);
      let e = p + 4;
      while (e < this.b.length && this.b[e] !== 0) e++;
      let s = '';
      for (let j = p + 4; j < e; j++) s += String.fromCharCode(this.b[j]);
      this.strings.set(id, s);
      p = (e + 1 + 3) & ~3;
    }
    return p;
  }

  /** Size of the record at p, or 0 when it cannot be determined. */
  size(p: number): number {
    const tag = this.b[p];
    const v17 = this.L.v17;
    const fixed = this.L.sizes[tag];
    if (fixed) return fixed;
    switch (tag) {
      case 0x1c:
        return v17 ? 948 + 144 * this.u16(p + 44) : 392 + 84 * this.u16(p + 50);
      case 0x21:
        return this.u32(p + 4);
      case 0x1d:
        // header, 56 bytes per layer, 256 bytes per entry
        return (v17 ? 28 : 24) + 56 * this.u16(p + 22) + 256 * this.u16(p + 20);
      case 0x1f:
        return (52 + 278 * this.u16(p + 26) + 3) & ~3;
      case 0x31:
        return 24 + ((this.u16(p + 22) + 3) & ~3);
      case 0x3c:
        return 12 + 4 * this.u32(p + 8);
      case 0x2a:
        // u16 count, count × (string, flags, 0), key
        return 8 + 12 * this.u16(p + 2);
      case 0x36: {
        const e = this.L.table36[this.u16(p + 2)];
        return e ? (v17 ? 32 + this.u32(p + 16) * e : 28 + this.u32(p + 12) * e) : 0;
      }
      case 0x03: {
        // 17.x has two more header words: type at +16, length at +18, count at +24.
        const h = v17 ? 8 : 0;
        const t = this.b[p + 12 + (v17 ? 4 : 0)];
        const len = this.u16(p + 14 + (v17 ? 4 : 0));
        const n = this.u32(p + 16 + h);
        if (t === 0x68 || t === 0x6b || t === 0x73) return 16 + h + ((len + 3) & ~3);
        if (t === 0x6c) return 20 + h + 4 * n;
        if (t === 0x65) return 16 + h;
        if (t === 0x64 || t === 0x66 || t === 0x67 || t === 0x6a) return 20 + h;
        if (t === 0x69) return 24 + h;
        if (t === 0x6e) return 20 + h + ((n + 3) & ~3);
        if (t === 0x6f) return 20 + h + 4 * n;
        return 0;
      }
      default:
        return 0;
    }
  }

  /** Walks the record stream; unknown layouts are skipped by finding the next record header. */
  walk(start: number, progress?: (f: number) => void): Walk {
    const b = this.b;
    const cap = Math.max(1024, Math.floor((b.length - start) / 16));
    let tags = new Uint8Array(cap),
      offs = new Uint32Array(cap);
    let count = 0,
      resyncs = 0;
    const byKey = new Map<number, number>();
    const keyLike = this.L.v17 ? (v: number) => v > 0 && v < 0x01000000 : (v: number) => v >= 0x01000000 && v < 0x80000000;
    let p = start;
    let nextTick = 0;
    while (p + 12 <= b.length) {
      // Zero padding between record groups.
      if (this.u32(p) === 0) {
        p += 4;
        continue;
      }
      const sz = this.size(p);
      if (sz < 8 || p + sz > b.length) {
        // Resynchronise: the next aligned position that looks like a record header.
        let q = p + 4;
        const lim = Math.min(b.length - 12, p + (1 << 20));
        for (; q < lim; q += 4) if (b[q] > 0 && b[q] < 0x40 && b[q + 1] === 0 && keyLike(this.u32(q + 4)) && this.size(q) >= 8) break;
        if (q >= lim) break;
        resyncs++;
        p = q;
        continue;
      }
      if (count === tags.length) {
        const t2 = new Uint8Array(tags.length * 2),
          o2 = new Uint32Array(offs.length * 2);
        t2.set(tags);
        o2.set(offs);
        tags = t2;
        offs = o2;
      }
      tags[count] = b[p];
      offs[count] = p;
      const key = this.u32(p + 4);
      if (key && !byKey.has(key)) byKey.set(key, count);
      count++;
      p += sz;
      if (progress && p > nextTick) {
        nextTick = p + (b.length >> 4);
        progress(p / b.length);
      }
    }
    return { tags, offs, count, byKey, resyncs };
  }
}

export const allegroFormat: FormatModule = {
  id: 'allegro',
  name: 'Cadence Allegro board',
  extensions: ['brd'],
  status: 'partial',
  summary: 'Native Allegro .brd database (16.x, 17.x): parts, pins, nets, vias, traces and outline — no Allegro or KiCad needed',
  detect(_s, f) {
    const b = f.bytes;
    if (b.length >= 0x200) {
      const tag = String.fromCharCode(b[0xf8], b[0xf9], b[0xfa]);
      if (tag === 'all' || tag === 'vie' || tag === 'dbd') return { confidence: 0.9, reason: `Allegro database marker "${tag}" at 0xF8` };
    }
    return null;
  },
  parse(ctx) {
    const a = new AllegroFile(ctx.file.bytes);
    const b = ctx.file.bytes;
    const magic = a.u32(0);
    const release = ALLEGRO_RELEASES[(magic & 0xffffff00) >>> 0] ?? null;
    const verText = String.fromCharCode(...b.subarray(0xf8, 0xf8 + 32)).replace(/[^\x20-\x7e].*$/s, '').replace(/[./]+$/, '');
    const major = (magic >>> 16) & 0xff;
    if (major !== 0x13 && major !== 0x14) {
      throw new ParseError(
        'unsupported.allegro',
        major < 0x13
          ? `This is a Cadence Allegro board${release ? ` from Allegro ${release}` : ''}${verText ? ` ("${verText}")` : ''}. BoardScope reads Allegro 16.x and 17.x databases natively; releases before 16 use an older record layout that is not supported yet (other free tools do not read it either). If Allegro 16 or later is available, opening and saving the board there makes it readable.`
          : `This is a Cadence Allegro board${release ? ` from Allegro ${release}` : ''}${verText ? ` ("${verText}")` : ''}. BoardScope reads Allegro 16.x and 17.x databases natively; this newer release's record layout is not supported yet.`,
      );
    }
    const what = `Cadence Allegro ${release ?? ''} board${verText ? ` ("${verText}")` : ''}`.replace('  ', ' ');
    if (b.length < 0x1200) throw new ParseError('allegro.truncated', `This ${what} is truncated: it ends inside the file header (${b.length} bytes).`);
    ctx.progress('Reading strings');
    const start = a.readStrings();
    ctx.progress('Reading records', 0);
    const w = a.walk(start, (f) => ctx.progress('Reading records', f));
    const at = (key: number, tag: number) => {
      const i = w.byKey.get(key);
      return i !== undefined && w.tags[i] === tag ? w.offs[i] : -1;
    };
    const str = (id: number) => a.strings.get(id) ?? '';
    const F = a.L.f;

    const bb = new BoardBuilder();
    bb.units = { unit: 'mil', toMm: 0.0254, assumed: false };
    bb.metadata.push(['Allegro release', release ?? `magic 0x${magic.toString(16)}`]);
    if (verText) bb.metadata.push(['Version', verText]);
    const k = 0.01; // 1/100 mil → mil

    // Nets: unnamed nets get a stable generated name so connectivity is kept.
    const netNames = new Map<number, string>();
    let unnamed = 0;
    const netOfAssign = (key: number): string | null => {
      const o4 = at(key, 0x04);
      if (o4 < 0) return null;
      const netKey = a.u32(o4 + 12);
      const o1b = at(netKey, 0x1b);
      if (o1b < 0) return null;
      let n = netNames.get(netKey);
      if (n === undefined) {
        n = str(a.u32(o1b + 12)) || `N$${++unnamed}`;
        netNames.set(netKey, n);
      }
      return n;
    };

    // Copper layers: the etch subclasses used by tracks, and the layer count of through-hole padstacks.
    let nLayers = 1;
    for (let i = 0; i < w.count; i++) {
      const o = w.offs[i];
      if (w.tags[i] === 0x05 && b[o + 2] === 6 && b[o + 3] < 64) nLayers = Math.max(nLayers, b[o + 3] + 1);
      else if (w.tags[i] === 0x1c && a.i32(o + 16) > 0) nLayers = Math.max(nLayers, Math.min(64, a.u16(o + 50)));
    }
    // Layer names from the etch layer list (0x2a with one entry per copper layer), when present.
    const names: string[] = [];
    for (let i = 0; i < w.count && !names.length; i++) {
      if (w.tags[i] !== 0x2a) continue;
      const o = w.offs[i];
      const n = a.u16(o + 2);
      if (n !== nLayers) continue;
      const list = Array.from({ length: n }, (_, j) => str(a.u32(o + 4 + 12 * j)));
      if (/TOP/i.test(list[0]) && /BOT/i.test(list[n - 1])) names.push(...list);
    }
    bb.layers = Array.from({ length: nLayers }, (_, i): LayerInfo => ({ id: i, name: names[i] || (i === 0 ? 'Top' : i === nLayers - 1 ? 'Bottom' : `Inner ${i}`), kind: i === 0 ? 'top' : i === nLayers - 1 ? 'bottom' : 'inner' }));

    // Footprints and pins.
    ctx.progress('Building board');
    const partOrigins: [number, number][] = [];
    let brokenChains = 0,
      anonymous = 0;
    for (let i = 0; i < w.count; i++) {
      if (w.tags[i] !== 0x2d) continue;
      const fp = w.offs[i];
      const o7 = at(a.u32(fp + F.fpRef), 0x07);
      const ref = o7 >= 0 ? str(a.u32(o7 + F.refStr)) : '';
      const bottom = (b[fp + 2] & 1) === 1;
      const rot = a.i32(fp + F.fpRot) / 1000;
      const ox = a.i32(fp + F.fpX),
        oy = a.i32(fp + F.fpY);
      const c = Math.cos((rot * Math.PI) / 180),
        s = Math.sin((rot * Math.PI) / 180);
      // Symbols without a reference designator and without pads (logos, mechanical drawings) are left out.
      if (!ref && at(a.u32(fp + F.fpPad), 0x32) < 0) {
        anonymous++;
        continue;
      }
      partOrigins.push([ox, oy]);
      const pi = bb.addPart({ name: ref || `?${i}`, side: bottom ? SIDE_BOTTOM : SIDE_TOP, mount: MOUNT_SMD, x: ox * k, y: oy * k, rot: ((rot % 360) + 360) % 360 });
      const self = a.u32(fp + 4);
      let th = false;
      for (let key = a.u32(fp + F.fpPad), guard = 0; key && key !== self && guard < 20000; guard++) {
        const o = at(key, 0x32);
        if (o < 0) {
          brokenChains++;
          break;
        }
        const od = at(a.u32(o + F.padDef), 0x0d);
        let lx = od >= 0 ? a.i32(od + 16) : 0;
        const ly = od >= 0 ? a.i32(od + 20) : 0;
        if (bottom) lx = -lx;
        const x = ox + lx * c - ly * s,
          y = oy + lx * s + ly * c;
        const ps = od >= 0 ? at(a.u32(od + 24), 0x1c) : -1;
        const drill = ps >= 0 ? a.i32(ps + F.psDrill) : 0;
        const type = ps >= 0 && F.psType ? a.u32(ps + F.psType) : 0;
        if (drill > 0) th = true;
        const w0 = a.i32(o + F.padBox + 8) - a.i32(o + F.padBox),
          h0 = a.i32(o + F.padBox + 12) - a.i32(o + F.padBox + 4);
        bb.addPin({
          part: pi,
          x: x * k,
          y: y * k,
          number: od >= 0 ? str(a.u32(od + 8)) : '',
          net: netOfAssign(a.u32(o + F.padNet)),
          side: drill > 0 ? SIDE_BOTH : undefined,
          shape: type === 2 ? SHAPE_CIRCLE : type === 6 ? SHAPE_OBLONG : SHAPE_RECT,
          w: Math.max(0, w0) * k,
          h: Math.max(0, h0) * k,
          hole: drill > 0 ? drill * k : undefined,
        });
        key = a.u32(o + F.padNext);
      }
      if (th) bb.partInput(pi).mount = MOUNT_TH;
    }

    // Vias, tracks and the board outline.
    const seg = (o: number, layer: number, net: string | null) => {
      const t = b[o];
      const width = a.i32(o + F.segW) * k;
      const x1 = a.i32(o + F.segW + 4),
        y1 = a.i32(o + F.segW + 8),
        x2 = a.i32(o + F.segW + 12),
        y2 = a.i32(o + F.segW + 16);
      const out: number[] = [];
      if (t === 0x01) {
        const cx = a.f64(o + F.arcD),
          cy = a.f64(o + F.arcD + 8),
          r = a.f64(o + F.arcD + 16);
        if (!(r > 0 && Number.isFinite(cx) && Number.isFinite(cy))) out.push(x1, y1, x2, y2);
        else {
          const cw = (b[o + 3] & 0x40) !== 0;
          const a0 = Math.atan2(y1 - cy, x1 - cx);
          let sweep = Math.atan2(y2 - cy, x2 - cx) - a0;
          if (cw) {
            if (sweep >= 0) sweep -= 2 * Math.PI;
          } else if (sweep <= 0) sweep += 2 * Math.PI;
          const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
          let px = x1,
            py = y1;
          for (let j = 1; j <= n; j++) {
            const ang = a0 + (sweep * j) / n;
            const qx = j === n ? x2 : cx + r * Math.cos(ang),
              qy = j === n ? y2 : cy + r * Math.sin(ang);
            out.push(px, py, qx, qy);
            px = qx;
            py = qy;
          }
        }
      } else out.push(x1, y1, x2, y2);
      for (let j = 0; j + 3 < out.length; j += 4) {
        if (out[j] === out[j + 2] && out[j + 1] === out[j + 3]) continue;
        if (layer < 0) bb.addOutlineSeg(out[j] * k, out[j + 1] * k, out[j + 2] * k, out[j + 3] * k);
        else bb.addTrace(out[j] * k, out[j + 1] * k, out[j + 2] * k, out[j + 3] * k, width, layer, net);
      }
    };
    const walkSegments = (owner: number, first: number, layer: number, net: string | null) => {
      const self = a.u32(owner + 4);
      for (let key = first, guard = 0; key && key !== self && guard < 100000; guard++) {
        const i = w.byKey.get(key);
        if (i === undefined) break;
        const t = w.tags[i];
        if (t !== 0x01 && t !== 0x15 && t !== 0x16 && t !== 0x17) break;
        seg(w.offs[i], layer, net);
        key = a.u32(w.offs[i] + 8);
      }
    };
    let outline = 0;
    const geometry = new Map<number, number[]>();
    for (let i = 0; i < w.count; i++) {
      const t = w.tags[i],
        o = w.offs[i];
      if (t === 0x33) {
        const box = a.i32(o + F.viaBox + 8) - a.i32(o + F.viaBox);
        bb.addVia(a.i32(o + F.viaX) * k, a.i32(o + F.viaX + 4) * k, Math.max(0, box) * k, netOfAssign(a.u32(o + F.viaNet)));
      } else if (t === 0x05 && b[o + 2] === 6) {
        walkSegments(o, a.u32(o + F.trkSeg), b[o + 3], netOfAssign(a.u32(o + F.trkNet)));
      } else if (t === 0x28 && b[o + 2] === 1) {
        // Board geometry shapes, grouped by subclass; the outline is chosen below.
        const sub = b[o + 3];
        (geometry.get(sub) ?? geometry.set(sub, []).get(sub)!).push(o);
      }
    }
    // Outline: the predefined OUTLINE (0xFD) / DESIGN_OUTLINE (0xEA) subclass, else a user subclass
    // named like an outline (17.x designs often use one); the smallest that holds the parts wins.
    const subs = new Set([0xfd, 0xea].filter((x) => geometry.has(x)));
    for (let i = 0; i < w.count; i++) {
      if (w.tags[i] !== 0x2a) continue;
      const o = w.offs[i];
      const n = a.u16(o + 2);
      for (let j = 0; j < n && j < 0xf0; j++) {
        const name = str(a.u32(o + 4 + 12 * j));
        if (/OUTLINE/i.test(name) && !/PANEL|OLD|TEST|PKG|PLACE|ROUTE|DIM|KEEP|SILK|ASSEM/i.test(name) && geometry.has(j)) subs.add(j);
      }
    }
    const boxOf = (list: number[]) => {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const o of list) {
        x0 = Math.min(x0, a.i32(o + F.shpBox));
        y0 = Math.min(y0, a.i32(o + F.shpBox + 4));
        x1 = Math.max(x1, a.i32(o + F.shpBox + 8));
        y1 = Math.max(y1, a.i32(o + F.shpBox + 12));
      }
      return [x0, y0, x1, y1];
    };
    const inside = (bx: number[]) => partOrigins.filter(([x, y]) => x >= bx[0] && x <= bx[2] && y >= bx[1] && y <= bx[3]).length;
    const area = (bx: number[]) => (bx[2] - bx[0]) * (bx[3] - bx[1]);
    const fits = [...subs].map((x) => ({ x, box: boxOf(geometry.get(x)!) })).filter((c) => inside(c.box) >= partOrigins.length * 0.9);
    // OUTLINE first, then DESIGN_OUTLINE, then the smallest user outline.
    const rank = (x: number) => (x === 0xfd ? 0 : x === 0xea ? 1 : 2);
    fits.sort((p, q) => rank(p.x) - rank(q.x) || area(p.box) - area(q.box));
    if (fits.length)
      for (const o of geometry.get(fits[0].x)!) {
        walkSegments(o, a.u32(o + F.shpSeg), -1, null);
        outline++;
      }
    if (brokenChains) bb.warn('allegro.chain', `${brokenChains} footprint pad list(s) could not be followed completely`);
    if (anonymous) bb.info('allegro.symbols', `${anonymous} symbol(s) without reference designator or pads (drawings, logos) are not shown`);
    if (w.resyncs) bb.info('allegro.resync', `${w.resyncs} record(s) of unknown layout were skipped`);
    if (!outline) bb.info('allegro.nooutline', 'No board outline shape (Board Geometry / Outline) was found; the outline is derived from the parts');
    return bb.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: release ? `Allegro ${release}` : null, extraFiles: [] });
  },
};

/** Internals for corpus checks. */
export const _allegro = { AllegroFile };
