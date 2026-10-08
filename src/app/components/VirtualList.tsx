import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * Fixed-row-height virtual list. Renders only visible rows, so lists with
 * 100k entries stay instant. `active` is kept scrolled into view (keyboard nav).
 */
export function VirtualList({
  count,
  rowHeight,
  render,
  active = -1,
  class: cls = '',
  overscan = 8,
  label,
  onKeyDown,
  id,
}: {
  count: number;
  rowHeight: number;
  render: (i: number) => ComponentChildren;
  active?: number;
  class?: string;
  overscan?: number;
  label?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || active < 0) return;
    const y = active * rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + rowHeight - el.clientHeight;
  }, [active, rowHeight]);

  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  const rows: ComponentChildren[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div key={i} style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>
        {render(i)}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      id={id}
      role="listbox"
      aria-label={label}
      tabIndex={count ? 0 : -1}
      onKeyDown={onKeyDown}
      class={`relative overflow-auto scroll-thin outline-none ${cls}`}
      onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: count * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
