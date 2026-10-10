import { describe, expect, test } from 'vitest';
import { BoardBuilder } from '../../src/model/builder';
import { traceSeries } from '../../src/model/trace';

const src = { fileName: 't', fileSize: 1, formatId: 'x', formatName: 'X', variant: null, extraFiles: [] };

/** Two-pin series part `name` between nets `a` and `b`. */
function series(b: BoardBuilder, name: string, a: string, bnet: string) {
  const p = b.addPart({ name });
  b.addPin({ part: p, x: 0, y: 0, net: a, number: '1' });
  b.addPin({ part: p, x: 1, y: 0, net: bnet, number: '2' });
}
const netIdx = (m: ReturnType<BoardBuilder['finish']>, name: string) => m.nets.name.indexOf(name);
const names = (m: ReturnType<BoardBuilder['finish']>, ids: number[]) => ids.map((i) => m.nets.name[i]).sort();

describe('traceSeries', () => {
  test('follows a straight chain U1 → R1 → L1 → connector', () => {
    const b = new BoardBuilder();
    const u = b.addPart({ name: 'U1' });
    b.addPin({ part: u, x: 0, y: 0, net: 'SPI_CLK', number: 'A1' });
    series(b, 'R1', 'SPI_CLK', 'N1');
    series(b, 'L1', 'N1', 'N2');
    const j = b.addPart({ name: 'J1' });
    b.addPin({ part: j, x: 5, y: 0, net: 'N2', number: '1' });
    b.addPin({ part: j, x: 6, y: 0, net: 'N2B', number: '2' });
    const m = b.finish(src);
    const r = traceSeries(m, netIdx(m, 'SPI_CLK'));
    expect(names(m, r.nets)).toEqual(['N1', 'N2', 'SPI_CLK']);
    expect(r.parts.map((p) => m.parts.name[p]).sort()).toEqual(['L1', 'R1']);
    expect(r.branched).toBe(false);
    expect(r.truncated).toBe(false);
  });

  test('records branches when a net feeds several series parts', () => {
    const b = new BoardBuilder();
    series(b, 'R1', 'A', 'B');
    series(b, 'R2', 'A', 'C');
    const m = b.finish(src);
    const r = traceSeries(m, netIdx(m, 'A'));
    expect(names(m, r.nets)).toEqual(['A', 'B', 'C']);
    expect(r.branched).toBe(true);
    expect(r.edges).toHaveLength(2);
  });

  test('terminates on a cycle without looping forever', () => {
    const b = new BoardBuilder();
    series(b, 'R1', 'A', 'B');
    series(b, 'R2', 'B', 'C');
    series(b, 'R3', 'C', 'A');
    const m = b.finish(src);
    const r = traceSeries(m, netIdx(m, 'A'));
    expect(names(m, r.nets)).toEqual(['A', 'B', 'C']);
    expect(r.edges.length).toBe(3); // the closing edge C→A is recorded but not re-expanded
  });

  test('does not step through a decoupling cap into a power/ground rail', () => {
    const b = new BoardBuilder();
    series(b, 'R1', 'VIN', 'VOUT'); // series regulator feedback-ish
    series(b, 'C1', 'VOUT', 'GND'); // decoupling cap to ground
    const m = b.finish(src);
    const r = traceSeries(m, netIdx(m, 'VIN'));
    // GND is a rail: the cap is a stub, so GND is not pulled in.
    expect(names(m, r.nets)).toEqual(['VIN', 'VOUT']);
    expect(r.parts.map((p) => m.parts.name[p])).toEqual(['R1']);
  });

  test('ignores multi-pin parts (ICs, connectors) as pass-throughs', () => {
    const b = new BoardBuilder();
    const u = b.addPart({ name: 'U1' });
    b.addPin({ part: u, x: 0, y: 0, net: 'A', number: '1' });
    b.addPin({ part: u, x: 1, y: 0, net: 'B', number: '2' });
    b.addPin({ part: u, x: 2, y: 0, net: 'C', number: '3' });
    const m = b.finish(src);
    const r = traceSeries(m, netIdx(m, 'A'));
    expect(r.nets).toHaveLength(1); // nothing to step through
  });

  test('anyTwoPin steps through any two-pin part regardless of refdes', () => {
    const b = new BoardBuilder();
    series(b, 'X9', 'A', 'B'); // not an R/L/FB name
    const m = b.finish(src);
    expect(traceSeries(m, netIdx(m, 'A')).nets).toHaveLength(1); // X9 is not a series refdes
    const r = traceSeries(m, netIdx(m, 'A'), { anyTwoPin: true });
    expect(names(m, r.nets)).toEqual(['A', 'B']);
  });
});
