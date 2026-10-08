/**
 * BVR raw boardview formats.
 *
 *  BVRAW_FORMAT_1: "<<Layout>> / <<Pin>> / <<Nail>>" tables, coordinates in
 *                  inches. Reference: OpenBoardView BVRFile.cpp (MIT).
 *  BVRAW_FORMAT_3: keyword records (PART_NAME … PIN_END … PART_END,
 *                  OUTLINE_POINTS / OUTLINE_SEGMENTED), coordinates in mils.
 *                  Reference: OpenBoardView BVR3File.cpp (MIT); written by
 *                  kicad-boardview (0BSD).
 */
import { ParseError } from '../io/bytes';
import { decodeText, splitLines, splitLinesObv, strtod, toNum } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, MOUNT_TH, PINKIND_TESTPOINT, SHAPE_CIRCLE, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type Side } from '../model/types';
import { INCH, MIL } from './common';
import type { FormatModule } from './types';

export const bvr1Format: FormatModule = {
  id: 'bvr1',
  name: 'BVR (BVRAW_FORMAT_1)',
  extensions: ['bvr'],
  status: 'verified',
  summary: 'Tabular <<Layout>>/<<Pin>>/<<Nail>> boardview, inch coordinates',
  detect(s) {
    if (s.headText.includes('BVRAW_FORMAT_1')) return { confidence: 0.96, reason: 'BVRAW_FORMAT_1 signature' };
    return null;
  },
  parse(ctx) {
    const lines = splitLinesObv(decodeText(ctx.file.bytes).text);
    const b = new BoardBuilder();
    b.units = INCH;
    const outline: number[] = [];
    let block = 0;
    let prevPart: string | null = null;
    let part = -1;
    let partSide: Side = SIDE_BOTTOM;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line === '<<Layout>>') {
        block = 1;
        i += 1;
        continue;
      }
      if (line === '<<Pin>>') {
        block = 2;
        i += 1;
        continue;
      }
      if (line === '<<Nail>>') {
        block = 3;
        i += 1;
        continue;
      }
      const ln = i + 1;
      if (block === 1) {
        let [x, p] = strtod(line, 0);
        if (line[p] === ',') p++;
        const [y] = strtod(line, p);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          b.warn('bvr1.layout', 'Malformed layout line skipped', { line: ln });
          continue;
        }
        outline.push(x, y);
      } else if (block === 2) {
        const t = line.split(/\s+/);
        if (t.length < 7) {
          b.warn('bvr1.pin', 'Malformed pin line skipped', { line: ln });
          continue;
        }
        const [pname, loc, id, pinName, xs, ys, , net = ''] = t;
        const x = toNum(xs),
          y = toNum(ys);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          b.warn('bvr1.pin', 'Malformed pin line skipped', { line: ln });
          continue;
        }
        const side: Side = loc === '(T)' ? SIDE_TOP : SIDE_BOTTOM;
        if (pname !== prevPart) {
          part = b.addPart({ name: pname, side, mount: MOUNT_SMD });
          partSide = side;
          prevPart = pname;
        }
        b.addPin({ part, x, y, net, side: partSide, number: id, name: pinName });
      } else if (block === 3) {
        // First (tab-separated) field is skipped by the reference.
        const tab = line.indexOf('\t');
        const rest = tab >= 0 ? line.slice(tab + 1) : '';
        const t = rest.trim().split(/\s+/);
        const x = toNum(t[0]),
          y = toNum(t[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          b.warn('bvr1.nail', 'Malformed nail line skipped', { line: ln });
          continue;
        }
        const loc = t[4];
        const net = t[6] ?? '';
        b.addPin({ part: -1, x, y, net, side: loc === '(T)' ? SIDE_TOP : SIDE_BOTTOM, kind: PINKIND_TESTPOINT, number: tab >= 0 ? line.slice(0, tab).trim() : '' });
      }
    }
    if (block === 0) throw new ParseError('bvr1.nosections', 'No <<Layout>>/<<Pin>>/<<Nail>> sections found');
    b.addOutlinePolyline(outline, false);
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: null, extraFiles: [] });
  },
};

function sideTBO(v: string): Side | undefined {
  return v === 'T' ? SIDE_TOP : v === 'B' ? SIDE_BOTTOM : v === 'O' ? SIDE_BOTH : undefined;
}

/** Joins unordered outline segments into a path (port of the reference heuristic). */
export function chainSegments(segs: number[][]): number[] {
  const out: number[] = [];
  if (!segs.length) return out;
  const list = segs.slice();
  const first = list.shift()!;
  out.push(first[0], first[1], first[2], first[3]);
  const sx = first[0],
    sy = first[1];
  let ex = first[2],
    ey = first[3];
  const man = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) + Math.abs(ay - by);
  while (!(sx === ex && sy === ey) && list.length) {
    let found = -1;
    let flip = false;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (ex === s[0] && ey === s[1]) {
        found = i;
        break;
      }
      if (ex === s[2] && ey === s[3]) {
        found = i;
        flip = true;
        break;
      }
    }
    if (found >= 0) {
      const s = list.splice(found, 1)[0];
      if (flip) {
        out.push(s[0], s[1]);
        ex = s[0];
        ey = s[1];
      } else {
        out.push(s[2], s[3]);
        ex = s[2];
        ey = s[3];
      }
      continue;
    }
    let best = 0,
      bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const d = Math.min(man(ex, ey, s[0], s[1]), man(ex, ey, s[2], s[3]));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const s = list[best];
    const ds = man(ex, ey, sx, sy);
    const d1 = man(ex, ey, s[0], s[1]),
      d2 = man(ex, ey, s[2], s[3]);
    if (ds <= d1 && ds <= d2) {
      out.push(sx, sy);
      break;
    }
    list.splice(best, 1);
    if (d1 <= d2) {
      out.push(s[0], s[1], s[2], s[3]);
      ex = s[2];
      ey = s[3];
    } else {
      out.push(s[2], s[3], s[0], s[1]);
      ex = s[0];
      ey = s[1];
    }
  }
  return out;
}

export const bvr3Format: FormatModule = {
  id: 'bvr3',
  name: 'BVR3 (BVRAW_FORMAT_3)',
  extensions: ['bvr', 'bvr3'],
  status: 'verified',
  summary: 'Keyword boardview (PART_NAME / PIN_* / OUTLINE_*), mil coordinates',
  detect(s) {
    if (s.headText.includes('BVRAW_FORMAT_3')) return { confidence: 0.97, reason: 'BVRAW_FORMAT_3 signature' };
    return null;
  },
  parse(ctx) {
    const lines = splitLines(decodeText(ctx.file.bytes).text);
    const b = new BoardBuilder();
    b.units = MIL;

    interface P {
      name: string;
      side?: Side;
      mount?: number;
      ox: number;
      oy: number;
      hasOrigin: boolean;
      pins: { number: string; name: string; side?: Side; x: number; y: number; r: number; net: string; comment: string; type: string; hasOrigin: boolean }[];
    }
    const newPart = (): P => ({ name: '', ox: 0, oy: 0, hasOrigin: false, pins: [] });
    const newPin = () => ({ number: '', name: '', side: undefined as Side | undefined, x: 0, y: 0, r: 0, net: '', comment: '', type: '', hasOrigin: false });
    let part = newPart();
    let pin = newPin();
    const outline: number[] = [];
    const segs: number[][] = [];
    let partsOut = 0;
    let pinNoOrigin = 0;

    const nums = (s: string) => s.trim().split(/\s+/).map(toNum);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      const val = sp < 0 ? '' : line.slice(sp + 1).trim();
      switch (key) {
        case 'PART_NAME':
          part.name = val.split(/\s+/)[0] ?? '';
          break;
        case 'PART_SIDE':
          part.side = sideTBO(val);
          break;
        case 'PART_ORIGIN': {
          const [x, y] = nums(val);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            part.ox = x;
            part.oy = y;
            part.hasOrigin = true;
          }
          break;
        }
        case 'PART_MOUNT':
          part.mount = val === 'SMD' ? MOUNT_SMD : MOUNT_TH;
          break;
        case 'PIN_NUMBER':
          pin.number = val.split(/\s+/)[0] ?? '';
          break;
        case 'PIN_NAME':
          pin.name = val.split(/\s+/)[0] ?? '';
          break;
        case 'PIN_SIDE':
          pin.side = sideTBO(val);
          break;
        case 'PIN_ORIGIN': {
          const [x, y] = nums(val);
          if (Number.isFinite(x) && Number.isFinite(y)) {
            pin.x = x;
            pin.y = y;
            pin.hasOrigin = true;
          }
          break;
        }
        case 'PIN_RADIUS': {
          const r = toNum(val);
          if (Number.isFinite(r)) pin.r = r;
          break;
        }
        case 'PIN_NET':
          pin.net = val.split(/\s+/)[0] ?? '';
          break;
        case 'PIN_TYPE':
          pin.type = val;
          break;
        case 'PIN_COMMENT':
          pin.comment = val;
          break;
        case 'PIN_END':
          if (!pin.hasOrigin) pinNoOrigin++;
          part.pins.push(pin);
          pin = newPin();
          break;
        case 'PART_END': {
          const idx = b.addPart({
            name: part.name,
            side: part.side ?? SIDE_BOTH,
            mount: (part.mount ?? MOUNT_TH) as 1 | 2,
            x: part.hasOrigin && (part.ox !== 0 || part.oy !== 0) ? part.ox : undefined,
            y: part.hasOrigin && (part.ox !== 0 || part.oy !== 0) ? part.oy : undefined,
          });
          for (const p of part.pins) {
            b.addPin({
              part: idx,
              x: p.x + part.ox,
              y: p.y + part.oy,
              net: p.net,
              side: p.side ?? SIDE_BOTH,
              number: p.number,
              name: p.name !== p.number ? p.name : '',
              shape: p.r > 0 ? SHAPE_CIRCLE : undefined,
              w: p.r > 0 ? 2 * p.r : undefined,
            });
          }
          partsOut++;
          part = newPart();
          break;
        }
        case 'OUTLINE_POINTS': {
          const v = nums(val);
          for (let k = 0; k + 1 < v.length; k += 2) {
            if (!Number.isFinite(v[k]) || !Number.isFinite(v[k + 1])) break;
            outline.push(v[k], v[k + 1]);
          }
          break;
        }
        case 'OUTLINE_SEGMENTED': {
          const v = nums(val);
          for (let k = 0; k + 3 < v.length; k += 4) {
            if (![v[k], v[k + 1], v[k + 2], v[k + 3]].every(Number.isFinite)) break;
            segs.push([v[k], v[k + 1], v[k + 2], v[k + 3]]);
          }
          break;
        }
        default:
          break; // PART_OUTLINE_RELATIVE, PIN_ID, BVRAW_FORMAT_3 … not needed
      }
    }
    if (pin.hasOrigin || part.pins.length) b.warn('bvr3.unterminated', 'File ends inside an unterminated PART/PIN record; it was ignored');
    if (pinNoOrigin) b.warn('bvr3.noorigin', `${pinNoOrigin} pin(s) have no PIN_ORIGIN and were placed at their part origin`);
    // Unordered segments are chained into a path like the reference does.
    if (segs.length) outline.push(...chainSegments(segs));
    b.addOutlinePolyline(outline, false);
    if (!partsOut && !outline.length) throw new ParseError('bvr3.empty', 'BVRAW_FORMAT_3 file without parts or outline');
    b.metadata.push(['Pad size', 'From PIN_RADIUS (circular approximation)']);
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: null, extraFiles: [] });
  },
};
