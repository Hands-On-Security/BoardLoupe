import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircuitBoard,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FolderOpen,
  HelpCircle,
  Layers,
  Maximize,
  Moon,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Printer,
  RotateCw,
  Ruler,
  Settings,
  Sun,
  Table2,
  X,
} from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { back, closeBoard, forward, openFiles, viewer } from '../actions';
import { HosByline } from '../brand';
import { type Prefs, setPrefs, store, useStore } from '../store';
import { IconButton, Toggle, cx } from './ui';

function useViewerOpts() {
  const [, force] = useState(0);
  useEffect(() => viewer.on('opts', () => force((n) => n + 1)), []);
  useEffect(() => viewer.on('view', () => force((n) => n + 1)), []);
  return viewer.opts;
}

export function openPicker() {
  const input = document.getElementById('bs-file-input') as HTMLInputElement | null;
  input?.click();
}

export function Toolbar() {
  const board = useStore(store, (s) => s.board);
  const prefs = useStore(store, (s) => s.prefs);
  const tool = useStore(store, (s) => s.tool);
  const histPos = useStore(store, (s) => s.historyPos);
  const histLen = useStore(store, (s) => s.history.length);
  const opts = useViewerOpts();
  const hasBoard = !!board;
  const sideable = !!board && board.model.caps.sides;

  return (
    <header class="h-11 shrink-0 flex items-center gap-1 px-2 border-b border-line bg-panel" role="toolbar" aria-label="Main toolbar">
      <div class="flex items-center gap-2 pl-1 pr-2 min-w-0">
        <CircuitBoard size={18} class="text-accent shrink-0" aria-hidden="true" />
        <span class="font-semibold tracking-tight text-[14px] hidden md:inline">BoardLoupe</span>
      </div>
      <IconButton label="Toggle explorer" shortcut="[" active={prefs.sidebar} onClick={() => setPrefs({ sidebar: !prefs.sidebar })}>
        <PanelLeft size={16} />
      </IconButton>
      <IconButton label="Open boardview file" shortcut="Ctrl+O" onClick={openPicker}>
        <FolderOpen size={16} />
      </IconButton>
      <FileMenu />
      <Sep />
      {hasBoard && (
        <>
          <div class={cx('flex items-center h-8 rounded-md border border-line2 p-0.5', !sideable && 'opacity-50')} role="group" aria-label="Board side">
            {(['Top', 'Bottom'] as const).map((label, i) => {
              const v = (i + 1) as 1 | 2;
              return (
                <button
                  key={label}
                  type="button"
                  disabled={!sideable}
                  aria-pressed={opts.side === v}
                  title={`${label} side (Space toggles)`}
                  class={cx('h-full px-2.5 rounded text-[12px] font-medium transition-colors', opts.side === v ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
                  onClick={() => viewer.setOptions({ side: v })}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {sideable && (
            <IconButton
              label={prefs.otherSide === 'hide' ? 'Show the other side (ghosted)' : 'Show only this side (hide the other side)'}
              shortcut="G"
              active={prefs.otherSide === 'hide'}
              onClick={() => setPrefs({ otherSide: prefs.otherSide === 'hide' ? 'ghost' : 'hide' })}
            >
              {prefs.otherSide === 'hide' ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
          )}
          <IconButton label="Mirror view" shortcut="X" active={viewer.view.mirror} onClick={() => viewer.toggleMirror()}>
            <FlipHorizontal2 size={16} />
          </IconButton>
          <IconButton label="Rotate 90°" shortcut="R" onClick={() => viewer.rotate(90)}>
            <RotateCw size={16} />
          </IconButton>
          <IconButton label="Fit board" shortcut="F" onClick={() => viewer.fit()}>
            <Maximize size={16} />
          </IconButton>
          <Sep />
          <IconButton label="Select tool" shortcut="V" active={tool === 'select'} onClick={() => store.set({ tool: 'select' })}>
            <MousePointer2 size={16} />
          </IconButton>
          <IconButton label="Measure distance" shortcut="M" active={tool === 'measure'} onClick={() => store.set({ tool: tool === 'measure' ? 'select' : 'measure', measure: { a: null, b: null } })}>
            <Ruler size={16} />
          </IconButton>
          <LayersMenu prefs={prefs} />
          <Sep />
          <IconButton label="Back" shortcut="Alt+←" disabled={histPos <= 0} onClick={back}>
            <ArrowLeft size={16} />
          </IconButton>
          <IconButton label="Forward" shortcut="Alt+→" disabled={histPos >= histLen - 1} onClick={forward}>
            <ArrowRight size={16} />
          </IconButton>
          <IconButton label="Tables & export" shortcut="T" onClick={() => store.set({ dialog: 'tables' })}>
            <Table2 size={16} />
          </IconButton>
          <IconButton label="Report (A4 PDF)" shortcut="Ctrl/⌘+P" onClick={() => store.set({ dialog: 'report' })}>
            <Printer size={16} />
          </IconButton>
        </>
      )}
      <div class="flex-1" />
      <HosByline class="hidden lg:inline-flex mr-1.5" />
      <Sep />
      <IconButton label={prefs.theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setPrefs({ theme: prefs.theme === 'dark' ? 'light' : 'dark' })}>
        {prefs.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </IconButton>
      <IconButton label="Settings" onClick={() => store.set({ dialog: 'settings' })}>
        <Settings size={16} />
      </IconButton>
      <IconButton label="Help & shortcuts" shortcut="?" onClick={() => store.set({ dialog: 'help' })}>
        <HelpCircle size={16} />
      </IconButton>
      <IconButton label="Toggle inspector" shortcut="]" active={prefs.inspector} onClick={() => setPrefs({ inspector: !prefs.inspector })}>
        <PanelRight size={16} />
      </IconButton>
    </header>
  );
}

function Sep() {
  return <span class="w-px h-5 bg-line2 mx-1 shrink-0" aria-hidden="true" />;
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function FileMenu() {
  const board = useStore(store, (s) => s.board);
  const recent = useStore(store, (s) => s.recent);
  const { open, setOpen, ref } = usePopover();
  if (!board) return null;
  return (
    <div class="relative min-w-0" ref={ref}>
      <button
        type="button"
        class="flex items-center gap-1.5 h-8 max-w-[260px] px-2 rounded-md hover:bg-raised text-[12.5px] min-w-0"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Recent files in this session"
        onClick={() => setOpen(!open)}
      >
        <span class="truncate font-medium" data-testid="file-name">
          {board.model.source.fileName}
        </span>
        <ChevronDown size={14} class="text-faint shrink-0" />
      </button>
      {open && (
        <div role="menu" class="absolute left-0 top-9 z-40 w-80 rounded-lg border border-line2 bg-raised shadow-pop py-1 fade-in">
          <div class="px-3 py-1.5 text-[11px] uppercase tracking-wider text-faint font-semibold">Recent (this session only)</div>
          {recent.map((r) => (
            <button
              key={r.id}
              role="menuitem"
              class="w-full text-left px-3 py-1.5 hover:bg-panel2 flex flex-col"
              onClick={() => {
                setOpen(false);
                void openFiles(r.files);
              }}
            >
              <span class="text-[12.5px] truncate">{r.name}</span>
              <span class="text-[11px] text-faint">
                {r.format} · {r.parts.toLocaleString()} parts · {r.pins.toLocaleString()} pins
              </span>
            </button>
          ))}
          <div class="border-t border-line my-1" />
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 hover:bg-panel2 flex items-center gap-2 text-[12.5px]"
            onClick={() => {
              setOpen(false);
              openPicker();
            }}
          >
            <FolderOpen size={14} /> Open another file…
          </button>
          <button
            role="menuitem"
            class="w-full text-left px-3 py-1.5 hover:bg-panel2 flex items-center gap-2 text-[12.5px]"
            onClick={() => {
              setOpen(false);
              closeBoard();
            }}
          >
            <X size={14} /> Close board
          </button>
        </div>
      )}
    </div>
  );
}

function LayersMenu({ prefs }: { prefs: Prefs }) {
  const board = useStore(store, (s) => s.board);
  const { open, setOpen, ref } = usePopover();
  const opts = useViewerOpts();
  if (!board) return null;
  const m = board.model;
  const set = (p: Partial<Prefs>) => {
    setPrefs(p);
  };
  return (
    <div class="relative" ref={ref}>
      <IconButton label="Layers & display" shortcut="L" active={open} onClick={() => setOpen(!open)}>
        <Layers size={16} />
      </IconButton>
      {open && (
        <div class="absolute left-0 top-9 z-40 w-72 rounded-lg border border-line2 bg-raised shadow-pop p-3 fade-in max-h-[75vh] overflow-auto scroll-thin" role="dialog" aria-label="Layers and display">
          <div class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1">Layers</div>
          <Toggle label="Board outline" checked={opts.showOutline} onChange={(v) => viewer.setOptions({ showOutline: v })} />
          <Toggle label="Component bodies" checked={opts.showBodies} onChange={(v) => viewer.setOptions({ showBodies: v })} />
          <Toggle label="Pins & pads" checked={opts.showPins} onChange={(v) => viewer.setOptions({ showPins: v })} />
          {m.caps.vias && <Toggle label="Vias & holes" checked={prefs.showVias} onChange={(v) => set({ showVias: v })} />}
          {m.caps.traces ? (
            <>
              <Toggle label="Copper traces (from file)" hint="Real routed geometry stored in the file" checked={prefs.showTraces} onChange={(v) => set({ showTraces: v })} />
              {prefs.showTraces && m.layers.length > 0 && (
                <div class="pl-9 pb-1 grid grid-cols-2 gap-x-2">
                  {m.layers
                    .filter((l) => m.traces.layer.includes(l.id))
                    .map((l) => (
                      <label key={l.id} class="flex items-center gap-1.5 text-[12px] text-muted py-0.5 truncate">
                        <input
                          type="checkbox"
                          checked={!!((opts.traceLayerMask >>> (l.id & 31)) & 1)}
                          onChange={(e) => {
                            const bit = 1 << (l.id & 31);
                            viewer.setOptions({ traceLayerMask: (e.target as HTMLInputElement).checked ? opts.traceLayerMask | bit : opts.traceLayerMask & ~bit });
                          }}
                        />
                        <span class="truncate">{l.name}</span>
                      </label>
                    ))}
                </div>
              )}
            </>
          ) : (
            <p class="text-[11.5px] text-faint py-1">This file contains no copper trace geometry.</p>
          )}
          <Toggle label="Air wires for selected net" hint="Inferred straight connections (dashed) — not real traces" checked={prefs.showRatsnest} onChange={(v) => set({ showRatsnest: v })} />
          <div class="text-[11px] uppercase tracking-wider text-faint font-semibold mt-3 mb-1">Labels</div>
          <Toggle label="Reference designators" checked={prefs.showPartLabels} onChange={(v) => set({ showPartLabels: v })} />
          <Toggle label="Pin numbers" checked={prefs.showPinLabels} onChange={(v) => set({ showPinLabels: v })} />
          <Toggle label="Net names on pads" checked={prefs.showNetLabels} onChange={(v) => set({ showNetLabels: v })} />
          <div class="text-[11px] uppercase tracking-wider text-faint font-semibold mt-3 mb-1">Display</div>
          <Toggle label="Colour pins by net" checked={prefs.colorByNet} onChange={(v) => set({ colorByNet: v })} />
          <Toggle label="Mirror when viewing bottom" checked={prefs.mirrorBottom} onChange={(v) => set({ mirrorBottom: v })} />
          <label class="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            Other side
            <select class="bg-panel2 border border-line2 rounded h-7 px-1 text-[12.5px]" value={prefs.otherSide} onChange={(e) => set({ otherSide: (e.target as HTMLSelectElement).value as Prefs['otherSide'] })}>
              <option value="ghost">Ghosted</option>
              <option value="hide">Hidden</option>
              <option value="show">Shown</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
