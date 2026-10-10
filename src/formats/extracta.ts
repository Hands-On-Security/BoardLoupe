/**
 * Allegro Extracta text ("A!/J!/S!" rows, e.g. fabmaster.txt exports).
 *
 *   A!COL1!COL2!…!    column header for the S rows that follow
 *   S!v1!v2!…!        a data row
 *   J!…!              job information: design, date, units (MILS, MILLIMETERS, MICRONS, INCHES)
 *
 * Fields are split on "!" outside double quotes. Columns are matched by name
 * (case-insensitive, "_" ignored), never by position, and tables are told
 * apart by the columns they carry:
 *
 *   REFDES + SYM_X/SYM_Y           components (rotation, mirror = bottom side, part number, value)
 *   REFDES + PIN_NUMBER + PIN_X/Y  pins with NET_NAME and TEST_POINT
 *   GRAPHIC_DATA_NAME              graphics: LINE / ARC / RECTANGLE on CLASS/SUBCLASS
 *                                  (board outline, etch with NET_NAME, part bodies)
 *   VIA_X/VIA_Y                    vias with NET_NAME
 *
 * No real file is available in this corpus; the reader follows the
 * documented column names and skips what it does not recognise.
 */
import { ParseError } from '../io/bytes';
import { decodeText, splitLines, toNum } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { type LayerInfo, MOUNT_SMD, SIDE_BOTTOM, SIDE_TOP, type UnitInfo } from '../model/types';
import type { FormatModule } from './types';

/** Splits a row on "!" outside double quotes. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = '',
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === '!' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const norm = (s: string) => s.toUpperCase().replace(/_/g, '').trim();

function unitsOf(text: string): UnitInfo | null {
  const t = text.toUpperCase();
  if (/\bMILS?\b/.test(t)) return { unit: 'mil', toMm: 0.0254, assumed: false };
  if (/\bMILLIMETERS?\b|\bMM\b/.test(t)) return { unit: 'mm', toMm: 1, assumed: false };
  if (/\bMICRONS?\b|\bUM\b/.test(t)) return { unit: 'um', toMm: 0.001, assumed: false };
  if (/\bINCH(ES)?\b/.test(t)) return { unit: 'inch', toMm: 25.4, assumed: false };
  return null;
}

type Row = Map<string, string>;

export const extractaFormat: FormatModule = {
  id: 'extracta',
  name: 'Allegro Extracta (A!/S! rows)',
  extensions: ['txt', 'cad', 'fil', 'fab'],
  status: 'experimental',
  summary: 'Allegro extract text: A! column rows, S! data rows (components, pins, nets, graphics)',
  detect(s) {
    const h = s.headText.slice(0, 65536);
    if (/^A!/m.test(h) && /^S!/m.test(h) && /\bREFDES\b|\bNET_NAME\b|\bGRAPHIC_DATA_NAME\b/.test(h)) return { confidence: 0.9, reason: 'Extracta rows (A! columns, S! data)' };
    return null;
  },
  parse(ctx) {
    const lines = splitLines(decodeText(ctx.file.bytes).text);
    let cols: string[] = [];
    let units: UnitInfo | null = null;
    const tables: { cols: Set<string>; rows: Row[] }[] = [];
    let cur: { cols: Set<string>; rows: Row[] } | null = null;
    for (const line of lines) {
      if (line.startsWith('A!')) {
        cols = fields(line).slice(1).map(norm);
        cur = { cols: new Set(cols), rows: [] };
        tables.push(cur);
      } else if (line.startsWith('J!')) units ??= unitsOf(line);
      else if (line.startsWith('S!') && cur) {
        const f = fields(line).slice(1);
        const row: Row = new Map();
        cols.forEach((c, i) => c && row.set(c, (f[i] ?? '').trim()));
        cur.rows.push(row);
      }
    }
    if (!tables.length) throw new ParseError('extracta.empty', 'No A! column rows found');
    const has = (t: { cols: Set<string> }, ...c: string[]) => c.every((x) => t.cols.has(x));
    const n = (r: Row, c: string) => toNum(r.get(c) ?? '');
    const b = new BoardBuilder();
    b.units = units ?? { unit: 'mil', toMm: 0.0254, assumed: true, note: 'No units in the J! rows; assumed mils.' };

    // Components.
    const parts = new Map<string, number>();
    for (const t of tables) {
      if (!has(t, 'REFDES', 'SYMX', 'SYMY')) continue;
      for (const r of t.rows) {
        const ref = r.get('REFDES') ?? '';
        if (!ref || parts.has(ref)) continue;
        const attrs: [string, string][] = [];
        for (const [k, label] of [
          ['COMPPARTNUMBER', 'Part number'],
          ['COMPDEVICETYPE', 'Device'],
          ['COMPCLASS', 'Class'],
        ] as const) {
          const v = r.get(k);
          if (v) attrs.push([label, v]);
        }
        const rot = n(r, 'SYMROTATE');
        parts.set(
          ref,
          b.addPart({
            name: ref,
            side: /^Y/i.test(r.get('SYMMIRROR') ?? '') ? SIDE_BOTTOM : SIDE_TOP,
            mount: MOUNT_SMD,
            x: n(r, 'SYMX'),
            y: n(r, 'SYMY'),
            rot: Number.isFinite(rot) ? rot : undefined,
            footprint: r.get('SYMNAME') || null,
            value: r.get('COMPVALUE') || null,
            attrs: attrs.length ? attrs : null,
          }),
        );
      }
    }
    // Standard exports keep connectivity in EXTRACT_NETS, separate from the
    // position rows in EXTRACT_PINS. Some exports combine them instead.
    const pinNets = new Map<string, { net: string; name: string }>();
    for (const t of tables) {
      if (!has(t, 'REFDES', 'PINNUMBER', 'NETNAME')) continue;
      for (const r of t.rows) {
        const ref = r.get('REFDES') ?? '', number = r.get('PINNUMBER') ?? '';
        if (ref) pinNets.set(`${ref}\u0000${number}`, { net: r.get('NETNAME') ?? '', name: r.get('PINNAME') ?? '' });
      }
    }
    // Pins (with nets and test access).
    let probes = 0;
    const seenPin = new Set<string>();
    for (const t of tables) {
      if (!has(t, 'REFDES', 'PINNUMBER', 'PINX', 'PINY')) continue;
      for (const r of t.rows) {
        const ref = r.get('REFDES') ?? '',
          no = r.get('PINNUMBER') ?? '';
        const key = `${ref}\u0000${no}`;
        const x = n(r, 'PINX'),
          y = n(r, 'PINY');
        if (!ref || seenPin.has(key) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        seenPin.add(key);
        let pi = parts.get(ref);
        if (pi === undefined) {
          pi = b.addPart({ name: ref, side: SIDE_TOP, mount: MOUNT_SMD });
          parts.set(ref, pi);
        }
        const tp = r.get('TESTPOINT') ?? '';
        const probe = /^(T|B|TOP|BOTTOM|YES|Y)$/i.test(tp) ? ++probes : undefined;
        const conn = pinNets.get(key);
        b.addPin({ part: pi, x, y, number: no, name: r.get('PINNAME') || conn?.name || undefined, net: r.get('NETNAME') || conn?.net || null, probe });
      }
    }
    // Graphics: outline and etch.
    const layers = new Map<string, number>();
    const layerOf = (sub: string) => {
      let i = layers.get(sub);
      if (i === undefined) {
        i = layers.size;
        layers.set(sub, i);
      }
      return i;
    };
    let outline = 0;
    const bodies = new Map<number, Map<string, number[]>>();
    for (const t of tables) {
      if (!has(t, 'GRAPHICDATANAME')) continue;
      for (const r of t.rows) {
        const kind = (r.get('GRAPHICDATANAME') ?? '').toUpperCase();
        const cls = (r.get('CLASS') ?? '').toUpperCase();
        const sub = (r.get('SUBCLASS') ?? '').toUpperCase();
        const g = (i: number) => n(r, `GRAPHICDATA${i}`);
        const isOutline = /BOARD GEOMETRY/.test(cls) ? /OUTLINE/.test(sub) : sub === 'OUTLINE' || sub === 'DESIGN_OUTLINE';
        const isEtch = cls === 'ETCH';
        const bodyPart = parts.get(r.get('REFDES') ?? '');
        const isBody = bodyPart !== undefined && /^(?:SILKSCREEN|ASSEMBLY|PLACE_BOUND)_(?:TOP|BOTTOM)$/.test(sub);
        if (!isOutline && !isEtch && !isBody) continue;
        const segs: number[] = [];
        let width = 0;
        if (kind === 'LINE') {
          segs.push(g(1), g(2), g(3), g(4));
          width = g(5);
        } else if (kind === 'ARC') {
          const [x1, y1, x2, y2, cx, cy] = [g(1), g(2), g(3), g(4), g(5), g(6)];
          width = g(8);
          const cw = /^CLOCK/i.test(r.get('GRAPHICDATA9') ?? '');
          const rr = Math.hypot(x1 - cx, y1 - cy);
          let a0 = Math.atan2(y1 - cy, x1 - cx);
          let sweep = Math.atan2(y2 - cy, x2 - cx) - a0;
          if (cw) {
            if (sweep >= 0) sweep -= 2 * Math.PI;
          } else if (sweep <= 0) sweep += 2 * Math.PI;
          const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
          let px = x1,
            py = y1;
          for (let k = 1; k <= steps; k++) {
            a0 += sweep / steps;
            const qx = k === steps ? x2 : cx + rr * Math.cos(a0),
              qy = k === steps ? y2 : cy + rr * Math.sin(a0);
            segs.push(px, py, qx, qy);
            px = qx;
            py = qy;
          }
        } else if (kind === 'RECTANGLE') {
          const [x1, y1, x2, y2] = [g(1), g(2), g(3), g(4)];
          segs.push(x1, y1, x2, y1, x2, y1, x2, y2, x2, y2, x1, y2, x1, y2, x1, y1);
        } else continue;
        for (let k = 0; k + 3 < segs.length; k += 4) {
          if (!segs.slice(k, k + 4).every(Number.isFinite)) continue;
          if (isOutline) {
            b.addOutlineSeg(segs[k], segs[k + 1], segs[k + 2], segs[k + 3]);
            outline++;
          } else if (isEtch) b.addTrace(segs[k], segs[k + 1], segs[k + 2], segs[k + 3], Number.isFinite(width) ? width : 0, layerOf(sub), r.get('NETNAME') || null);
          else if (isBody) {
            let byLayer = bodies.get(bodyPart!);
            if (!byLayer) bodies.set(bodyPart!, (byLayer = new Map()));
            const body = byLayer.get(sub) ?? [];
            body.push(...segs.slice(k, k + 4));
            byLayer.set(sub, body);
          }
        }
      }
    }
    for (const [part, byLayer] of bodies) {
      const side = b.partInput(part).side === SIDE_BOTTOM ? 'BOTTOM' : 'TOP';
      const body = byLayer.get(`SILKSCREEN_${side}`) ?? byLayer.get(`ASSEMBLY_${side}`) ?? byLayer.get(`PLACE_BOUND_${side}`);
      if (body?.length) b.partInput(part).body = body;
    }
    // Vias.
    for (const t of tables) {
      if (!has(t, 'VIAX', 'VIAY')) continue;
      for (const r of t.rows) {
        const x = n(r, 'VIAX'),
          y = n(r, 'VIAY');
        if (Number.isFinite(x) && Number.isFinite(y)) b.addVia(x, y, 0, r.get('NETNAME') || null);
      }
    }
    if (!b.partCount) throw new ParseError('extracta.noparts', 'The extract has no component or pin rows (REFDES with SYM_X/SYM_Y or PIN_X/PIN_Y)');
    const names = [...layers.keys()];
    b.layers = names.map<LayerInfo>((name, i) => ({ id: i, name, kind: /TOP/.test(name) ? 'top' : /BOT/.test(name) ? 'bottom' : 'inner' }));
    if (!outline) b.info('extracta.nooutline', 'No board outline graphics (BOARD GEOMETRY / OUTLINE); the outline is derived from the parts');
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: null, extraFiles: [] });
  },
};
