/**
 * Fabmaster jobs (FABmaster / Unisoft CAM, exported from Allegro and others),
 * in their two text encodings:
 *
 *   FATF  ":FABMASTER FATF REV 11.x;" — ":SECTION" lines closed by ":EOD",
 *         comma-separated records ending in ";", e.g.
 *           :PARTS    id,"ref","device","package",x,y,rotation,T|B;
 *           :NETS     id,"name",S,((partId,pinIndex),…);
 *           :PACKAGES id,"name",xmin,xmax,ymin,ymax (PINS (idx,"name",x,y,T|B|D)…) (idx,PAD (stack ((x,y))) … idx,LAYER(layer(shape)) …);
 *           :LAYERS   netId,LAYER (layer (TRACK(width (x,y)(x,y)…),…));
 *
 *   FARC  ":SECTION NAME 1" … ":EOSECTION" (the .far file inside a .faz ZIP),
 *         the same content as whitespace-separated nested lists with
 *         [FLAG …] groups, plus FABXYDATA (absolute pin positions).
 *
 * Both share one model: packages with local pins, nets as (part, pin index)
 * pairs, pad stacks → pad symbols, net-attributed copper tracks and pads
 * (vias) per layer, and test points on pins. Parts are placed by negating
 * local Y on the bottom side, then rotating clockwise (tenths of a degree):
 * this puts every pin of a real FARC job on its FABXYDATA position, every
 * FATF test point on its pin, and every bottom part whose pins meet copper
 * onto that copper (no other of the eight orientations does).
 */
import { ParseError } from '../io/bytes';
import { decodeText } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { type LayerInfo, MOUNT_SMD, MOUNT_TH, type PadShape, PINKIND_TESTPOINT, SHAPE_CIRCLE, SHAPE_RECT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type UnitInfo } from '../model/types';
import type { FormatModule } from './types';

// ─── Tokenizer ────────────────────────────────────────────────────────────

/** A [A B …] flag group (FARC). */
export class Flags {
  constructor(readonly items: string[]) {}
  has(f: string) {
    return this.items.includes(f);
  }
}
export type Node = string | Flags | Node[];

const isList = (n: Node | undefined): n is Node[] => Array.isArray(n);
const num = (n: Node | undefined) => (typeof n === 'string' && n !== '' ? Number(n) : NaN);
const str = (n: Node | undefined) => (typeof n === 'string' ? n : '');

/**
 * Reads nested lists from text[from, to). FATF: records end with ";" at depth
 * 0 and commas separate fields (",," is an empty field); a line starting with
 * ";" between records is a comment. FARC: every top-level list is passed on.
 * `onRecord(items)` receives each record (FATF) or each top-level item (FARC).
 */
export function scan(text: string, from: number, to: number, fatf: boolean, onRecord: (items: Node[]) => void) {
  const stack: Node[][] = [];
  let cur: Node[] = [];
  let lastComma = false;
  let i = from;
  const flush = () => {
    if (cur.length) onRecord(cur);
    cur = [];
  };
  while (i < to) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      // Comment line between FATF records.
      if (fatf && c === 10) {
        let j = i + 1;
        while (j < to && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
        if (j < to && text.charCodeAt(j) === 59 /* ; */ && !stack.length && !cur.length) {
          while (j < to && text.charCodeAt(j) !== 10) j++;
          i = j;
          continue;
        }
      }
      i++;
      continue;
    }
    switch (c) {
      case 40 /* ( */: {
        const l: Node[] = [];
        cur.push(l);
        stack.push(cur);
        cur = l;
        lastComma = false;
        i++;
        continue;
      }
      case 41 /* ) */:
        if (stack.length) cur = stack.pop()!;
        lastComma = false;
        i++;
        if (!fatf && !stack.length) flush();
        continue;
      case 44 /* , */:
        if (lastComma) cur.push('');
        lastComma = true;
        i++;
        continue;
      case 59 /* ; */:
        i++;
        lastComma = false;
        if (fatf && !stack.length) flush();
        continue;
      case 34 /* " */: {
        const e = text.indexOf('"', i + 1);
        const end = e < 0 || e > to ? to : e;
        cur.push(text.slice(i + 1, end));
        i = end + 1;
        lastComma = false;
        continue;
      }
      case 91 /* [ */: {
        const e = text.indexOf(']', i + 1);
        const end = e < 0 || e > to ? to : e;
        cur.push(new Flags(text.slice(i + 1, end).split(/\s+/).filter(Boolean)));
        i = end + 1;
        lastComma = false;
        continue;
      }
    }
    let j = i + 1;
    for (; j < to; j++) {
      const d = text.charCodeAt(j);
      if (d <= 32 || d === 40 || d === 41 || d === 44 || d === 59 || d === 34 || d === 91 || d === 93) break;
    }
    cur.push(text.slice(i, j));
    lastComma = false;
    i = j;
    if (!fatf && !stack.length) flush();
  }
  while (stack.length) cur = stack.pop()!;
  flush();
}

interface Section {
  name: string;
  from: number;
  to: number;
}

/** FATF: ":NAME" … ":EOD". A header without its ":EOD" ends at the next header. */
function fatfSections(text: string): { sections: Map<string, Section>; directives: string[] } {
  const sections = new Map<string, Section>();
  const directives: string[] = [];
  let open: Section | null = null;
  const re = /^[ \t]*:([^\r\n]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const head = m[1].trim();
    if (open) {
      open.to = m.index;
      if (!sections.has(open.name)) sections.set(open.name, open);
      open = null;
    }
    if (/^(EOD|EOF)\b/.test(head)) continue;
    if (/[=;]/.test(head) || /\s/.test(head)) {
      directives.push(head.replace(/;\s*$/, ''));
      continue;
    }
    open = { name: head.toUpperCase(), from: m.index + m[0].length, to: text.length };
  }
  if (open && !sections.has(open.name)) sections.set(open.name, open);
  return { sections, directives };
}

/** FARC: ":SECTION NAME n" … ":EOSECTION". */
function farcSections(text: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  const re = /^:SECTION[ \t]+(\S+)[^\r\n]*$|^:EOSECTION\b/gm;
  let open: Section | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) open = { name: m[1].toUpperCase(), from: m.index + m[0].length, to: text.length };
    else if (open) {
      open.to = m.index;
      if (!sections.has(open.name)) sections.set(open.name, open);
      open = null;
    }
  }
  return sections;
}

// ─── Job model shared by both encodings ───────────────────────────────────

interface Shape {
  kind: 'round' | 'block' | 'poly';
  /** round: d, cx, cy; block: x1, y1, x2, y2; poly: bbox x1, y1, x2, y2. */
  v: number[];
}
interface Graphic {
  kind: 'track' | 'poly';
  width: number;
  pts: number[];
}
interface PkgPin {
  name: string;
  x: number;
  y: number;
  /** T: placement side, B: opposite side, D: both (through hole). */
  side: 'T' | 'B' | 'D';
  stack: number;
  /** Copper shape per layer id (package-local). */
  shapes: Map<number, Shape>;
}
interface Package {
  pins: Map<number, PkgPin>;
  /** Package graphics per layer id (pin index 0 in the file). */
  art: Map<number, Graphic[]>;
}
export interface Part {
  id: number;
  ref: string;
  device: string;
  pkg: string;
  /** Package key when it differs from the name (FARC: 8.3 outline file name). */
  pkgKey?: string;
  x: number;
  y: number;
  /** Tenths of a degree, clockwise. */
  rot: number;
  bottom: boolean;
}
interface LayerName {
  name: string;
  side: string;
  type: string;
}
interface Job {
  variant: string;
  /** Multiply file coordinates by this to get `units`. */
  scale: number;
  units: UnitInfo;
  meta: [string, string][];
  outline: number[][];
  parts: Part[];
  packages: Map<string, Package>;
  nets: Map<number, { name: string; members: [number, number][] }>;
  symbols: Map<number, Shape>;
  stacks: Map<number, { drill: number; symbols: [number, number][] }>;
  layerNames: Map<number, LayerName>;
  layerSets: Map<number, number[]>;
  /** Net-attributed board graphics per layer. */
  copper: { net: number; layer: number; g: Graphic }[];
  /** Board-level graphics on non-electrical layers (outline fallback). */
  art: Map<number, Graphic[]>;
  vias: { net: number; stack: number; x: number; y: number }[];
  tests: { x: number; y: number; bottom: boolean; part: number; pin: number }[];
  /** Absolute pin positions (FARC FABXYDATA): key part:pin. */
  xy: Map<string, [number, number]>;
}

const newJob = (variant: string, scale: number, units: UnitInfo): Job => ({
  variant,
  scale,
  units,
  meta: [],
  outline: [],
  parts: [],
  packages: new Map(),
  nets: new Map(),
  symbols: new Map(),
  stacks: new Map(),
  layerNames: new Map(),
  layerSets: new Map(),
  copper: [],
  art: new Map(),
  vias: [],
  tests: [],
  xy: new Map(),
});

/** Point list from [[x,y,…],…] or [x,y] items. */
function points(items: Node[]): number[] {
  const out: number[] = [];
  for (const p of items) {
    if (!isList(p)) continue;
    if (isList(p[0])) {
      out.push(...points(p));
      continue;
    }
    const x = num(p[0]),
      y = num(p[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(x, y);
  }
  return out;
}

function bboxShape(pts: number[]): Shape | null {
  if (pts.length < 2) return null;
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
  return { kind: 'poly', v: [x1, y1, x2, y2] };
}

/** Shape keyword + argument list → pad shape (ROUND d x y | BLOCK x1 y1 x2 y2 | POLYGON w pts). */
function shapeOf(kw: string, args: Node[]): Shape | null {
  switch (kw.replace(/^P_/, '')) {
    case 'ROUND': {
      const d = num(args[0]);
      return Number.isFinite(d) ? { kind: 'round', v: [d, num(args[1]) || 0, num(args[2]) || 0] } : null;
    }
    case 'BLOCK': {
      const v = args.slice(0, 4).map(num);
      return v.every(Number.isFinite) ? { kind: 'block', v } : null;
    }
    case 'POLYGON':
    case 'POLY':
      return bboxShape(points(args.slice(1)));
    case 'CIRCLE': {
      // CIRCLE(dx, dy, x, y): an ellipse given by its two diameters.
      const [dx, dy, x, y] = args.slice(0, 4).map(num);
      return [dx, dy, x, y].every(Number.isFinite) ? { kind: 'round', v: [Math.max(dx, dy), x, y] } : null;
    }
    default:
      return null;
  }
}

/** FATF graphic sequence: KW (args), KW (args), … */
function fatfGraphics(items: Node[], onShape: (kw: string, args: Node[]) => void) {
  for (let i = 0; i < items.length; i++) {
    const kw = items[i];
    if (typeof kw === 'string' && isList(items[i + 1])) {
      onShape(kw.toUpperCase(), items[i + 1] as Node[]);
      i++;
    }
  }
}

function graphicOf(kw: string, args: Node[]): Graphic | null {
  if (kw === 'TRACK' || kw === 'POLYGON' || kw === 'POLY') {
    const pts = points(args.slice(1));
    return pts.length >= 4 ? { kind: kw === 'TRACK' ? 'track' : 'poly', width: num(args[0]) || 0, pts } : null;
  }
  if (kw === 'CIRCLE') {
    const [dx, dy, x, y] = args.slice(0, 4).map(num);
    if (![dx, dy, x, y].every(Number.isFinite)) return null;
    const pts: number[] = [];
    for (let i = 0; i <= 24; i++) pts.push(x + (dx / 2) * Math.cos((i * Math.PI) / 12), y + (dy / 2) * Math.sin((i * Math.PI) / 12));
    return { kind: 'poly', width: 0, pts };
  }
  if (kw === 'BLOCK') {
    const [x1, y1, x2, y2] = args.slice(0, 4).map(num);
    return [x1, y1, x2, y2].every(Number.isFinite) ? { kind: 'poly', width: 0, pts: [x1, y1, x2, y1, x2, y2, x1, y2, x1, y1] } : null;
  }
  return null;
}

const pushTo = <K, V>(m: Map<K, V[]>, k: K, v: V) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);

const area = (s: Shape) => (s.kind === 'round' ? s.v[0] * s.v[0] : Math.abs((s.v[2] - s.v[0]) * (s.v[3] - s.v[1])));
/** A pad drawn from several shapes on one layer: keep the largest. */
function setShape(pin: PkgPin, layer: number, s: Shape) {
  const old = pin.shapes.get(layer);
  if (!old || area(s) > area(old)) pin.shapes.set(layer, s);
}

// ─── FATF ─────────────────────────────────────────────────────────────────

function unitsFromDirective(d: string): { scale: number; units: UnitInfo } | null {
  const m = /^UNITS\s*=\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(INCH|INCHES|MM|MILS?|THOU|MICRONS?|UM)\b/i.exec(d);
  if (!m) return null;
  const f = Number(m[1]) / Number(m[2]);
  switch (m[3].toUpperCase()) {
    case 'INCH':
    case 'INCHES':
      return { scale: f * 1000, units: { unit: 'mil', toMm: 0.0254, assumed: false } };
    case 'MIL':
    case 'MILS':
    case 'THOU':
      return { scale: f, units: { unit: 'mil', toMm: 0.0254, assumed: false } };
    case 'MM':
      return { scale: f, units: { unit: 'mm', toMm: 1, assumed: false } };
    default:
      return { scale: f, units: { unit: 'um', toMm: 0.001, assumed: false } };
  }
}

function readFatf(text: string): Job {
  const { sections, directives } = fatfSections(text);
  const rev = directives.find((d) => /^FABMASTER FATF/i.test(d));
  const u = directives.map(unitsFromDirective).find(Boolean) ?? null;
  const job = newJob(rev ? rev.replace(/^FABMASTER\s+/i, '') : 'FATF', u?.scale ?? 1, u?.units ?? { unit: 'mil', toMm: 0.0254, assumed: true, note: 'No :UNITS directive; assumed mils.' });
  if (!u) job.meta.push(['Units', 'not stated (assumed mils)']);
  const each = (name: string, fn: (r: Node[]) => void) => {
    const s = sections.get(name);
    if (s) scan(text, s.from, s.to, true, fn);
  };

  each('BOARD_DATA', (r) => {
    for (let i = 1; i < r.length; i++) {
      const kw = str(r[i]).toUpperCase();
      const arg = r[i + 1];
      if (kw === 'JOB' && isList(arg)) {
        if (str(arg[0])) job.meta.push(['Job', str(arg[0])]);
        if (str(arg[2])) job.meta.push(['Date', str(arg[2])]);
      } else if (kw === 'CONTOUR' && isList(arg)) {
        const pts = points(arg);
        if (pts.length >= 4) job.outline.push(pts);
      } else if (kw === 'THICKNESS' && r[i + 1] !== undefined && !isList(arg)) job.meta.push(['Board thickness', str(arg)]);
    }
  });

  each('PARTS', (r) => {
    // id,"ref","device","package",x,y,rotation,side
    const id = num(r[0]);
    if (!Number.isFinite(id)) return;
    job.parts.push({ id, ref: str(r[1]), device: str(r[2]), pkg: str(r[3]), x: num(r[4]), y: num(r[5]), rot: num(r[6]) || 0, bottom: str(r[7]).toUpperCase() === 'B' });
  });

  each('NETS', (r) => {
    // id,"name",S,((part,pin),…)
    const id = num(r[0]);
    const list = r.find((x, i) => i >= 2 && isList(x)) as Node[] | undefined;
    const members: [number, number][] = [];
    if (list) for (const p of list) if (isList(p)) members.push([num(p[0]), num(p[1])]);
    if (Number.isFinite(id)) job.nets.set(id, { name: str(r[1]), members });
  });

  each('PACKAGES', (r) => {
    const name = str(r[1]);
    if (!name) return;
    const pkg: Package = { pins: new Map(), art: new Map() };
    job.packages.set(name, pkg);
    for (const grp of r.slice(2)) {
      if (!isList(grp)) continue;
      if (str(grp[0]).toUpperCase() === 'PINS') {
        for (const p of grp.slice(1)) {
          if (!isList(p)) continue;
          const side = str(p[4]).toUpperCase();
          pkg.pins.set(num(p[0]), { name: str(p[1]), x: num(p[2]), y: num(p[3]), side: side === 'B' ? 'B' : side === 'D' ? 'D' : 'T', stack: -1, shapes: new Map() });
        }
        continue;
      }
      // idx,PAD (stack ((x,y))) … idx,LAYER (layer (SHAPE(…),…)) …
      for (let i = 0; i + 2 < grp.length; i++) {
        const idx = num(grp[i]);
        const kw = str(grp[i + 1]).toUpperCase();
        const arg = grp[i + 2];
        if (!Number.isFinite(idx) || !isList(arg) || (kw !== 'PAD' && kw !== 'LAYER')) continue;
        i += 2;
        const layer = num(arg[0]);
        const body = isList(arg[1]) ? arg[1] : [];
        if (kw === 'PAD') {
          const pin = pkg.pins.get(idx);
          if (pin) pin.stack = layer;
        } else if (idx === 0) {
          fatfGraphics(body, (k, a) => {
            const g = graphicOf(k, a);
            if (g) pushTo(pkg.art, layer, g);
          });
        } else {
          const pin = pkg.pins.get(idx);
          if (pin)
            fatfGraphics(body, (k, a) => {
              const s = shapeOf(k, a);
              if (s) setShape(pin, layer, s);
            });
        }
      }
    }
  });

  each('PAD_SYMBOLS', (r) => {
    const id = num(r[0]);
    const s = isList(r[2]) ? shapeOf(str(r[1]).toUpperCase(), r[2]) : null;
    if (Number.isFinite(id) && s) job.symbols.set(id, s);
  });
  each('PAD_STACKS', (r) => {
    // id,"name",drill,P|B|N,((layerSet,symbol),…)
    const id = num(r[0]);
    const list = r.find((x, i) => i >= 3 && isList(x)) as Node[] | undefined;
    const symbols: [number, number][] = [];
    if (list) for (const p of list) if (isList(p)) symbols.push([num(p[0]), num(p[1])]);
    if (Number.isFinite(id)) job.stacks.set(id, { drill: num(r[2]) || 0, symbols });
  });
  each('LAYER_NAMES', (r) => {
    const id = num(r[0]);
    if (Number.isFinite(id)) job.layerNames.set(id, { name: str(r[1]), side: str(r[2]).toUpperCase(), type: str(r[4]).toUpperCase() });
  });
  each('LAYER_SETS', (r) => {
    const id = num(r[0]);
    const list = r.find((x, i) => i >= 1 && isList(x)) as Node[] | undefined;
    if (Number.isFinite(id) && list) job.layerSets.set(id, list.map(num).filter(Number.isFinite));
  });
  each('LAYERS', (r) => {
    // netId,LAYER (layer (TRACK(…),…))
    const net = num(r[0]);
    for (let i = 1; i + 1 < r.length; i++) {
      if (str(r[i]).toUpperCase() !== 'LAYER' || !isList(r[i + 1])) continue;
      const arg = r[i + 1] as Node[];
      const layer = num(arg[0]);
      fatfGraphics(isList(arg[1]) ? arg[1] : [], (k, a) => {
        const g = graphicOf(k, a);
        if (!g) return;
        if (net > 0) job.copper.push({ net, layer, g });
        else pushTo(job.art, layer, g);
      });
    }
  });
  each('PADS', (r) => {
    // netId,stack,((x,y),…)
    const net = num(r[0]),
      stack = num(r[1]);
    const pts = points(r.filter(isList));
    for (let i = 0; i + 1 < pts.length; i += 2) job.vias.push({ net, stack, x: pts[i], y: pts[i + 1] });
  });
  each('TEST_POINTS', (r) => {
    // id(x,y)side,part,pin
    const xy = r.find(isList);
    if (!xy) return;
    const k = r.indexOf(xy);
    job.tests.push({ x: num(xy[0]), y: num(xy[1]), bottom: str(r[k + 1]).toUpperCase() === 'B', part: num(r[k + 2]), pin: num(r[k + 3]) });
  });
  if (!sections.has('PARTS')) throw new ParseError('fatf.noparts', 'Fabmaster FATF file has no :PARTS section');
  return job;
}

// ─── FARC ─────────────────────────────────────────────────────────────────

const flagsOf = (items: Node[]) => items.find((x): x is Flags => x instanceof Flags);

/** Records: the lists inside the first top-level list of a section (after an optional count). */
function farcRecords(text: string, s: Section | undefined, nth = 0): Node[][] {
  if (!s) return [];
  const tops: Node[][] = [];
  scan(text, s.from, s.to, false, (items) => {
    for (const it of items) if (isList(it)) tops.push(it);
  });
  return (tops[nth] ?? []).filter(isList);
}

function farcGraphics(items: Node[], onShape: (kw: string, args: Node[]) => void) {
  for (const it of items) {
    if (!isList(it) || typeof it[0] !== 'string') continue;
    const kw = it[0].toUpperCase();
    // (TRACK width [flags] ((x y)…)) → TRACK [width, pts…]; (ROUND d) / (BLOCK(x1 y1 x2 y2))
    const rest = it.slice(1).filter((x) => !(x instanceof Flags));
    if (kw === 'TRACK' || kw === 'POLYGON' || kw === 'POLY') onShape(kw, [rest[0] ?? '0', ...(isList(rest[rest.length - 1]) ? (rest[rest.length - 1] as Node[]) : [])]);
    else onShape(kw, rest.length === 1 && isList(rest[0]) ? rest[0] : rest);
  }
}

function readFarc(text: string): Job {
  const sec = farcSections(text);
  const head = sec.get('FABMASTER');
  const ver = head ? /V\d[\w.]*/.exec(text.slice(head.from, head.to))?.[0] : undefined;
  const job = newJob(`FARC${ver ? ' ' + ver : ''}`, 1, { unit: 'mil', toMm: 0.0254, assumed: true, note: 'FARC jobs are written in mils.' });
  const jd = sec.get('JOBDATA');
  if (jd) {
    scan(text, jd.from, jd.to, false, (items) => {
      for (const it of items) if (typeof it === 'string' && it && !job.meta.length && /\D/.test(it)) job.meta.push(['Job', it]);
    });
  }
  // Board outline: FORMAT tracks.
  for (const r of farcRecords(text, sec.get('FORMAT')))
    farcGraphics([r], (k, a) => {
      const g = graphicOf(k, a);
      if (g) job.outline.push(g.pts);
    });

  for (const r of farcRecords(text, sec.get('PARTS'))) {
    // (id "ref" ("device" …) ("package" "package" …) x y rot [flags] …)
    const id = num(r[0]);
    const dev = isList(r[2]) ? str(r[2][0]) : '';
    // ("package" "OUTLINE" …): the second name is the package's 8.3 outline file.
    const pkg = isList(r[3]) ? str(r[3][0]) : '';
    const pkgKey = isList(r[3]) ? str(r[3][1]) : '';
    const fl = r[7] instanceof Flags ? r[7] : undefined;
    if (Number.isFinite(id)) job.parts.push({ id, ref: str(r[1]), device: dev, pkg, pkgKey: pkgKey || undefined, x: num(r[4]), y: num(r[5]), rot: num(r[6]) || 0, bottom: !!fl?.has('BOTTOM') });
  }
  for (const r of farcRecords(text, sec.get('NETS'))) {
    // (id signal "name" n [flags] ((part pin)…))
    const id = num(r[0]);
    const list = r.slice(3).find(isList);
    const members: [number, number][] = [];
    if (list) for (const p of list) if (isList(p)) members.push([num(p[0]), num(p[1])]);
    if (Number.isFinite(id)) job.nets.set(id, { name: str(r[2]), members });
  }
  for (const r of farcRecords(text, sec.get('PACKAGE'))) {
    // ("NAME.OTL" (bbox…) (bbox) ((idx x y "name" [side])…) ((idx stack n ((x y [f])) stack)…) ((idx layer (graphics…))…))
    const name = str(r[0]).replace(/\.OTL$/i, '');
    const lists = r.filter(isList);
    const pkg: Package = { pins: new Map(), art: new Map() };
    job.packages.set(name, pkg);
    const [pinList, padList, artList] = [lists[2], lists[3], lists[4]];
    for (const p of pinList ?? []) {
      if (!isList(p)) continue;
      const fl = flagsOf(p);
      pkg.pins.set(num(p[0]), { name: str(p[3]), x: num(p[1]), y: num(p[2]), side: fl?.has('VIA') ? 'D' : fl?.has('BOTTOM') ? 'B' : 'T', stack: -1, shapes: new Map() });
    }
    for (const p of padList ?? []) {
      if (!isList(p)) continue;
      const pin = pkg.pins.get(num(p[0]));
      if (pin) pin.stack = num(p[1]);
    }
    for (const a of artList ?? []) {
      if (!isList(a)) continue;
      const idx = num(a[0]),
        layer = num(a[1]);
      const body = a.slice(2).find(isList) ?? [];
      if (idx === 0)
        farcGraphics(body, (k, args) => {
          const g = graphicOf(k, args);
          if (g) pushTo(pkg.art, layer, g);
        });
      else {
        const pin = pkg.pins.get(idx);
        if (pin)
          farcGraphics(body, (k, args) => {
            const s = shapeOf(k, args);
            if (s) setShape(pin, layer, s);
          });
      }
    }
  }
  for (const r of farcRecords(text, sec.get('PAD_SYMBOLS'))) {
    const kw = str(r[1]).toUpperCase();
    const s = shapeOf(kw, isList(r[2]) ? r[2] : r.slice(2));
    if (s) job.symbols.set(num(r[0]), s);
  }
  for (const r of farcRecords(text, sec.get('PAD_STACKS'))) {
    const list = r.slice(2).find(isList);
    const symbols: [number, number][] = [];
    if (list) for (const p of list) if (isList(p)) symbols.push([num(p[0]), num(p[1])]);
    job.stacks.set(num(r[0]), { drill: num(r[1]) || 0, symbols });
  }
  for (const r of farcRecords(text, sec.get('LAYER_NAMES'))) job.layerNames.set(num(r[0]), { name: str(r[1]), side: str(r[2]).toUpperCase(), type: str(r[4]).toUpperCase() });
  for (const r of farcRecords(text, sec.get('LAYER_SETS'))) {
    const list = r.slice(1).find(isList);
    if (list) job.layerSets.set(num(r[0]), list.map(num).filter(Number.isFinite));
  }
  for (const r of farcRecords(text, sec.get('LAYERS'))) {
    // (net layer ((TRACK …)(TEXT …)…))
    const net = num(r[0]),
      layer = num(r[1]);
    farcGraphics(r.slice(2).find(isList) ?? [], (k, a) => {
      const g = graphicOf(k, a);
      if (!g) return;
      if (net > 0) job.copper.push({ net, layer, g });
      else pushTo(job.art, layer, g);
    });
  }
  for (const r of farcRecords(text, sec.get('PADS'))) {
    // (net stack n ((x y [f])…) stack)
    const pts = points(r.slice(3).filter(isList));
    for (let i = 0; i + 1 < pts.length; i += 2) job.vias.push({ net: num(r[0]), stack: num(r[1]), x: pts[i], y: pts[i + 1] });
  }
  for (const r of farcRecords(text, sec.get('TEST_POINTS'))) {
    // (id (x y) T|B part pin)
    const xy = r.find(isList);
    if (!xy) continue;
    const k = r.indexOf(xy);
    job.tests.push({ x: num(xy[0]), y: num(xy[1]), bottom: str(r[k + 1]).toUpperCase() === 'B', part: num(r[k + 2]), pin: num(r[k + 3]) });
  }
  // FABXYDATA: (x y net part pin KIND …) — absolute pin positions.
  for (const r of farcRecords(text, sec.get('FABXYDATA'), 1)) {
    const kind = str(r[5]).toUpperCase();
    if (!/^[TBD]PIN$/.test(kind)) continue;
    job.xy.set(`${num(r[3])}:${num(r[4])}`, [num(r[0]), num(r[1])]);
  }
  if (!sec.has('PARTS')) throw new ParseError('farc.noparts', 'Fabmaster FARC job has no PARTS section');
  return job;
}

// ─── Job → BoardModel ─────────────────────────────────────────────────────

/** Package-local point → board: negate Y on the bottom, rotate clockwise, translate. */
export function placePoint(p: Part, lx: number, ly: number): [number, number] {
  const a = (-p.rot / 10) * (Math.PI / 180);
  const c = Math.cos(a),
    s = Math.sin(a);
  const y = p.bottom ? -ly : ly;
  return [p.x + lx * c - y * s, p.y + lx * s + y * c];
}

const SHAPE_KIND: Record<Shape['kind'], PadShape> = { round: SHAPE_CIRCLE, block: SHAPE_RECT, poly: SHAPE_RECT };

function buildModel(job: Job, fileName: string, fileSize: number, formatId: string, formatName: string) {
  const b = new BoardBuilder();
  const k = job.scale;
  b.units = job.units;
  b.metadata.push(...job.meta);

  // Layers: electrical layers, top first, bottom last.
  const elec = [...job.layerNames.entries()].filter(([, l]) => l.type === 'ELECTRICAL' && l.side !== 'COMMON');
  elec.sort((a, c) => (a[1].side === 'TOP' ? -1 : a[1].side === 'BOTTOM' ? 1 : 0) - (c[1].side === 'TOP' ? -1 : c[1].side === 'BOTTOM' ? 1 : 0));
  const layerIndex = new Map<number, number>();
  b.layers = elec.map<LayerInfo>(([id, l], i) => {
    layerIndex.set(id, i);
    return { id: i, name: l.name.replace(/_{2,}/g, ' ').trim(), kind: l.side === 'TOP' ? 'top' : l.side === 'BOTTOM' ? 'bottom' : 'inner' };
  });
  const topLayers = new Set(elec.filter(([, l]) => l.side === 'TOP').map(([id]) => id));
  const botLayers = new Set(elec.filter(([, l]) => l.side === 'BOTTOM').map(([id]) => id));
  const assembly = (side: 'TOP' | 'BOTTOM') => [...job.layerNames.entries()].filter(([, l]) => l.side === side && l.type === 'ASSEMBLY').map(([id]) => id);
  const silk = (side: 'TOP' | 'BOTTOM') => [...job.layerNames.entries()].filter(([, l]) => l.side === side && l.type === 'SILKSCREEN' && !/^REFDES/i.test(l.name)).map(([id]) => id);
  const bodyLayers = [...assembly('TOP'), ...silk('TOP')];

  // Outline: contour/format, else graphics on board-outline layers.
  let outline = job.outline;
  if (!outline.length)
    for (const [id, l] of job.layerNames)
      if (l.type === 'BOARD_CUTOUT' || /BOARD\s*OUTLIN/i.test(l.name)) for (const g of job.art.get(id) ?? []) outline.push(g.pts);
  // FATF repeats the contour as tracks; keep each polyline once.
  outline = outline.filter((p, i) => outline.findIndex((q) => q.length === p.length && q.every((v, j) => v === p[j])) === i);
  for (const pl of outline) {
    const pts = pl.map((v) => v * k);
    b.addOutlinePolyline(pts, pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]);
  }

  const symbolSize = (stackId: number, bottom: boolean): { shape: Shape; drill: number } | null => {
    const st = job.stacks.get(stackId);
    if (!st) return null;
    const want = bottom ? botLayers : topLayers;
    const pick = st.symbols.find(([set]) => (job.layerSets.get(set) ?? [set]).some((l) => want.has(l))) ?? st.symbols[0];
    const shape = pick ? job.symbols.get(pick[1]) : undefined;
    return shape ? { shape, drill: st.drill } : null;
  };

  // Nets and test access by (part id, pin index), known before the pins are added.
  const netOf = new Map<string, string>();
  for (const [, net] of job.nets) for (const [p, i] of net.members) netOf.set(`${p}:${i}`, net.name);
  const probeOf = new Map<string, number>();
  job.tests.forEach((t, i) => probeOf.has(`${t.part}:${t.pin}`) || probeOf.set(`${t.part}:${t.pin}`, i + 1));

  const pinIndex = new Map<string, number>();
  let missingPkg = 0;
  let unplaced = 0;
  for (const part of job.parts) {
    const pkg = (part.pkgKey ? job.packages.get(part.pkgKey) : undefined) ?? job.packages.get(part.pkg) ?? job.packages.get(part.device.split('|')[0]);
    if (!pkg) missingPkg++;
    if (!Number.isFinite(part.x) || !Number.isFinite(part.y)) {
      unplaced++;
      continue;
    }
    const x = part.x * k,
      y = part.y * k;
    const bar = part.device.indexOf('|');
    const attrs: [string, string][] = [];
    let value: string | null = null;
    if (bar >= 0) {
      attrs.push(['Device', part.device.slice(0, bar)]);
      value = part.device.slice(bar + 1) || null;
    } else if (part.device && part.device !== part.pkg) attrs.push(['Device', part.device]);
    else if (part.device) attrs.push(['Part number', part.device]);
    // Body from package artwork on an assembly or silkscreen layer.
    let body: number[] | null = null;
    if (pkg) {
      const layer = bodyLayers.find((l) => pkg.art.get(l)?.length);
      if (layer !== undefined) {
        body = [];
        for (const g of pkg.art.get(layer)!) {
          for (let i = 0; i + 3 < g.pts.length; i += 2) {
            if (g.pts[i] === g.pts[i + 2] && g.pts[i + 1] === g.pts[i + 3]) continue;
            const [ax, ay] = placePoint(part, g.pts[i], g.pts[i + 1]);
            const [bx, by] = placePoint(part, g.pts[i + 2], g.pts[i + 3]);
            body.push(ax * k, ay * k, bx * k, by * k);
          }
        }
      }
    }
    const pi = b.addPart({
      name: part.ref,
      side: part.bottom ? SIDE_BOTTOM : SIDE_TOP,
      mount: MOUNT_SMD,
      x,
      y,
      rot: (((-part.rot / 10) % 360) + 360) % 360,
      footprint: part.pkg || null,
      value,
      attrs: attrs.length ? attrs : null,
      body: body && body.length ? body : null,
    });
    if (!pkg) continue;
    let th = false;
    for (const [idx, pin] of [...pkg.pins.entries()].sort((a, c) => a[0] - c[0])) {
      const [px, py] = placePoint(part, pin.x, pin.y);
      const pinBottom = pin.side === 'B' ? !part.bottom : part.bottom;
      // Copper shape: the pin's own pad on a top copper layer (package-local), else its pad stack.
      let shape: Shape | undefined;
      for (const [l, s] of pin.shapes) if (topLayers.has(l)) shape = s;
      if (!shape) for (const [l, s] of pin.shapes) if (job.layerNames.get(l)?.type === 'ELECTRICAL') shape = s;
      const fromStack = pin.stack >= 0 ? symbolSize(pin.stack, false) : null;
      shape ??= fromStack?.shape;
      const drill = fromStack?.drill ?? 0;
      const through = pin.side === 'D' || drill > 0;
      if (through) th = true;
      let w = 0,
        h = 0;
      if (shape?.kind === 'round') w = h = shape.v[0];
      else if (shape) {
        w = Math.abs(shape.v[2] - shape.v[0]);
        h = Math.abs(shape.v[3] - shape.v[1]);
      }
      // Rotation of the pad: the part's rotation (a rectangle mirrors onto itself).
      const key = `${part.id}:${idx}`;
      const idxPin = b.addPin({
        part: pi,
        x: px * k,
        y: py * k,
        net: netOf.get(key),
        probe: probeOf.get(key),
        number: pin.name || String(idx),
        side: through ? SIDE_BOTH : pinBottom ? SIDE_BOTTOM : SIDE_TOP,
        ...(shape ? { shape: SHAPE_KIND[shape.kind], w: w * k, h: h * k, rot: b.partInput(pi).rot } : {}),
        hole: drill > 0 ? drill * k : undefined,
      });
      pinIndex.set(key, idxPin);
    }
    if (th) b.partInput(pi).mount = MOUNT_TH;
  }

  let dangling = 0;
  for (const key of netOf.keys()) if (!pinIndex.has(key)) dangling++;
  // Test points that hit no known pin become probes of their own.
  job.tests.forEach((t, i) => {
    if (pinIndex.has(`${t.part}:${t.pin}`) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return;
    b.addPin({ part: -1, x: t.x * k, y: t.y * k, kind: PINKIND_TESTPOINT, side: t.bottom ? SIDE_BOTTOM : SIDE_TOP, number: String(i + 1), probe: i + 1 });
  });

  // Vias (board-level pads) and copper tracks.
  const netName = (id: number) => job.nets.get(id)?.name ?? null;
  for (const v of job.vias) {
    const st = symbolSize(v.stack, false);
    const d = st ? (st.shape.kind === 'round' ? st.shape.v[0] : Math.max(Math.abs(st.shape.v[2] - st.shape.v[0]), Math.abs(st.shape.v[3] - st.shape.v[1]))) : 0;
    b.addVia(v.x * k, v.y * k, d * k, netName(v.net));
  }
  for (const c of job.copper) {
    const L = layerIndex.get(c.layer);
    if (L === undefined || c.g.kind !== 'track') continue;
    const p = c.g.pts;
    const net = netName(c.net);
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (p[i] === p[i + 2] && p[i + 1] === p[i + 3]) continue;
      b.addTrace(p[i] * k, p[i + 1] * k, p[i + 2] * k, p[i + 3] * k, c.g.width * k, L, net);
    }
  }

  if (missingPkg) b.warn('fab.nopackage', `${missingPkg} part(s) reference a package that is not defined; shown without pins`);
  if (unplaced) b.warn('fab.unplaced', `${unplaced} part(s) have no placement and were skipped`);
  if (dangling) b.warn('fab.netpin', `${dangling} net member(s) reference a pin that does not exist`);
  if (!outline.length) b.info('fab.nooutline', 'The job has no board contour; the outline is derived from the parts');
  return b.finish({ fileName, fileSize, formatId, formatName, variant: job.variant, extraFiles: [] });
}

export const fabmasterFormat: FormatModule = {
  id: 'fabmaster',
  name: 'Fabmaster FATF / FARC',
  extensions: ['fatf', 'fat', 'far', 'faz', 'cad', 'fil'],
  status: 'verified',
  summary: 'Fabmaster jobs: FATF text and FARC (.far, inside .faz) — parts, pins, nets, pads, copper, test points',
  detect(s) {
    const h = s.headText.slice(0, 4096);
    if (/^[ \t]*:FABMASTER FATF REV/m.test(h)) return { confidence: 0.97, variant: 'FATF', reason: '":FABMASTER FATF REV" header' };
    if (/^:SECTION FABMASTER\b/m.test(h)) return { confidence: 0.97, variant: 'FARC', reason: '":SECTION FABMASTER" header (FARC job)' };
    return null;
  },
  parse(ctx) {
    const text = decodeText(ctx.file.bytes).text;
    ctx.progress('Reading job');
    const job = /^:SECTION FABMASTER\b/m.test(text.slice(0, 4096)) ? readFarc(text) : readFatf(text);
    ctx.progress('Building board');
    return buildModel(job, ctx.file.name, ctx.file.bytes.length, this.id, this.name);
  },
};

/** Internals for tests and corpus checks. */
export const _fab = { readFatf, readFarc };
