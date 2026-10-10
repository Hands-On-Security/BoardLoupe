/**
 * NBV: NexusBV's own export ("NBV 1.0\0\0" + one zlib stream).
 *
 * The inflated payload is little-endian: str = u64 length + bytes,
 * vec(T) = u64 count + T×count, bool = one byte.
 *
 *   payload   = str("NBV_PAYLOAD_1|2|3") header vec(meta) vec(layer) vec(component)
 *               vec(graphic) vec(auxA) vec(auxB) vec(auxC) vec(auxD)
 *   header    = str, [str (payload 2+)], str, str, str, vec(str), u32, vec(str), u32, str, bool×5, u32, str, str, str
 *   meta      = str, u32×4, bool, bool, u8
 *   layer     = u32 id, bool, str name, [str extra (payload 3)]
 *   component = str×6 (refdes, value, …), vec(str), u32×3, u8 side ('T'/'B'), bool, u32×2, bool, u32×4,
 *               bool×4, u64, vec(pin), side×2, bool×4, u32
 *   side      = u32×7, bool, u32, bool, u32×7, bool, u32, bool×4
 *   pin       = f32 x, y, radius, u8 side, u32, str net, str name, u32×6, vec(pair32),
 *               vec(vec(pair32)), u32×4, bool, u32×2, bool×7
 *   graphic   = u32×3, u8, str, bool, f32 x1, y1, x2, y2, u32×6, u32×3, bool, vec(pair32), vec(vec(pair32))
 *
 * Only these documented fields are mapped; every other word is skipped
 * exactly. No NBV file was available to confirm the coordinate unit, so
 * coordinates are shown as given (assumed mils).
 */
import { unzlibSync } from 'fflate';
import { ParseError, startsWithBytes } from '../io/bytes';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, SHAPE_CIRCLE, SIDE_BOTTOM, SIDE_TOP } from '../model/types';
import type { FormatModule } from './types';

const MAGIC = [0x4e, 0x42, 0x56, 0x20, 0x31, 0x2e, 0x30, 0x00, 0x00]; // "NBV 1.0\0\0"
const MAX_STR = 1 << 20;
const MAX_VEC = 50_000_000;

class Reader {
  p = 0;
  readonly v: DataView;
  constructor(readonly b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number, what: string) {
    if (n < 0 || this.p + n > this.b.length) throw new ParseError('nbv.truncated', `NBV payload ends while reading ${what} (offset 0x${this.p.toString(16)})`, { offset: this.p });
  }
  u8 = () => (this.need(1, 'u8'), this.b[this.p++]);
  bool = () => this.u8() !== 0;
  u32 = () => {
    this.need(4, 'u32');
    const x = this.v.getUint32(this.p, true);
    this.p += 4;
    return x;
  };
  f32 = () => {
    this.need(4, 'f32');
    const x = this.v.getFloat32(this.p, true);
    this.p += 4;
    return x;
  };
  u64(what: string) {
    this.need(8, what);
    const lo = this.v.getUint32(this.p, true),
      hi = this.v.getUint32(this.p + 4, true);
    this.p += 8;
    if (hi) throw new ParseError('nbv.count', `Implausible ${what} (offset 0x${(this.p - 8).toString(16)})`, { offset: this.p - 8 });
    return lo;
  }
  skip = (n: number) => {
    this.need(n, 'data');
    this.p += n;
  };
  str(): string {
    const n = this.u64('string length');
    if (n > MAX_STR) throw new ParseError('nbv.count', `Implausible string length ${n}`, { offset: this.p - 8 });
    this.need(n, 'string');
    const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  count(minBytes: number, what: string) {
    const n = this.u64(what);
    if (n > MAX_VEC || n * minBytes > this.b.length - this.p) throw new ParseError('nbv.count', `Implausible ${what} ${n}`, { offset: this.p - 8 });
    return n;
  }
  pairs() {
    this.skip(8 * this.count(8, 'point count'));
  }
  rings() {
    const n = this.count(8, 'ring count');
    for (let i = 0; i < n; i++) this.pairs();
  }
}

export const nbvFormat: FormatModule = {
  id: 'nbv',
  name: 'NexusBV export (NBV)',
  extensions: ['nbv'],
  status: 'experimental',
  summary: 'NexusBV export: "NBV 1.0" + zlib payload (components, pins, graphics)',
  detect(s) {
    return startsWithBytes(s.head, MAGIC) ? { confidence: 0.98, reason: '"NBV 1.0" header' } : null;
  },
  parse(ctx) {
    let payload: Uint8Array;
    try {
      payload = unzlibSync(ctx.file.bytes.subarray(MAGIC.length));
    } catch (e) {
      throw new ParseError('nbv.zlib', `The NBV payload does not inflate: ${(e as Error).message}`);
    }
    if (payload.length > ctx.options.maxDecompressedBytes) throw new ParseError('nbv.size', 'The NBV payload is larger than the safety limit');
    const r = new Reader(payload);
    const kind = r.str();
    const version = /^NBV_PAYLOAD_([123])$/.exec(kind)?.[1];
    if (!version) throw new ParseError('nbv.payload', `Unknown NBV payload "${kind.slice(0, 40)}"`);
    // header
    const title = r.str();
    if (version !== '1') r.str();
    r.str();
    r.str();
    r.str();
    for (let n = r.count(8, 'header list'), i = 0; i < n; i++) r.str();
    r.u32();
    for (let n = r.count(8, 'header list'), i = 0; i < n; i++) r.str();
    r.u32();
    r.str();
    r.skip(5);
    r.u32();
    r.str();
    r.str();
    r.str();
    // meta
    for (let n = r.count(27, 'meta count'), i = 0; i < n; i++) {
      r.str();
      r.skip(16 + 3);
    }
    // layers
    const layers: string[] = [];
    for (let n = r.count(13, 'layer count'), i = 0; i < n; i++) {
      r.u32();
      r.bool();
      layers.push(r.str());
      if (version === '3') r.str();
    }
    const b = new BoardBuilder();
    b.units = { unit: 'mil', toMm: 0.0254, assumed: true, note: 'NBV coordinates are shown as stored; the unit is not confirmed by a real file.' };
    if (title) b.metadata.push(['Title', title]);
    // components
    const nc = r.count(80, 'component count');
    for (let i = 0; i < nc; i++) {
      const ref = r.str();
      const value = r.str();
      r.str();
      r.str();
      r.str();
      r.str();
      for (let n = r.count(8, 'string list'), j = 0; j < n; j++) r.str();
      r.skip(12);
      const side = r.u8();
      r.skip(1 + 8 + 1 + 16 + 4 + 8);
      const pins: { x: number; y: number; d: number; bottom: boolean; net: string; name: string }[] = [];
      for (let n = r.count(60, 'pin count'), j = 0; j < n; j++) {
        const x = r.f32(),
          y = r.f32(),
          rad = r.f32();
        const ps = r.u8();
        r.u32();
        const net = r.str();
        const name = r.str();
        r.skip(24);
        r.pairs();
        r.rings();
        r.skip(16 + 1 + 8 + 7);
        pins.push({ x, y, d: 2 * rad, bottom: ps === 0x42 /* B */ || ps === 2, net, name });
      }
      for (let k = 0; k < 2; k++) r.skip(28 + 1 + 4 + 1 + 28 + 1 + 4 + 4);
      r.skip(4 + 4);
      const bottom = side === 0x42 || side === 2;
      const pi = b.addPart({ name: ref || `?${i + 1}`, side: bottom ? SIDE_BOTTOM : SIDE_TOP, mount: MOUNT_SMD, value: value || null });
      pins.forEach((q, j) => {
        if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return;
        b.addPin({ part: pi, x: q.x, y: q.y, number: q.name || String(j + 1), net: q.net || null, side: q.bottom ? SIDE_BOTTOM : SIDE_TOP, shape: SHAPE_CIRCLE, w: Number.isFinite(q.d) && q.d > 0 ? q.d : undefined });
      });
    }
    // Graphics: lines named like a board outline become the outline.
    let lines = 0;
    for (let n = r.count(60, 'graphic count'), i = 0; i < n; i++) {
      r.skip(12 + 1);
      const gname = r.str();
      r.bool();
      const x1 = r.f32(),
        y1 = r.f32(),
        x2 = r.f32(),
        y2 = r.f32();
      r.skip(24 + 12 + 1);
      r.pairs();
      r.rings();
      if (/outline|board|edge/i.test(gname) && [x1, y1, x2, y2].every(Number.isFinite) && (x1 !== x2 || y1 !== y2)) {
        b.addOutlineSeg(x1, y1, x2, y2);
        lines++;
      }
    }
    if (!b.partCount) throw new ParseError('nbv.empty', 'The NBV file has no components');
    if (layers.length) b.metadata.push(['Layers', layers.join(', ')]);
    if (!lines) b.info('nbv.nooutline', 'No graphic lines; the outline is derived from the parts');
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: `payload ${version}`, extraFiles: [] });
  },
};
