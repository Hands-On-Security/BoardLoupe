import type { Bounds } from '../model/types';

/**
 * View transform. World is Y-up (CAD); screen is Y-down (CSS pixels).
 *
 *   screen = C + R(rot) · M(mirror) · S(scale) · F(yflip) · (world − center)
 *
 * `mirror` flips the X axis — used for the bottom-side view so the board is
 * seen as if physically turned over (left/right swapped). Rotation is in
 * 90° steps (clockwise on screen). The same object is used for picking
 * (screenToWorld) so selection stays consistent in every orientation.
 */
export interface View {
  cx: number; // world point shown at the canvas centre
  cy: number;
  scale: number; // CSS px per world unit
  rot: 0 | 90 | 180 | 270;
  mirror: boolean;
  width: number; // CSS px
  height: number;
}

/** Affine 2×3 matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];

export function viewMatrix(v: View): Mat {
  // world → centred, y-flipped, scaled
  const sx = v.mirror ? -v.scale : v.scale;
  const sy = -v.scale;
  // rotation (screen clockwise because screen y points down)
  const r = (v.rot * Math.PI) / 180;
  const cos = Math.round(Math.cos(r)),
    sin = Math.round(Math.sin(r));
  // R · diag(sx, sy)
  const a = cos * sx,
    b = sin * sx,
    c = -sin * sy,
    d = cos * sy;
  const e = v.width / 2 - (a * v.cx + c * v.cy);
  const f = v.height / 2 - (b * v.cx + d * v.cy);
  return [a, b, c, d, e, f];
}

export function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const ia = d / det,
    ib = -b / det,
    ic = -c / det,
    id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function worldToScreen(v: View, x: number, y: number): [number, number] {
  return apply(viewMatrix(v), x, y);
}

export function screenToWorld(v: View, sx: number, sy: number): [number, number] {
  return apply(invert(viewMatrix(v)), sx, sy);
}

/** World-space rectangle visible in the viewport (axis aligned, any rotation). */
export function visibleWorldRect(v: View, margin = 0): Bounds {
  const inv = invert(viewMatrix(v));
  const pts = [apply(inv, -margin, -margin), apply(inv, v.width + margin, -margin), apply(inv, -margin, v.height + margin), apply(inv, v.width + margin, v.height + margin)];
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}

/** View that fits `b` in the viewport with padding (keeps rot/mirror). */
export function fitView(v: View, b: Bounds, paddingPx = 32): View {
  const w = Math.max(b.maxX - b.minX, 1e-9);
  const h = Math.max(b.maxY - b.minY, 1e-9);
  const swap = v.rot === 90 || v.rot === 270;
  const ww = swap ? h : w,
    hh = swap ? w : h;
  const availW = Math.max(v.width - 2 * paddingPx, 10);
  const availH = Math.max(v.height - 2 * paddingPx, 10);
  const scale = Math.min(availW / ww, availH / hh);
  return { ...v, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 };
}

/** Zoom by `factor` keeping the world point under screen (sx, sy) fixed. */
export function zoomAt(v: View, factor: number, sx: number, sy: number, minScale: number, maxScale: number): View {
  const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
  const [wx, wy] = screenToWorld(v, sx, sy);
  const nv = { ...v, scale };
  const [nx, ny] = screenToWorld(nv, sx, sy);
  return { ...nv, cx: v.cx + (wx - nx), cy: v.cy + (wy - ny) };
}

/** Pan by a screen-space delta. */
export function panBy(v: View, dx: number, dy: number): View {
  const inv = invert(viewMatrix(v));
  // Linear part only.
  const wx = inv[0] * dx + inv[2] * dy;
  const wy = inv[1] * dx + inv[3] * dy;
  return { ...v, cx: v.cx - wx, cy: v.cy - wy };
}
