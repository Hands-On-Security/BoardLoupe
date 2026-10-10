/**
 * F2B: Unisoft's MFC CArchive board file (little-endian object graph).
 *
 *   u32 version (6 | 8), …, f32 resolution @13 (units per inch), u16 @0x11,
 *   u16 layer count @0x13, then trace lists until layer 0x7FFF:
 *     u16 layer, CString "CTraceList", u16 version 1, u16 count, count × 28-byte
 *     records { u16 kind=3, u16 net, u16 net, i16 x1,y1,x2,y2, u16 layer, … }
 *   u16 0, CString "CPinList", u16 version 1, count, then per pin:
 *     u16 version 1, i16 x, i16 y, u16 flags, i16 number, u16 net, CObject* owner
 *   CMapStringToOb: component name → CComponent
 *   CString "NetNames", u16 version 1, u16 count, count × (u16 key, CString)
 *   document metadata, part-number dictionary, display settings (not used)
 *
 * CComponent (schema 7/8/9): u16 version, i16 xmin,xmax,ymin,ymax, six
 * CStrings (reference, part number, device, –, –, description), then a
 * 43/47/51-byte tail starting with the pin count. A pin's owner is an MFC
 * object reference: the first pin of a component carries the component
 * itself; a null owner marks a via. Pin flags & 0xFE: 24 top SMD, 44 bottom
 * SMD, 80 through-hole, 164 bottom through-hole, 240 via. Negative pin
 * numbers are keys of alphanumeric labels (BGA balls) in the NetNames
 * dictionary; net key 0xFFFF means unconnected. Layer 1 is the top copper,
 * the last layer the bottom. Pad sizes and the board outline are not stored.
 */
import { ByteReader, ParseError } from '../io/bytes';
import { BoardBuilder } from '../model/builder';
import { type LayerInfo, MOUNT_SMD, MOUNT_TH, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP } from '../model/types';
import type { FormatModule } from './types';

const TAIL: Record<number, number> = { 7: 43, 8: 47, 9: 51 };

interface Comp {
  version: number;
  strs: string[];
  pinCount: number;
}
interface Pin {
  x: number;
  y: number;
  flags: number;
  num: number;
  net: number;
  owner: Comp | null;
}

class F2bReader {
  r: ByteReader;
  /** MFC load map: classes and objects share one index space starting at 1. */
  objs: (string | Comp | null)[] = [null];
  comps: Comp[] = [];
  constructor(bytes: Uint8Array) {
    this.r = new ByteReader(bytes);
  }
  fail(what: string, at = this.r.pos): never {
    throw new ParseError('f2b.structure', `${what} (offset 0x${at.toString(16)})`, { offset: at });
  }
  take(n: number, what: string): Uint8Array {
    const r = this.r;
    r.need(n, what);
    r.pos += n;
    return r.bytes.subarray(r.pos - n, r.pos);
  }
  /** MFC CString: u8 length, 0xFF → u16, 0xFFFF → u32; 0xFFFE marks Unicode (not supported). */
  cstr(): string {
    const r = this.r;
    let n = r.u8();
    if (n === 0xff) {
      n = r.u16();
      if (n === 0xfffe) this.fail('Unicode strings are not supported');
      if (n === 0xffff) n = r.u32();
    }
    const b = this.take(n, 'string');
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  /** MFC element count: u16, or 0xFFFF then u32. */
  count(minBytesEach: number, what: string): number {
    const r = this.r;
    let n = r.u16(what);
    if (n === 0xffff) n = r.u32(what);
    if (n * minBytesEach > r.remaining) this.fail(`Implausible ${what} ${n}`, r.pos - 2);
    return n;
  }
  /** CArchive::ReadObject for the one class the format uses (CComponent). */
  object(): Comp | null {
    const r = this.r;
    const tag = r.u16('object tag');
    if (tag === 0) return null;
    let cls: number;
    if (tag === 0xffff) {
      r.u16('class schema');
      const len = r.u16('class name length');
      const name = String.fromCharCode(...this.take(len, 'class name'));
      this.objs.push(name);
      cls = this.objs.length - 1;
    } else if (tag === 0x7fff) {
      const big = r.u32('object tag');
      if (!(big & 0x80000000)) return this.ref(big);
      cls = big & 0x7fffffff;
    } else if (tag & 0x8000) cls = tag & 0x7fff;
    else return this.ref(tag);
    if (this.objs[cls] !== 'CComponent') this.fail(`Unsupported class "${String(this.objs[cls])}"`, r.pos - 2);
    const version = r.u16('component version');
    const tail = TAIL[version];
    if (!tail) this.fail(`Unsupported component version ${version}`, r.pos - 2);
    r.skip(8, 'component extents');
    const strs: string[] = [];
    for (let i = 0; i < 6; i++) strs.push(this.cstr());
    const pinCount = r.u16('component pin count');
    r.skip(tail - 2, 'component tail');
    const c: Comp = { version, strs, pinCount };
    this.objs.push(c);
    this.comps.push(c);
    return c;
  }
  ref(i: number): Comp | null {
    const o = this.objs[i];
    if (o === undefined || typeof o === 'string') this.fail(`Invalid object reference ${i}`, this.r.pos - 2);
    return o;
  }

  read() {
    const r = this.r;
    const version = r.u32('archive version');
    if (version !== 6 && version !== 8) this.fail(`Unsupported archive version ${version}`, 0);
    r.seek(13);
    const resolution = r.f32('resolution');
    if (!(resolution > 0 && resolution < 1e7)) this.fail(`Implausible resolution ${resolution}`, 13);
    r.seek(0x13);
    const layerCount = r.u16('layer count');
    // Trace lists.
    const traces: { layer: number; net: number; x1: number; y1: number; x2: number; y2: number }[] = [];
    const layers = new Set<number>();
    for (let guard = 0; ; guard++) {
      const layer = r.u16('trace list layer');
      if (layer === 0x7fff) break;
      if (guard > 256) this.fail('Too many trace lists');
      const name = this.cstr();
      if (name !== 'CTraceList') this.fail(`Expected a CTraceList, found "${name.slice(0, 20)}"`);
      r.u16('trace list version');
      const n = r.u16('trace count');
      if (n * 28 > r.remaining) this.fail(`Implausible trace count ${n}`, r.pos - 2);
      layers.add(layer);
      for (let i = 0; i < n; i++) {
        const at = r.pos;
        const kind = r.u16();
        const net = r.u16();
        r.u16();
        const x1 = r.s16(),
          y1 = r.s16(),
          x2 = r.s16(),
          y2 = r.s16();
        r.seek(at + 28);
        if (kind === 3) traces.push({ layer, net, x1, y1, x2, y2 });
      }
    }
    r.u16();
    const pl = this.cstr();
    if (pl !== 'CPinList') this.fail(`Expected the CPinList, found "${pl.slice(0, 20)}"`);
    r.u16('pin list version');
    const np = this.count(14, 'pin count');
    const pins: Pin[] = [];
    for (let i = 0; i < np; i++) {
      r.u16('pin version');
      const x = r.s16(),
        y = r.s16(),
        flags = r.u16(),
        num = r.s16(),
        net = r.u16();
      pins.push({ x, y, flags, num, net, owner: this.object() });
    }
    // Component map (adds components without pins, e.g. unplated holes).
    const nm = this.count(4, 'component map size');
    for (let i = 0; i < nm; i++) {
      this.cstr();
      this.object();
    }
    // Net and label dictionary.
    const dn = this.cstr();
    if (dn !== 'NetNames') this.fail(`Expected the NetNames dictionary, found "${dn.slice(0, 20)}"`);
    r.u16('dictionary version');
    const nd = this.count(3, 'dictionary size');
    const dict = new Map<number, string>();
    for (let i = 0; i < nd; i++) {
      const k = r.u16();
      dict.set(k, this.cstr());
    }
    let source = '';
    try {
      source = this.cstr();
    } catch {
      // metadata is optional for display
    }
    return { version, resolution, layerCount, layers, traces, pins, dict, source, comps: this.comps };
  }
}

export const f2bFormat: FormatModule = {
  id: 'f2b',
  name: 'Unisoft F2B',
  extensions: ['f2b'],
  status: 'verified',
  summary: 'Unisoft MFC archive (.f2b): parts, pins with BGA labels, nets, vias and copper traces',
  detect(s) {
    const h = s.head;
    if (h.length < 40) return null;
    const v = h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24);
    if ((v === 6 || v === 8) && h[0x17] === 10 && String.fromCharCode(...h.subarray(0x18, 0x22)) === 'CTraceList') return { confidence: 0.95, reason: 'MFC archive with a CTraceList at offset 24' };
    return null;
  },
  parse(ctx) {
    ctx.progress('Reading archive');
    const f = new F2bReader(ctx.file.bytes).read();
    const b = new BoardBuilder();
    // Coordinates in 1/resolution inch → mils.
    const k = 1000 / f.resolution;
    b.units = { unit: 'mil', toMm: 0.0254, assumed: false };
    b.metadata.push(['Archive version', String(f.version)], ['Resolution', `${f.resolution} per inch`]);
    if (f.source) b.metadata.push(['Source', f.source]);
    const NO_NET = 0xffff;
    const netName = (key: number) => (key === NO_NET ? null : (f.dict.get(key) ?? null));

    // Layers: 1 = top … highest = bottom.
    const ids = [...f.layers].sort((a, c) => a - c);
    const top = Math.min(...ids, 1),
      bottom = Math.max(...ids, f.layerCount);
    const layerIndex = new Map(ids.map((l, i) => [l, i]));
    b.layers = ids.map<LayerInfo>((l, i) => ({ id: i, name: l === top ? 'Top' : l === bottom ? 'Bottom' : `Inner ${l}`, kind: l === top ? 'top' : l === bottom ? 'bottom' : 'inner' }));

    // Parts in first-pin order, with their pins.
    const byComp = new Map<Comp, Pin[]>();
    for (const p of f.pins) if (p.owner) (byComp.get(p.owner) ?? byComp.set(p.owner, []).get(p.owner)!).push(p);
    // Fixture tooling holes are stored as components far outside the board:
    // leave out components whose pins all lie well outside the copper.
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    const grow = (x: number, y: number) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    };
    for (const t of f.traces) {
      grow(t.x1, t.y1);
      grow(t.x2, t.y2);
    }
    for (const p of f.pins) if (!p.owner) grow(p.x, p.y);
    const mx = (x1 - x0) * 0.1,
      my = (y1 - y0) * 0.1;
    const offBoard = (p: Pin) => Number.isFinite(x0) && (p.x < x0 - mx || p.x > x1 + mx || p.y < y0 - my || p.y > y1 + my);
    const outside: string[] = [];
    let countMismatch = 0;
    for (const c of f.comps) {
      const pins = byComp.get(c) ?? [];
      if (pins.length && pins.every(offBoard)) {
        outside.push(c.strs[0]);
        continue;
      }
      if (pins.length !== c.pinCount) countMismatch++;
      const sides = pins.map((p) => p.flags & 0xfe);
      const bottomSide = sides.filter((s) => s === 44 || s === 164).length > sides.length / 2;
      const th = sides.some((s) => s === 80 || s === 164);
      const attrs: [string, string][] = [];
      if (c.strs[1]) attrs.push(['Part number', c.strs[1]]);
      if (c.strs[5]) attrs.push(['Description', c.strs[5]]);
      if (!pins.length) {
        // A component without pins (e.g. a mounting hole) carries no position here.
        continue;
      }
      const pi = b.addPart({ name: c.strs[0], side: bottomSide ? SIDE_BOTTOM : SIDE_TOP, mount: th ? MOUNT_TH : MOUNT_SMD, footprint: c.strs[2] || null, attrs: attrs.length ? attrs : null });
      for (const p of pins) {
        const s = p.flags & 0xfe;
        const label = p.num < 0 ? f.dict.get(p.num & 0xffff) : undefined;
        b.addPin({
          part: pi,
          x: p.x * k,
          y: p.y * k,
          number: label ?? String(p.num),
          net: netName(p.net),
          side: s === 80 || s === 164 ? SIDE_BOTH : s === 44 ? SIDE_BOTTOM : s === 24 ? SIDE_TOP : undefined,
        });
      }
    }
    // Pins without a component are vias.
    for (const p of f.pins) if (!p.owner) b.addVia(p.x * k, p.y * k, 0, netName(p.net));
    for (const t of f.traces) {
      if (t.x1 === t.x2 && t.y1 === t.y2) continue;
      b.addTrace(t.x1 * k, t.y1 * k, t.x2 * k, t.y2 * k, 0, layerIndex.get(t.layer) ?? 0, netName(t.net));
    }
    if (outside.length) b.info('f2b.offboard', `${outside.length} component(s) far outside the board (fixture tooling holes: ${outside.slice(0, 4).join(', ')}${outside.length > 4 ? ', …' : ''}) are not shown`);
    if (countMismatch) b.warn('f2b.pincount', `${countMismatch} component(s) declare a different pin count than the pins that reference them`);
    b.info('f2b.nooutline', 'F2B files store no board outline or pad sizes; the outline is derived from the parts and pads are drawn at a typical size');
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: `archive v${f.version}`, extraFiles: [] });
  },
};
