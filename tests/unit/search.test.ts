import { describe, expect, test } from 'vitest';
import { SearchIndex, fuzzyScore } from '../../src/search/search';
import { parse } from '../helpers/load';

const m = parse('fixtures/real/glasgow/glasgow-kicad10.cad').model!;
const s = new SearchIndex(m);

describe('search ranking', () => {
  test('exact refdes ranks first', () => {
    const h = s.query('U1');
    expect(h[0].kind).toBe('part');
    expect(h[0].label).toBe('U1');
    // prefix matches follow (U10, U11 …)
    expect(h.slice(1, 5).every((x) => x.label.toUpperCase().startsWith('U1'))).toBe(true);
  });
  test('case-insensitive', () => {
    expect(s.query('u30')[0].label).toBe('U30');
  });
  test('net names: GND first for "gnd"', () => {
    const h = s.query('gnd');
    expect(h[0].kind).toBe('net');
    expect(h[0].label).toBe('GND');
  });
  test('pin reference "U1.12" and "U1 pin 12"', () => {
    for (const q of ['U1.12', 'U1 pin 12', 'u1:12']) {
      const h = s.query(q);
      expect(h[0].kind).toBe('pin');
      expect(h[0].label).toBe('U1.12');
    }
  });
  test('"pin 1" prefers the context part', () => {
    const k = m.parts.name.findIndex((n, i) => n.startsWith('U') && Array.from({ length: m.parts.pinCount[i] }, (_, j) => m.pins.number[m.parts.pinStart[i] + j]).includes('1'));
    const h = s.query('pin 1', 50, k);
    expect(h[0].label).toBe(`${m.parts.name[k]}.1`);
    expect(h.length).toBeGreaterThan(5);
  });
  test('substring and boundary matches for net fragments', () => {
    const h = s.query('sda');
    expect(h.length).toBeGreaterThan(0);
    expect(h[0].label.toLowerCase()).toContain('sda');
  });
  test('fuzzy fallback', () => {
    expect(fuzzyScore('u3v', 'usb_3v3')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'usb_3v3')).toBe(0);
    const h = s.query('glsgw');
    void h; // no crash; may be empty
  });
  test('value search', () => {
    const k = m.parts.value.findIndex((v) => !!v && v.length > 3);
    const v = m.parts.value[k]!;
    const h = s.query(v.slice(0, 4));
    expect(h.some((x) => x.kind === 'part')).toBe(true);
  });
  test('empty query returns nothing and is fast on a full board', () => {
    expect(s.query('  ')).toEqual([]);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) s.query(['u', 'gn', 'c1', 'sda', 'r2', '3v'][i % 6]);
    expect((performance.now() - t0) / 200).toBeLessThan(5);
  });
});
