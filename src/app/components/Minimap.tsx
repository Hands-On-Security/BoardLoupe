import { useEffect, useRef } from 'preact/hooks';
import { invert, viewMatrix } from '../../render/camera';
import { viewer } from '../actions';
import { drawMinimap, minimapLayout, MINIMAP_WIDTH, type MinimapCache } from '../minimap-draw';
import { store, useStore } from '../store';

/** Board overview: click or drag to move the view. */
export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const boardId = useStore(store, (s) => s.board?.id ?? 0);
  const theme = useStore(store, (s) => s.prefs.theme);

  useEffect(() => {
    const c = ref.current!;
    let cache: MinimapCache | null = null;
    const draw = () => {
      cache = drawMinimap(c, viewer, cache);
      if (cache) c.style.height = `${cache.height}px`;
    };
    const off1 = viewer.on('view', draw);
    const off2 = viewer.on('opts', () => {
      cache = null;
      draw();
    });
    draw();

    let dragging = false;
    const go = (e: PointerEvent) => {
      const layout = minimapLayout(viewer);
      if (!layout) return;
      const r = c.getBoundingClientRect();
      const inv = invert(viewMatrix(layout.view));
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
    <div class="rounded-lg border border-line2 bg-panel/90 shadow-pop p-0 overflow-hidden" style={{ width: MINIMAP_WIDTH }}>
      <canvas ref={ref} style={{ width: MINIMAP_WIDTH, display: 'block', cursor: 'pointer', touchAction: 'none' }} aria-label="Minimap: click or drag to move the view" role="img" />
    </div>
  );
}
