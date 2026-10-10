/**
 * BV boardview databases (Microsoft Access / Jet 4), read by the built-in
 * Jet reader: the synthetic Glasgow database and an unrelated Access file.
 */
import { describe, expect, test } from 'vitest';
import { MdbReader } from '../../src/io/mdb';
import { MOUNT_TH, PINKIND_TESTPOINT, SIDE_BOTH } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { loadSource } from '../../tools/fixtures/source';
import { writeJet4 } from '../../tools/fixtures/writers';
import { ROOT, file, parse, parseBytes } from '../helpers/load';

describe('Jet reader', () => {
  test('catalog, column definitions and rows', () => {
    const db = new MdbReader(file('fixtures/synthetic/glasgow.bv').bytes);
    expect(db.jet4).toBe(true);
    const t = db.tables();
    expect([...t.keys()]).toEqual(['Layout', 'Nail', 'Pin']);
    const def = db.tableDef(t.get('Pin')!);
    expect(def.columns.map((c) => c.name)).toEqual(['Part', 'TB', 'Pin', 'Name', 'X', 'Y', 'Layer', 'Net']);
    const rows = db.rows(t.get('Pin')!);
    expect(rows.length).toBe(def.rowCount);
    expect(rows[0]).toMatchObject({ TB: expect.stringMatching(/^\((T|B)\)$/), Pin: 1 });
  });
  test('rejects files that are not Jet databases', () => {
    expect(() => new MdbReader(new Uint8Array(4096))).toThrow(/Standard Jet DB/);
  });
});

describe('BV boardview', () => {
  const src = loadSource(ROOT);
  const out = parse('fixtures/synthetic/glasgow.bv');
  const m = out.model!;
  test('parts, pins, nets, nails and outline', () => {
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(m.source.formatId).toBe('bv');
    expect(validateModel(m)).toEqual([]);
    expect(m.units).toMatchObject({ unit: 'inch', toMm: 25.4 });
    expect(m.parts.count).toBe(src.parts.length);
    const tps = [...Array(m.pins.count).keys()].filter((i) => m.pins.kind[i] === PINKIND_TESTPOINT);
    expect(tps.length).toBe(src.nails.length);
    expect(m.outline.source).toBe('file');
    const th = src.parts.find((p) => p.th)!;
    const k = m.parts.name.indexOf(th.name);
    expect(m.parts.mount[k]).toBe(MOUNT_TH);
    expect(m.pins.side[m.parts.pinStart[k]]).toBe(SIDE_BOTH);
  });
  test('an Access database without a Pin table is explained', () => {
    const db = writeJet4([{ name: 'Customers', cols: [{ name: 'Name', type: 'text' }], rows: [['Ada']] }]);
    const r = parseBytes('orders.bv', db);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.level === 'error')?.message).toMatch(/no "Pin" table.*Customers/);
  });
});
