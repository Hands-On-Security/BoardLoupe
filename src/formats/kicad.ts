/**
 * KiCad PCB (.kicad_pcb), KiCad 5 to 10: the s-expression board format, which
 * KiCad documents publicly ("S-Expression Format" in the KiCad developer
 * documentation). Reading it also opens every design KiCad can import —
 * Cadence Allegro, Altium, PADS, Eagle, CADSTAR … — after
 * `kicad-cli pcb import <file> -o board.kicad_pcb`.
 *
 * Streaming: top-level items are parsed one at a time and turned into model
 * records immediately, so memory stays bounded. Subtrees the viewer never
 * uses (copper zones and their fills, embedded fonts/files, 3D models, text
 * effects, UUIDs …) are skipped at byte level; on boards converted from Allegro
 * these make up most of the file.
 *
 * Geometry: millimetres, KiCad's Y axis points down (negated here). Footprint
 * children are stored relative to the footprint, unrotated; pad angles are
 * absolute. Version differences handled: `module` vs `footprint`, reference /
 * value as `fp_text` (≤6) or `property` (≥7), nets as `(net id "name")` with a
 * net table (≤9) or `(net "name")` (10), centre-based arcs (5) vs start/mid/end
 * arcs (≥6).
 */
import { ParseError } from '../io/bytes';
import { BoardBuilder } from '../model/builder';
import {
  type LayerInfo,
  MOUNT_SMD,
  MOUNT_TH,
  type PadShape,
  SHAPE_CIRCLE,
  SHAPE_OBLONG,
  SHAPE_RECT,
  SHAPE_ROUNDRECT,
  SIDE_BOTH,
  SIDE_BOTTOM,
  SIDE_TOP,
  type Side,
} from '../model/types';
import type { FormatModule } from './types';

type Atom = string | number;
type Node = Atom | List;
type List = Node[];

/** Subtrees never needed by a boardview; skipped without building nodes. */
const SKIP = new Set([
  'uuid',
  'tstamp',
  'effects',
  'stroke',
  'font',
  'zone',
  'embedded_files',
  'embedded_fonts',
  'model',
  'generated',
  'group',
  'image',
  'dimension',
  'table',
  'render_cache',
  'teardrops',
  'tenting',
  'setup',
  'primitives',
  'paper',
  'net_class',
  'filled_polygon',
  'fill_segments',
  'keepout',
  'path',
  'sheetname',
  'sheetfile',
  'descr',
  'tags',
  'pinfunction',
  'pintype',
  'die_length',
  'thermal_bridge_angle',
  'zone_connect',
  'clearance',
  'solder_mask_margin',
  'solder_paste_margin',
  'chamfer_ratio',
  'chamfer',
  'remove_unused_layers',
  'keep_end_layers',
  'zone_layer_connections',
  'padstack',
]);

/**
 * Byte-level s-expression reader. Numbers become JS numbers when written in
 * canonical decimal form (no "+", no leading zeros), so an unquoted name such
 * as "+5V" or a pad "01" stays a string.
 */
class Sexp {
  p = 0;
  skipped = new Map<string, number>();
  private readonly td = new TextDecoder('utf-8');
  constructor(readonly b: Uint8Array) {}

  ws() {
    const b = this.b;
    let p = this.p;
    while (p < b.length) {
      const c = b[p];
      if (c === 32 || c === 9 || c === 10 || c === 13) p++;
      else break;
    }
    this.p = p;
  }

  /** Head symbol of the list at this.p (which points at "("), without consuming it. */
  peekHead(): string {
    const b = this.b;
    let p = this.p + 1;
    while (p < b.length && (b[p] === 32 || b[p] === 9 || b[p] === 10 || b[p] === 13)) p++;
    const a = p;
    while (p < b.length) {
      const c = b[p];
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 40 || c === 41 || c === 34) break;
      p++;
    }
    return this.ascii(a, p);
  }

  private ascii(a: number, z: number): string {
    const b = this.b;
    if (z - a > 64) return this.td.decode(b.subarray(a, z));
    let s = '';
    for (let i = a; i < z; i++) {
      const c = b[i];
      if (c >= 0x80) return this.td.decode(b.subarray(a, z));
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Skips the list at this.p (pointing at "("), honouring quoted strings. */
  skipList() {
    const b = this.b;
    let p = this.p,
      depth = 0;
    while (p < b.length) {
      const c = b[p++];
      if (c === 34) {
        while (p < b.length && b[p] !== 34) p += b[p] === 92 ? 2 : 1;
        p++;
      } else if (c === 40) depth++;
      else if (c === 41 && --depth === 0) break;
    }
    if (depth !== 0) throw new ParseError('kicad.eof', 'Unexpected end of file (unbalanced parentheses)', { offset: p });
    this.p = p;
  }

  /** Parses the list at this.p (pointing at "("). */
  list(depth = 0): List {
    const b = this.b;
    if (depth > 200) throw new ParseError('kicad.depth', 'Lists are nested implausibly deep for a KiCad board', { offset: this.p });
    this.p++;
    const out: List = [];
    for (;;) {
      this.ws();
      if (this.p >= b.length) throw new ParseError('kicad.eof', 'Unexpected end of file (unbalanced parentheses)', { offset: this.p });
      const c = b[this.p];
      if (c === 41) {
        this.p++;
        return out;
      }
      if (c === 40) {
        const head = this.peekHead();
        if (SKIP.has(head)) {
          this.skipped.set(head, (this.skipped.get(head) ?? 0) + 1);
          this.skipList();
        } else out.push(this.list(depth + 1));
        continue;
      }
      out.push(this.atom());
    }
  }

  atom(): Atom {
    const b = this.b;
    if (b[this.p] === 34) {
      // Quoted string with backslash escapes.
      let p = this.p + 1;
      const a = p;
      let esc = false;
      while (p < b.length && b[p] !== 34) {
        if (b[p] === 92) {
          esc = true;
          p++;
        }
        p++;
      }
      const raw = this.ascii(a, Math.min(p, b.length));
      this.p = p + 1;
      return esc ? raw.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch)) : raw;
    }
    const a = this.p;
    let p = a;
    while (p < b.length) {
      const c = b[p];
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 40 || c === 41) break;
      p++;
    }
    this.p = p;
    // Canonical decimal numbers parse straight from the bytes.
    let i = a,
      neg = false;
    if (b[i] === 45) {
      neg = true;
      i++;
    }
    const d0 = i;
    let v = 0;
    while (i < p && b[i] >= 48 && b[i] <= 57) v = v * 10 + (b[i++] - 48);
    const intDigits = i - d0;
    if (intDigits > 0 && !(intDigits > 1 && b[d0] === 48)) {
      if (i === p) return neg ? -v : v;
      if (b[i] === 46) {
        i++;
        let f = 0,
          scale = 1;
        const f0 = i;
        while (i < p && b[i] >= 48 && b[i] <= 57) {
          f = f * 10 + (b[i++] - 48);
          scale *= 10;
        }
        if (i === p && i > f0) {
          const r = v + f / scale;
          return neg ? -r : r;
        }
      }
    }
    return this.ascii(a, p);
  }
}

// ---- tree helpers ----------------------------------------------------------

const isList = (n: Node | undefined): n is List => Array.isArray(n);
const head = (l: List) => l[0];
function child(l: List, h: string): List | undefined {
  for (let i = 1; i < l.length; i++) {
    const n = l[i];
    if (isList(n) && n[0] === h) return n;
  }
  return undefined;
}
function children(l: List, h: string): List[] {
  const out: List[] = [];
  for (let i = 1; i < l.length; i++) {
    const n = l[i];
    if (isList(n) && n[0] === h) out.push(n);
  }
  return out;
}
const num = (n: Node | undefined, d = NaN): number => (typeof n === 'number' ? n : typeof n === 'string' && n !== '' && Number.isFinite(Number(n)) ? Number(n) : d);
const str = (n: Node | undefined): string => (n === undefined || isList(n) ? '' : String(n));
function xy(l: List | undefined): [number, number] | null {
  if (!l) return null;
  const x = num(l[1]),
    y = num(l[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}
const layerOf = (l: List) => str(child(l, 'layer')?.[1]);

// ---- geometry ---------------------------------------------------------------

/** Footprint placement: local (KiCad, Y down, unrotated) -> world (Y up). */
interface Place {
  x: number;
  y: number;
  c: number;
  s: number;
}
const IDENT: Place = { x: 0, y: 0, c: 1, s: 0 };
function placeOf(at: List | undefined): Place & { a: number } {
  const x = num(at?.[1], 0),
    y = num(at?.[2], 0),
    a = num(at?.[3], 0);
  const r = (a * Math.PI) / 180;
  return { x, y, a, c: Math.cos(r), s: Math.sin(r) };
}
/** World point (Y up) of a local point. */
function tx(P: Place, lx: number, ly: number): [number, number] {
  return [P.x + lx * P.c + ly * P.s, -(P.y - lx * P.s + ly * P.c)];
}

/** Points along the arc start -> mid -> end (local coordinates). */
function arc3(sx: number, sy: number, mx: number, my: number, ex: number, ey: number): number[] {
  const d = 2 * (sx * (my - ey) + mx * (ey - sy) + ex * (sy - my));
  if (Math.abs(d) < 1e-12) return [sx, sy, ex, ey];
  const s2 = sx * sx + sy * sy,
    m2 = mx * mx + my * my,
    e2 = ex * ex + ey * ey;
  const cx = (s2 * (my - ey) + m2 * (ey - sy) + e2 * (sy - my)) / d;
  const cy = (s2 * (ex - mx) + m2 * (sx - ex) + e2 * (mx - sx)) / d;
  const r = Math.hypot(sx - cx, sy - cy);
  const a0 = Math.atan2(sy - cy, sx - cx);
  let am = Math.atan2(my - cy, mx - cx) - a0,
    a1 = Math.atan2(ey - cy, ex - cx) - a0;
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  am = norm(am);
  a1 = norm(a1);
  // Sweep direction: the one that passes through mid.
  const sweep = am <= a1 ? a1 : a1 - 2 * Math.PI;
  return arcPts(cx, cy, r, a0, sweep);
}
function arcPts(cx: number, cy: number, r: number, a0: number, sweep: number): number[] {
  const n = Math.max(2, Math.min(64, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return out;
}

/** Local polyline(s) of a graphic item (gr_… or fp_…), or null when not drawable. */
function graphicPolylines(g: List): number[][] | null {
  const kind = String(head(g)).slice(3); // line, arc, circle, rect, poly, curve
  const st = xy(child(g, 'start')),
    en = xy(child(g, 'end'));
  switch (kind) {
    case 'line':
      return st && en ? [[st[0], st[1], en[0], en[1]]] : null;
    case 'rect':
      return st && en ? [[st[0], st[1], en[0], st[1], en[0], en[1], st[0], en[1], st[0], st[1]]] : null;
    case 'circle': {
      const c = xy(child(g, 'center')) ?? st;
      if (!c || !en) return null;
      return [arcPts(c[0], c[1], Math.hypot(en[0] - c[0], en[1] - c[1]), 0, 2 * Math.PI)];
    }
    case 'arc': {
      const mid = xy(child(g, 'mid'));
      if (st && mid && en) return [arc3(st[0], st[1], mid[0], mid[1], en[0], en[1])];
      // KiCad 5: start = centre, end = arc start, angle = sweep (degrees, Y down).
      const ang = num(child(g, 'angle')?.[1]);
      if (st && en && Number.isFinite(ang)) {
        const r = Math.hypot(en[0] - st[0], en[1] - st[1]);
        return [arcPts(st[0], st[1], r, Math.atan2(en[1] - st[1], en[0] - st[0]), (ang * Math.PI) / 180)];
      }
      return null;
    }
    case 'poly':
    case 'curve': {
      const pts = child(g, 'pts');
      if (!pts) return null;
      const out: number[] = [];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        if (!isList(p)) continue;
        if (p[0] === 'xy') out.push(num(p[1]), num(p[2]));
        else if (p[0] === 'arc') {
          const a = xy(child(p, 'start')),
            m = xy(child(p, 'mid')),
            e = xy(child(p, 'end'));
          if (a && m && e) out.push(...arc3(a[0], a[1], m[0], m[1], e[0], e[1]));
        }
      }
      if (kind === 'curve' && out.length === 8) {
        // Cubic Bézier through its four control points.
        const b: number[] = [];
        for (let i = 0; i <= 16; i++) {
          const t = i / 16,
            u = 1 - t;
          b.push(
            u * u * u * out[0] + 3 * u * u * t * out[2] + 3 * u * t * t * out[4] + t * t * t * out[6],
            u * u * u * out[1] + 3 * u * u * t * out[3] + 3 * u * t * t * out[5] + t * t * t * out[7],
          );
        }
        return [b];
      }
      if (out.length >= 4 && kind === 'poly') out.push(out[0], out[1]);
      return out.length >= 4 ? [out] : null;
    }
  }
  return null;
}

function emitPolylines(polys: number[][], P: Place, push: (x1: number, y1: number, x2: number, y2: number) => void) {
  for (const pl of polys) {
    let [px, py] = tx(P, pl[0], pl[1]);
    for (let i = 2; i + 1 < pl.length; i += 2) {
      const [qx, qy] = tx(P, pl[i], pl[i + 1]);
      push(px, py, qx, qy);
      px = qx;
      py = qy;
    }
  }
}

// ---- format module ------------------------------------------------------------

const PAD_SHAPES: Record<string, PadShape> = { circle: SHAPE_CIRCLE, rect: SHAPE_RECT, oval: SHAPE_OBLONG, roundrect: SHAPE_ROUNDRECT, trapezoid: SHAPE_RECT };

const COPPER_RE = /^(F|B|In(\d+))\.Cu$/;
/** Copper stack order: F.Cu, In1.Cu … InN.Cu, B.Cu. */
function copperRank(name: string): number {
  const m = COPPER_RE.exec(name);
  if (!m) return -1;
  return m[1] === 'F' ? 0 : m[1] === 'B' ? 1000 : Number(m[2]);
}

export const kicadFormat: FormatModule = {
  id: 'kicad',
  name: 'KiCad PCB',
  extensions: ['kicad_pcb'],
  status: 'verified',
  summary: 'KiCad 5–10 board; also Allegro, Altium, PADS, Eagle … via KiCad import',
  detect(s) {
    if (/^\s*\(kicad_pcb\b/.test(s.headText)) return { confidence: 0.99, reason: '"(kicad_pcb" s-expression header' };
    return null;
  },
  parse(ctx) {
    const bytes = ctx.file.bytes;
    const sx = new Sexp(bytes);
    sx.ws();
    if (bytes[sx.p] !== 40 || sx.peekHead() !== 'kicad_pcb') throw new ParseError('kicad.header', 'Not a KiCad board: the file does not start with "(kicad_pcb"', { offset: 0 });
    sx.p++; // into the root list
    const b = new BoardBuilder();
    b.units = { unit: 'mm', toMm: 1, assumed: false };

    const netById = new Map<number, string>();
    const netName = (n: List | undefined): string | null => {
      if (!n) return null;
      // (net "name") in KiCad 10; (net id "name") or (net id) before.
      if (n.length >= 3) return str(n[2]) || null;
      const v = n[1];
      if (typeof v === 'number') return netById.get(v) || null;
      return str(v) || null;
    };

    let version = 0;
    let copper: { rank: number; name: string; user: string }[] = [];
    const layerIndex = new Map<string, number>();
    const meta: [string, string][] = [];
    let footprints = 0,
      outlineSegs = 0,
      noCopper = 0;
    const total = bytes.length;
    let nextProgress = 0;

    const addOutline = (polys: number[][], P: Place) =>
      emitPolylines(polys, P, (x1, y1, x2, y2) => {
        b.addOutlineSeg(x1, y1, x2, y2);
        outlineSegs++;
      });

    const footprint = (fp: List) => {
      footprints++;
      const P = placeOf(child(fp, 'at'));
      const side: Side = layerOf(fp).startsWith('B.') ? SIDE_BOTTOM : SIDE_TOP;
      // First real Reference / Value. Boards imported from Allegro carry a second
      // "Reference" property whose text is the unresolved variable "${REFERENCE}".
      let ref = '',
        value = '';
      const real = (v: string) => v !== '' && !/^\$\{[^}]+\}$/.test(v);
      for (const p of children(fp, 'property')) {
        const v = str(p[2]);
        if (p[1] === 'Reference' && !ref && real(v)) ref = v;
        else if (p[1] === 'Value' && !value && real(v)) value = v;
      }
      for (const t of children(fp, 'fp_text')) {
        const v = str(t[2]);
        if (t[1] === 'reference' && !ref && real(v)) ref = v;
        else if (t[1] === 'value' && !value && real(v)) value = v;
      }
      const lib = str(fp[1]);
      const pads = children(fp, 'pad');
      // Body: assembly (Fab) outline, else courtyard, else silkscreen.
      const groups: Record<'fab' | 'crt' | 'silk', number[][]> = { fab: [], crt: [], silk: [] };
      for (let i = 1; i < fp.length; i++) {
        const g = fp[i];
        if (!isList(g) || typeof g[0] !== 'string' || !g[0].startsWith('fp_') || g[0] === 'fp_text') continue;
        const L = layerOf(g);
        const polys = /Edge\.Cuts/.test(L) || /Fab|CrtYd|SilkS/.test(L) ? graphicPolylines(g) : null;
        if (!polys) continue;
        if (L === 'Edge.Cuts') addOutline(polys, P);
        else if (L.endsWith('.Fab')) groups.fab.push(...polys);
        else if (L.endsWith('.CrtYd')) groups.crt.push(...polys);
        else if (L.endsWith('.SilkS')) groups.silk.push(...polys);
      }
      const body: number[] = [];
      const bodyPolys = groups.fab.length ? groups.fab : groups.crt.length ? groups.crt : groups.silk;
      emitPolylines(bodyPolys, P, (x1, y1, x2, y2) => body.push(x1, y1, x2, y2));

      const th = pads.some((p) => p[2] === 'thru_hole');
      const copperPads = pads.filter((p) => p[2] !== 'np_thru_hole');
      const [wx, wy] = tx(P, 0, 0);
      const k = b.addPart({
        name: ref,
        side,
        mount: th ? MOUNT_TH : MOUNT_SMD,
        mechanical: copperPads.length === 0 || (/^(FID|MH|H\d)/i.test(ref) && copperPads.every((p) => !netName(child(p, 'net')))),
        x: wx,
        y: wy,
        rot: P.a,
        value: value || null,
        footprint: lib || null,
        body: body.length ? body : null,
      });
      for (const pad of pads) {
        const layers = (child(pad, 'layers') ?? []).slice(1).map(str);
        // Stencil apertures (paste/mask only, e.g. split paste on a thermal pad) carry no copper.
        if (pad[2] !== 'np_thru_hole' && !layers.some((l) => l.endsWith('.Cu'))) {
          noCopper++;
          continue;
        }
        const at = child(pad, 'at');
        const lx = num(at?.[1], 0),
          ly = num(at?.[2], 0);
        const [x, y] = tx(P, lx, ly);
        const size = child(pad, 'size');
        let shapeName = str(pad[3]);
        if (shapeName === 'custom') shapeName = str(child(child(pad, 'options') ?? [], 'anchor')?.[1]) || 'rect';
        const onF = layers.some((l) => l === 'F.Cu' || l === '*.Cu' || l === 'F&B.Cu'),
          onB = layers.some((l) => l === 'B.Cu' || l === '*.Cu' || l === 'F&B.Cu');
        const drill = child(pad, 'drill');
        let hole = 0;
        if (drill) hole = drill[1] === 'oval' ? Math.min(num(drill[2], 0), num(drill[3], num(drill[2], 0))) : num(drill[1], 0);
        b.addPin({
          part: k,
          x,
          y,
          net: netName(child(pad, 'net')),
          number: str(pad[1]),
          side: (onF && onB) || pad[2] === 'thru_hole' || pad[2] === 'np_thru_hole' ? SIDE_BOTH : onB ? SIDE_BOTTOM : SIDE_TOP,
          shape: PAD_SHAPES[shapeName] ?? SHAPE_RECT,
          w: num(size?.[1], 0),
          h: num(size?.[2], num(size?.[1], 0)),
          rot: num(at?.[3], 0),
          hole: hole > 0 ? hole : undefined,
        });
      }
    };

    for (;;) {
      sx.ws();
      if (sx.p >= bytes.length) throw new ParseError('kicad.eof', 'Unexpected end of file: the board is truncated', { offset: sx.p });
      const c = bytes[sx.p];
      if (c === 41) break; // end of kicad_pcb
      if (c !== 40) {
        sx.atom();
        continue;
      }
      const h = sx.peekHead();
      if (SKIP.has(h)) {
        sx.skipped.set(h, (sx.skipped.get(h) ?? 0) + 1);
        sx.skipList();
        continue;
      }
      const item = sx.list();
      if (sx.p > nextProgress) {
        ctx.progress('Reading KiCad board', sx.p / total);
        nextProgress = sx.p + 4 * 1024 * 1024;
      }
      switch (h) {
        case 'version':
          version = num(item[1], 0);
          break;
        case 'generator':
        case 'generator_version':
          meta.push([h === 'generator' ? 'Generator' : 'Generator version', str(item[1])]);
          break;
        case 'title_block': {
          const t = str(child(item, 'title')?.[1]),
            r = str(child(item, 'rev')?.[1]);
          if (t) meta.push(['Title', t]);
          if (r) meta.push(['Revision', r]);
          break;
        }
        case 'layers':
          copper = item
            .slice(1)
            .filter(isList)
            .map((l) => ({ rank: copperRank(str(l[1])), name: str(l[1]), user: str(l[3]) }))
            .filter((l) => l.rank >= 0)
            .sort((a, c2) => a.rank - c2.rank);
          copper.forEach((l, i) => layerIndex.set(l.name, i));
          b.layers = copper.map<LayerInfo>((l, i) => ({ id: i, name: l.user || l.name, kind: i === 0 ? 'top' : i === copper.length - 1 ? 'bottom' : 'inner' }));
          break;
        case 'net':
          netById.set(num(item[1], -1), str(item[2]));
          break;
        case 'footprint':
        case 'module':
          footprint(item);
          break;
        case 'via': {
          const at = xy(child(item, 'at'));
          if (at) b.addVia(at[0], -at[1], num(child(item, 'size')?.[1], 0), netName(child(item, 'net')));
          break;
        }
        case 'segment':
        case 'arc': {
          const L = layerIndex.get(layerOf(item));
          if (L === undefined) break;
          const w = num(child(item, 'width')?.[1], 0);
          const net = netName(child(item, 'net'));
          const st = xy(child(item, 'start')),
            en = xy(child(item, 'end'));
          if (!st || !en) break;
          const mid = h === 'arc' ? xy(child(item, 'mid')) : null;
          const pts = mid ? arc3(st[0], st[1], mid[0], mid[1], en[0], en[1]) : [st[0], st[1], en[0], en[1]];
          for (let i = 0; i + 3 < pts.length; i += 2) b.addTrace(pts[i], -pts[i + 1], pts[i + 2], -pts[i + 3], w, L, net);
          break;
        }
        default:
          if (h.startsWith('gr_') && layerOf(item) === 'Edge.Cuts') {
            const polys = graphicPolylines(item);
            if (polys) addOutline(polys, IDENT);
          }
      }
    }

    if (!footprints) b.warn('kicad.empty', 'The board has no footprints');
    const zones = sx.skipped.get('zone') ?? 0;
    if (zones) b.info('kicad.zones', `${zones.toLocaleString('en')} zone(s) (copper pours and rule areas) are not drawn`);
    if (!outlineSegs) b.info('kicad.nooutline', 'The board has no Edge.Cuts outline');
    if (noCopper) b.info('kicad.nocopper', `${noCopper} pad(s) without copper (solder-paste apertures) are not shown`);
    b.metadata = [['KiCad file version', String(version)], ...meta];
    return b.finish({
      fileName: ctx.file.name,
      fileSize: bytes.length,
      formatId: 'kicad',
      formatName: 'KiCad PCB',
      variant: version ? `file version ${version}` : null,
      extraFiles: [],
    });
  },
};
