/**
 * Allegro Extracta text (A!/J!/S! rows), hand-written from the documented
 * column names: tables in any order, columns matched by name, quoted "!".
 */
import { describe, expect, test } from 'vitest';
import { NO_PROBE, SIDE_BOTTOM } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { parseBytes } from '../helpers/load';

const TXT = `J!board.brd!Fri Oct 09 2026!MILS!
A!NET_NAME!REFDES!PIN_NUMBER!PIN_X!PIN_Y!PAD_STACK_NAME!TEST_POINT!
S!VCC!R1!1!1000!950!SMD!!
S!GND!R1!2!1000!1050!SMD!B!
S!VCC!U1!1!2030!1000!SMD!!
A!REFDES!COMP_CLASS!COMP_PART_NUMBER!SYM_NAME!SYM_MIRROR!SYM_ROTATE!SYM_X!SYM_Y!COMP_VALUE!
S!R1!DISCRETE!RES-10K!R0402!NO!90!1000!1000!10K!
S!U1!IC!"LDO!3V3"!SOT23!YES!0!2000!1000!!
A!CLASS!SUBCLASS!GRAPHIC_DATA_NAME!GRAPHIC_DATA_NUMBER!RECORD_TAG!GRAPHIC_DATA_1!GRAPHIC_DATA_2!GRAPHIC_DATA_3!GRAPHIC_DATA_4!GRAPHIC_DATA_5!GRAPHIC_DATA_6!GRAPHIC_DATA_7!GRAPHIC_DATA_8!GRAPHIC_DATA_9!NET_NAME!
S!BOARD GEOMETRY!OUTLINE!LINE!1!1 1!0!0!3000!0!0!!!!!!
S!BOARD GEOMETRY!OUTLINE!LINE!2!1 2!3000!0!3000!2000!0!!!!!!
S!BOARD GEOMETRY!OUTLINE!ARC!3!1 3!3000!2000!0!2000!1500!2000!1500!0!COUNTERCLOCKWISE!!
S!BOARD GEOMETRY!OUTLINE!LINE!4!1 4!0!2000!0!0!0!!!!!!
S!ETCH!TOP!LINE!1!2 1!1000!950!2030!1000!8!!!!!VCC!
A!VIA_X!VIA_Y!NET_NAME!PAD_STACK_NAME!
S!1500!500!GND!VIA16!
`;

describe('Allegro Extracta', () => {
  const out = parseBytes('fabmaster.txt', new TextEncoder().encode(TXT));
  const m = out.model!;
  test('components, pins, nets, test access, graphics and vias', () => {
    expect(out.ok, out.diagnostics.map((d) => d.message).join('; ')).toBe(true);
    expect(m.source.formatId).toBe('extracta');
    expect(validateModel(m)).toEqual([]);
    expect(m.units).toMatchObject({ unit: 'mil', assumed: false });
    expect(m.parts.name).toEqual(['R1', 'U1']);
    const u1 = m.parts.name.indexOf('U1');
    expect(m.parts.side[u1]).toBe(SIDE_BOTTOM);
    expect(m.parts.attrs[u1]).toContainEqual(['Part number', 'LDO!3V3']);
    expect(m.parts.value[m.parts.name.indexOf('R1')]).toBe('10K');
    const pins = [...Array(m.pins.count).keys()];
    expect(pins.map((j) => `${m.parts.name[m.pins.part[j]]}.${m.pins.number[j]}=${m.nets.name[m.pins.net[j]]}`)).toEqual(['R1.1=VCC', 'R1.2=GND', 'U1.1=VCC']);
    expect(pins.filter((j) => m.pins.probe[j] !== NO_PROBE)).toHaveLength(1);
    expect(m.outline.source).toBe('file');
    expect(m.outline.segs.length / 4).toBeGreaterThan(4); // the arc is flattened
    expect([m.traces.count, m.vias.count]).toEqual([1, 1]);
    expect(m.nets.name[m.traces.net[0]]).toBe('VCC');
  });
});
