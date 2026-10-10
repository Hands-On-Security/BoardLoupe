/** Allegro 15.x database records. Kept separate from the 16/17 layout. */
import { ParseError } from '../io/bytes';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, SHAPE_CIRCLE, SHAPE_RECT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type LayerInfo } from '../model/types';
import type { ParseContext } from './types';

const SCALE = 0.01; // Allegro 15.5 sample: raw coordinates are 1/100 mil.
const MAX_COORD = 10_000_000;
type Index = Map<number, number | number[]>;

export function parseAllegro15(ctx: ParseContext, release: string | null) {
  const bytes = ctx.file.bytes;
  if (bytes.length < 0x1200) throw new ParseError('allegro.truncated', 'Allegro 15.x file ends inside its header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u = (p: number) => view.getUint32(p, true);
  const s = (p: number) => view.getInt32(p, true);
  const cstr = (p: number, size: number) => {
    let text = '';
    for (let i = p; i < Math.min(bytes.length, p + size) && bytes[i]; i++) text += String.fromCharCode(bytes[i]);
    return text;
  };

  const count = u(0x194);
  if (count > bytes.length / 5) throw new ParseError('allegro.strings', 'Allegro 15.x string count is implausible.');
  const strings = new Map<number, string>();
  let start = 0x1200;
  for (let i = 0; i < count; i++) {
    if (start + 4 >= bytes.length) throw new ParseError('allegro.strings', 'Allegro 15.x string table is truncated.');
    const end = bytes.indexOf(0, start + 4);
    if (end < 0) throw new ParseError('allegro.strings', 'Allegro 15.x string table is unterminated.');
    strings.set(u(start), cstr(start + 4, end - start - 4));
    start = (end + 4) & ~3;
  }

  // V15 uses the second byte of the four-byte prefix as the record type
  // (the V16 type multiplied by four). Records of a type are not necessarily
  // contiguous; their keys are heap addresses rather than file offsets.
  const index = new Map<number, Index>();
  const records = new Map<number, number[]>();
  const add = (type: number, key: number, offset: number) => {
    let m = index.get(type);
    if (!m) index.set(type, (m = new Map()));
    const prev = m.get(key);
    m.set(key, prev === undefined ? offset : typeof prev === 'number' ? [prev, offset] : (prev.push(offset), prev));
    let list = records.get(type);
    if (!list) records.set(type, (list = []));
    list.push(offset);
  };
  ctx.progress('Reading Allegro 15.x records', 0);
  for (let p = start; p + 72 <= bytes.length; p += 4) {
    const type = bytes[p + 1], flag = bytes[p], cls = bytes[p + 2], sub = bytes[p + 3];
    let accept = false;
    switch (type) {
      case 0x1c: case 0x34: case 0x10: case 0x6c: case 0xac: case 0xb4:
        accept = flag === 0 && sub === 0;
        break;
      case 0xc8:
        accept = (flag === 0 || flag === 4 || flag === 16) && cls === 12 && (sub & 0x1f) === 0;
        break;
      case 0xcc:
        accept = (flag === 0 || flag === 4 || flag === 16) && cls === 0x12;
        break;
      case 0x14:
        accept = (flag === 0 || flag === 4 || flag === 16 || flag === 20) && cls === 6 && sub < 64;
        break;
      case 0x54: case 0x58: case 0x5c:
        accept = flag === 0 && cls === 0 && sub === 0;
        break;
      case 0x04:
        accept = flag === 0 && cls === 0 && (sub === 0 || sub === 0x40);
        break;
      case 0x50: case 0xa0:
        accept = flag === 0 && cls === 1 && (sub === 0xfd || sub === 0xea);
        break;
      case 0xa8:
        accept = flag === 0 && cls > 0 && cls <= 32 && sub === 0;
        break;
    }
    if (accept) add(type, u(p + 4), p);
  }
  const at = (type: number, key: number, owner?: number): number => {
    const hit = index.get(type)?.get(key);
    if (hit === undefined) return -1;
    if (typeof hit === 'number') return owner === undefined || u(hit + 12) === owner ? hit : -1;
    return hit.find((p) => owner === undefined || u(p + 12) === owner) ?? -1;
  };
  const str = (id: number) => strings.get(id) ?? '';
  const netOf = (assignment: number): string | null => {
    const a = at(0x10, assignment);
    if (a < 0) return null;
    const n = at(0x6c, u(a + 12));
    return n < 0 ? null : str(u(n + 12)) || null;
  };

  const bb = new BoardBuilder();
  bb.units = { unit: 'mil', toMm: 0.0254, assumed: false };
  bb.metadata.push(['Allegro release', release ?? '15.x']);
  const partOrigins: [number, number][] = [];
  let pinChains = 0;
  const placements = records.get(0xb4) ?? [];
  for (const p of placements) {
    const inst = at(0x1c, u(p + 28));
    if (inst < 0) continue; // drawing symbols and false record signatures
    const name = cstr(inst + 8, 32);
    if (!name) continue;
    const ox = s(p + 16), oy = s(p + 20);
    if (Math.abs(ox) > MAX_COORD || Math.abs(oy) > MAX_COORD) continue;
    const self = u(p + 4);
    const firstPad = u(p + 36);
    if (at(0xc8, firstPad) < 0) continue;
    let footprint: string | null = null;
    for (let key = u(p + 24), guard = 0; key && guard < 10000; guard++) {
      const def = at(0xac, key);
      if (def >= 0) { footprint = str(u(def + 8)) || null; break; }
      const next = at(0xb4, key);
      if (next < 0) break;
      key = u(next + 24);
    }
    const side = bytes[p + 2] & 1 ? SIDE_BOTTOM : SIDE_TOP;
    const pi = bb.addPart({ name, side, mount: MOUNT_SMD, x: ox * SCALE, y: oy * SCALE, rot: ((s(p + 12) / 1000) % 360 + 360) % 360, footprint });
    partOrigins.push([ox, oy]);
    let key = firstPad;
    for (let guard = 0; key && key !== self && guard < 10000; guard++) {
      const pad = at(0xc8, key);
      if (pad < 0 || u(pad + 20) !== self) { pinChains++; break; }
      const x0 = s(pad + 56), y0 = s(pad + 60), x1 = s(pad + 64), y1 = s(pad + 68);
      const numberRec = at(0x34, u(pad + 28));
      const number = numberRec >= 0 ? cstr(numberRec + 8, 32) : '';
      const w = Math.abs(x1 - x0) * SCALE, h = Math.abs(y1 - y0) * SCALE;
      bb.addPin({
        part: pi, x: (x0 + x1) * SCALE / 2, y: (y0 + y1) * SCALE / 2,
        number, net: netOf(u(pad + 12)), side: bytes[pad + 3] & 0x80 ? SIDE_BOTH : side,
        shape: Math.abs(w - h) < 0.01 ? SHAPE_CIRCLE : SHAPE_RECT, w, h,
      });
      key = u(pad + 16);
    }
  }
  if (!bb.partCount || !bb.pinCount) throw new ParseError('allegro15.empty', 'Allegro 15.x components or pads could not be resolved.');
  if (pinChains) bb.warn('allegro15.chain', `${pinChains} pad chain(s) ended before their owner.`);

  // Inline 32-byte names in the ETCH layer list (0xA8); choose the list
  // bounded by TOP and BOTTOM. Other 0xA8 lists name manufacturing classes.
  for (const p of records.get(0xa8) ?? []) {
    const n = bytes[p + 2];
    if (p + 8 + 36 * n > bytes.length) continue;
    const names = Array.from({ length: n }, (_, i) => cstr(p + 4 + 36 * i, 32));
    if (!/^TOP$/i.test(names[0]) || !/^BOTTOM$/i.test(names[n - 1])) continue;
    bb.layers = names.map((name, id): LayerInfo => ({ id, name, kind: id === 0 ? 'top' : id === n - 1 ? 'bottom' : 'inner' }));
    break;
  }

  const segment = (p: number): [number, number, number, number][] => {
    const x1 = s(p + 24), y1 = s(p + 28), x2 = s(p + 32), y2 = s(p + 36);
    if (bytes[p + 1] !== 0x04) return [[x1, y1, x2, y2]];
    const cx = s(p + 40), cy = s(p + 44), r = s(p + 48);
    if (r <= 0) return [[x1, y1, x2, y2]];
    const a0 = Math.atan2(y1 - cy, x1 - cx);
    let sweep = Math.atan2(y2 - cy, x2 - cx) - a0;
    if (bytes[p + 3] & 0x40) { if (sweep >= 0) sweep -= 2 * Math.PI; }
    else if (sweep <= 0) sweep += 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
    const out: [number, number, number, number][] = [];
    let px = x1, py = y1;
    for (let i = 1; i <= n; i++) {
      const a = a0 + sweep * i / n;
      const qx = i === n ? x2 : cx + r * Math.cos(a), qy = i === n ? y2 : cy + r * Math.sin(a);
      out.push([px, py, qx, qy]); px = qx; py = qy;
    }
    return out;
  };
  const walkSegments = (owner: number, first: number, emit: (p: number, point: [number, number, number, number]) => void) => {
    const self = u(owner + 4);
    let key = first, count = 0;
    for (; key && key !== self && count < 100000; count++) {
      const p = [0x54, 0x58, 0x5c, 0x04].map((t) => at(t, key, self)).find((x) => x >= 0) ?? -1;
      if (p < 0) break;
      for (const point of segment(p)) emit(p, point);
      key = u(p + 8);
    }
    return key === self ? count : 0;
  };

  // Via centres and copper traces are absolute board coordinates.
  for (const p of records.get(0xcc) ?? []) {
    const x = s(p + 20), y = s(p + 24);
    if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) continue;
    const diameter = Math.abs(s(p + 60) - s(p + 52)) * SCALE;
    bb.addVia(x * SCALE, y * SCALE, diameter, netOf(u(p + 12)));
  }
  for (const p of records.get(0x14) ?? []) {
    const layer = bytes[p + 3];
    if (bb.layers.length && layer >= bb.layers.length) continue;
    const net = netOf(u(p + 12));
    walkSegments(p, u(p + 36), (seg, [x1, y1, x2, y2]) => {
      const width = s(seg + (bytes[seg + 1] === 0x04 ? 20 : 16)) * SCALE;
      bb.addTrace(x1 * SCALE, y1 * SCALE, x2 * SCALE, y2 * SCALE, width, layer, net);
    });
  }

  // Select a board-geometry outline that encloses the placed components.
  const outlines: { area: number; owner: number; first: number }[] = [];
  for (const type of [0xa0, 0x50]) for (const p of records.get(type) ?? []) {
    const first = u(p + (type === 0xa0 ? 28 : 16));
    if (!first) continue;
    const points: [number, number, number, number][] = [];
    const closed = walkSegments(p, first, (_seg, point) => points.push(point));
    if (!closed || points.length < 4) continue;
    const x0 = Math.min(...points.map((q) => Math.min(q[0], q[2]))), y0 = Math.min(...points.map((q) => Math.min(q[1], q[3])));
    const x1 = Math.max(...points.map((q) => Math.max(q[0], q[2]))), y1 = Math.max(...points.map((q) => Math.max(q[1], q[3])));
    const area = (x1 - x0) * (y1 - y0);
    if (area < 1000 * 1000 || area > MAX_COORD * MAX_COORD) continue;
    const inside = partOrigins.filter(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1).length;
    if (inside >= partOrigins.length * 0.9) outlines.push({ area, owner: p, first });
  }
  outlines.sort((a, b) => a.area - b.area);
  if (outlines.length) walkSegments(outlines[0].owner, outlines[0].first, (_seg, [x1, y1, x2, y2]) => bb.addOutlineSeg(x1 * SCALE, y1 * SCALE, x2 * SCALE, y2 * SCALE));
  else bb.info('allegro15.nooutline', 'Board outline was derived from component positions.');

  return bb.finish({ fileName: ctx.file.name, fileSize: bytes.length, formatId: 'allegro', formatName: 'Cadence Allegro board', variant: release ? `Allegro ${release}` : 'Allegro 15.x', extraFiles: [] });
}
