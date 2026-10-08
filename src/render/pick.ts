import type Flatbush from 'flatbush';
import type { BoardModel } from '../model/types';
import { SHAPE_OBLONG, SHAPE_RECT, SHAPE_ROUNDRECT } from '../model/types';
import type { Scene } from '../scene/scene';
import { type View, screenToWorld } from './camera';
import type { RenderOptions } from './style';

export type PickResult = { kind: 'pin' | 'via' | 'part'; index: number } | null;

export interface PickIndexes {
  pin: Flatbush | null;
  part: Flatbush | null;
  via: Flatbush | null;
}

/** Signed distance from (x,y) to pin i's pad outline (world units, <0 inside). */
export function pinDistance(m: BoardModel, s: Scene, i: number, x: number, y: number): number {
  const dx = x - m.pins.x[i],
    dy = y - m.pins.y[i];
  const hw = s.pinHW[i],
    hh = s.pinHH[i];
  const sh = m.pins.shape[i];
  if (sh === SHAPE_RECT || sh === SHAPE_ROUNDRECT || sh === SHAPE_OBLONG) {
    const r = (-m.pins.rot[i] * Math.PI) / 180;
    const lx = dx * Math.cos(r) - dy * Math.sin(r);
    const ly = dx * Math.sin(r) + dy * Math.cos(r);
    const qx = Math.abs(lx) - hw,
      qy = Math.abs(ly) - hh;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  }
  return Math.hypot(dx, dy) - Math.min(hw, hh);
}

/**
 * Hit test at a screen position. Pins win over vias, vias over parts; pins on
 * the viewed side win over ghosted pins on the other side. Parts are matched
 * by the smallest body containing the point.
 */
export function pick(m: BoardModel, s: Scene, idx: PickIndexes, view: View, o: RenderOptions, sx: number, sy: number, tolPx = 4): PickResult {
  const [x, y] = screenToWorld(view, sx, sy);
  const tol = tolPx / view.scale;
  const minPinW = 0.75 / view.scale;
  const other = (side: number) => (side === 1 && o.side === 2) || (side === 2 && o.side === 1);
  const sideOk = (side: number) => !other(side) || o.otherSide !== 'hide';

  if (o.showPins && idx.pin) {
    let best = -1,
      bestD = Infinity,
      bestOther = true;
    for (const i of idx.pin.search(x - tol, y - tol, x + tol, y + tol)) {
      const sd = m.pins.side[i];
      if (!sideOk(sd)) continue;
      const d = Math.max(pinDistance(m, s, i, x, y), Math.hypot(x - m.pins.x[i], y - m.pins.y[i]) - minPinW);
      if (d > tol) continue;
      const ot = other(sd);
      // Prefer the viewed side, then the closest.
      if ((bestOther && !ot) || (ot === bestOther && d < bestD)) {
        best = i;
        bestD = d;
        bestOther = ot;
      }
    }
    if (best >= 0 && !(bestOther && o.otherSide === 'ghost' && pickPart(m, s, idx, o, x, y, false) >= 0)) return { kind: 'pin', index: best };
  }
  if (o.showVias && idx.via) {
    let best = -1,
      bestD = Infinity;
    for (const i of idx.via.search(x - tol, y - tol, x + tol, y + tol)) {
      const r = m.vias.d[i] > 0 ? m.vias.d[i] / 2 : s.typicalPin * 0.6;
      const d = Math.hypot(x - m.vias.x[i], y - m.vias.y[i]) - r;
      if (d <= tol && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best >= 0) return { kind: 'via', index: best };
  }
  const k = pickPart(m, s, idx, o, x, y, true);
  if (k >= 0) return { kind: 'part', index: k };
  return null;
}

function pickPart(m: BoardModel, s: Scene, idx: PickIndexes, o: RenderOptions, x: number, y: number, allowOther: boolean): number {
  if (!o.showBodies && !o.showPins) return -1;
  if (!idx.part) return -1;
  let best = -1,
    bestA = Infinity,
    bestOther = true;
  const other = (side: number) => (side === 1 && o.side === 2) || (side === 2 && o.side === 1);
  for (const k of idx.part.search(x, y, x, y)) {
    const ot = other(m.parts.side[k]);
    if (ot && (!allowOther || o.otherSide === 'hide')) continue;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let j = s.bodyStart[k] * 4; j < s.bodyStart[k + 1] * 4; j += 2) {
      x0 = Math.min(x0, s.bodySegs[j]);
      x1 = Math.max(x1, s.bodySegs[j]);
      y0 = Math.min(y0, s.bodySegs[j + 1]);
      y1 = Math.max(y1, s.bodySegs[j + 1]);
    }
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const a = (x1 - x0) * (y1 - y0);
    if ((bestOther && !ot) || (ot === bestOther && a < bestA)) {
      best = k;
      bestA = a;
      bestOther = ot;
    }
  }
  return best;
}
