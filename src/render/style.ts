import type { BoardModel } from '../model/types';
import { MOUNT_TH, NETFLAG_GROUND, NETFLAG_NOCONNECT, PINKIND_TESTPOINT } from '../model/types';
import type { Scene } from '../scene/scene';
import { type Palette, type RGBA, netColor } from './palette';

export interface RenderOptions {
  /** Side being viewed: 1 = top, 2 = bottom. */
  side: 1 | 2;
  otherSide: 'ghost' | 'hide' | 'show';
  showOutline: boolean;
  showBodies: boolean;
  showPins: boolean;
  showVias: boolean;
  showTraces: boolean;
  showPartLabels: boolean;
  showPinLabels: boolean;
  showNetLabels: boolean;
  showRatsnest: boolean;
  colorByNet: boolean;
  /** Bitmask of visible trace layers (by LayerInfo.id, < 32). */
  traceLayerMask: number;
  light: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  side: 1,
  otherSide: 'ghost',
  showOutline: true,
  showBodies: true,
  showPins: true,
  showVias: true,
  showTraces: false,
  showPartLabels: true,
  showPinLabels: true,
  showNetLabels: true,
  showRatsnest: false,
  colorByNet: false,
  traceLayerMask: 0xffffffff,
  light: false,
};

export interface Highlight {
  part: number;
  pin: number;
  nets: number[];
  parts: number[]; // multi-selection
  isolate: boolean;
  /** Nets hidden by "hide other nets". */
  hideUnselectedNets: boolean;
}

export const EMPTY_HIGHLIGHT: Highlight = { part: -1, pin: -1, nets: [], parts: [], isolate: false, hideUnselectedNets: false };

export interface Colors {
  pin: Uint8Array;
  part: Uint8Array;
  via: Uint8Array;
  trace: Uint8Array;
  /** 1 for pads/vias that get an on-top halo so they stay visible when zoomed out. */
  pinEmph: Uint8Array;
  viaEmph: Uint8Array;
}

function put(a: Uint8Array, i: number, c: RGBA, alpha = c[3]) {
  a[4 * i] = c[0];
  a[4 * i + 1] = c[1];
  a[4 * i + 2] = c[2];
  a[4 * i + 3] = alpha;
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t] as RGBA;
}

/**
 * Per-instance colours. Recomputed only when selection/options change (not on
 * hover or pan), O(pins + parts + vias + traces).
 */
export function computeColors(m: BoardModel, _s: Scene, o: RenderOptions, h: Highlight, p: Palette): Colors {
  const { pins, parts, nets, vias, traces } = m;
  const pin = new Uint8Array(pins.count * 4);
  const part = new Uint8Array(parts.count * 4);
  const via = new Uint8Array(vias.count * 4);
  const trace = new Uint8Array(traces.count * 4);
  const pinEmph = new Uint8Array(pins.count);
  const viaEmph = new Uint8Array(vias.count);

  const netSel = new Uint8Array(nets.count);
  for (const n of h.nets) if (n >= 0 && n < nets.count) netSel[n] = 1;
  // A multi-net (bus) selection gets a distinct colour per net; a single net
  // keeps the plain selection colour. Index follows h.nets order (selection order).
  const multiBus = h.nets.length > 1;
  const busOf = (n: number): RGBA => {
    if (!multiBus) return p.selNet;
    const i = h.nets.indexOf(n);
    return i < 0 ? p.selNet : p.busColors[i % p.busColors.length];
  };
  const partSel = new Uint8Array(parts.count);
  for (const k of h.parts) if (k >= 0 && k < parts.count) partSel[k] = 2;
  if (h.part >= 0 && h.part < parts.count) partSel[h.part] = 1;
  const anySel = h.nets.length > 0 || h.parts.length > 0 || h.part >= 0 || h.pin >= 0;
  const dimAlpha = o.light ? 70 : 60;
  const isolate = h.isolate && anySel;

  // Parts touched by a highlighted net get a hint of that net's colour.
  // Stores netIndex+1 of the first selected net reaching the part (0 = none).
  const partTouch = new Int32Array(parts.count);
  if (h.nets.length) {
    for (const n of h.nets) {
      if (n < 0 || n >= nets.count) continue;
      for (let j = nets.pinStart[n]; j < nets.pinStart[n + 1]; j++) {
        const k = pins.part[nets.pinIndex[j]];
        if (k >= 0 && partTouch[k] === 0) partTouch[k] = n + 1;
      }
    }
  }

  for (let i = 0; i < pins.count; i++) {
    const n = pins.net[i];
    const flags = n >= 0 ? nets.flags[n] : 0;
    const k = pins.part[i];
    let c: RGBA;
    if (o.colorByNet && n >= 0 && !(flags & NETFLAG_NOCONNECT)) c = netColor(n, o.light);
    else if (pins.kind[i] === PINKIND_TESTPOINT) c = p.testpoint;
    else if (flags & NETFLAG_NOCONNECT || n < 0) c = p.padNC;
    else if (flags & NETFLAG_GROUND) c = p.padGnd;
    else if (pins.hole[i] > 0 || (k >= 0 && parts.mount[k] === MOUNT_TH)) c = p.padTH;
    else c = p.pad;
    let hl = false;
    let emph = false;
    if (n >= 0 && netSel[n]) {
      c = busOf(n);
      hl = true;
      emph = true;
    } else if (k >= 0 && partSel[k]) {
      c = mix(c, partSel[k] === 1 ? p.selPart : p.multi, 0.6);
      hl = true;
      // Small parts (ICs, passives) get a halo so a selected component is
      // findable when zoomed out; large parts (BGAs) rely on their outline.
      if (parts.pinCount[k] <= 64) emph = true;
    }
    if (i === h.pin) {
      c = p.selPin;
      hl = true;
      emph = true;
    }
    let a = c[3];
    if ((isolate || (h.hideUnselectedNets && h.nets.length)) && !hl) a = h.hideUnselectedNets && h.nets.length ? 0 : dimAlpha;
    // While a net is highlighted, other pads recede so the net stands out.
    else if (h.nets.length && !hl) c = mix(c, p.bg, 0.6);
    if (emph && a > 0) pinEmph[i] = 1;
    put(pin, i, c, a);
  }

  for (let k = 0; k < parts.count; k++) {
    let c: RGBA = _s.bodyDerived[k] ? p.bodyDerived : p.body;
    let hl = false;
    if (partSel[k] === 1) {
      c = p.selPart;
      hl = true;
    } else if (partSel[k] === 2) {
      c = p.multi;
      hl = true;
    } else if (partTouch[k]) {
      c = mix(c, busOf(partTouch[k] - 1), 0.45);
      hl = true;
    }
    if (h.nets.length && !hl && !isolate) c = mix(c, p.bg, 0.4);
    put(part, k, c, isolate && !hl ? dimAlpha : c[3]);
  }

  for (let i = 0; i < vias.count; i++) {
    const n = vias.net[i];
    const sel = n >= 0 && netSel[n] === 1;
    const c = sel ? busOf(n) : o.colorByNet && n >= 0 ? netColor(n, o.light) : p.via;
    if (sel) viaEmph[i] = 1;
    put(via, i, c, (isolate || (h.hideUnselectedNets && h.nets.length)) && !sel ? dimAlpha / 2 : c[3]);
  }

  const layerIdx = new Map<number, number>();
  m.layers.forEach((l, i) => layerIdx.set(l.id, i));
  for (let i = 0; i < traces.count; i++) {
    const n = traces.net[i];
    const sel = n >= 0 && netSel[n] === 1;
    const li = layerIdx.get(traces.layer[i]) ?? traces.layer[i];
    const base = p.traceLayers[li % p.traceLayers.length];
    const bc = sel ? busOf(n) : p.selNet;
    const c = sel ? ([bc[0], bc[1], bc[2], 235] as RGBA) : o.colorByNet && n >= 0 ? ([...netColor(n, o.light).slice(0, 3), base[3]] as RGBA) : base;
    put(trace, i, c, anySel && h.nets.length && !sel ? Math.round(c[3] * 0.35) : c[3]);
  }
  return { pin, part, via, trace, pinEmph, viaEmph };
}
