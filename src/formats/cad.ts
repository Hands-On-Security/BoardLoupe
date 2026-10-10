/**
 * Mentor Graphics Neutral File (and the "###Panel Added" CAD exports derived
 * from it): whitespace-separated text records, quoted strings, continuation
 * lines ending in " - ".
 *
 *   B_UNITS Inches|Mils|Mm
 *   B_ATTR 'BOARD_ROUTING_OUTLINE' '' x y x y …        board outline (also PLACEMENT / OUTLINE)
 *   COMP <ref> <partno> <device> <geom> <x> <y> <side 1=top 2=bottom> <rot>
 *   C_PROP (INSTPAR,"value") (DESC,"…")                  properties of the preceding COMP
 *   C_PIN <ref-pin> <x> <y> <layer> <side> <rot> <padstack> <net>
 *   NET <name> / N_PIN / N_VIA <x> <y> <padstack> … / N_TEST PIN|VIA <x> <y> TOP|BOT <padstack> [ref-pin]
 *   GEOM <name> / G_PIN <pin> <x> <y> <padstack> … / G_ATTR 'COMPONENT_BODY_OUTLINE' '' x y …
 *   PAD PIN|VIA <padstack> Surf|Thru|Bur <drill> / P_SHAPE <padstack> <layer> CIRCLE d | RECTANGLE w h [CENTER dx dy]
 *   HOLE PTH|NPTH <x> <y> <d>
 *
 * COMP/C_PIN/NET/N_VIA field use follows OpenBoardView CADFile.cpp (MIT), so
 * files the reference reads give the same parts, pins and nets. Beyond the
 * reference: units, board outline, footprint bodies (GEOM outlines placed by
 * rotating counter-clockwise, then mirroring X on the bottom side — this maps
 * every G_PIN onto its C_PIN in real files), pad shapes, drills, real vias,
 * test access and values.
 */
import { ParseError } from '../io/bytes';
import { decodeText, splitLines, toNum } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, MOUNT_TH, type PadShape, PINKIND_TESTPOINT, SHAPE_CIRCLE, SHAPE_OBLONG, SHAPE_RECT, SHAPE_ROUNDRECT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type UnitInfo } from '../model/types';
import { INCH } from './common';
import type { FormatModule } from './types';

const stripSlash = (n: string) => (n.includes('/') ? n.slice(1) : n);

/** Splits a record into tokens, keeping '…' and "…" strings whole (quotes removed). */
function tokens(line: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Joins continuation lines (ending in " -") into whole records. */
function records(text: string): { line: string; ln: number }[] {
  const out: { line: string; ln: number }[] = [];
  let acc = '',
    start = 0;
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trimEnd();
    if (!acc) start = i + 1;
    if (/\s-$/.test(l) || l === '-') {
      acc += l.slice(0, -1) + ' ';
      continue;
    }
    acc += l;
    const t = acc.trim();
    if (t) out.push({ line: t, ln: start });
    acc = '';
  }
  if (acc.trim()) out.push({ line: acc.trim(), ln: start });
  return out;
}

interface PadShapeDef {
  layer: string;
  kind: string;
  w: number;
  h: number;
}
interface Padstack {
  type: string; // Surf | Thru | Bur
  drill: number;
  shapes: PadShapeDef[];
}

const SHAPES: Record<string, PadShape> = { CIRCLE: SHAPE_CIRCLE, ROUND: SHAPE_CIRCLE, OCTAGON: SHAPE_CIRCLE, RECTANGLE: SHAPE_RECT, SQUARE: SHAPE_RECT, OBLONG: SHAPE_OBLONG, OVAL: SHAPE_OBLONG, ROUNDED_RECTANGLE: SHAPE_ROUNDRECT };
const OUTLINE_PREFERENCE = ['BOARD_OUTLINE', 'BOARD_ROUTING_OUTLINE', 'BOARD_PLACEMENT_OUTLINE'];
const BODY_PREFERENCE = ['COMPONENT_BODY_OUTLINE', 'COMPONENT_PLACEMENT_OUTLINE'];

function unitsOf(tok: string | undefined): UnitInfo {
  switch ((tok ?? '').toLowerCase()) {
    case 'mils':
    case 'mil':
      return { unit: 'mil', toMm: 0.0254, assumed: false };
    case 'mm':
    case 'millimeters':
      return { unit: 'mm', toMm: 1, assumed: false };
    case 'inches':
    case 'inch':
      return { unit: 'inch', toMm: 25.4, assumed: false };
    default:
      return INCH;
  }
}

const numsFrom = (t: string[], from: number) => {
  const out: number[] = [];
  for (let i = from; i + 1 < t.length; i += 2) {
    const x = toNum(t[i]),
      y = toNum(t[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    out.push(x, y);
  }
  return out;
};

export const cadPanelFormat: FormatModule = {
  id: 'cad-panel',
  name: 'Mentor Neutral File / CAD panel',
  extensions: ['cad', 'neu', 'fil'],
  status: 'verified',
  summary: 'Mentor Graphics neutral file and "###Panel Added" CAD exports (COMP / C_PIN / NET records)',
  detect(s) {
    const h = s.headText;
    if (h.includes('###Panel Added') && /\b(C_PIN|COMP|B_UNITS)\b/.test(h)) return { confidence: 0.93, reason: '"###Panel Added" header with Mentor neutral records' };
    if (/^\s*B_UNITS\s+(Inches|Mils|Mm)\b/m.test(h) && /^\s*(COMP|BOARD|B_ATTR)\s/m.test(h)) return { confidence: 0.9, reason: 'Mentor neutral file (B_UNITS record)' };
    return null;
  },
  parse(ctx) {
    const recs = records(decodeText(ctx.file.bytes).text);
    const b = new BoardBuilder();
    b.units = INCH;

    // Pass 1: units, padstacks, footprint geometries, board outline.
    const pads = new Map<string, Padstack>();
    const geoms = new Map<string, { outlines: Map<string, number[][]> }>();
    const outlines = new Map<string, number[][]>();
    let curGeom: string | null = null;
    for (const { line } of recs) {
      const t = tokens(line);
      switch (t[0]) {
        case 'B_UNITS':
          b.units = unitsOf(t[1]);
          break;
        case 'B_ATTR': {
          const name = t[1] ?? '';
          if (/OUTLINE$/.test(name) && name.startsWith('BOARD')) {
            const pts = numsFrom(t, 3);
            if (pts.length >= 4) (outlines.get(name) ?? outlines.set(name, []).get(name)!).push(pts);
          }
          break;
        }
        case 'PAD': {
          const ps = pads.get(t[2]) ?? { type: '', drill: 0, shapes: [] };
          ps.type = t[3] ?? '';
          ps.drill = toNum(t[4]) || 0;
          pads.set(t[2], ps);
          break;
        }
        case 'P_SHAPE': {
          const ps = pads.get(t[1]) ?? { type: '', drill: 0, shapes: [] };
          const kind = (t[3] ?? '').toUpperCase();
          const w = toNum(t[4]);
          const h = kind === 'CIRCLE' || kind === 'ROUND' || kind === 'OCTAGON' || kind === 'SQUARE' ? w : toNum(t[5]);
          if (Number.isFinite(w) && w > 0) ps.shapes.push({ layer: t[2] ?? '', kind, w, h: Number.isFinite(h) && h > 0 ? h : w });
          pads.set(t[1], ps);
          break;
        }
        case 'GEOM':
          curGeom = t[1] ?? null;
          if (curGeom) geoms.set(curGeom, { outlines: new Map() });
          break;
        case 'G_ATTR':
          if (curGeom && BODY_PREFERENCE.includes(t[1] ?? '')) {
            const pts = numsFrom(t, 3);
            const g = geoms.get(curGeom)!.outlines;
            if (pts.length >= 4) (g.get(t[1]) ?? g.set(t[1], []).get(t[1])!).push(pts);
          }
          break;
        default:
          // A geometry block is GEOM followed by its G_… records; anything else ends it.
          if (!/^G_/.test(t[0] ?? '')) curGeom = null;
      }
    }
    const outlineName = OUTLINE_PREFERENCE.find((n) => outlines.has(n));
    if (outlineName) for (const pl of outlines.get(outlineName)!) b.addOutlinePolyline(pl, pl[0] === pl[pl.length - 2] && pl[1] === pl[pl.length - 1]);

    // Pass 2: components, pins, nets, vias, test access, holes (reference field use).
    const partByName = new Map<string, number>();
    const pinByRef = new Map<string, number>();
    let lastPart = -1;
    let netName = '';
    let seen = 0,
      missing = 0,
      testAccess = 0;
    const pinSeq = new Map<number, number>();
    const padFor = (name: string | undefined, bottom: boolean) => {
      const ps = name ? pads.get(name) : undefined;
      if (!ps || !ps.shapes.length) return null;
      const s = bottom ? (ps.shapes.find((x) => /BOT/i.test(x.layer)) ?? ps.shapes[ps.shapes.length - 1]) : (ps.shapes.find((x) => !/BOT/i.test(x.layer)) ?? ps.shapes[0]);
      return { shape: SHAPES[s.kind] ?? SHAPE_RECT, w: s.w, h: s.h, drill: ps.type === 'Thru' ? ps.drill : 0, thru: ps.type === 'Thru' };
    };
    // Test access on component pins (N_TEST PIN … ref-pin); the NET section may precede the components.
    const testRefs = new Map<string, number>();
    for (const { line } of recs) {
      if (!line.startsWith('N_TEST')) continue;
      const t = tokens(line);
      testAccess++;
      if (t[1] === 'PIN' && t[6] && !testRefs.has(t[6])) testRefs.set(t[6], testAccess);
    }
    for (const { line, ln } of recs) {
      const t = tokens(line);
      const kw = t[0];
      if (kw === 'COMP') {
        seen++;
        const name = t[1] ?? '';
        const x = toNum(t[5]),
          y = toNum(t[6]);
        const bottom = t[7] !== '1';
        const rot = toNum(t[8]);
        const attrs: [string, string][] = [];
        if (t[2] && t[2] !== '?') attrs.push(['Part number', t[2]]);
        if (t[3] && t[3] !== '?') attrs.push(['Device', t[3]]);
        // Footprint body from the geometry outline, placed like the pins.
        let body: number[] | null = null;
        const g = t[4] ? geoms.get(t[4]) : undefined;
        if (g && Number.isFinite(x) && Number.isFinite(y)) {
          const pls = BODY_PREFERENCE.map((n) => g.outlines.get(n)).find(Boolean);
          if (pls) {
            const a = ((Number.isFinite(rot) ? rot : 0) * Math.PI) / 180;
            const c = Math.cos(a),
              s = Math.sin(a);
            const place = (lx: number, ly: number): [number, number] => {
              const rx = lx * c - ly * s,
                ry = lx * s + ly * c;
              return [x + (bottom ? -rx : rx), y + ry];
            };
            body = [];
            for (const pl of pls) {
              let [px, py] = place(pl[0], pl[1]);
              for (let i = 2; i + 1 < pl.length; i += 2) {
                const [qx, qy] = place(pl[i], pl[i + 1]);
                body.push(px, py, qx, qy);
                px = qx;
                py = qy;
              }
            }
          }
        }
        lastPart = b.addPart({
          name,
          side: bottom ? SIDE_BOTTOM : SIDE_TOP,
          mount: MOUNT_SMD,
          x: Number.isFinite(x) ? x : undefined,
          y: Number.isFinite(y) ? y : undefined,
          rot: Number.isFinite(rot) ? rot : undefined,
          footprint: t[4] || null,
          attrs: attrs.length ? attrs : null,
          body: body && body.length ? body : null,
        });
        partByName.set(name, lastPart);
      } else if (kw === 'C_PROP' && lastPart >= 0) {
        const props = new Map<string, string>();
        for (const m of line.matchAll(/\(([A-Z_]+),"([^"]*)"/g)) props.set(m[1], m[2]);
        const p = b.partInput(lastPart);
        const value = props.get('INSTPAR') || props.get('VALUE');
        if (value) p.value = value;
        const desc = props.get('DESC');
        if (desc) p.attrs = [...(p.attrs ?? []), ['Description', desc]];
      } else if (kw === 'C_PIN') {
        seen++;
        const ref = t[1] ?? '';
        const dash = ref.indexOf('-');
        let pname = dash >= 0 ? ref.slice(0, dash) : ref;
        let pinNo = dash >= 0 ? ref.slice(dash + 1) : '';
        // References containing "-": match the longest known component prefix.
        if (!partByName.has(pname)) {
          for (let d = ref.lastIndexOf('-'); d > 0; d = ref.lastIndexOf('-', d - 1))
            if (partByName.has(ref.slice(0, d))) {
              pname = ref.slice(0, d);
              pinNo = ref.slice(d + 1);
              break;
            }
        }
        const x = toNum(t[2]),
          y = toNum(t[3]);
        const net = stripSlash(t[8] ?? '');
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          b.warn('cad.pin', 'Malformed C_PIN line skipped', { line: ln });
          continue;
        }
        const p = partByName.get(pname);
        if (p === undefined) missing++;
        const k = (pinSeq.get(p ?? -1) ?? 0) + 1;
        pinSeq.set(p ?? -1, k);
        const bottomPin = t[5] === '2' || (p !== undefined && b.partInput(p).side === SIDE_BOTTOM);
        const pad = padFor(t[7], bottomPin);
        if (pad?.thru && p !== undefined) b.partInput(p).mount = MOUNT_TH;
        const idx = b.addPin({
          part: p ?? -1,
          x,
          y,
          net,
          number: pinNo || String(k),
          ...(pad ? { shape: pad.shape, w: pad.w, h: pad.h, hole: pad.drill || undefined, side: pad.thru ? SIDE_BOTH : undefined } : {}),
          rot: Number.isFinite(toNum(t[6])) ? toNum(t[6]) : undefined,
          probe: testRefs.get(ref),
        });
        pinByRef.set(ref, idx);
      }
    }
    testAccess = 0;
    for (const { line, ln } of recs) {
      const t = tokens(line);
      const kw = t[0];
      if (kw === 'NET') {
        seen++;
        netName = stripSlash(t[1] ?? '');
      } else if (kw === 'N_VIA') {
        seen++;
        const x = toNum(t[1]),
          y = toNum(t[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          b.warn('cad.via', 'Malformed N_VIA line skipped', { line: ln });
          continue;
        }
        const pad = padFor(t[3], false);
        b.addVia(x, y, pad ? Math.max(pad.w, pad.h) : 0, netName);
      } else if (kw === 'N_TEST') {
        // Test access: on a component pin (PIN … ref-pin) or on a via/pad of the net.
        const x = toNum(t[2]),
          y = toNum(t[3]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        testAccess++;
        const onPin = t[1] === 'PIN' && t[6] ? pinByRef.get(t[6]) : undefined;
        if (onPin === undefined) {
          const pad = padFor(t[5], t[4] === 'BOT');
          b.addPin({ part: -1, x, y, net: netName, kind: PINKIND_TESTPOINT, side: t[4] === 'BOT' ? SIDE_BOTTOM : SIDE_TOP, number: String(testAccess), probe: testAccess, ...(pad ? { shape: pad.shape, w: pad.w, h: pad.h } : {}) });
        }
      } else if (kw === 'HOLE' && t[1] === 'NPTH') {
        // Unplated mounting holes (plated ones coincide with through-hole pads and vias).
        const x = toNum(t[2]),
          y = toNum(t[3]),
          d = toNum(t[4]);
        if (Number.isFinite(x) && Number.isFinite(y)) b.addVia(x, y, Number.isFinite(d) ? d : 0, null);
      }
    }
    if (!seen) throw new ParseError('cad.empty', 'No COMP/C_PIN records found');
    if (missing) b.warn('cad.unknownpart', `${missing} C_PIN record(s) reference an undefined COMP; shown as unowned`);
    if (!outlineName) b.info('cad.nooutline', 'No board outline attribute (BOARD_OUTLINE / BOARD_ROUTING_OUTLINE / BOARD_PLACEMENT_OUTLINE) in the file');
    const variant = recs.some((r) => r.line.startsWith('B_UNITS')) ? 'Mentor neutral file' : 'CAD panel export';
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant, extraFiles: [] });
  },
};
