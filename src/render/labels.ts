import type Flatbush from 'flatbush';
import { type BoardModel, PINKIND_TESTPOINT } from '../model/types';
import type { Scene } from '../scene/scene';
import { type View, viewMatrix, visibleWorldRect } from './camera';
import type { Palette } from './palette';
import type { Highlight, RenderOptions } from './style';

export const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** Label widths at a 100 px font, per weight: text width scales linearly with size. */
const widthCache = new Map<string, number>();
function textWidth100(ctx: CanvasRenderingContext2D, text: string, weight: number): number {
  const key = weight + '|' + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (widthCache.size > 50000) widthCache.clear();
    const prev = ctx.font;
    ctx.font = `${weight} 100px ${SANS}`;
    w = ctx.measureText(text).width;
    ctx.font = prev;
    widthCache.set(key, w);
  }
  return w;
}

export interface Overlay {
  measure: { ax: number; ay: number; bx: number; by: number; label: string } | null;
}

/**
 * Draws text labels on the 2D overlay canvas: reference designators scaled to
 * their part, pin numbers and net names when pads are large enough on screen.
 * Text always stays upright regardless of view rotation/mirroring.
 */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  view: View,
  m: BoardModel,
  s: Scene,
  partIdx: Flatbush | null,
  pinIdx: Flatbush | null,
  o: RenderOptions,
  h: Highlight,
  p: Palette,
  overlay: Overlay,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const M = viewMatrix(view);
  const tx = (x: number, y: number) => M[0] * x + M[2] * y + M[4];
  const ty = (x: number, y: number) => M[1] * x + M[3] * y + M[5];
  const vr = visibleWorldRect(view, 10);
  const other = (side: number) => (side === 1 && o.side === 2) || (side === 2 && o.side === 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const selected = new Set<number>(h.parts);
  if (h.part >= 0) selected.add(h.part);

  // Test pads get a diamond outline; vias stay hollow rings. Put the mark at
  // the pad edge so pin/net labels in the centre remain readable.
  if (o.showPins && pinIdx) {
    const ids = pinIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY);
    if (ids.length < 20000) {
      for (const i of ids) {
        if (m.pins.kind[i] !== PINKIND_TESTPOINT || (other(m.pins.side[i]) && o.otherSide === 'hide')) continue;
        const padPx = Math.min(s.pinHW[i], s.pinHH[i]) * view.scale;
        if (padPx < 2.5) continue;
        const x = tx(m.pins.x[i], m.pins.y[i]),
          y = ty(m.pins.x[i], m.pins.y[i]);
        const r = Math.max(6, padPx + 3);
        ctx.globalAlpha = other(m.pins.side[i]) && o.otherSide === 'ghost' ? 0.4 : 1;
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.strokeStyle = p.labelHalo;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = p.label;
        ctx.lineWidth = 1.75;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  if (o.showPartLabels && partIdx) {
    const ids = partIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY);
    // Largest parts first so they win when the budget runs out.
    const cand: { k: number; w: number; hgt: number; cx: number; cy: number }[] = [];
    for (const k of ids) {
      const side = m.parts.side[k];
      if (other(side) && !selected.has(k) && o.otherSide !== 'show') continue;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let j = s.bodyStart[k] * 4; j < s.bodyStart[k + 1] * 4; j += 2) {
        const X = tx(s.bodySegs[j], s.bodySegs[j + 1]),
          Y = ty(s.bodySegs[j], s.bodySegs[j + 1]);
        if (X < x0) x0 = X;
        if (X > x1) x1 = X;
        if (Y < y0) y0 = Y;
        if (Y > y1) y1 = Y;
      }
      if (!Number.isFinite(x0)) continue;
      const w = x1 - x0,
        hgt = y1 - y0;
      if (Math.min(w, hgt) < 10 && !selected.has(k)) continue;
      cand.push({ k, w, hgt, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }
    // Selected parts first, then larger parts, so they win when labels collide.
    cand.sort((a, b) => Number(selected.has(b.k)) - Number(selected.has(a.k)) || b.w * b.hgt - a.w * a.hgt);
    const budget = 1500;
    let drawn = 0;
    // Screen-space boxes of drawn labels in a coarse grid: a label that would
    // overlap one already drawn is skipped (selected labels always draw).
    const CELL = 48;
    const grid = new Map<number, number[]>();
    const boxes: number[] = [];
    const cellKey = (cx: number, cy: number) => cx * 73856093 + cy;
    const collides = (x0: number, y0: number, x1: number, y1: number) => {
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++)
          for (const j of grid.get(cellKey(cx, cy)) ?? []) if (x0 < boxes[j + 2] && x1 > boxes[j] && y0 < boxes[j + 3] && y1 > boxes[j + 1]) return true;
      return false;
    };
    const occupy = (x0: number, y0: number, x1: number, y1: number) => {
      const j = boxes.length;
      boxes.push(x0, y0, x1, y1);
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const key = cellKey(cx, cy);
          const list = grid.get(key);
          if (list) list.push(j);
          else grid.set(key, [j]);
        }
    };
    for (const c of cand) {
      if (drawn >= budget) break;
      const name = m.parts.name[c.k];
      if (!name) continue;
      const sel = selected.has(c.k);
      const len = name.length;
      let fs = Math.min(c.hgt * 0.42, (c.w * 0.9) / (len * 0.62), 26);
      if (sel) fs = Math.max(fs, 12);
      if (fs < 8.5) continue;
      ctx.font = `${sel ? 700 : 600} ${fs.toFixed(1)}px ${SANS}`;
      const half = (textWidth100(ctx, name, sel ? 700 : 600) * fs) / 200 + 1;
      const bx0 = c.cx - half,
        bx1 = c.cx + half,
        by0 = c.cy - fs * 0.55,
        by1 = c.cy + fs * 0.55;
      if (!sel && collides(bx0, by0, bx1, by1)) continue;
      occupy(bx0, by0, bx1, by1);
      ctx.lineWidth = Math.max(2, fs * 0.22);
      ctx.strokeStyle = p.labelHalo;
      ctx.strokeText(name, c.cx, c.cy);
      ctx.fillStyle = sel ? `rgb(${p.selPart[0]},${p.selPart[1]},${p.selPart[2]})` : other(m.parts.side[c.k]) ? p.labelDim : p.label;
      ctx.fillText(name, c.cx, c.cy);
      drawn++;
    }
  }

  if ((o.showPinLabels || o.showNetLabels) && pinIdx && o.showPins) {
    const minR = Math.min(view.scale * s.typicalPin, 1e9);
    if (minR > 3) {
      const ids = pinIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY);
      if (ids.length < 6000) {
        let drawn = 0;
        for (const i of ids) {
          if (drawn > 3000) break;
          if (other(m.pins.side[i]) && o.otherSide !== 'show') continue;
          const r = Math.min(s.pinHW[i], s.pinHH[i]) * view.scale;
          const R = Math.max(s.pinHW[i], s.pinHH[i]) * view.scale;
          if (r < 7) continue;
          const x = tx(m.pins.x[i], m.pins.y[i]),
            y = ty(m.pins.x[i], m.pins.y[i]);
          const num = m.pins.number[i] || m.pins.name[i];
          const net = m.pins.net[i] >= 0 ? m.nets.name[m.pins.net[i]] : '';
          const showNet = o.showNetLabels && net && r > 15;
          if (o.showPinLabels && num) {
            const fs = Math.min(r * 0.9, (2 * R * 0.85) / Math.max(1, num.length * 0.62), 18);
            if (fs >= 6) {
              ctx.font = `600 ${fs.toFixed(1)}px ${MONO}`;
              ctx.fillStyle = p.pinLabel;
              ctx.fillText(num, x, showNet ? y - fs * 0.45 : y);
              drawn++;
            }
          }
          if (showNet) {
            const fs = Math.min(r * 0.5, (2 * R * 0.95) / Math.max(1, net.length * 0.6), 13);
            if (fs >= 5.5) {
              ctx.font = `500 ${fs.toFixed(1)}px ${SANS}`;
              ctx.fillStyle = p.pinLabel;
              ctx.fillText(net, x, y + fs * 0.8);
            }
          }
        }
      }
    }
  }

  if (overlay.measure) {
    const { ax, ay, bx, by, label } = overlay.measure;
    const x1 = tx(ax, ay),
      y1 = ty(ax, ay),
      x2 = tx(bx, by),
      y2 = ty(bx, by);
    const mc = p.measure;
    ctx.strokeStyle = `rgb(${mc[0]},${mc[1]},${mc[2]})`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `600 12px ${MONO}`;
    const tw = ctx.measureText(label).width;
    const mx = (x1 + x2) / 2,
      my = (y1 + y2) / 2 - 14;
    ctx.fillStyle = p.labelHalo;
    ctx.fillRect(mx - tw / 2 - 6, my - 10, tw + 12, 20);
    ctx.fillStyle = `rgb(${mc[0]},${mc[1]},${mc[2]})`;
    ctx.fillText(label, mx, my);
  }
}
