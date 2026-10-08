import type { BoardModel } from './types';

/**
 * Referential-integrity check of a normalized model. Returns a list of
 * human-readable problems (empty when the model is consistent). The builder
 * guarantees these invariants; this check exists to catch builder/parser bugs
 * and is also run by the test-suite on every fixture.
 */
export function validateModel(m: BoardModel, maxProblems = 20): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (out.length < maxProblems) out.push(s);
  };
  const { parts, pins, nets, vias, traces } = m;

  const lens = (o: Record<string, unknown>, n: number, label: string, mult: Record<string, number> = {}) => {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'count') continue;
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        const want = n * (mult[k] ?? 1);
        if (mult[k] === 0) continue;
        const len = (v as ArrayLike<unknown>).length;
        if (len !== want) push(`${label}.${k} has length ${len}, expected ${want}`);
      }
    }
  };
  lens(parts as unknown as Record<string, unknown>, parts.count, 'parts', { bbox: 4, bodyStart: 0, bodySegs: 0 });
  lens(pins as unknown as Record<string, unknown>, pins.count, 'pins');
  lens(vias as unknown as Record<string, unknown>, vias.count, 'vias');
  lens(traces as unknown as Record<string, unknown>, traces.count, 'traces', { segs: 4 });
  if (parts.bodyStart.length !== parts.count + 1) push('parts.bodyStart length mismatch');
  if (nets.name.length !== nets.count || nets.flags.length !== nets.count) push('nets table length mismatch');
  if (nets.pinStart.length !== nets.count + 1) push('nets.pinStart length mismatch');

  for (let i = 0; i < pins.count; i++) {
    const p = pins.part[i];
    if (p < -1 || p >= parts.count) push(`pin ${i} references part ${p}`);
    const n = pins.net[i];
    if (n < -1 || n >= nets.count) push(`pin ${i} references net ${n}`);
    if (!Number.isFinite(pins.x[i]) || !Number.isFinite(pins.y[i])) push(`pin ${i} has non-finite position`);
  }
  let total = 0;
  for (let k = 0; k < parts.count; k++) {
    const s = parts.pinStart[k],
      c = parts.pinCount[k];
    if (s + c > pins.count) push(`part ${k} pin range out of bounds`);
    for (let j = s; j < s + c && j < pins.count; j++) if (pins.part[j] !== k) push(`pin ${j} not owned by part ${k}`);
    total += c;
  }
  let unowned = 0;
  for (let i = 0; i < pins.count; i++) if (pins.part[i] === -1) unowned++;
  if (total + unowned !== pins.count) push(`pin ownership count mismatch (${total}+${unowned} != ${pins.count})`);

  let netTotal = 0;
  for (let k = 0; k < nets.count; k++) {
    const a = nets.pinStart[k],
      b = nets.pinStart[k + 1];
    if (b < a || b > nets.pinIndex.length) {
      push(`net ${k} has invalid member range`);
      continue;
    }
    netTotal += b - a;
    for (let j = a; j < b; j++) {
      const pi = nets.pinIndex[j];
      if (pi >= pins.count || pins.net[pi] !== k) push(`net ${k} member ${pi} does not point back to the net`);
    }
  }
  let withNet = 0;
  for (let i = 0; i < pins.count; i++) if (pins.net[i] >= 0) withNet++;
  if (withNet !== netTotal) push(`net membership count mismatch (${netTotal} != ${withNet})`);

  for (let i = 0; i < vias.count; i++) if (vias.net[i] < -1 || vias.net[i] >= nets.count) push(`via ${i} references net ${vias.net[i]}`);
  for (let i = 0; i < traces.count; i++) if (traces.net[i] < -1 || traces.net[i] >= nets.count) push(`trace ${i} references net ${traces.net[i]}`);

  const b = m.bounds;
  if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) || b.minX > b.maxX || b.minY > b.maxY) push('board bounds are not finite');
  return out;
}
