import { CircuitBoard, Cpu, FileText, Search, Spline, X } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { NETFLAG_GROUND, NETFLAG_NOCONNECT, NETFLAG_POWER, unitLabel } from '../../model/types';
import { type SearchHit, collator } from '../../search/search';
import { selectNet, selectPart, selectPin } from '../actions';
import { formatBytes, plural } from '../format';
import { type Panel, store, useStore } from '../store';
import { Badge, Field, SectionTitle, cx } from './ui';
import { VirtualList } from './VirtualList';

const TABS: { id: Panel; label: string; icon: typeof Search }[] = [
  { id: 'search', label: 'Search', icon: Search },
  { id: 'parts', label: 'Parts', icon: Cpu },
  { id: 'nets', label: 'Nets', icon: Spline },
  { id: 'info', label: 'File', icon: FileText },
];

export function Sidebar() {
  const panel = useStore(store, (s) => s.panel);
  return (
    <aside class="w-[300px] shrink-0 border-r border-line bg-panel flex flex-col min-h-0" aria-label="Explorer">
      <div role="tablist" class="flex items-center gap-0.5 px-2 h-10 border-b border-line shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={panel === t.id}
            id={`tab-${t.id}`}
            class={cx('flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12.5px] font-medium transition-colors', panel === t.id ? 'bg-raised text-fg' : 'text-muted hover:text-fg')}
            onClick={() => store.set({ panel: t.id })}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>
      <div class="flex-1 min-h-0 flex flex-col" role="tabpanel" aria-labelledby={`tab-${panel}`}>
        {panel === 'search' && <SearchPanel />}
        {panel === 'parts' && <PartsPanel />}
        {panel === 'nets' && <NetsPanel />}
        {panel === 'info' && <InfoPanel />}
      </div>
    </aside>
  );
}

function FilterInput({ value, onInput, placeholder, inputRef, onKeyDown, id }: { value: string; onInput: (v: string) => void; placeholder: string; inputRef?: { current: HTMLInputElement | null }; onKeyDown?: (e: KeyboardEvent) => void; id?: string }) {
  return (
    <div class="relative px-2.5 pt-2.5 pb-2 shrink-0">
      <Search size={14} class="absolute left-5 top-[19px] text-faint pointer-events-none" />
      <input
        ref={inputRef}
        id={id}
        type="search"
        spellcheck={false}
        autocomplete="off"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
        class="w-full h-8 pl-8 pr-8 rounded-md bg-panel2 border border-line2 text-[13px] text-fg placeholder:text-faint focus:border-accent outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button aria-label="Clear" class="absolute right-4 top-[17px] text-faint hover:text-fg" onClick={() => onInput('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

const KIND_STYLE: Record<string, string> = {
  part: 'text-part border-part/40',
  net: 'text-net border-net/40',
  pin: 'text-info border-info/40',
};

function HitRow({ h, active, onClick }: { h: SearchHit; active: boolean; onClick: () => void }) {
  return (
    <button
      role="option"
      aria-selected={active}
      class={cx('w-full h-full flex items-center gap-2 px-2.5 text-left rounded-md mx-0', active ? 'bg-accent-soft' : 'hover:bg-raised')}
      onClick={onClick}
      tabIndex={-1}
    >
      <span class={cx('w-9 shrink-0 text-center text-[10px] font-semibold uppercase rounded border py-px', KIND_STYLE[h.kind])}>{h.kind}</span>
      <span class="flex-1 min-w-0">
        <span class="block truncate font-mono text-[12.5px] text-fg">{h.label}</span>
        <span class="block truncate text-[11px] text-faint">
          {h.detail}
          {h.via && h.via !== 'fuzzy' ? ` · matched ${h.via}` : ''}
        </span>
      </span>
    </button>
  );
}

export function activateHit(h: SearchHit) {
  if (h.kind === 'part') selectPart(h.index);
  else if (h.kind === 'net') selectNet(h.index);
  else selectPin(h.index);
}

function SearchPanel() {
  const board = useStore(store, (s) => s.board);
  const text = useStore(store, (s) => s.searchText);
  const sel = useStore(store, (s) => s.sel);
  const [q, setQ] = useState(text);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [ms, setMs] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onFocus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('bs-focus-search', onFocus);
    return () => window.removeEventListener('bs-focus-search', onFocus);
  }, []);

  useEffect(() => {
    if (!board) return;
    const t = setTimeout(() => {
      const t0 = performance.now();
      const ctx = sel.kind === 'part' ? sel.index : sel.kind === 'pin' ? board.model.pins.part[sel.index] : -1;
      setHits(board.search.query(q, 200, ctx));
      setMs(performance.now() - t0);
      setActive(0);
      store.set({ searchText: q });
    }, 60);
    return () => clearTimeout(t);
  }, [q, board]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      activateHit(hits[active]);
    } else if (e.key === 'Escape') {
      if (q) {
        e.stopPropagation();
        setQ('');
      } else (e.target as HTMLElement).blur();
    }
  };

  if (!board) return <NoBoard />;
  return (
    <>
      <FilterInput id="bs-search" inputRef={inputRef} value={q} onInput={setQ} placeholder="Search parts, nets, pins…" onKeyDown={onKey} />
      {!q ? (
        <div class="px-4 py-3 text-[12.5px] text-muted space-y-3">
          <p>Find components, nets and pins. Ranked by exact, prefix, substring and fuzzy match.</p>
          <div class="flex flex-wrap gap-1.5">
            {exampleQueries(board.model).map((ex) => (
              <button key={ex} class="h-6 px-2 rounded border border-line2 font-mono text-[11.5px] hover:bg-raised text-fg" onClick={() => setQ(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <ul class="text-faint text-[12px] space-y-1 list-disc pl-4">
            <li>
              <span class="font-mono text-muted">U12.4</span> or <span class="font-mono text-muted">U12 pin 4</span> — a specific pin
            </li>
            <li>
              <span class="font-mono text-muted">pin 17</span> — pin 17 of the selected part, then others
            </li>
            <li>Enter jumps to the result, ↑/↓ to move.</li>
          </ul>
        </div>
      ) : (
        <>
          <div class="px-3 pb-1 text-[11px] text-faint flex justify-between shrink-0" aria-live="polite">
            <span>{hits.length ? `${hits.length >= 200 ? '200+' : hits.length} results` : 'No matches'}</span>
            <span class="tabular">{ms.toFixed(1)} ms</span>
          </div>
          <VirtualList
            class="flex-1 px-1.5 pb-2"
            count={hits.length}
            rowHeight={40}
            active={active}
            label="Search results"
            render={(i) => <HitRow h={hits[i]} active={i === active} onClick={() => (setActive(i), activateHit(hits[i]))} />}
          />
        </>
      )}
    </>
  );
}

function exampleQueries(m: import('../../model/types').BoardModel): string[] {
  const out: string[] = [];
  const pick = (re: RegExp) => m.parts.name.find((n) => re.test(n));
  for (const re of [/^U\d+$/i, /^R\d+$/i, /^C\d+$/i]) {
    const n = pick(re);
    if (n) out.push(n);
  }
  const gnd = m.nets.name.find((n) => /^GND$/i.test(n)) ?? m.nets.name.find((n) => /GND/i.test(n));
  if (gnd) out.push(gnd);
  const pwr = m.nets.name.find((n) => /^\+?\d+V\d*/i.test(n) || /^PP/i.test(n) || /^VCC/i.test(n));
  if (pwr) out.push(pwr);
  if (out.length < 3 && m.parts.count) out.push(m.parts.name[0]);
  return out.slice(0, 6);
}

function NoBoard() {
  return <div class="p-4 text-[12.5px] text-faint">Open a boardview file to explore its parts and nets.</div>;
}

function PartsPanel() {
  const board = useStore(store, (s) => s.board);
  const sel = useStore(store, (s) => s.sel);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'name' | 'pins'>('name');
  const order = useMemo(() => {
    if (!board) return [];
    const m = board.model;
    const ql = q.trim().toLowerCase();
    const idx: number[] = [];
    for (let k = 0; k < m.parts.count; k++) {
      if (!ql || m.parts.name[k].toLowerCase().includes(ql) || (m.parts.value[k] ?? '').toLowerCase().includes(ql)) idx.push(k);
    }
    if (sort === 'name') idx.sort((a, b) => collator.compare(m.parts.name[a], m.parts.name[b]));
    else idx.sort((a, b) => m.parts.pinCount[b] - m.parts.pinCount[a] || collator.compare(m.parts.name[a], m.parts.name[b]));
    return idx;
  }, [board, q, sort]);
  if (!board) return <NoBoard />;
  const m = board.model;
  const activeRow = sel.kind === 'part' ? order.indexOf(sel.index) : -1;
  return (
    <>
      <FilterInput value={q} onInput={setQ} placeholder="Filter parts" />
      <div class="flex items-center justify-between px-3 pb-1.5 text-[11px] text-faint shrink-0">
        <span>{plural(order.length, 'part')}</span>
        <label class="flex items-center gap-1">
          Sort
          <select class="bg-panel2 border border-line2 rounded px-1 h-6 text-muted" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'name' | 'pins')}>
            <option value="name">Name</option>
            <option value="pins">Pin count</option>
          </select>
        </label>
      </div>
      <VirtualList
        class="flex-1 px-1.5 pb-2"
        count={order.length}
        rowHeight={30}
        active={activeRow}
        label="Parts"
        render={(i) => {
          const k = order[i];
          return (
            <button
              role="option"
              aria-selected={i === activeRow}
              class={cx('w-full h-full flex items-center gap-2 px-2.5 rounded-md text-left', i === activeRow ? 'bg-accent-soft' : 'hover:bg-raised')}
              onClick={(e) => selectPart(k, true, e.shiftKey || e.metaKey || e.ctrlKey)}
              tabIndex={-1}
            >
              <span class="font-mono text-[12.5px] text-fg w-20 truncate">{m.parts.name[k] || '—'}</span>
              <span class="flex-1 truncate text-[11.5px] text-faint">{m.parts.value[k] ?? ''}</span>
              <span class="text-[11px] text-faint tabular">{m.parts.pinCount[k]}</span>
              <span class={cx('text-[10px] w-4 text-center', m.parts.side[k] === 2 ? 'text-info' : 'text-muted')} title={m.parts.side[k] === 2 ? 'Bottom' : m.parts.side[k] === 1 ? 'Top' : 'Both'}>
                {m.parts.side[k] === 2 ? 'B' : m.parts.side[k] === 1 ? 'T' : '±'}
              </span>
            </button>
          );
        }}
      />
    </>
  );
}

function NetsPanel() {
  const board = useStore(store, (s) => s.board);
  const sel = useStore(store, (s) => s.sel);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'name' | 'pins'>('name');
  const order = useMemo(() => {
    if (!board) return [];
    const m = board.model;
    const ql = q.trim().toLowerCase();
    const idx: number[] = [];
    for (let n = 0; n < m.nets.count; n++) if (!ql || m.nets.name[n].toLowerCase().includes(ql)) idx.push(n);
    const cnt = (n: number) => m.nets.pinStart[n + 1] - m.nets.pinStart[n];
    if (sort === 'name') idx.sort((a, b) => collator.compare(m.nets.name[a], m.nets.name[b]));
    else idx.sort((a, b) => cnt(b) - cnt(a) || collator.compare(m.nets.name[a], m.nets.name[b]));
    return idx;
  }, [board, q, sort]);
  if (!board) return <NoBoard />;
  const m = board.model;
  const activeRow = sel.kind === 'net' ? order.indexOf(sel.index) : -1;
  return (
    <>
      <FilterInput value={q} onInput={setQ} placeholder="Filter nets" />
      <div class="flex items-center justify-between px-3 pb-1.5 text-[11px] text-faint shrink-0">
        <span>{plural(order.length, 'net')}</span>
        <label class="flex items-center gap-1">
          Sort
          <select class="bg-panel2 border border-line2 rounded px-1 h-6 text-muted" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'name' | 'pins')}>
            <option value="name">Name</option>
            <option value="pins">Pin count</option>
          </select>
        </label>
      </div>
      <VirtualList
        class="flex-1 px-1.5 pb-2"
        count={order.length}
        rowHeight={30}
        active={activeRow}
        label="Nets"
        render={(i) => {
          const n = order[i];
          const f = m.nets.flags[n];
          return (
            <button
              role="option"
              aria-selected={i === activeRow}
              class={cx('w-full h-full flex items-center gap-2 px-2.5 rounded-md text-left', i === activeRow ? 'bg-accent-soft' : 'hover:bg-raised')}
              onClick={(e) => selectNet(n, true, e.shiftKey || e.metaKey || e.ctrlKey)}
              tabIndex={-1}
            >
              <span class={cx('w-1.5 h-1.5 rounded-full shrink-0', f & NETFLAG_GROUND ? 'bg-ok' : f & NETFLAG_POWER ? 'bg-err' : f & NETFLAG_NOCONNECT ? 'bg-faint' : 'bg-net')} />
              <span class="flex-1 font-mono text-[12.5px] text-fg truncate">{m.nets.name[n]}</span>
              <span class="text-[11px] text-faint tabular">{m.nets.pinStart[n + 1] - m.nets.pinStart[n]}</span>
            </button>
          );
        }}
      />
    </>
  );
}

const STATUS_TONE = { verified: 'ok', partial: 'warn', experimental: 'warn', diagnostic: 'err' } as const;

function InfoPanel() {
  const board = useStore(store, (s) => s.board);
  if (!board) return <NoBoard />;
  const m = board.model;
  const src = m.source;
  const caps = m.caps;
  const yes = (b: boolean) => (b ? <span class="text-ok">yes</span> : <span class="text-faint">no</span>);
  return (
    <div class="flex-1 overflow-auto scroll-thin pb-4">
      <SectionTitle>File</SectionTitle>
      <dl>
        <Field label="Name">
          <span class="font-mono text-[12px]">{src.fileName}</span>
        </Field>
        {src.extraFiles.length > 0 && <Field label="With">{src.extraFiles.join(', ')}</Field>}
        <Field label="Size">{formatBytes(src.fileSize)}</Field>
        <Field label="Format">
          <span class="flex flex-wrap items-center gap-1.5">
            {src.formatName}
            <Badge tone={STATUS_TONE[src.status]} title="Support level of this format in BoardScope">
              {src.status}
            </Badge>
          </span>
        </Field>
        {src.variant && <Field label="Variant">{src.variant}</Field>}
        <Field label="Detection">{(src.confidence * 100).toFixed(0)}% confidence</Field>
        <Field label="Units">
          {unitLabel(m.units)}
          {m.units.note && <div class="text-faint text-[11px]">{m.units.note}</div>}
        </Field>
        {m.metadata.map(([k, v]) => (
          <Field key={k} label={k}>
            {v}
          </Field>
        ))}
      </dl>
      <SectionTitle>Contents</SectionTitle>
      <dl>
        <Field label="Parts">{m.parts.count.toLocaleString()}</Field>
        <Field label="Pins">{m.pins.count.toLocaleString()}</Field>
        <Field label="Nets">{m.nets.count.toLocaleString()}</Field>
        {m.vias.count > 0 && <Field label="Vias / holes">{m.vias.count.toLocaleString()}</Field>}
        {m.traces.count > 0 && <Field label="Copper segs">{m.traces.count.toLocaleString()}</Field>}
        {m.layers.length > 0 && <Field label="Layers">{m.layers.map((l) => l.name).join(', ')}</Field>}
      </dl>
      <SectionTitle>Capabilities</SectionTitle>
      <dl>
        <Field label="Board outline">{caps.outline === 'file' ? <span class="text-ok">from file</span> : caps.outline === 'derived' ? <span class="text-warn">derived (dashed)</span> : 'none'}</Field>
        <Field label="Part bodies">{caps.partBodies === 'file' ? <span class="text-ok">from file</span> : <span class="text-muted">derived from pins / boxes</span>}</Field>
        <Field label="Pad shapes">{yes(caps.padShapes)}</Field>
        <Field label="Pin names">{yes(caps.pinNames)}</Field>
        <Field label="Sides">{yes(caps.sides)}</Field>
        <Field label="Rotation">{yes(caps.rotation)}</Field>
        <Field label="Test points">{yes(caps.testpoints)}</Field>
        <Field label="Vias">{yes(caps.vias)}</Field>
        <Field label="Copper traces">{yes(caps.traces)}</Field>
        <Field label="Values">{yes(caps.values)}</Field>
      </dl>
      <SectionTitle>Diagnostics</SectionTitle>
      <ul class="px-3 space-y-1.5" data-testid="diagnostics">
        {m.diagnostics.length === 0 && <li class="text-faint text-[12px]">None</li>}
        {m.diagnostics.map((d, i) => (
          <li key={i} class="flex gap-2 text-[12px] leading-snug">
            <Badge tone={d.level === 'error' ? 'err' : d.level === 'warning' ? 'warn' : 'info'}>{d.level}</Badge>
            <span class="text-muted min-w-0">
              {d.message}
              {d.count && d.count > 1 ? <span class="text-faint"> (×{d.count})</span> : null}
              {d.line ? <span class="text-faint"> · line {d.line}</span> : null}
              {d.offset !== undefined ? <span class="text-faint"> · offset 0x{d.offset.toString(16)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <SectionTitle>Performance</SectionTitle>
      <dl>
        <Field label="Parse">{board.timings.parseMs.toFixed(0)} ms</Field>
        <Field label="Index">{board.timings.sceneMs.toFixed(0)} ms</Field>
        <Field label="Total load">{board.timings.totalMs.toFixed(0)} ms</Field>
        <Field label="Parsed in">{board.timings.mode}</Field>
      </dl>
      <div class="px-3 pt-4 text-[11px] text-faint flex items-center gap-1.5">
        <CircuitBoard size={12} /> Processed locally in your browser. Nothing is uploaded.
      </div>
    </div>
  );
}
