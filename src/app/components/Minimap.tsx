import { useEffect, useRef } from 'preact/hooks';
import { invert, viewMatrix } from '../../render/camera';
import { viewer } from '../actions';
import { store, useStore } from '../store';

const W = 184;

/**
 * Overview map: cached raster of outline + part bodies, with the current
 * viewport drawn on top. Click or drag to move the view. Respects the
 * current side/mirror/rotation so it always matches the main view.
 */
export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const boardId = useStore(store, (s) => s.board?.id ?? 0);
  const theme = useStore(store, (s) => s.prefs.theme);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    let cache: { key: string; img: HTMLCanvasElement; h: number } | null = null;

    const layout = () => {
      const m = viewer.model;
      if (!m) return null;
      const b = m.bounds;
      const v = viewer.view;
      const swap = v.rot === 90 || v.rot === 270;
      const bw = (swap ? b.maxY - b.minY : b.maxX - b.minX) || 1;
      const bh = (swap ? b.maxX - b.minX : b.maxY - b.minY) || 1;
      const h = Math.max(60, Math.min(170, (W * bh) / bw));
      const scale = Math.min((W - 12) / bw, (h - 12) / bh);
      // Minimap view: same orientation as the main view, fitted.
      const mv = { ...v, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale, width: W, height: h };
      return { mv, h };
    };

    const draw = () => {
      const m = viewer.model,
        s = viewer.scene;
      const L = layout();
      if (!m || !s || !L) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { mv, h } = L;
      const key = `${boardId}:${mv.rot}:${mv.mirror}:${viewer.opts.side}:${theme}:${h}`;
      if (!cache || cache.key !== key) {
        const img = document.createElement('canvas');
        img.width = W * dpr;
        img.height = h * dpr;
        const g = img.getContext('2d')!;
        const M = viewMatrix(mv);
        g.setTransform(M[0] * dpr, M[1] * dpr, M[2] * dpr, M[3] * dpr, M[4] * dpr, M[5] * dpr);
        const px = 1 / mv.scale;
        const pal = viewer.palette;
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
        cache = { key, img, h };
      }
      c.width = W * dpr;
      c.height = cache.h * dpr;
      c.style.height = `${cache.h}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(cache.img, 0, 0);
      // Viewport rectangle: main-view screen corners → world → minimap screen.
      const inv = invert(viewMatrix(viewer.view));
      const M = viewMatrix(mv);
      const v = viewer.view;
      const corners = [
        [0, 0],
        [v.width, 0],
        [v.width, v.height],
        [0, v.height],
      ].map(([x, y]) => {
        const wx = inv[0] * x + inv[2] * y + inv[4],
          wy = inv[1] * x + inv[3] * y + inv[5];
        return [(M[0] * wx + M[2] * wy + M[4]) * dpr, (M[1] * wx + M[3] * wy + M[5]) * dpr];
      });
      const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8b04a';
      ctx.strokeStyle = acc;
      ctx.fillStyle = acc + '22';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };

    const off1 = viewer.on('view', draw);
    const off2 = viewer.on('opts', () => {
      cache = null;
      draw();
    });
    draw();

    let dragging = false;
    const go = (e: PointerEvent) => {
      const L = layout();
      if (!L) return;
      const r = c.getBoundingClientRect();
      const inv = invert(viewMatrix(L.mv));
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      viewer.setView({ cx: inv[0] * x + inv[2] * y + inv[4], cy: inv[1] * x + inv[3] * y + inv[5] });
    };
    const down = (e: PointerEvent) => {
      dragging = true;
      c.setPointerCapture(e.pointerId);
      go(e);
    };
    const move = (e: PointerEvent) => dragging && go(e);
    const up = () => (dragging = false);
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    return () => {
      off1();
      off2();
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
    };
  }, [boardId, theme]);

  return (
    <div class="rounded-lg border border-line2 bg-panel/90 shadow-pop p-0 overflow-hidden" style={{ width: W }}>
      <canvas ref={ref} style={{ width: W, display: 'block', cursor: 'pointer', touchAction: 'none' }} aria-label="Minimap: click or drag to move the view" role="img" />
    </div>
  );
}
