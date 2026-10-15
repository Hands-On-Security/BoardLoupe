import Flatbush from 'flatbush';
import type { BoardModel } from '../model/types';
import { type View, fitView, panBy, screenToWorld, zoomAt } from '../render/camera';
import { Canvas2DRenderer } from '../render/canvas2d';
import { GLRenderer } from '../render/gl';
import { type Overlay, drawLabels } from '../render/labels';
import { DARK, LIGHT, type Palette } from '../render/palette';
import { type PickResult, pick } from '../render/pick';
import type { Hover, Renderer } from '../render/renderer';
import { type Highlight, type RenderOptions, DEFAULT_RENDER_OPTIONS, EMPTY_HIGHLIGHT, computeColors } from '../render/style';
import { ratsnest } from '../scene/ratsnest';
import type { Scene } from '../scene/scene';

type Listener = () => void;

export interface FrameStats {
  lastMs: number;
  avgMs: number;
  frames: number;
}

/**
 * Imperative viewer: owns renderer, camera, hover and overlay. UI components
 * talk to it through methods and subscribe to throttled change events, so
 * pan/zoom/hover never trigger a Preact re-render of the app tree.
 */
export class Viewer {
  model: BoardModel | null = null;
  scene: Scene | null = null;
  renderer: Renderer | null = null;
  rendererError: string | null = null;
  view: View = { cx: 0, cy: 0, scale: 1, rot: 0, mirror: false, width: 1, height: 1 };
  opts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS };
  highlight: Highlight = EMPTY_HIGHLIGHT;
  hover: Hover = { pin: -1, part: -1, via: -1 };
  overlay: Overlay = { measure: null };
  pinIdx: Flatbush | null = null;
  partIdx: Flatbush | null = null;
  viaIdx: Flatbush | null = null;
  stats: FrameStats = { lastMs: 0, avgMs: 0, frames: 0 };
  ratsSkipped: number[] = [];
  /** Mirror the view automatically when looking at the bottom side. */
  mirrorBottom = true;
  /** While true (after load or "Fit"), the board is re-fitted when the canvas resizes. */
  autoFit = true;
  /** Scale at the last fit, used to report zoom as a percentage. */
  fitScale = 1;

  private glCanvas: HTMLCanvasElement | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private overlayCtx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private dpr = 1;
  private listeners = new Map<string, Set<Listener>>();
  private colorsDirty = true;
  private viewEmitTimer = 0;

  get palette(): Palette {
    return this.opts.light ? LIGHT : DARK;
  }

  on(ev: 'view' | 'hover' | 'render' | 'opts', fn: Listener): () => void {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  private emit(ev: string) {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  attach(gl: HTMLCanvasElement, overlay: HTMLCanvasElement, forceCanvas2d = false) {
    this.overlayCanvas = overlay;
    this.overlayCtx = overlay.getContext('2d');
    this.renderer?.dispose();
    this.renderer = null;
    this.glCanvas = gl;
    if (!forceCanvas2d) {
      try {
        this.renderer = new GLRenderer(gl);
      } catch (e) {
        this.rendererError = (e as Error).message;
      }
    }
    if (!this.renderer) {
      // A canvas that failed to give a WebGL2 context can still give a 2D one only if
      // no context was created on it; use the overlay-sized replacement if needed.
      try {
        this.renderer = new Canvas2DRenderer(gl);
      } catch {
        const c = document.createElement('canvas');
        c.className = gl.className;
        gl.replaceWith(c);
        this.glCanvas = c;
        this.renderer = new Canvas2DRenderer(c);
      }
    }
    if (this.model && this.scene) {
      this.renderer.setScene(this.model, this.scene);
      this.colorsDirty = true;
    }
    this.requestRender();
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
    this.renderer = null;
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = dpr;
    this.view = { ...this.view, width: w, height: h };
    this.renderer?.resize(w, h, dpr);
    if (this.overlayCanvas) {
      this.overlayCanvas.width = Math.max(1, Math.round(w * dpr));
      this.overlayCanvas.height = Math.max(1, Math.round(h * dpr));
    }
    if (this.autoFit && this.model) this.fit();
    this.requestRender();
    this.emitView();
  }

  setBoard(m: BoardModel | null, s: Scene | null) {
    this.model = m;
    this.scene = s;
    this.highlight = EMPTY_HIGHLIGHT;
    this.hover = { pin: -1, part: -1, via: -1 };
    this.overlay = { measure: null };
    this.pinIdx = s?.pinIndex ? Flatbush.from(s.pinIndex) : null;
    this.partIdx = s?.partIndex ? Flatbush.from(s.partIndex) : null;
    this.viaIdx = s?.viaIndex ? Flatbush.from(s.viaIndex) : null;
    if (m && s) {
      this.renderer?.setScene(m, s);
      this.renderer?.setRatsnest(null);
      this.opts = { ...this.opts, side: 1, traceLayerMask: 0xffffffff };
      this.view = { ...this.view, rot: 0, mirror: false };
      this.colorsDirty = true;
      this.autoFit = true;
      if (this.view.width > 1) this.fit();
    }
    this.requestRender();
    this.emit('opts');
  }

  setOptions(p: Partial<RenderOptions>) {
    const prevSide = this.opts.side;
    this.opts = { ...this.opts, ...p };
    if (p.side !== undefined && p.side !== prevSide) {
      // Turn the board over: mirror horizontally around the current centre.
      this.view = { ...this.view, mirror: p.side === 2 && this.mirrorBottom };
      if (this.autoFit) this.fit();
    }
    this.colorsDirty = true;
    this.requestRender();
    this.emit('opts');
    this.emitView();
  }

  setHighlight(h: Highlight) {
    this.highlight = h;
    this.colorsDirty = true;
    this.updateRatsnest();
    this.requestRender();
  }

  updateRatsnest() {
    if (!this.model || !this.renderer) return;
    if (this.opts.showRatsnest && this.highlight.nets.length) {
      const r = ratsnest(this.model, this.highlight.nets);
      this.ratsSkipped = r.skipped;
      this.renderer.setRatsnest(r.segs.length ? r.segs : null);
    } else {
      this.ratsSkipped = [];
      this.renderer.setRatsnest(null);
    }
  }

  setView(v: Partial<View>) {
    this.autoFit = false;
    this.view = { ...this.view, ...v };
    this.requestRender();
    this.emitView();
  }

  minScale(): number {
    if (!this.model) return 1e-9;
    const b = this.model.bounds;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1e-9);
    return (Math.min(this.view.width, this.view.height) / size) * 0.05;
  }
  maxScale(): number {
    const tp = this.scene?.typicalPin || 1;
    return (Math.min(this.view.width, this.view.height) / tp) * 2;
  }

  fit(bounds = this.model?.bounds, padding = 36) {
    if (!bounds) return;
    this.view = fitView(this.view, bounds, padding);
    this.fitScale = this.view.scale;
    this.autoFit = bounds === this.model?.bounds;
    this.requestRender();
    this.emitView();
  }

  /** Fits a world rectangle but never zooms in past a comfortable level. */
  focus(b: { minX: number; minY: number; maxX: number; maxY: number }, maxZoomPinPx = 28) {
    this.autoFit = false;
    const tp = this.scene?.typicalPin || 1;
    const v = fitView(this.view, b, 80);
    const cap = maxZoomPinPx / tp;
    this.view = { ...v, scale: Math.min(v.scale, cap, this.maxScale()) };
    this.requestRender();
    this.emitView();
  }

  zoomBy(factor: number, sx = this.view.width / 2, sy = this.view.height / 2) {
    this.autoFit = false;
    this.view = zoomAt(this.view, factor, sx, sy, this.minScale(), this.maxScale());
    this.requestRender();
    this.emitView();
  }

  panBy(dx: number, dy: number) {
    this.autoFit = false;
    this.view = panBy(this.view, dx, dy);
    this.requestRender();
    this.emitView();
  }

  rotate(delta: 90 | -90) {
    const rot = (((this.view.rot + delta) % 360) + 360) % 360;
    this.view = { ...this.view, rot: rot as View['rot'] };
    if (this.autoFit) this.fit();
    this.requestRender();
    this.emitView();
  }

  toggleMirror() {
    this.view = { ...this.view, mirror: !this.view.mirror };
    this.requestRender();
    this.emitView();
  }

  setBottomMirror(enabled: boolean) {
    if (this.mirrorBottom === enabled) return;
    this.mirrorBottom = enabled;
    if (this.opts.side === 2 && this.view.mirror !== enabled) {
      this.view = { ...this.view, mirror: enabled };
      this.requestRender();
      this.emitView();
    }
  }

  pickAt(sx: number, sy: number): PickResult {
    if (!this.model || !this.scene) return null;
    return pick(this.model, this.scene, { pin: this.pinIdx, part: this.partIdx, via: this.viaIdx }, this.view, this.opts, sx, sy);
  }

  setHover(p: PickResult) {
    const h: Hover = { pin: p?.kind === 'pin' ? p.index : -1, part: p?.kind === 'part' ? p.index : -1, via: p?.kind === 'via' ? p.index : -1 };
    if (h.pin === this.hover.pin && h.part === this.hover.part && h.via === this.hover.via) return;
    this.hover = h;
    this.requestRender();
    this.emit('hover');
  }

  worldAt(sx: number, sy: number): [number, number] {
    return screenToWorld(this.view, sx, sy);
  }

  /**
   * Renders the current view (board, highlights and labels) at print
   * resolution and returns it as a PNG data URL. Optionally uses the light
   * palette for a print-friendly image. Everything happens synchronously in
   * one task, so the on-screen canvas never shows the intermediate frame and
   * the WebGL drawing buffer is still valid when it is read.
   *
   * With `aspect` (width / height) the image gets exactly that shape: the
   * rendered area is extended around the same centre and zoom, never cropped,
   * so everything visible on screen is in the image and the rest of the frame
   * shows more of the board instead of empty margins.
   */
  captureImage(
    o: { light?: boolean; minDpr?: number; aspect?: number; decorate?: (ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number) => void } = {},
  ): { url: string; width: number; height: number } | null {
    const r = this.renderer,
      gl = this.glCanvas,
      ov = this.overlayCanvas;
    if (!r || !gl || !this.model || !this.scene) return null;
    const prevView = this.view;
    const w0 = prevView.width,
      h0 = prevView.height;
    let w = w0,
      h = h0;
    if (o.aspect && o.aspect > 0 && w0 > 0 && h0 > 0) {
      if (w0 / h0 < o.aspect) w = h0 * o.aspect;
      else h = w0 / o.aspect;
    }
    const prevDpr = this.dpr,
      prevLight = this.opts.light;
    // At least 2x for print, but the longest side stays within 4096 px so the
    // drawing buffer is never silently clamped by the GPU.
    const dpr = Math.min(3, Math.max(o.minDpr ?? 2, prevDpr), 4096 / Math.max(w, h));
    const swapTheme = o.light !== undefined && o.light !== prevLight;
    const size = (cw: number, ch: number, d: number) => [Math.max(1, Math.round(cw * d)), Math.max(1, Math.round(ch * d))] as const;
    try {
      this.dpr = dpr;
      this.view = { ...prevView, width: w, height: h };
      r.resize(w, h, dpr);
      if (ov) [ov.width, ov.height] = size(w, h, dpr);
      if (swapTheme) {
        this.opts = { ...this.opts, light: !!o.light };
        this.colorsDirty = true;
      }
      this.renderNow();
      const [cw, ch] = size(w, h, dpr);
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const bg = this.palette.bg;
      ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(gl, 0, 0, cw, ch);
      if (ov) ctx.drawImage(ov, 0, 0, cw, ch);
      o.decorate?.(ctx, cw, ch, dpr);
      return { url: c.toDataURL('image/png'), width: cw, height: ch };
    } catch {
      return null;
    } finally {
      this.view = prevView;
      this.dpr = prevDpr;
      if (swapTheme) {
        this.opts = { ...this.opts, light: prevLight };
        this.colorsDirty = true;
      }
      r.resize(w0, h0, prevDpr);
      if (ov) [ov.width, ov.height] = size(w0, h0, prevDpr);
      this.renderNow();
    }
  }

  private emitView() {
    if (this.viewEmitTimer) return;
    this.viewEmitTimer = window.setTimeout(() => {
      this.viewEmitTimer = 0;
      this.emit('view');
    }, 50);
  }

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderNow();
    });
  }

  renderNow() {
    const r = this.renderer;
    if (!r) return;
    const t0 = performance.now();
    if (this.colorsDirty && this.model && this.scene) {
      r.setColors(computeColors(this.model, this.scene, this.opts, this.highlight, this.palette));
      this.colorsDirty = false;
    }
    r.render({ view: this.view, opts: this.opts, hover: this.hover, palette: this.palette, selPart: this.highlight.part });
    if (this.overlayCtx) {
      if (this.model && this.scene) {
        drawLabels(this.overlayCtx, this.dpr, this.view, this.model, this.scene, this.partIdx, this.pinIdx, this.opts, this.highlight, this.palette, this.overlay);
      } else {
        this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.overlayCtx.clearRect(0, 0, this.overlayCtx.canvas.width, this.overlayCtx.canvas.height);
      }
    }
    const dt = performance.now() - t0;
    this.stats.lastMs = dt;
    this.stats.avgMs = this.stats.frames ? this.stats.avgMs * 0.9 + dt * 0.1 : dt;
    this.stats.frames++;
    this.emit('render');
  }
}
