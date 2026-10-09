import Flatbush from 'flatbush';
import type { BoardModel } from '../model/types';
import { SHAPE_OBLONG, SHAPE_RECT, SHAPE_ROUNDRECT } from '../model/types';
import type { Scene } from '../scene/scene';
import { viewMatrix, visibleWorldRect } from './camera';
import type { FrameInput, Renderer } from './renderer';
import type { Colors } from './style';

/**
 * Canvas 2D fallback renderer (used when WebGL2 is unavailable). Draws only
 * what intersects the viewport (flatbush queries) and degrades tiny pads to
 * single-pixel dots, so it stays usable on large boards.
 */
export class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d' as const;
  private ctx: CanvasRenderingContext2D;
  private model: BoardModel | null = null;
  private scene: Scene | null = null;
  private colors: Colors | null = null;
  private rats: Float64Array | null = null;
  private pinIdx: Flatbush | null = null;
  private partIdx: Flatbush | null = null;
  private viaIdx: Flatbush | null = null;
  private traceIdx: Flatbush | null = null;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
  }

  setScene(m: BoardModel, s: Scene) {
    this.model = m;
    this.scene = s;
    this.pinIdx = s.pinIndex ? Flatbush.from(s.pinIndex) : null;
    this.partIdx = s.partIndex ? Flatbush.from(s.partIndex) : null;
    this.viaIdx = s.viaIndex ? Flatbush.from(s.viaIndex) : null;
    this.traceIdx = s.traceIndex ? Flatbush.from(s.traceIndex) : null;
  }
  setColors(c: Colors) {
    this.colors = c;
  }
  setRatsnest(segs: Float64Array | null) {
    this.rats = segs;
  }
  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)),
      h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(f: FrameInput) {
    const { ctx } = this;
    const { view, opts, palette } = f;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgb(${palette.bg[0]},${palette.bg[1]},${palette.bg[2]})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const m = this.model,
      s = this.scene,
      c = this.colors;
    if (!m || !s || !c) return;
    const M = viewMatrix(view);
    const d = this.dpr;
    // World transform (lines are drawn with screen-constant widths via lineWidth / scale).
    ctx.setTransform(M[0] * d, M[1] * d, M[2] * d, M[3] * d, M[4] * d, M[5] * d);
    const px = 1 / view.scale; // one CSS px in world units
    const vr = visibleWorldRect(view, 20);
    const ghostA = opts.otherSide === 'hide' ? 0 : opts.otherSide === 'show' ? 1 : 0.22;
    const isOther = (side: number) => (side === 1 && opts.side === 2) || (side === 2 && opts.side === 1);
    const rgba = (a: Uint8Array, i: number, mul = 1) => `rgba(${a[4 * i]},${a[4 * i + 1]},${a[4 * i + 2]},${((a[4 * i + 3] / 255) * mul).toFixed(3)})`;

    for (const pass of [0, 1]) {
      const want = (side: number) => (pass === 0 ? isOther(side) : !isOther(side));
      const mul = pass === 0 ? ghostA : 1;
      if (mul === 0) continue;
      if (opts.showTraces && this.traceIdx) {
        const ids = this.traceIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY);
        ctx.lineCap = 'round';
        for (const i of ids) {
          const l = m.traces.layer[i];
          if (l < 32 && !((opts.traceLayerMask >>> l) & 1)) continue;
          if (pass === 0) continue;
          ctx.strokeStyle = rgba(c.trace, i);
          ctx.lineWidth = Math.max(m.traces.width[i], 0.6 * px);
          ctx.beginPath();
          ctx.moveTo(m.traces.segs[4 * i], m.traces.segs[4 * i + 1]);
          ctx.lineTo(m.traces.segs[4 * i + 2], m.traces.segs[4 * i + 3]);
          ctx.stroke();
        }
      }
      if (opts.showVias && this.viaIdx && pass === 1) {
        for (const i of this.viaIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY)) {
          const r = Math.max(m.vias.d[i] > 0 ? m.vias.d[i] / 2 : s.typicalPin * 0.6, 0.75 * px);
          ctx.strokeStyle = rgba(c.via, i);
          ctx.lineWidth = r * 0.5;
          ctx.beginPath();
          ctx.arc(m.vias.x[i], m.vias.y[i], r * 0.72, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (opts.showBodies && this.partIdx) {
        ctx.lineWidth = 1.25 * px;
        for (const k of this.partIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY)) {
          if (!want(m.parts.side[k] || 3)) continue;
          ctx.strokeStyle = rgba(c.part, k, mul);
          // Mechanical outlines (mounting holes, fiducials) are keep-outs: dashed.
          ctx.setLineDash(s.bodyDashed[k] ? [4 * px, 4 * px] : []);
          ctx.beginPath();
          for (let j = s.bodyStart[k]; j < s.bodyStart[k + 1]; j++) {
            ctx.moveTo(s.bodySegs[4 * j], s.bodySegs[4 * j + 1]);
            ctx.lineTo(s.bodySegs[4 * j + 2], s.bodySegs[4 * j + 3]);
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      if (opts.showPins && this.pinIdx) {
        const ids = this.pinIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY);
        for (const i of ids) {
          if (!want(m.pins.side[i] || 3)) continue;
          if (c.pin[4 * i + 3] === 0) continue;
          ctx.fillStyle = rgba(c.pin, i, mul);
          const hw = Math.max(s.pinHW[i], 0.75 * px),
            hh = Math.max(s.pinHH[i], 0.75 * px);
          const x = m.pins.x[i],
            y = m.pins.y[i];
          if (Math.max(hw, hh) * view.scale < 1.5) {
            ctx.fillRect(x - hw, y - hh, 2 * hw, 2 * hh);
            continue;
          }
          const sh = m.pins.shape[i];
          ctx.beginPath();
          if (sh === SHAPE_RECT || sh === SHAPE_ROUNDRECT || sh === SHAPE_OBLONG) {
            const rot = (m.pins.rot[i] * Math.PI) / 180;
            if (rot) {
              ctx.save();
              ctx.translate(x, y);
              ctx.rotate(rot);
              ctx.rect(-hw, -hh, 2 * hw, 2 * hh);
              ctx.restore();
            } else ctx.rect(x - hw, y - hh, 2 * hw, 2 * hh);
          } else ctx.arc(x, y, Math.min(hw, hh), 0, Math.PI * 2);
          ctx.fill();

          if (i === f.hover.pin) {
            ctx.strokeStyle = opts.light ? '#000' : '#fff';
            ctx.lineWidth = 1.5 * px;
            ctx.stroke();
          }

        }
      }
    }
    // Drill holes after all pads (both sides), so overlapping copper never hides a drill.
    if (opts.showPins && this.pinIdx) {
      ctx.fillStyle = `rgb(${palette.bg[0]},${palette.bg[1]},${palette.bg[2]})`;
      ctx.strokeStyle = `rgb(${palette.holeEdge[0]},${palette.holeEdge[1]},${palette.holeEdge[2]})`;
      ctx.lineWidth = px;
      for (const i of this.pinIdx.search(vr.minX, vr.minY, vr.maxX, vr.maxY)) {
        if (!(m.pins.hole[i] > 0) || c.pin[4 * i + 3] === 0) continue;
        const hr = Math.min(m.pins.hole[i] / 2, Math.min(s.pinHW[i], s.pinHH[i]));
        if (hr * view.scale <= 0.75) continue;
        ctx.beginPath();
        ctx.arc(m.pins.x[i], m.pins.y[i], hr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (opts.showOutline && m.outline.segs.length) {
      const o = m.outline.segs;
      const oc = m.outline.source === 'derived' ? palette.outlineDerived : palette.outline;
      ctx.strokeStyle = `rgba(${oc[0]},${oc[1]},${oc[2]},1)`;
      ctx.lineWidth = 1.6 * px;
      ctx.setLineDash(m.outline.source === 'derived' ? [6 * px, 6 * px] : []);
      ctx.beginPath();
      for (let i = 0; i < o.length; i += 4) {
        ctx.moveTo(o[i], o[i + 1]);
        ctx.lineTo(o[i + 2], o[i + 3]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.rats) {
      const r = this.rats;
      const rc = palette.ratsnest;
      ctx.strokeStyle = `rgba(${rc[0]},${rc[1]},${rc[2]},${rc[3] / 255})`;
      ctx.lineWidth = 1.2 * px;
      ctx.setLineDash([5 * px, 5 * px]);
      ctx.beginPath();
      for (let i = 0; i < r.length; i += 4) {
        ctx.moveTo(r[i], r[i + 1]);
        ctx.lineTo(r[i + 2], r[i + 3]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  dispose() {}
}
