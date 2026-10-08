import { ShieldCheck } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { unitLabel } from '../../model/types';
import { viewer } from '../actions';
import { formatCoord, formatLength } from '../format';
import { store, useStore } from '../store';
import { Badge } from './ui';

export function StatusBar() {
  const board = useStore(store, (s) => s.board);
  const tool = useStore(store, (s) => s.tool);
  const measure = useStore(store, (s) => s.measure);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    const onC = (e: Event) => setCursor((e as CustomEvent<[number, number]>).detail);
    window.addEventListener('bs-cursor', onC);
    const off = viewer.on('view', () => force((n) => n + 1));
    return () => {
      window.removeEventListener('bs-cursor', onC);
      off();
    };
  }, []);
  const m = board?.model;
  const zoom = m && board ? viewer.view.scale / viewer.fitScale : 0;
  return (
    <footer class="h-7 shrink-0 flex items-center gap-3 px-3 border-t border-line bg-panel text-[11.5px] text-muted" aria-label="Status bar">
      <span class="flex items-center gap-1 text-ok" title="All processing happens locally. No network requests, no telemetry.">
        <ShieldCheck size={13} /> Offline · local only
      </span>
      {m && (
        <>
          <span class="tabular font-mono w-[200px] truncate" title="Cursor position (board coordinates)">
            {cursor ? formatCoord(cursor[0], cursor[1], m.units) : '—'}
          </span>
          <span class="tabular" title="Zoom (100% = whole board fits)">
            {(zoom * 100).toFixed(0)}%
          </span>
          {tool === 'measure' && (
            <span class="text-accent tabular font-mono" data-testid="measure-readout">
              {measure.a && measure.b
                ? formatLength(Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]), m.units)
                : measure.a
                  ? 'Click the second point'
                  : 'Measure: click the first point (snaps to pins)'}
            </span>
          )}
          <span class="flex-1" />
          <span class="hidden lg:inline">{unitLabel(m.units)}</span>
          <span class="tabular">
            {m.parts.count.toLocaleString()} parts · {m.pins.count.toLocaleString()} pins · {m.nets.count.toLocaleString()} nets
          </span>
          <Badge title="Renderer">{viewer.renderer?.kind === 'webgl2' ? 'WebGL2' : 'Canvas 2D'}</Badge>
          <span class="tabular w-[64px] text-right hidden md:inline" title="Average frame time (CPU)">
            {viewer.stats.avgMs.toFixed(1)} ms
          </span>
        </>
      )}
      {!m && <span class="flex-1" />}
    </footer>
  );
}
