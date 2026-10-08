import { Maximize, Minus, Plus } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BoardModel } from '../../model/types';
import { sideLabel } from '../../model/types';
import { clearSelection, selectNet, selectPart, selectPin, selectVia, viewer } from '../actions';
import { formatLength } from '../format';
import { store, useStore } from '../store';
import { Minimap } from './Minimap';
import { IconButton, cx } from './ui';

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

function tipFor(m: BoardModel, kind: 'pin' | 'part' | 'via', i: number): Omit<Tip, 'x' | 'y'> {
  if (kind === 'pin') {
    const k = m.pins.part[i];
    const n = m.pins.net[i];
    const num = m.pins.number[i] || '?';
    const title = k >= 0 ? `${m.parts.name[k]} · pin ${num}` : `Test point ${num}`;
    const lines = [n >= 0 ? `Net ${m.nets.name[n] || '(unnamed)'}` : 'No net'];
    if (m.pins.name[i] && m.pins.name[i] !== num) lines.push(`Name ${m.pins.name[i]}`);
    return { title, lines };
  }
  if (kind === 'via') {
    const n = m.vias.net[i];
    return { title: 'Via', lines: [n >= 0 ? `Net ${m.nets.name[n]}` : 'No net'] };
  }
  const lines = [`${m.parts.pinCount[i]} pins · ${sideLabel(m.parts.side[i])}`];
  if (m.parts.value[i]) lines.push(m.parts.value[i]!);
  return { title: m.parts.name[i] || '(unnamed part)', lines };
}

export function BoardCanvas() {
  const wrap = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [cursor, setCursor] = useState('board-cursor-grab');
  const tool = useStore(store, (s) => s.tool);
  const forceCanvas2d = useStore(store, (s) => s.prefs.forceCanvas2d);
  const minimap = useStore(store, (s) => s.prefs.minimap);
  const hasBoard = useStore(store, (s) => !!s.board);

  useEffect(() => {
    viewer.attach(glRef.current!, ovRef.current!, forceCanvas2d);
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      viewer.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, 3));
    });
    ro.observe(el);
    const mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDpr = () => {
      const r = el.getBoundingClientRect();
      viewer.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, 3));
    };
    mq?.addEventListener?.('change', onDpr);
    return () => {
      ro.disconnect();
      mq?.removeEventListener?.('change', onDpr);
      viewer.detach();
    };
  }, [forceCanvas2d]);

  // --- interaction -----------------------------------------------------------
  useEffect(() => {
    const el = ovRef.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; t: number; moved: boolean; button: number } | null = null;
    let last = { x: 0, y: 0, t: 0 };
    let vel = { x: 0, y: 0 };
    let inertia = 0;
    let pinch: { d: number; cx: number; cy: number } | null = null;
    let hoverRaf = 0;
    let lastMove: { x: number; y: number } | null = null;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const stopInertia = () => {
      if (inertia) cancelAnimationFrame(inertia);
      inertia = 0;
    };
    const updateHover = () => {
      hoverRaf = 0;
      if (!lastMove || down || pinch) return;
      const m = viewer.model;
      if (!m) return;
      const p = viewer.pickAt(lastMove.x, lastMove.y);
      viewer.setHover(p);
      if (p) {
        setTip({ x: lastMove.x, y: lastMove.y, ...tipFor(m, p.kind, p.index) });
        setCursor(store.get().tool === 'measure' ? 'board-cursor-crosshair' : 'board-cursor-pointer');
      } else {
        setTip(null);
        setCursor(store.get().tool === 'measure' ? 'board-cursor-crosshair' : 'board-cursor-grab');
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!viewer.model) return;
      e.preventDefault();
      stopInertia();
      const p = local(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit,
        dx = e.deltaX * unit;
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch (reported as ctrl+wheel) or explicit modifier zoom.
        viewer.zoomBy(Math.exp(-dy * 0.01), p.x, p.y);
      } else if (Math.abs(dx) > Math.abs(dy) * 0.5 && Math.abs(dx) > 0) {
        viewer.panBy(-dx, -dy);
      } else {
        viewer.zoomBy(Math.exp(-dy * 0.0022), p.x, p.y);
      }
      setTip(null);
    };

    const onDown = (e: PointerEvent) => {
      if (!viewer.model) return;
      stopInertia();
      el.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        down = null;
        return;
      }
      down = { x: p.x, y: p.y, t: performance.now(), moved: false, button: e.button };
      last = { x: p.x, y: p.y, t: performance.now() };
      vel = { x: 0, y: 0 };
      setTip(null);
    };

    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2,
          cy = (a.y + b.y) / 2;
        viewer.panBy(cx - pinch.cx, cy - pinch.cy);
        if (pinch.d > 0) viewer.zoomBy(d / pinch.d, cx, cy);
        pinch = { d, cx, cy };
        return;
      }
      if (down) {
        const dx = p.x - last.x,
          dy = p.y - last.y;
        if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > 4) {
          down.moved = true;
          setCursor('board-cursor-grabbing');
        }
        if (down.moved) {
          viewer.panBy(dx, dy);
          const now = performance.now();
          const dt = Math.max(1, now - last.t);
          vel = { x: 0.8 * (dx / dt) + 0.2 * vel.x, y: 0.8 * (dy / dt) + 0.2 * vel.y };
          last = { x: p.x, y: p.y, t: now };
        }
        return;
      }
      lastMove = p;
      const s = store.get();
      if (s.tool === 'measure' && s.measure.a && !s.measure.b && viewer.model) {
        const [wx, wy] = viewer.worldAt(p.x, p.y);
        viewer.overlay = { measure: measureOverlay(viewer.model, s.measure.a, [wx, wy]) };
        viewer.requestRender();
      }
      if (!hoverRaf) hoverRaf = requestAnimationFrame(updateHover);
      window.dispatchEvent(new CustomEvent('bs-cursor', { detail: viewer.worldAt(p.x, p.y) }));
    };

    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        return;
      }
      const d = down;
      down = null;
      if (!d) return;
      const p = local(e);
      setCursor(store.get().tool === 'measure' ? 'board-cursor-crosshair' : 'board-cursor-grab');
      if (d.moved) {
        // Inertial glide (skipped for reduced motion or a slow release).
        const speed = Math.hypot(vel.x, vel.y);
        if (!reduced && speed > 0.25 && performance.now() - last.t < 60) {
          let vx = vel.x * 16,
            vy = vel.y * 16;
          const step = () => {
            vx *= 0.9;
            vy *= 0.9;
            viewer.panBy(vx, vy);
            inertia = Math.hypot(vx, vy) > 0.4 ? requestAnimationFrame(step) : 0;
          };
          inertia = requestAnimationFrame(step);
        }
        return;
      }
      if (d.button !== 0) return;
      onClick(p.x, p.y, e.shiftKey || e.metaKey || e.ctrlKey);
    };

    const onClick = (x: number, y: number, additive: boolean) => {
      const m = viewer.model;
      if (!m) return;
      const s = store.get();
      if (s.tool === 'measure') {
        const pk = viewer.pickAt(x, y);
        // Snap to pin/via centres for precise measurements.
        let w = viewer.worldAt(x, y);
        if (pk?.kind === 'pin') w = [m.pins.x[pk.index], m.pins.y[pk.index]];
        else if (pk?.kind === 'via') w = [m.vias.x[pk.index], m.vias.y[pk.index]];
        if (!s.measure.a || s.measure.b) {
          store.set({ measure: { a: w, b: null } });
          viewer.overlay = { measure: measureOverlay(m, w, w) };
        } else {
          store.set({ measure: { a: s.measure.a, b: w } });
          viewer.overlay = { measure: measureOverlay(m, s.measure.a, w) };
        }
        viewer.requestRender();
        return;
      }
      const pk = viewer.pickAt(x, y);
      if (!pk) {
        if (!additive) clearSelection();
        return;
      }
      if (pk.kind === 'pin') {
        if (additive) {
          const n = m.pins.net[pk.index];
          if (n >= 0) selectNet(n, false, true);
        } else selectPin(pk.index, false);
      } else if (pk.kind === 'via') selectVia(pk.index);
      else selectPart(pk.index, false, additive);
    };

    const onDbl = (e: MouseEvent) => {
      if (!viewer.model || store.get().tool === 'measure') return;
      const p = local(e);
      viewer.zoomBy(2, p.x, p.y);
    };
    const onLeave = () => {
      lastMove = null;
      viewer.setHover(null);
      setTip(null);
    };
    const onContext = (e: Event) => e.preventDefault();

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('contextmenu', onContext);
    return () => {
      stopInertia();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('dblclick', onDbl);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('contextmenu', onContext);
    };
  }, []);

  useEffect(() => {
    setCursor(tool === 'measure' ? 'board-cursor-crosshair' : 'board-cursor-grab');
    if (tool !== 'measure') {
      viewer.overlay = { measure: null };
      viewer.requestRender();
    }
  }, [tool]);

  return (
    <div ref={wrap} class="absolute inset-0 overflow-hidden bg-canvas" data-testid="board">
      <canvas ref={glRef} class="absolute inset-0 w-full h-full" aria-hidden="true" />
      <canvas
        ref={ovRef}
        class={cx('absolute inset-0 w-full h-full touch-none', cursor)}
        role="img"
        aria-label="Board view. Drag to pan, scroll to zoom, click to select."
        data-testid="board-canvas"
      />
      {tip && (
        <div
          class="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-line2 bg-raised/95 shadow-pop px-2.5 py-1.5 text-[12px]"
          style={{ left: Math.min(tip.x + 14, (wrap.current?.clientWidth ?? 9999) - 290), top: tip.y + 16 }}
          role="tooltip"
        >
          <div class="font-semibold text-fg font-mono">{tip.title}</div>
          {tip.lines.map((l) => (
            <div class="text-muted truncate" key={l}>
              {l}
            </div>
          ))}
        </div>
      )}
      {hasBoard && (
        <div class="absolute right-3 bottom-3 flex flex-col items-end gap-2 z-10">
          <div class="flex flex-col rounded-lg border border-line2 bg-panel/90 shadow-pop overflow-hidden">
            <IconButton label="Zoom in" shortcut="+" onClick={() => viewer.zoomBy(1.6)}>
              <Plus size={16} />
            </IconButton>
            <IconButton label="Zoom out" shortcut="−" onClick={() => viewer.zoomBy(1 / 1.6)}>
              <Minus size={16} />
            </IconButton>
            <IconButton label="Fit board" shortcut="F" onClick={() => viewer.fit()}>
              <Maximize size={15} />
            </IconButton>
          </div>
          {minimap && <Minimap />}
        </div>
      )}
    </div>
  );
}

export function measureOverlay(m: BoardModel, a: [number, number], b: [number, number]) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dx = Math.abs(b[0] - a[0]),
    dy = Math.abs(b[1] - a[1]);
  const label = `${formatLength(d, m.units)}   Δx ${formatLength(dx, m.units, true)}  Δy ${formatLength(dy, m.units, true)}`;
  return { ax: a[0], ay: a[1], bx: b[0], by: b[1], label };
}
