/**
 * Builds the neutral "source board" used to synthesise fixtures in formats for
 * which no redistributable real file exists. The data comes from a REAL board:
 * the Glasgow interface explorer (0BSD), exported by KiCad 10 to GenCAD
 * (fixtures/real/glasgow/glasgow-kicad10.cad). Coordinates are integer mils,
 * Y up, shifted so the outline's minimum corner is the origin.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import { MOUNT_TH, SHAPE_CIRCLE, SHAPE_RECT, SHAPE_ROUNDRECT } from '../../src/model/types';

export interface SrcPin {
  number: string;
  name: string;
  x: number;
  y: number;
  net: string;
  w: number;
  h: number;
  shape: 'round' | 'rect' | 'roundrect';
  hole: number;
  side: 'T' | 'B';
}
export interface SrcPart {
  name: string;
  side: 'T' | 'B';
  th: boolean;
  x: number;
  y: number;
  rot: number;
  bbox: [number, number, number, number];
  value: string;
  footprint: string;
  pins: SrcPin[];
}
export interface SrcNail {
  probe: number;
  x: number;
  y: number;
  side: 'T' | 'B';
  net: string;
}
export interface SrcBoard {
  outline: [number, number][]; // closed polygon (first point not repeated)
  outlineSegs: [number, number, number, number][];
  parts: SrcPart[];
  nails: SrcNail[];
  nets: string[];
  traces: { x1: number; y1: number; x2: number; y2: number; w: number; layer: 'T' | 'B' | 'I'; net: string }[];
  vias: { x: number; y: number; d: number; net: string }[];
}

/** Fixture strings are kept to printable ASCII so every format/encoding agrees byte-for-byte. */
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');

export function loadSource(root: string): SrcBoard {
  const buf = readFileSync(resolve(root, 'fixtures/real/glasgow/glasgow-kicad10.cad'));
  const out = parseFiles([{ name: 'glasgow.cad', bytes: new Uint8Array(buf) }], DEFAULT_OPTIONS);
  if (!out.ok || !out.model) throw new Error('cannot load source board');
  const m = out.model;
  const segs = m.outline.segs;
  let minX = Infinity,
    minY = Infinity;
  for (let i = 0; i < segs.length; i += 2) {
    minX = Math.min(minX, segs[i]);
    minY = Math.min(minY, segs[i + 1]);
  }
  const X = (x: number) => Math.round(x - minX);
  const Y = (y: number) => Math.round(y - minY);
  const outlineSegs: SrcBoard['outlineSegs'] = [];
  for (let i = 0; i < segs.length; i += 4) {
    const s: [number, number, number, number] = [X(segs[i]), Y(segs[i + 1]), X(segs[i + 2]), Y(segs[i + 3])];
    if (s[0] !== s[2] || s[1] !== s[3]) outlineSegs.push(s);
  }
  // The KiCad outline is a single closed chain: recover the polygon order.
  const outline: [number, number][] = outlineSegs.map((s) => [s[0], s[1]]);

  const parts: SrcPart[] = [];
  const nails: SrcNail[] = [];
  for (let k = 0; k < m.parts.count; k++) {
    const name = ascii(m.parts.name[k]);
    const c = m.parts.pinCount[k];
    if (!c) continue;
    const side: 'T' | 'B' = m.parts.side[k] === 2 ? 'B' : 'T';
    const pins: SrcPin[] = [];
    for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + c; j++) {
      const sh = m.pins.shape[j];
      const ps = m.pins.side[j];
      pins.push({
        number: ascii(m.pins.number[j]),
        name: ascii(m.pins.number[j]),
        x: X(m.pins.x[j]),
        y: Y(m.pins.y[j]),
        net: m.pins.net[j] >= 0 ? ascii(m.nets.name[m.pins.net[j]]) : '',
        w: Math.max(1, Math.round(m.pins.w[j])),
        h: Math.max(1, Math.round(m.pins.h[j])),
        shape: sh === SHAPE_CIRCLE ? 'round' : sh === SHAPE_ROUNDRECT ? 'roundrect' : sh === SHAPE_RECT ? 'rect' : 'round',
        hole: Math.round(m.pins.hole[j]),
        side: ps === 2 ? 'B' : ps === 1 ? 'T' : side,
      });
    }
    const b = m.parts.bbox;
    const part: SrcPart = {
      name,
      side: m.parts.mount[k] === MOUNT_TH ? (m.parts.side[k] === 2 ? 'B' : 'T') : side,
      th: m.parts.mount[k] === MOUNT_TH,
      x: X(m.parts.x[k]),
      y: Y(m.parts.y[k]),
      rot: Number.isNaN(m.parts.rot[k]) ? 0 : Math.round(m.parts.rot[k]),
      bbox: [X(b[4 * k]), Y(b[4 * k + 1]), X(b[4 * k + 2]), Y(b[4 * k + 3])],
      value: ascii(m.parts.value[k] ?? ''),
      footprint: ascii(m.parts.footprint[k] ?? '').replace(/\s+/g, '_'),
      pins,
    };
    if (/^TP\d+$/.test(name) && c === 1) {
      nails.push({ probe: Number(name.slice(2)), x: pins[0].x, y: pins[0].y, side: pins[0].side, net: pins[0].net });
    }
    parts.push(part);
  }
  const nets = [...new Set(parts.flatMap((p) => p.pins.map((q) => q.net)).filter(Boolean))];
  const traces: SrcBoard['traces'] = [];
  const layerName = (id: number) => m.layers.find((l) => l.id === id)?.name ?? '';
  for (let i = 0; i < m.traces.count; i++) {
    const ln = layerName(m.traces.layer[i]);
    traces.push({
      x1: X(m.traces.segs[4 * i]),
      y1: Y(m.traces.segs[4 * i + 1]),
      x2: X(m.traces.segs[4 * i + 2]),
      y2: Y(m.traces.segs[4 * i + 3]),
      w: Math.max(1, Math.round(m.traces.width[i])),
      layer: ln === 'TOP' ? 'T' : ln === 'BOTTOM' ? 'B' : 'I',
      net: m.traces.net[i] >= 0 ? ascii(m.nets.name[m.traces.net[i]]) : '',
    });
  }
  const vias: SrcBoard['vias'] = [];
  for (let i = 0; i < m.vias.count; i++) vias.push({ x: X(m.vias.x[i]), y: Y(m.vias.y[i]), d: Math.max(1, Math.round(m.vias.d[i])), net: m.vias.net[i] >= 0 ? ascii(m.nets.name[m.vias.net[i]]) : '' });
  return { outline, outlineSegs, parts, nails, nets, traces, vias };
}

/** Deterministic PRNG for reproducible fixtures. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
