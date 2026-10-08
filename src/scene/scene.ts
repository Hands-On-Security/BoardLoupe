import Flatbush from 'flatbush';
import type { BoardModel } from '../model/types';

/**
 * Render-ready data derived from a BoardModel. Built in the worker (it is
 * O(n log n)) and transferred with the model. Nothing here is "data from the
 * file": it is presentation geometry (default pad sizes when the file has
 * none, rectangle bodies when the file has no body outlines) and indexes.
 */
export interface Scene {
  /** Half extents used to draw each pin (file size, or a derived default). */
  pinHW: Float32Array;
  pinHH: Float32Array;
  /** 1 when the pin size came from the file. */
  pinSizeFromFile: Uint8Array;
  /** Body segments per part (x1,y1,x2,y2 flat) — file bodies or derived rectangles. */
  bodySegs: Float32Array;
  bodyStart: Uint32Array; // per part, in segments; length parts+1
  bodyDerived: Uint8Array; // per part
  /** Spatial indexes (flatbush buffers). */
  pinIndex: ArrayBuffer | null;
  partIndex: ArrayBuffer | null;
  viaIndex: ArrayBuffer | null;
  traceIndex: ArrayBuffer | null;
  /** Typical pin half-size, used to scale strokes and labels. */
  typicalPin: number;
  /** World origin subtracted from GPU coordinates to keep float32 precision. */
  originX: number;
  originY: number;
}

function median(a: Float64Array | number[]): number {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
}

/** Estimates a sensible pin half-size from local pin spacing. */
function derivePinSizes(m: BoardModel, hw: Float32Array, hh: Float32Array, fromFile: Uint8Array) {
  const { pins, parts, bounds } = m;
  const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) || 1;
  // Per part: nearest-neighbour distance among its pins (O(k^2) capped, grid for big parts).
  const partSize = new Float64Array(parts.count).fill(NaN);
  const spacings: number[] = [];
  for (let k = 0; k < parts.count; k++) {
    const s = parts.pinStart[k],
      c = parts.pinCount[k];
    if (c < 2) continue;
    let best = Infinity;
    if (c <= 64) {
      for (let i = s; i < s + c; i++)
        for (let j = i + 1; j < s + c; j++) {
          const d = Math.hypot(pins.x[i] - pins.x[j], pins.y[i] - pins.y[j]);
          if (d > 0 && d < best) best = d;
        }
    } else {
      // Large parts (BGAs, connectors): sample nearest neighbours via sorting by x.
      const idx = Array.from({ length: c }, (_, i) => s + i).sort((a, b) => pins.x[a] - pins.x[b]);
      for (let i = 0; i < idx.length; i++)
        for (let j = i + 1; j < Math.min(idx.length, i + 24); j++) {
          const d = Math.hypot(pins.x[idx[i]] - pins.x[idx[j]], pins.y[idx[i]] - pins.y[idx[j]]);
          if (d > 0 && d < best) best = d;
        }
    }
    if (Number.isFinite(best)) {
      partSize[k] = best;
      spacings.push(best);
    }
  }
  const typicalSpacing = median(spacings);
  const fallback = Number.isFinite(typicalSpacing) ? typicalSpacing * 0.35 : diag * 0.002;
  for (let i = 0; i < pins.count; i++) {
    if (pins.w[i] > 0 && pins.h[i] > 0) {
      hw[i] = pins.w[i] / 2;
      hh[i] = pins.h[i] / 2;
      fromFile[i] = 1;
      continue;
    }
    const p = pins.part[i];
    let r = p >= 0 && Number.isFinite(partSize[p]) ? partSize[p] * 0.35 : fallback;
    // Clamp to a plausible range relative to the board.
    r = Math.min(Math.max(r, diag * 0.0004), diag * 0.01, fallback * 3);
    hw[i] = r;
    hh[i] = r;
  }
}

export function buildScene(m: BoardModel): Scene {
  const { pins, parts, vias, traces, bounds } = m;
  const N = pins.count;
  const pinHW = new Float32Array(N);
  const pinHH = new Float32Array(N);
  const pinSizeFromFile = new Uint8Array(N);
  derivePinSizes(m, pinHW, pinHH, pinSizeFromFile);
  const typicalPin = median(Array.from(pinHW.subarray(0, Math.min(N, 20000)))) || 1;

  // Bodies: file outlines when present, otherwise a rectangle around the part.
  const bodyStart = new Uint32Array(parts.count + 1);
  const bodyDerived = new Uint8Array(parts.count);
  const segs: number[] = [];
  for (let k = 0; k < parts.count; k++) {
    bodyStart[k] = segs.length / 4;
    const a = parts.bodyStart[k],
      b = parts.bodyStart[k + 1];
    if (b > a) {
      for (let i = a * 4; i < b * 4; i++) segs.push(parts.bodySegs[i]);
      continue;
    }
    let x0 = parts.bbox[4 * k],
      y0 = parts.bbox[4 * k + 1],
      x1 = parts.bbox[4 * k + 2],
      y1 = parts.bbox[4 * k + 3];
    if (!Number.isFinite(x0)) continue;
    const s = parts.pinStart[k],
      c = parts.pinCount[k];
    if (!parts.bboxFromFile[k] && c > 0) {
      // Pad the pin extent by the pin size so the body encloses the pads.
      let pad = 0;
      for (let j = s; j < s + c; j++) pad = Math.max(pad, pinHW[j], pinHH[j]);
      x0 -= pad * 0.6;
      y0 -= pad * 0.6;
      x1 += pad * 0.6;
      y1 += pad * 0.6;
      if (c > 0) {
        // ensure bodies of 1-pin parts are not degenerate
        const minSide = pad * 2.4;
        if (x1 - x0 < minSide) {
          const cx = (x0 + x1) / 2;
          x0 = cx - minSide / 2;
          x1 = cx + minSide / 2;
        }
        if (y1 - y0 < minSide) {
          const cy = (y0 + y1) / 2;
          y0 = cy - minSide / 2;
          y1 = cy + minSide / 2;
        }
      }
      bodyDerived[k] = 1;
    } else if (!parts.bboxFromFile[k]) {
      bodyDerived[k] = 1;
    }
    if (x1 - x0 <= 0 && y1 - y0 <= 0) {
      const r = typicalPin * 2;
      x0 -= r;
      x1 += r;
      y0 -= r;
      y1 += r;
    }
    segs.push(x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0);
  }
  bodyStart[parts.count] = segs.length / 4;

  const originX = Math.round((bounds.minX + bounds.maxX) / 2);
  const originY = Math.round((bounds.minY + bounds.maxY) / 2);

  let pinIndex: ArrayBuffer | null = null;
  if (N) {
    const fb = new Flatbush(N);
    for (let i = 0; i < N; i++) {
      const r = Math.max(pinHW[i], pinHH[i]);
      fb.add(pins.x[i] - r, pins.y[i] - r, pins.x[i] + r, pins.y[i] + r);
    }
    fb.finish();
    pinIndex = fb.data as ArrayBuffer;
  }
  let partIndex: ArrayBuffer | null = null;
  if (parts.count) {
    const fb = new Flatbush(parts.count);
    for (let k = 0; k < parts.count; k++) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = bodyStart[k] * 4; i < bodyStart[k + 1] * 4; i += 2) {
        x0 = Math.min(x0, segs[i]);
        x1 = Math.max(x1, segs[i]);
        y0 = Math.min(y0, segs[i + 1]);
        y1 = Math.max(y1, segs[i + 1]);
      }
      if (!Number.isFinite(x0)) {
        // Parts without geometry are indexed far away so queries never hit them.
        x0 = x1 = y0 = y1 = -1e30;
      }
      fb.add(x0, y0, x1, y1);
    }
    fb.finish();
    partIndex = fb.data as ArrayBuffer;
  }
  let viaIndex: ArrayBuffer | null = null;
  if (vias.count) {
    const fb = new Flatbush(vias.count);
    for (let i = 0; i < vias.count; i++) {
      const r = Math.max(vias.d[i] / 2, typicalPin * 0.5);
      fb.add(vias.x[i] - r, vias.y[i] - r, vias.x[i] + r, vias.y[i] + r);
    }
    fb.finish();
    viaIndex = fb.data as ArrayBuffer;
  }
  let traceIndex: ArrayBuffer | null = null;
  if (traces.count) {
    const fb = new Flatbush(traces.count);
    for (let i = 0; i < traces.count; i++) {
      const w = traces.width[i] / 2;
      const a = traces.segs[4 * i],
        b = traces.segs[4 * i + 1],
        c = traces.segs[4 * i + 2],
        d = traces.segs[4 * i + 3];
      fb.add(Math.min(a, c) - w, Math.min(b, d) - w, Math.max(a, c) + w, Math.max(b, d) + w);
    }
    fb.finish();
    traceIndex = fb.data as ArrayBuffer;
  }

  return {
    pinHW,
    pinHH,
    pinSizeFromFile,
    bodySegs: Float32Array.from(segs),
    bodyStart,
    bodyDerived,
    pinIndex,
    partIndex,
    viaIndex,
    traceIndex,
    typicalPin,
    originX,
    originY,
  };
}

export function sceneTransferables(s: Scene): ArrayBuffer[] {
  const out: ArrayBuffer[] = [s.pinHW.buffer as ArrayBuffer, s.pinHH.buffer as ArrayBuffer, s.pinSizeFromFile.buffer as ArrayBuffer, s.bodySegs.buffer as ArrayBuffer, s.bodyStart.buffer as ArrayBuffer, s.bodyDerived.buffer as ArrayBuffer];
  for (const b of [s.pinIndex, s.partIndex, s.viaIndex, s.traceIndex]) if (b) out.push(b);
  return out;
}
