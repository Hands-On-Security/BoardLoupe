/**
 * GenCAD 1.4 (.cad / .gcd) — open, documented CAD exchange format exported by
 * KiCad, Allegro, PADS, CAMCAD and many ICT tools.
 *
 * Implemented from the GenCAD 1.4 specification; component/pin transform,
 * padstack-side and duplicate handling follow OpenBoardView GenCADFile.cpp
 * (MIT). Verified against KiCad 10 exports (see fixtures/PROVENANCE.md).
 */
import { ParseError } from '../io/bytes';
import { decodeText, splitLines, toNum } from '../io/text';
import { BoardBuilder } from '../model/builder';
import {
  MOUNT_SMD,
  MOUNT_TH,
  PINKIND_TESTPOINT,
  SHAPE_CIRCLE,
  SHAPE_OBLONG,
  SHAPE_RECT,
  SIDE_BOTH,
  SIDE_BOTTOM,
  SIDE_TOP,
  type PadShape,
  type Side,
  type UnitInfo,
} from '../model/types';
import type { FormatModule } from './types';

/** Splits a GenCAD line into tokens; "quoted strings" are single tokens. */
export function gcTokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n) break;
    if (line[i] === '"') {
      const j = line.indexOf('"', i + 1);
      if (j < 0) {
        out.push(line.slice(i + 1));
        break;
      }
      out.push(line.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < n && line[j] !== ' ' && line[j] !== '\t') j++;
      out.push(line.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** Rest of a line after its keyword, unquoted when fully quoted. */
function toEnd(line: string, kw: string): string {
  const s = line.slice(line.indexOf(kw) + kw.length).trim();
  if (s.length >= 2 && s[0] === '"' && s.indexOf('"', 1) === s.length - 1) return s.slice(1, -1);
  return s;
}

interface Geo {
  segs: number[]; // local segments
  circles: [number, number, number][];
  rects: [number, number, number, number][];
}
const newGeo = (): Geo => ({ segs: [], circles: [], rects: [] });

function addGeo(g: Geo, t: string[]): boolean {
  const kw = t[0];
  const v = t.slice(1).map(toNum);
  if (kw === 'LINE' && v.length >= 4 && v.slice(0, 4).every(Number.isFinite)) {
    g.segs.push(v[0], v[1], v[2], v[3]);
    return true;
  }
  if (kw === 'ARC' && v.length >= 6 && v.slice(0, 6).every(Number.isFinite)) {
    // ARC x1 y1 x2 y2 xc yc : counter-clockwise from start to end.
    const [x1, y1, x2, y2, xc, yc] = v;
    const r = Math.hypot(x1 - xc, y1 - yc);
    let a0 = Math.atan2(y1 - yc, x1 - xc);
    let a1 = Math.atan2(y2 - yc, x2 - xc);
    if (a1 <= a0) a1 += 2 * Math.PI;
    if (x1 === x2 && y1 === y2) {
      a0 = 0;
      a1 = 2 * Math.PI;
    }
    const n = Math.max(4, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 48));
    let px = x1,
      py = y1;
    for (let k = 1; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      const x = k === n ? x2 : xc + r * Math.cos(a),
        y = k === n ? y2 : yc + r * Math.sin(a);
      g.segs.push(px, py, x, y);
      px = x;
      py = y;
    }
    return true;
  }
  if (kw === 'CIRCLE' && v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) {
    g.circles.push([v[0], v[1], v[2]]);
    const n = 48;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI,
        b = ((k + 1) / n) * 2 * Math.PI;
      g.segs.push(v[0] + v[2] * Math.cos(a), v[1] + v[2] * Math.sin(a), v[0] + v[2] * Math.cos(b), v[1] + v[2] * Math.sin(b));
    }
    return true;
  }
  if (kw === 'RECTANGLE' && v.length >= 4 && v.slice(0, 4).every(Number.isFinite)) {
    const [x, y, w, h] = v;
    g.rects.push([x, y, w, h]);
    g.segs.push(x, y, x + w, y, x + w, y, x + w, y + h, x + w, y + h, x, y + h, x, y + h, x, y);
    return true;
  }
  return false;
}

interface PadDef {
  shape: PadShape;
  w: number;
  h: number;
  ox: number;
  oy: number;
  drill: number;
}

function padFromGeo(type: string, drill: number, g: Geo): PadDef {
  if (g.circles.length === 1 && g.segs.length === 48 * 4) {
    const [x, y, r] = g.circles[0];
    return { shape: SHAPE_CIRCLE, w: 2 * r, h: 2 * r, ox: x, oy: y, drill };
  }
  if (g.rects.length === 1 && g.segs.length === 16) {
    const [x, y, w, h] = g.rects[0];
    return { shape: SHAPE_RECT, w: Math.abs(w), h: Math.abs(h), ox: x + w / 2, oy: y + h / 2, drill };
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < g.segs.length; i += 2) {
    x0 = Math.min(x0, g.segs[i]);
    x1 = Math.max(x1, g.segs[i]);
    y0 = Math.min(y0, g.segs[i + 1]);
    y1 = Math.max(y1, g.segs[i + 1]);
  }
  if (!Number.isFinite(x0)) return { shape: SHAPE_CIRCLE, w: drill, h: drill, ox: 0, oy: 0, drill };
  const shape: PadShape = type === 'FINGER' || type === 'BULLET' ? SHAPE_OBLONG : type === 'ROUND' || type === 'ANNULAR' ? SHAPE_CIRCLE : SHAPE_RECT;
  return { shape, w: x1 - x0, h: y1 - y0, ox: (x0 + x1) / 2, oy: (y0 + y1) / 2, drill };
}

interface ShapePin {
  name: string;
  pad: string;
  x: number;
  y: number;
  layer: string;
  rot: number;
}
interface ShapeDef {
  insert: string;
  pins: ShapePin[];
  geo: Geo;
}

function unitsFor(t: string[]): { scale: number; units: UnitInfo } | null {
  const mil: UnitInfo = { unit: 'mil', toMm: 0.0254, assumed: false };
  const mm: UnitInfo = { unit: 'mm', toMm: 1, assumed: false };
  const n = toNum(t[2]);
  switch (t[1]) {
    case 'INCH':
      return { scale: 1000, units: mil };
    case 'THOU':
      return { scale: 1, units: mil };
    case 'MM':
      return { scale: 1, units: mm };
    case 'MM100':
      return { scale: 0.01, units: mm };
    case 'USER':
      return n > 0 ? { scale: 1000 / n, units: mil } : null;
    case 'USERCM':
    case 'USERM':
      return n > 0 ? { scale: 10 / n, units: mm } : null;
    case 'USERMM':
      return n > 0 ? { scale: 1 / n, units: mm } : null;
  }
  return null;
}

export const gencadFormat: FormatModule = {
  id: 'gencad',
  name: 'GenCAD 1.4',
  extensions: ['cad', 'gcd', 'gencad'],
  status: 'verified',
  summary: 'Open CAD exchange format (KiCad, Allegro, PADS, CAMCAD exports)',
  detect(s) {
    if (s.headText.includes('$HEADER') && /GENCAD/i.test(s.headText)) return { confidence: 0.95, reason: '$HEADER section with GENCAD version' };
    return null;
  },
  parse(ctx) {
    const lines = splitLines(decodeText(ctx.file.bytes).text);
    const b = new BoardBuilder();
    let scale = 1000;
    b.units = { unit: 'mil', toMm: 0.0254, assumed: true, note: 'UNITS missing; GenCAD default (INCH) assumed' };

    const pads = new Map<string, PadDef>();
    const padstacks = new Map<string, { pad: string | null; sides: number; drill: number }>();
    const shapes = new Map<string, ShapeDef>();
    const devices = new Map<string, { value?: string; part?: string; desc?: string; pkg?: string }>();
    const nodes = new Map<string, string>(); // "comp\0pin" -> net
    interface Comp {
      name: string;
      x: number;
      y: number;
      side: Side;
      rot: number;
      shape: string;
      mirror: string;
      flip: boolean;
      device: string;
      value?: string;
      pn?: string;
      line: number;
    }
    const comps: Comp[] = [];
    const tracks = new Map<string, number>();
    const routeSegs: { segs: number[]; width: number; net: string; layer: string }[] = [];
    const vias: { x: number; y: number; d: number; net: string }[] = [];
    const testpads: { x: number; y: number; net: string; name: string }[] = [];
    const boardGeo = newGeo();

    let section = '';
    let cur: { kind: string; name: string; geo?: Geo; type?: string; drill?: number } | null = null;
    let curShape: ShapeDef | null = null;
    let curComp: Comp | null = null;
    let curDev: { value?: string; part?: string; desc?: string; pkg?: string } | null = null;
    let curSignal = '';
    let route: { net: string; width: number; layer: string; geo: Geo } | null = null;
    let sawHeader = false;
    let boardSub = '';

    const flushPad = () => {
      if (cur?.kind === 'pad' && cur.geo) pads.set(cur.name, padFromGeo(cur.type ?? '', cur.drill ?? 0, cur.geo));
      cur = null;
    };
    const flushRoute = () => {
      if (route && route.geo.segs.length) routeSegs.push({ segs: route.geo.segs, width: route.width, net: route.net, layer: route.layer });
      if (route) route.geo = newGeo();
    };

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].trim();
      if (!line) continue;
      const ln = li + 1;
      if (line[0] === '$') {
        const sec = line.split(/\s/)[0].toUpperCase();
        if (sec.startsWith('$END')) {
          flushPad();
          flushRoute();
          route = null;
          section = '';
        } else {
          section = sec;
          if (sec === '$HEADER') sawHeader = true;
        }
        continue;
      }
      const t = gcTokens(line);
      const kw = t[0];
      switch (section) {
        case '$HEADER':
          if (kw === 'UNITS') {
            const u = unitsFor(t);
            if (u) {
              scale = u.scale;
              b.units = u.units;
            } else b.warn('gencad.units', `Unrecognised UNITS "${line}"; INCH assumed`, { line: ln });
          } else if (kw === 'DRAWING' || kw === 'REVISION' || kw === 'USER') {
            b.metadata.push([kw[0] + kw.slice(1).toLowerCase(), toEnd(line, kw)]);
          }
          break;
        case '$BOARD':
          if (kw === 'CUTOUT') boardSub = 'cutout';
          else if (kw === 'MASK' || kw === 'ARTWORK' || kw === 'TEXT' || kw === 'ATTRIBUTE') boardSub = kw === 'MASK' || kw === 'ARTWORK' ? 'skip' : boardSub;
          else if (boardSub !== 'skip') addGeo(boardGeo, t);
          break;
        case '$PADS':
          if (kw === 'PAD') {
            flushPad();
            cur = { kind: 'pad', name: t[1] ?? '', type: t[2], drill: toNum(t[3]) || 0, geo: newGeo() };
          } else if (cur?.geo) addGeo(cur.geo, t);
          break;
        case '$PADSTACKS':
          if (kw === 'PADSTACK') {
            cur = { kind: 'padstack', name: t[1] ?? '' };
            padstacks.set(cur.name, { pad: null, sides: 0, drill: toNum(t[2]) || 0 });
          } else if (kw === 'PAD' && cur?.kind === 'padstack') {
            const ps = padstacks.get(cur.name)!;
            const layer = t[2] ?? '';
            // Accumulate copper sides from all pad layers of the stack.
            ps.sides |= layer === 'TOP' ? 1 : layer === 'BOTTOM' ? 2 : layer === 'ALL' ? 3 : 0;
            if (!ps.pad || layer === 'TOP' || layer === 'ALL') ps.pad = t[1] ?? null;
          }
          break;
        case '$SHAPES':
          if (kw === 'SHAPE') {
            curShape = { insert: '', pins: [], geo: newGeo() };
            shapes.set(t[1] ?? '', curShape);
          } else if (!curShape) break;
          else if (kw === 'INSERT') curShape.insert = (t[1] ?? '').toUpperCase();
          else if (kw === 'PIN') {
            const x = toNum(t[3]),
              y = toNum(t[4]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
              b.warn('gencad.shapepin', 'Malformed shape PIN line skipped', { line: ln });
              break;
            }
            curShape.pins.push({ name: t[1] ?? '', pad: t[2] ?? '', x, y, layer: t[5] ?? '', rot: toNum(t[6]) || 0 });
          } else addGeo(curShape.geo, t);
          break;
        case '$COMPONENTS':
          if (kw === 'COMPONENT') {
            curComp = { name: t[1] ?? '', x: NaN, y: NaN, side: SIDE_TOP, rot: 0, shape: '', mirror: '0', flip: false, device: '', line: ln };
            comps.push(curComp);
          } else if (!curComp) break;
          else if (kw === 'PLACE') {
            curComp.x = toNum(t[1]);
            curComp.y = toNum(t[2]);
          } else if (kw === 'LAYER') curComp.side = t[1] === 'BOTTOM' ? SIDE_BOTTOM : SIDE_TOP;
          else if (kw === 'ROTATION') curComp.rot = toNum(t[1]) || 0;
          else if (kw === 'SHAPE') {
            curComp.shape = t[1] ?? '';
            curComp.mirror = t[2] ?? '0';
            curComp.flip = t[3] === 'FLIP';
          } else if (kw === 'DEVICE') curComp.device = toEnd(line, 'DEVICE').replace(/ /g, '_');
          else if (kw === 'VALUE' || kw === 'Value') curComp.value = toEnd(line, kw);
          else if (kw === 'PartNumber') curComp.pn = t[1];
          break;
        case '$DEVICES':
          if (kw === 'DEVICE') {
            curDev = {};
            devices.set(toEnd(line, 'DEVICE').replace(/ /g, '_'), curDev);
          } else if (!curDev) break;
          else if (kw === 'VALUE' || kw === 'Value') curDev.value = toEnd(line, kw);
          else if (kw === 'PART') curDev.part = toEnd(line, 'PART');
          else if (kw === 'DESC') curDev.desc = toEnd(line, 'DESC');
          else if (kw === 'PACKAGE') curDev.pkg = toEnd(line, 'PACKAGE');
          break;
        case '$SIGNALS':
          if (kw === 'SIGNAL') curSignal = toEnd(line, 'SIGNAL');
          else if (kw === 'NODE' && t.length >= 3) nodes.set(`${t[1]}\0${t[2]}`, curSignal);
          break;
        case '$TRACKS':
          if (kw === 'TRACK') tracks.set(t[1] ?? '', toNum(t[2]) || 0);
          break;
        case '$ROUTES':
          if (kw === 'ROUTE') {
            flushRoute();
            route = { net: toEnd(line, 'ROUTE'), width: 0, layer: '', geo: newGeo() };
          } else if (!route) break;
          else if (kw === 'TRACK') {
            flushRoute();
            route.width = tracks.get(t[1] ?? '') ?? 0;
          } else if (kw === 'LAYER') {
            flushRoute();
            route.layer = t[1] ?? '';
          } else if (kw === 'VIA') {
            const x = toNum(t[2]),
              y = toNum(t[3]);
            if (Number.isFinite(x) && Number.isFinite(y)) vias.push({ x, y, d: toNum(t[5]) || 0, net: route.net });
          } else if (kw === 'TESTPAD') {
            const x = toNum(t[2]),
              y = toNum(t[3]);
            if (Number.isFinite(x) && Number.isFinite(y)) testpads.push({ x, y, net: route.net, name: t[6] ?? '' });
          } else if (kw === 'LINE' || kw === 'ARC') addGeo(route.geo, t);
          break;
      }
    }
    flushPad();
    if (!sawHeader) throw new ParseError('gencad.noheader', 'Missing $HEADER section');
    if (!comps.length) throw new ParseError('gencad.nocomponents', 'No $COMPONENTS found');

    const S = (v: number) => v * scale;
    const layerIds = new Map<string, number>();
    const layerId = (name: string): number => {
      if (name === 'TOP') return 0;
      if (name === 'BOTTOM') return 1;
      let id = layerIds.get(name);
      if (id === undefined) {
        id = 2 + layerIds.size;
        layerIds.set(name, id);
      }
      return id;
    };
    for (let i = 0; i < boardGeo.segs.length; i += 4) b.addOutlineSeg(S(boardGeo.segs[i]), S(boardGeo.segs[i + 1]), S(boardGeo.segs[i + 2]), S(boardGeo.segs[i + 3]));

    const psSide = (name: string): { side: Side | null; pad: PadDef | null; drilled: boolean } => {
      const ps = padstacks.get(name);
      if (ps) {
        const s = ps.sides;
        const pad = ps.pad ? (pads.get(ps.pad) ?? null) : null;
        return { side: s === 1 ? SIDE_TOP : s === 2 ? SIDE_BOTTOM : SIDE_BOTH, pad, drilled: ps.drill > 0 || (pad?.drill ?? 0) > 0 };
      }
      const pad = pads.get(name) ?? null;
      return { side: null, pad, drilled: (pad?.drill ?? 0) > 0 };
    };

    const seen = new Set<string>();
    let dup = 0,
      noShape = 0,
      noPlace = 0,
      noSignal = 0;
    for (const c of comps) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) {
        noPlace++;
        continue;
      }
      const sh = shapes.get(c.shape);
      const key = `${c.side}|${Math.round(S(c.x))}|${Math.round(S(c.y))}|${c.shape}`;
      if (sh) {
        if (seen.has(key)) {
          dup++;
          continue;
        }
        seen.add(key);
      } else noShape++;
      const dev = devices.get(c.device);
      const mx = c.mirror === 'MIRRORX' ? -1 : 1;
      const my = c.mirror === 'MIRRORY' ? -1 : 1;
      let ang = (c.rot * Math.PI) / 180;
      if (mx * my === -1) ang = Math.PI - ang;
      const cs = Math.cos(ang),
        sn = Math.sin(ang);
      const tx = (x: number, y: number) => S(c.x) + mx * S(x * cs - y * sn);
      const ty = (x: number, y: number) => S(c.y) + my * S(x * sn + y * cs);

      let th = false;
      if (sh) th = sh.insert === 'TH' || sh.insert === 'PTH' || (sh.insert !== 'SMD' && sh.pins.some((p) => psSide(p.pad).drilled));
      const body: number[] = [];
      if (sh) for (let i = 0; i < sh.geo.segs.length; i += 4) body.push(tx(sh.geo.segs[i], sh.geo.segs[i + 1]), ty(sh.geo.segs[i], sh.geo.segs[i + 1]), tx(sh.geo.segs[i + 2], sh.geo.segs[i + 3]), ty(sh.geo.segs[i + 2], sh.geo.segs[i + 3]));
      const attrs: [string, string][] = [];
      if (c.device) attrs.push(['Device', c.device]);
      if (dev?.part) attrs.push(['Part', dev.part]);
      if (dev?.desc) attrs.push(['Description', dev.desc]);
      if (c.pn) attrs.push(['Part number', c.pn]);
      const idx = b.addPart({
        name: c.name,
        side: th ? SIDE_BOTH : c.side,
        mount: sh ? (th ? MOUNT_TH : MOUNT_SMD) : undefined,
        x: S(c.x),
        y: S(c.y),
        rot: c.rot,
        footprint: c.shape || dev?.pkg || null,
        value: c.value ?? dev?.value ?? null,
        attrs,
        body: body.length ? body : null,
      });
      if (!sh) continue;
      for (const p of sh.pins) {
        const info = psSide(p.pad);
        let side: Side = info.side ?? c.side;
        if (c.flip) side = side === SIDE_TOP ? SIDE_BOTTOM : side === SIDE_BOTTOM ? SIDE_TOP : side;
        const pad = info.pad;
        const net = nodes.get(`${c.name}\0${p.name}`) ?? null;
        if (net === null) noSignal++;
        b.addPin({
          part: idx,
          x: tx(p.x, p.y),
          y: ty(p.x, p.y),
          net,
          number: p.name,
          side,
          shape: pad?.shape,
          w: pad ? S(pad.w) : undefined,
          h: pad ? S(pad.h) : undefined,
          rot: (c.rot + p.rot) * (mx * my),
          hole: info.drilled ? S(pad?.drill || padstacks.get(p.pad)?.drill || 0) : 0,
        });
      }
    }
    if (dup) b.info('gencad.dup', `${dup} duplicate component placement(s) (same shape, side and position) were ignored`);
    if (noShape) b.warn('gencad.noshape', `${noShape} component(s) reference an undefined SHAPE; they have no pins`);
    if (noSignal) b.info('gencad.nosignal', `${noSignal} pin(s) are not listed in $SIGNALS and have no net`);
    if (noPlace) b.warn('gencad.noplace', `${noPlace} component(s) have no PLACE record and were skipped`);

    for (const r of routeSegs) {
      for (let i = 0; i < r.segs.length; i += 4) b.addTrace(S(r.segs[i]), S(r.segs[i + 1]), S(r.segs[i + 2]), S(r.segs[i + 3]), S(r.width), layerId(r.layer), r.net);
    }
    for (const v of vias) b.addVia(S(v.x), S(v.y), S(v.d), v.net);
    for (const tp of testpads) b.addPin({ part: -1, x: S(tp.x), y: S(tp.y), net: tp.net, kind: PINKIND_TESTPOINT, number: tp.name, side: SIDE_BOTH });
    if (routeSegs.length) {
      const names = [...new Set(routeSegs.map((r) => r.layer))];
      b.layers = names.map((n) => ({ id: layerId(n), name: n || 'Unnamed layer', kind: n === 'TOP' ? 'top' : n === 'BOTTOM' ? 'bottom' : n.startsWith('INNER') ? 'inner' : 'other' }));
    }
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: null, extraFiles: [] });
  },
};

