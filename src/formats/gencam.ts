/**
 * IPC-2511 GenCAM 1.x (`.a3p`, Teradyne/GRA3 test-engineering exports).
 *
 * Keyword statements `KEYWORD: p1,p2,…;` inside `$SECTION` … `$ENDSECTION`.
 * Parameters are numbers, bare words, "strings" ("" escapes a quote),
 * references `"(group).owner"."name"` and tuples `(x,y)`. Definitions are
 * collected first and resolved afterwards:
 *
 *   $PRIMITIVES   CIRCLEDEF / RECTCORNERDEF / RECTCENTERDEF / POLYGONDEF   pad and hole shapes
 *   $PADSTACKS    HOLEDEF; PADSTACK: name; PAD: layer, shape,…,(x,y),rot; HOLEREF
 *   $PATTERNS     PATTERNDEF: name; PADSTACKREF: padstack, "pin", (x,y), rot; ARTWORKREF
 *   $ARTWORKS     ARTWORKDEF: name; POLYLINE / STARTAT / LINETO / CIRCARCTO
 *   $DEVICES      DEVICE: name, …; PART: vendor, number; VALUE: v, unit
 *   $COMPONENTS   COMPONENT: ref, layer, (x,y), rot[, MIRROR]; DEVICEREF; PATTERNREF
 *   $ROUTES       ROUTE: net; COMPPIN: component, pin; VIA: name, padstack,,,(x,y),rot; PATH: layer, …; POLYLINE…
 *   $TESTCONNECTS TESTPROBE: name, …, layer, …, (x,y); VIAREF / COMPPINREF
 *   $BOARDS       BOARD: name; OUTLINE: …; POLYLINE…
 *
 * Pattern pins are placed by mirroring X when the component says MIRROR,
 * rotating counter-clockwise, then translating (IPC-2511), which puts copper
 * route ends and vias on the pins of their nets in real files.
 */
import { ParseError } from '../io/bytes';
import { decodeText } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { type LayerInfo, MOUNT_SMD, MOUNT_TH, PINKIND_TESTPOINT, SHAPE_CIRCLE, SHAPE_RECT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type UnitInfo } from '../model/types';
import type { FormatModule } from './types';

// ─── Statements ───────────────────────────────────────────────────────────

/** A reference "(group).owner"."name". */
interface Ref {
  ref: true;
  group: string;
  name: string;
}
type Param = string | number[] | Ref;
interface Stmt {
  kw: string;
  p: Param[];
}

const isRef = (p: Param | undefined): p is Ref => typeof p === 'object' && p !== null && !Array.isArray(p);
const isTuple = (p: Param | undefined): p is number[] => Array.isArray(p);
const s = (p: Param | undefined) => (typeof p === 'string' ? p : isRef(p) ? p.name : '');
const n = (p: Param | undefined) => (typeof p === 'string' && p !== '' ? Number(p) : NaN);
const refKey = (p: Param | undefined) => (isRef(p) ? p.name : typeof p === 'string' ? p : '');

/** Reads a quoted string at text[i] (opening quote); "" is an escaped quote. */
function readQuoted(t: string, i: number): [string, number] {
  let out = '';
  let j = i + 1;
  for (;;) {
    const e = t.indexOf('"', j);
    if (e < 0) return [out + t.slice(j), t.length];
    out += t.slice(j, e);
    if (t.charCodeAt(e + 1) === 34) {
      out += '"';
      j = e + 2;
      continue;
    }
    return [out, e + 1];
  }
}

function parseParams(t: string): Param[] {
  const out: Param[] = [];
  let cur: Param | null = null;
  let i = 0;
  while (i < t.length) {
    const c = t.charCodeAt(i);
    if (c === 44 /* , */) {
      out.push(cur ?? '');
      cur = null;
      i++;
    } else if (c <= 32) i++;
    else if (c === 34 /* " */) {
      const [str, j] = readQuoted(t, i);
      i = j;
      // "group"."name" is a reference.
      if (t.charCodeAt(i) === 46 && t.charCodeAt(i + 1) === 34) {
        const [name, k] = readQuoted(t, i + 1);
        cur = { ref: true, group: str, name };
        i = k;
      } else cur = str;
    } else if (c === 40 /* ( */) {
      const e = t.indexOf(')', i);
      const end = e < 0 ? t.length : e;
      cur = t
        .slice(i + 1, end)
        .split(',')
        .map((x) => Number(x));
      i = end + 1;
    } else {
      let j = i;
      while (j < t.length && t.charCodeAt(j) !== 44) j++;
      cur = t.slice(i, j).trim();
      i = j;
    }
  }
  if (cur !== null || t.trimEnd().endsWith(',')) out.push(cur ?? '');
  return out;
}

/** Splits the file into sections of statements (";" ends a statement outside quotes). */
function statements(text: string): Map<string, Stmt[]> {
  const sections = new Map<string, Stmt[]>();
  let cur: Stmt[] | null = null;
  let i = 0;
  const L = text.length;
  while (i < L) {
    // Skip whitespace.
    let c = text.charCodeAt(i);
    if (c <= 32) {
      i++;
      continue;
    }
    if (c === 36 /* $ */) {
      let e = text.indexOf('\n', i);
      if (e < 0) e = L;
      const name = text.slice(i + 1, e).trim().toUpperCase();
      if (name.startsWith('END')) cur = null;
      else {
        cur = [];
        sections.set(name, cur);
      }
      i = e + 1;
      continue;
    }
    // Statement up to ";" outside quotes.
    let j = i;
    let inQ = false;
    for (; j < L; j++) {
      c = text.charCodeAt(j);
      if (c === 34) inQ = !inQ;
      else if (c === 59 && !inQ) break;
      else if (c === 36 && !inQ && (text.charCodeAt(j - 1) === 10 || text.charCodeAt(j - 1) === 13)) break; // runaway statement
    }
    const body = text.slice(i, j);
    i = text.charCodeAt(j) === 59 ? j + 1 : j;
    const colon = body.indexOf(':');
    if (colon < 0 || !cur) continue;
    cur.push({ kw: body.slice(0, colon).trim().toUpperCase(), p: parseParams(body.slice(colon + 1)) });
  }
  return sections;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────

interface Shape {
  round: boolean;
  /** Bounding box x1, y1, x2, y2 (shape-local). */
  box: [number, number, number, number];
}

/** STARTAT / LINETO / CIRCARCTO sequence → polyline points (arcs flattened). */
function pathPoints(stmts: Stmt[], from: number): { pts: number[]; next: number } {
  const pts: number[] = [];
  let i = from;
  for (; i < stmts.length; i++) {
    const st = stmts[i];
    const a = st.p[0];
    if (st.kw === 'STARTAT' || st.kw === 'LINETO') {
      if (st.kw === 'STARTAT' && pts.length) break;
      if (isTuple(a)) pts.push(a[0], a[1]);
    } else if (st.kw === 'CIRCARCTO' || st.kw === 'ARCTO') {
      const end = st.p[0],
        ctr = st.p[1];
      if (!isTuple(end) || !isTuple(ctr) || pts.length < 2) continue;
      const x0 = pts[pts.length - 2],
        y0 = pts[pts.length - 1];
      const cw = /^CLKW/i.test(s(st.p[2]));
      const r = Math.hypot(x0 - ctr[0], y0 - ctr[1]);
      let a0 = Math.atan2(y0 - ctr[1], x0 - ctr[0]);
      let sweep = Math.atan2(end[1] - ctr[1], end[0] - ctr[0]) - a0;
      if (cw) {
        if (sweep >= 0) sweep -= 2 * Math.PI;
      } else if (sweep <= 0) sweep += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 16)));
      for (let k = 1; k < steps; k++) {
        a0 += sweep / steps;
        pts.push(ctr[0] + r * Math.cos(a0), ctr[1] + r * Math.sin(a0));
      }
      pts.push(end[0], end[1]);
    } else if (st.kw === 'ENDLINE') continue;
    else break;
  }
  return { pts, next: i };
}

function bbox(pts: number[]): [number, number, number, number] {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    x1 = Math.min(x1, pts[i]);
    x2 = Math.max(x2, pts[i]);
    y1 = Math.min(y1, pts[i + 1]);
    y2 = Math.max(y2, pts[i + 1]);
  }
  return [x1, y1, x2, y2];
}

function unitsOf(u: string): { scale: number; units: UnitInfo } {
  switch (u.toUpperCase()) {
    case 'THOU':
      return { scale: 1, units: { unit: 'mil', toMm: 0.0254, assumed: false } };
    case 'THOU10':
      return { scale: 0.1, units: { unit: 'mil', toMm: 0.0254, assumed: false } };
    case 'INCH':
      return { scale: 1, units: { unit: 'inch', toMm: 25.4, assumed: false } };
    case 'MM':
      return { scale: 1, units: { unit: 'mm', toMm: 1, assumed: false } };
    case 'MM100':
      return { scale: 0.01, units: { unit: 'mm', toMm: 1, assumed: false } };
    case 'UM':
    case 'MICRON':
      return { scale: 1, units: { unit: 'um', toMm: 0.001, assumed: false } };
    default:
      return { scale: 1, units: { unit: 'unknown', toMm: 1, assumed: true, note: `GenCAM units "${u}" are not interpreted.` } };
  }
}

// ─── Reader ───────────────────────────────────────────────────────────────

interface PatPin {
  name: string;
  x: number;
  y: number;
  rot: number;
  stack: string;
}

export const gencamFormat: FormatModule = {
  id: 'gencam',
  name: 'GenCAM (IPC-2511)',
  extensions: ['a3p', 'gcm', 'gencam'],
  status: 'verified',
  summary: 'IPC-2511 GenCAM 1.x text (.a3p test-engineering exports): parts, pins, nets, pads, copper, probes',
  detect(sn) {
    const h = sn.headText.slice(0, 8192);
    if (/^\s*\$HEADER\b/.test(h) && /\bGENCAM\s*:/i.test(h)) return { confidence: 0.96, reason: '$HEADER with a GENCAM: revision statement' };
    return null;
  },
  parse(ctx) {
    ctx.progress('Reading statements');
    const sec = statements(decodeText(ctx.file.bytes).text);
    const head = sec.get('HEADER') ?? [];
    const hs = (kw: string) => head.find((x) => x.kw === kw);
    if (!hs('GENCAM')) throw new ParseError('gencam.header', 'No GENCAM: revision statement in $HEADER');
    const { scale: k, units } = unitsOf(s(hs('UNITS')?.p[0]) || s(hs('DIMENSION')?.p[0]) || 'THOU');
    const radians = /^RAD/i.test(s(hs('ANGLEUNITS')?.p[0]) || s(hs('ANGULARUNIT')?.p[0]));
    const deg = (v: number) => (Number.isFinite(v) ? (radians ? (v * 180) / Math.PI : v) : 0);
    const b = new BoardBuilder();
    b.units = units;
    b.metadata.push(['GenCAM', s(hs('GENCAM')?.p[0])]);
    const gen = hs('GENERATEDBY');
    if (gen) b.metadata.push(['Generated by', gen.p.map(s).filter(Boolean).join(' ')]);
    const boards = head.filter((x) => x.kw === 'BOARD');
    if (boards.length > 1) b.info('gencam.boards', `The file declares ${boards.length} boards; all components are shown together`);

    // Primitives: pad and hole shapes.
    const shapes = new Map<string, Shape>();
    const prims = sec.get('PRIMITIVES') ?? [];
    for (let i = 0; i < prims.length; i++) {
      const st = prims[i];
      const name = s(st.p[0]);
      if (st.kw === 'CIRCLEDEF') {
        const d = n(st.p[1]);
        if (Number.isFinite(d)) shapes.set(name, { round: true, box: [-d / 2, -d / 2, d / 2, d / 2] });
      } else if (st.kw === 'RECTCORNERDEF' && isTuple(st.p[1]) && isTuple(st.p[2])) {
        shapes.set(name, { round: false, box: [Math.min(st.p[1][0], st.p[2][0]), Math.min(st.p[1][1], st.p[2][1]), Math.max(st.p[1][0], st.p[2][0]), Math.max(st.p[1][1], st.p[2][1])] });
      } else if (st.kw === 'RECTCENTERDEF') {
        // RECTCENTERDEF: name, width, height[, (centre)]
        const w = n(st.p[1]),
          h = n(st.p[2]);
        const c = isTuple(st.p[3]) ? st.p[3] : [0, 0];
        if (Number.isFinite(w) && Number.isFinite(h)) shapes.set(name, { round: false, box: [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2] });
      } else if (st.kw === 'POLYGONDEF') {
        const { pts, next } = pathPoints(prims, i + 1);
        if (pts.length >= 6) shapes.set(name, { round: false, box: bbox(pts) });
        i = next - 1;
      }
    }

    // Pad stacks: copper pad per side and drill.
    const layerSide = new Map<string, string>();
    const layerKind = new Map<string, string>();
    for (const st of sec.get('LAYERS') ?? [])
      if (st.kw === 'LAYERSINGLE') {
        layerSide.set(s(st.p[0]), s(st.p[1]).toUpperCase());
        layerKind.set(s(st.p[0]), s(st.p[2]).toUpperCase());
      }
    const holes = new Map<string, number>();
    const stacks = new Map<string, { top?: Shape; bottom?: Shape; inner?: Shape; drill: number }>();
    let curStack: { top?: Shape; bottom?: Shape; inner?: Shape; drill: number } | null = null;
    for (const st of sec.get('PADSTACKS') ?? []) {
      if (st.kw === 'HOLEDEF') {
        const sh = shapes.get(refKey(st.p[2]));
        if (sh) holes.set(s(st.p[0]), sh.box[2] - sh.box[0]);
      } else if (st.kw === 'PADSTACK') {
        curStack = { drill: 0 };
        stacks.set(s(st.p[0]), curStack);
      } else if (st.kw === 'PAD' && curStack) {
        const layer = refKey(st.p[0]);
        if (layerKind.get(layer) !== 'CONDUCTOR') continue;
        const sh = shapes.get(refKey(st.p[1]));
        if (!sh) continue;
        const side = layerSide.get(layer);
        const off = isTuple(st.p[6]) ? st.p[6] : [0, 0];
        const placed: Shape = { round: sh.round, box: [sh.box[0] + off[0], sh.box[1] + off[1], sh.box[2] + off[0], sh.box[3] + off[1]] };
        if (side === 'TOP') curStack.top ??= placed;
        else if (side === 'BOTTOM') curStack.bottom ??= placed;
        else curStack.inner ??= placed;
      } else if (st.kw === 'HOLEREF' && curStack) curStack.drill = holes.get(refKey(st.p[0])) ?? curStack.drill;
    }

    // Artworks (component bodies) and patterns (footprints).
    const artworks = new Map<string, number[][]>();
    const arts = sec.get('ARTWORKS') ?? [];
    let curArt: number[][] | null = null;
    for (let i = 0; i < arts.length; i++) {
      const st = arts[i];
      if (st.kw === 'ARTWORKDEF') {
        curArt = [];
        artworks.set(s(st.p[0]), curArt);
      } else if ((st.kw === 'POLYLINE' || st.kw === 'POLYGON') && curArt) {
        const { pts, next } = pathPoints(arts, i + 1);
        if (pts.length >= 4) curArt.push(pts);
        i = next - 1;
      }
    }
    const patterns = new Map<string, { pins: PatPin[]; art: { name: string; x: number; y: number; rot: number }[] }>();
    let curPat: { pins: PatPin[]; art: { name: string; x: number; y: number; rot: number }[] } | null = null;
    for (const st of sec.get('PATTERNS') ?? []) {
      if (st.kw === 'PATTERNDEF') {
        curPat = { pins: [], art: [] };
        patterns.set(s(st.p[0]), curPat);
      } else if (st.kw === 'PADSTACKREF' && curPat && isTuple(st.p[2])) curPat.pins.push({ stack: refKey(st.p[0]), name: s(st.p[1]), x: st.p[2][0], y: st.p[2][1], rot: deg(n(st.p[3])) });
      else if (st.kw === 'ARTWORKREF' && curPat) {
        const layer = refKey(st.p[1]);
        const pos = isTuple(st.p[3]) ? st.p[3] : [0, 0];
        if (/ASSEMB|COMPONENT|PLACE/i.test(layer) || layerKind.get(layer) === 'COMPONENT') curPat.art.push({ name: refKey(st.p[0]), x: pos[0], y: pos[1], rot: deg(n(st.p[4])) });
      }
    }

    // Devices: part number and value.
    const devices = new Map<string, { part?: string; value?: string }>();
    let curDev: { part?: string; value?: string } | null = null;
    for (const st of sec.get('DEVICES') ?? []) {
      if (st.kw === 'DEVICE') {
        curDev = {};
        devices.set(s(st.p[0]), curDev);
      } else if (st.kw === 'PART' && curDev) curDev.part = s(st.p[1]) || undefined;
      else if (st.kw === 'VALUE' && curDev) {
        const v = n(st.p[0]);
        const u = s(st.p[1]);
        if (Number.isFinite(v) && v !== 0) curDev.value = `${v}${u && !/^(NONE|OTHER)$/i.test(u) ? ' ' + u.toLowerCase() : ''}`;
      }
    }

    // Nets: COMPPIN membership; vias; copper paths.
    ctx.progress('Reading routes');
    const netOfPin = new Map<string, string>();
    const vias: { name: string; net: string; stack: string; x: number; y: number }[] = [];
    const paths: { net: string; layer: string; width: number; pts: number[] }[] = [];
    const lineWidth = new Map<string, number>();
    for (const st of prims) if (st.kw === 'LINEDESC') lineWidth.set(s(st.p[0]), n(st.p[1]));
    const routes = sec.get('ROUTES') ?? [];
    let net = '';
    let pathLayer = '';
    let pathWidth = 0;
    for (let i = 0; i < routes.length; i++) {
      const st = routes[i];
      switch (st.kw) {
        case 'ROUTE':
          net = s(st.p[0]);
          break;
        case 'COMPPIN':
          netOfPin.set(`${refKey(st.p[0])}\u0000${s(st.p[1])}`, net);
          break;
        case 'VIA':
          if (isTuple(st.p[4])) vias.push({ name: s(st.p[0]), net, stack: refKey(st.p[1]), x: st.p[4][0], y: st.p[4][1] });
          break;
        case 'PATH':
          pathLayer = refKey(st.p[0]);
          pathWidth = lineWidth.get(refKey(st.p[1])) ?? 0;
          break;
        case 'POLYLINE': {
          const w = lineWidth.get(refKey(st.p[0]));
          const { pts, next } = pathPoints(routes, i + 1);
          if (pts.length >= 4) paths.push({ net, layer: pathLayer, width: w ?? pathWidth, pts });
          i = next - 1;
          break;
        }
      }
    }

    // Test probes: on a via (VIAREF) or a component pin (COMPPINREF).
    const probes: { x: number; y: number; bottom: boolean; via?: string; pin?: string }[] = [];
    let curProbe: (typeof probes)[number] | null = null;
    for (const st of sec.get('TESTCONNECTS') ?? []) {
      if (st.kw === 'TESTPROBE') {
        const xy = st.p.find(isTuple);
        const layer = st.p.map(refKey).find((x) => layerSide.has(x)) ?? '';
        curProbe = xy ? { x: xy[0], y: xy[1], bottom: layerSide.get(layer) === 'BOTTOM' } : null;
        if (curProbe) probes.push(curProbe);
      } else if (st.kw === 'VIAREF' && curProbe) curProbe.via = refKey(st.p[0]);
      else if (st.kw === 'COMPPINREF' && curProbe) curProbe.pin = `${refKey(st.p[0])}\u0000${s(st.p[1])}`;
    }
    const probeOfPin = new Map<string, number>();
    probes.forEach((p, i) => p.pin && !probeOfPin.has(p.pin) && probeOfPin.set(p.pin, i + 1));

    // Copper layers: top, inner, bottom.
    const copper = [...layerKind.entries()].filter(([, kd]) => kd === 'CONDUCTOR').map(([name]) => name);
    const order = (l: string) => (layerSide.get(l) === 'TOP' ? 0 : layerSide.get(l) === 'BOTTOM' ? 2 : 1);
    copper.sort((a, c) => order(a) - order(c));
    const layerIndex = new Map(copper.map((l, i) => [l, i]));
    b.layers = copper.map<LayerInfo>((l, i) => ({ id: i, name: l.replace(/_{2,}/g, ' ').trim(), kind: order(l) === 0 ? 'top' : order(l) === 2 ? 'bottom' : 'inner' }));

    // Board outline.
    const boardStmts = sec.get('BOARDS') ?? [];
    let outline = 0;
    for (let i = 0; i < boardStmts.length; i++) {
      if (boardStmts[i].kw !== 'OUTLINE') continue;
      for (let j = i + 1; j < boardStmts.length && /^(POLYLINE|POLYGON|STARTAT|LINETO|CIRCARCTO|ARCTO|ENDLINE)$/.test(boardStmts[j].kw); ) {
        if (boardStmts[j].kw === 'POLYLINE' || boardStmts[j].kw === 'POLYGON') {
          const { pts, next } = pathPoints(boardStmts, j + 1);
          if (pts.length >= 4) {
            b.addOutlinePolyline(
              pts.map((v) => v * k),
              pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1],
            );
            outline++;
          }
          j = next;
        } else j++;
      }
    }

    // Components.
    ctx.progress('Placing components');
    let missingPattern = 0;
    const comps = sec.get('COMPONENTS') ?? [];
    const pinIndex = new Map<string, number>();
    let cur: { ref: string; x: number; y: number; rot: number; mirror: boolean; bottom: boolean; attrs: [string, string][]; device?: string; pattern?: string } | null = null;
    const place = (c: NonNullable<typeof cur>, lx: number, ly: number): [number, number] => {
      const x = c.mirror ? -lx : lx;
      const a = (c.rot * Math.PI) / 180;
      return [c.x + x * Math.cos(a) - ly * Math.sin(a), c.y + x * Math.sin(a) + ly * Math.cos(a)];
    };
    const emit = (c: NonNullable<typeof cur>) => {
      const pat = c.pattern ? patterns.get(c.pattern) : undefined;
      if (!pat) missingPattern++;
      const dev = c.device ? devices.get(c.device) : undefined;
      const attrs = [...c.attrs];
      if (dev?.part) attrs.unshift(['Part number', dev.part]);
      // Body from the pattern's assembly artwork.
      const body: number[] = [];
      for (const ar of pat?.art ?? []) {
        const a = (ar.rot * Math.PI) / 180;
        for (const pl of artworks.get(ar.name) ?? []) {
          const pts: [number, number][] = [];
          for (let i = 0; i + 1 < pl.length; i += 2) pts.push(place(c, ar.x + pl[i] * Math.cos(a) - pl[i + 1] * Math.sin(a), ar.y + pl[i] * Math.sin(a) + pl[i + 1] * Math.cos(a)));
          for (let i = 0; i + 1 < pts.length; i++) body.push(pts[i][0] * k, pts[i][1] * k, pts[i + 1][0] * k, pts[i + 1][1] * k);
        }
      }
      const pi = b.addPart({
        name: c.ref,
        side: c.bottom ? SIDE_BOTTOM : SIDE_TOP,
        mount: MOUNT_SMD,
        x: c.x * k,
        y: c.y * k,
        rot: ((c.rot % 360) + 360) % 360,
        footprint: c.pattern ?? null,
        value: dev?.value ?? null,
        attrs: attrs.length ? attrs : null,
        body: body.length ? body : null,
      });
      let th = false;
      for (const pp of pat?.pins ?? []) {
        const [x, y] = place(c, pp.x, pp.y);
        const st = stacks.get(pp.stack);
        // A mirrored pattern's top pad is on the bottom copper.
        const sh = (c.mirror ? (st?.bottom ?? st?.top) : (st?.top ?? st?.bottom)) ?? st?.inner;
        const drill = st?.drill ?? 0;
        if (drill > 0) th = true;
        const key = `${c.ref}\u0000${pp.name}`;
        const rot = (((c.mirror ? -pp.rot : pp.rot) + c.rot) % 360 + 360) % 360;
        const pin = b.addPin({
          part: pi,
          x: x * k,
          y: y * k,
          number: pp.name,
          net: netOfPin.get(key),
          probe: probeOfPin.get(key),
          side: drill > 0 ? SIDE_BOTH : undefined,
          ...(sh ? { shape: sh.round ? SHAPE_CIRCLE : SHAPE_RECT, w: (sh.box[2] - sh.box[0]) * k, h: (sh.box[3] - sh.box[1]) * k, rot } : {}),
          hole: drill > 0 ? drill * k : undefined,
        });
        pinIndex.set(key, pin);
      }
      if (th) b.partInput(pi).mount = MOUNT_TH;
    };
    for (const st of comps) {
      if (st.kw === 'COMPONENT') {
        if (cur) emit(cur);
        const xy = isTuple(st.p[2]) ? st.p[2] : [NaN, NaN];
        const layer = refKey(st.p[1]);
        cur = {
          ref: s(st.p[0]),
          x: xy[0],
          y: xy[1],
          rot: deg(n(st.p[3])),
          mirror: st.p.slice(4).some((p) => s(p).toUpperCase() === 'MIRROR'),
          bottom: layerSide.get(layer) === 'BOTTOM' || /BOT/i.test(layer),
          attrs: [],
        };
      } else if (!cur) continue;
      else if (st.kw === 'DEVICEREF') cur.device = refKey(st.p[0]);
      else if (st.kw === 'PATTERNREF') cur.pattern = refKey(st.p[0]);
      else if (st.kw === 'ATTRIBUTE') {
        const key = s(st.p[1]);
        if (/^(BOM_Description|BOM_TYPE|BOM_Package|DESCRIPTION|VALUE|PART_NUMBER)$/i.test(key) && s(st.p[2])) cur.attrs.push([key.replace(/^BOM_/, ''), s(st.p[2])]);
      }
    }
    if (cur) emit(cur);

    // Vias, test probes on vias, copper.
    const viaByName = new Map<string, number>();
    for (const v of vias) {
      const st = stacks.get(v.stack);
      const sh = st?.top ?? st?.bottom ?? st?.inner;
      viaByName.set(v.name, vias.indexOf(v));
      b.addVia(v.x * k, v.y * k, sh ? (sh.box[2] - sh.box[0]) * k : (st?.drill ?? 0) * k, v.net || null);
    }
    probes.forEach((p, i) => {
      if (p.pin && pinIndex.has(p.pin)) return;
      const v = p.via !== undefined ? viaByName.get(p.via) : undefined;
      b.addPin({ part: -1, x: p.x * k, y: p.y * k, net: v !== undefined ? vias[v].net || null : null, kind: PINKIND_TESTPOINT, side: p.bottom ? SIDE_BOTTOM : SIDE_TOP, number: String(i + 1), probe: i + 1 });
    });
    for (const pth of paths) {
      const L = layerIndex.get(pth.layer);
      if (L === undefined) continue;
      const p = pth.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (p[i] === p[i + 2] && p[i + 1] === p[i + 3]) continue;
        b.addTrace(p[i] * k, p[i + 1] * k, p[i + 2] * k, p[i + 3] * k, pth.width * k, L, pth.net || null);
      }
    }

    if (!comps.some((x) => x.kw === 'COMPONENT')) throw new ParseError('gencam.empty', 'GenCAM file has no $COMPONENTS');
    if (missingPattern) b.warn('gencam.pattern', `${missingPattern} component(s) reference a pattern that is not defined; shown without pins`);
    let dangling = 0;
    for (const key of netOfPin.keys()) if (!pinIndex.has(key)) dangling++;
    if (dangling) b.warn('gencam.comppin', `${dangling} COMPPIN reference(s) name a pin that no placed component has`);
    if (!outline) b.info('gencam.nooutline', 'No board OUTLINE in $BOARDS; the outline is derived from the parts');
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: `GenCAM ${s(hs('GENCAM')?.p[0])}`.trim(), extraFiles: [] });
  },
};
