/**
 * BV boardview database: a Microsoft Access (Jet) file with the tables
 *
 *   Pin(Part, TB, Pin, Name, X, Y, Layer, Net)          one row per pin; TB "(T)"/"(B)",
 *                                                         Layer 1 top, 2 bottom, 0 through-hole
 *   Nail(Nail, X, Y, Type, Grid, TB, NET, NetName, …)    test probes
 *   Layout(X, Y, R, Group)                               board outline, one polyline per group
 *
 * Coordinates are inches. Read with the built-in Jet reader (src/io/mdb.ts);
 * no ODBC/COM. Row order is kept.
 */
import { ParseError } from '../io/bytes';
import { type Cell, MdbReader } from '../io/mdb';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, MOUNT_TH, PINKIND_TESTPOINT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP } from '../model/types';
import type { FormatModule } from './types';

const txt = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c)).trim();
const num = (c: Cell | undefined) => (typeof c === 'number' ? c : typeof c === 'string' && c.trim() !== '' ? Number(c) : NaN);
/** float32 columns: drop the binary noise (4.939000129699707 → 4.939). */
const clean = (v: number) => Math.round(v * 1e6) / 1e6;
const bottomTB = (c: Cell | undefined) => /B/i.test(txt(c));

/** Case- and underscore-insensitive column lookup. */
function col(row: Record<string, Cell>, ...names: string[]): Cell | undefined {
  for (const n of names) if (n in row) return row[n];
  const keys = Object.keys(row);
  for (const n of names) {
    const want = n.toLowerCase().replace(/_/g, '');
    const k = keys.find((x) => x.toLowerCase().replace(/_/g, '') === want);
    if (k) return row[k];
  }
  return undefined;
}

export const bvFormat: FormatModule = {
  id: 'bv',
  name: 'BV database (Access)',
  extensions: ['bv', 'mdb'],
  status: 'verified',
  summary: 'BV boardview stored as a Microsoft Access (Jet) database: Pin, Nail and Layout tables',
  detect(s) {
    const h = s.headText;
    if (/^.{4}Standard (Jet|ACE) DB/s.test(h.slice(0, 32))) return { confidence: s.ext === 'bv' ? 0.95 : 0.85, reason: '"Standard Jet DB" (Microsoft Access) header' };
    return null;
  },
  parse(ctx) {
    ctx.progress('Reading database');
    const db = new MdbReader(ctx.file.bytes);
    const tables = db.tables();
    const find = (name: string) => [...tables].find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
    const pinTable = find('Pin');
    if (pinTable === undefined) {
      const names = [...tables.keys()];
      throw new ParseError('bv.notboard', `This Access database has no "Pin" table, so it is not a BV boardview${names.length ? ` (tables: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''})` : ''}.`);
    }
    const b = new BoardBuilder();
    b.units = { unit: 'inch', toMm: 25.4, assumed: true, note: 'BV coordinates are inches by convention; the database does not state units.' };
    b.metadata.push(['Database', db.jet4 ? 'Jet 4 (Access 2000+)' : 'Jet 3 (Access 97)'], ['Tables', [...tables.keys()].join(', ')]);

    // Pins, grouped into parts in first-appearance order.
    const rows = db.rows(pinTable);
    const groups = new Map<string, Record<string, Cell>[]>();
    for (const r of rows) {
      const part = txt(col(r, 'Part'));
      (groups.get(part) ?? groups.set(part, []).get(part)!).push(r);
    }
    for (const [name, pins] of groups) {
      const bottom = pins.filter((r) => bottomTB(col(r, 'TB'))).length > pins.length / 2;
      const th = pins.some((r) => num(col(r, 'Layer')) === 0);
      const pi = name ? b.addPart({ name, side: bottom ? SIDE_BOTTOM : SIDE_TOP, mount: th ? MOUNT_TH : MOUNT_SMD }) : -1;
      pins.forEach((r, i) => {
        const x = num(col(r, 'X')),
          y = num(col(r, 'Y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const layer = num(col(r, 'Layer'));
        const no = txt(col(r, 'Pin'));
        const label = txt(col(r, 'Name'));
        b.addPin({
          part: pi,
          x: clean(x),
          y: clean(y),
          number: no || String(i + 1),
          name: label && label !== no ? label : undefined,
          net: txt(col(r, 'Net')) || null,
          side: layer === 0 ? SIDE_BOTH : layer === 2 ? SIDE_BOTTOM : layer === 1 ? SIDE_TOP : undefined,
        });
      });
    }

    // Nails: test probes.
    const nailTable = find('Nail');
    let nails = 0;
    if (nailTable !== undefined)
      db.rows(nailTable).forEach((r, i) => {
        const x = num(col(r, 'X')),
          y = num(col(r, 'Y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const id = txt(col(r, 'Nail')).replace(/^\$/, '');
        const probe = /^\d+$/.test(id) && id !== '0' ? Number(id) : i + 1;
        b.addPin({ part: -1, x: clean(x), y: clean(y), kind: PINKIND_TESTPOINT, side: bottomTB(col(r, 'TB')) ? SIDE_BOTTOM : SIDE_TOP, number: String(probe), probe, net: txt(col(r, 'NetName')) || null });
        nails++;
      });

    // Layout: outline polylines by group, in row order.
    const layoutTable = find('Layout');
    let outline = 0;
    if (layoutTable !== undefined) {
      const byGroup = new Map<number, number[]>();
      for (const r of db.rows(layoutTable)) {
        const x = num(col(r, 'X')),
          y = num(col(r, 'Y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const g = num(col(r, 'Group'));
        (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(clean(x), clean(y));
      }
      for (const pts of byGroup.values()) {
        if (pts.length < 4) continue;
        b.addOutlinePolyline(pts, pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]);
        outline++;
      }
    }
    if (!outline) b.info('bv.nooutline', 'The database has no Layout rows; the outline is derived from the parts');
    if (!nails) b.info('bv.nonails', 'The database has no Nail (test probe) rows');
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: db.jet4 ? 'Jet 4' : 'Jet 3', extraFiles: [] });
  },
};
