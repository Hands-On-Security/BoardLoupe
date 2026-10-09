import { type BoardModel, NO_PROBE, sideLabel } from '../model/types';

/** CSV and JSON export of the normalized model (no UI dependencies). */

const FORMULA_RISK = /^[=@\t\r]|^[+-].*[(|!]/;
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_RISK.test(s)) s = "'" + s; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function modelToJson(m: BoardModel) {
  const nn = (n: number) => (n >= 0 ? m.nets.name[n] : null);
  return {
    schema: m.schema,
    source: m.source,
    units: m.units,
    bounds: m.bounds,
    capabilities: m.caps,
    metadata: Object.fromEntries(m.metadata),
    outline: { source: m.outline.source, segments: Array.from(m.outline.segs) },
    parts: Array.from({ length: m.parts.count }, (_, k) => ({
      id: k,
      name: m.parts.name[k],
      side: sideLabel(m.parts.side[k]).toLowerCase(),
      x: m.parts.x[k],
      y: m.parts.y[k],
      originFromFile: !!m.parts.originFromFile[k],
      mechanical: !!(m.parts.flags[k] & 1),
      rotation: Number.isNaN(m.parts.rot[k]) ? null : m.parts.rot[k],
      bbox: Array.from(m.parts.bbox.subarray(4 * k, 4 * k + 4)),
      value: m.parts.value[k],
      footprint: m.parts.footprint[k],
      attributes: m.parts.attrs[k] ? Object.fromEntries(m.parts.attrs[k]!) : null,
      pins: Array.from({ length: m.parts.pinCount[k] }, (_, j) => m.parts.pinStart[k] + j),
    })),
    pins: Array.from({ length: m.pins.count }, (_, i) => ({
      id: i,
      part: m.pins.part[i] >= 0 ? m.parts.name[m.pins.part[i]] : null,
      partId: m.pins.part[i] >= 0 ? m.pins.part[i] : null,
      number: m.pins.number[i] || null,
      name: m.pins.name[i] || null,
      net: nn(m.pins.net[i]),
      x: m.pins.x[i],
      y: m.pins.y[i],
      side: sideLabel(m.pins.side[i]).toLowerCase(),
      kind: m.pins.kind[i] ? 'testpoint' : 'pin',
      width: m.pins.w[i] || null,
      height: m.pins.h[i] || null,
      drill: m.pins.hole[i] || null,
      probe: m.pins.probe[i] === NO_PROBE ? null : m.pins.probe[i],
    })),
    nets: Array.from({ length: m.nets.count }, (_, n) => ({ id: n, name: m.nets.name[n], pins: Array.from(m.nets.pinIndex.subarray(m.nets.pinStart[n], m.nets.pinStart[n + 1])) })),
    vias: Array.from({ length: m.vias.count }, (_, i) => ({ x: m.vias.x[i], y: m.vias.y[i], diameter: m.vias.d[i] || null, net: nn(m.vias.net[i]) })),
    diagnostics: m.diagnostics,
  };
}

