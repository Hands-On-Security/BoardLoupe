import { invert, viewMatrix } from '../render/camera';
import type { BoardModel } from '../model/types';
import type { Viewer } from './viewer';

export const MINIMAP_WIDTH = 184;

export interface MinimapCache {
  model: BoardModel;
  key: string;
  image: HTMLCanvasElement;
  height: number;
}

export function minimapLayout(viewer: Viewer) {
  const m = viewer.model;
  if (!m) return null;
  const b = m.bounds;
  const v = viewer.view;
  const swap = v.rot === 90 || v.rot === 270;
  const bw = (swap ? b.maxY - b.minY : b.maxX - b.minX) || 1;
  const bh = (swap ? b.maxX - b.minX : b.maxY - b.minY) || 1;
  const height = Math.max(60, Math.min(170, (MINIMAP_WIDTH * bh) / bw));
  const scale = Math.min((MINIMAP_WIDTH - 12) / bw, (height - 12) / bh);
  return { view: { ...v, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale, width: MINIMAP_WIDTH, height }, height };
}

/** Draw the board overview and current viewport for the viewer and reports. */
export function drawMinimap(canvas: HTMLCanvasElement, viewer: Viewer, cache: MinimapCache | null = null, dpr = Math.min(window.devicePixelRatio || 1, 2)): MinimapCache | null {
  const m = viewer.model,
    s = viewer.scene,
    layout = minimapLayout(viewer);
  if (!m || !s || !layout) return null;
  const { view: mv, height } = layout;
  const pal = viewer.palette;
  const key = `${mv.rot}:${mv.mirror}:${viewer.opts.side}:${viewer.opts.light}:${height}:${dpr}`;
  if (!cache || cache.model !== m || cache.key !== key) {
    const image = document.createElement('canvas');
    image.width = Math.round(MINIMAP_WIDTH * dpr);
    image.height = Math.round(height * dpr);
    const g = image.getContext('2d')!;
    g.fillStyle = `rgb(${pal.bg[0]},${pal.bg[1]},${pal.bg[2]})`;
    g.fillRect(0, 0, image.width, image.height);
    const M = viewMatrix(mv);
    g.setTransform(M[0] * dpr, M[1] * dpr, M[2] * dpr, M[3] * dpr, M[4] * dpr, M[5] * dpr);
    const px = 1 / mv.scale;
    g.lineWidth = px;
    g.strokeStyle = `rgba(${pal.body[0]},${pal.body[1]},${pal.body[2]},0.8)`;
    g.beginPath();
    for (let k = 0; k < m.parts.count; k++) {
      const side = m.parts.side[k];
      if ((side === 1 && viewer.opts.side === 2) || (side === 2 && viewer.opts.side === 1)) continue;
      const i0 = s.bodyStart[k] * 4,
        i1 = s.bodyStart[k + 1] * 4;
      for (let j = i0; j < i1; j += 4) {
        g.moveTo(s.bodySegs[j], s.bodySegs[j + 1]);
        g.lineTo(s.bodySegs[j + 2], s.bodySegs[j + 3]);
      }
    }
    g.stroke();
    g.strokeStyle = `rgb(${pal.outline[0]},${pal.outline[1]},${pal.outline[2]})`;
    g.lineWidth = 1.4 * px;
    g.beginPath();
    const o = m.outline.segs;
    for (let i = 0; i < o.length; i += 4) {
      g.moveTo(o[i], o[i + 1]);
      g.lineTo(o[i + 2], o[i + 3]);
    }
    g.stroke();
    cache = { model: m, key, image, height };
  }
  canvas.width = cache.image.width;
  canvas.height = cache.image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(cache.image, 0, 0);

  // Main-view screen corners → world → overview screen.
  const inv = invert(viewMatrix(viewer.view));
  const M = viewMatrix(mv);
  const v = viewer.view;
  const corners = [[0, 0], [v.width, 0], [v.width, v.height], [0, v.height]].map(([x, y]) => {
    const wx = inv[0] * x + inv[2] * y + inv[4],
      wy = inv[1] * x + inv[3] * y + inv[5];
    return [(M[0] * wx + M[2] * wy + M[4]) * dpr, (M[1] * wx + M[3] * wy + M[5]) * dpr];
  });
  const accent = pal.selNet;
  ctx.strokeStyle = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
  ctx.fillStyle = `rgba(${accent[0]},${accent[1]},${accent[2]},0.15)`;
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return cache;
}
