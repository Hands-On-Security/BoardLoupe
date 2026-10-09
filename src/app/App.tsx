import { useEffect, useState } from 'preact/hooks';
import { back, clearSelection, focusSelection, forward, openFiles, viewer } from './actions';
import { BoardCanvas } from './components/BoardCanvas';
import { HelpDialog, SettingsDialog, TablesDialog } from './components/Dialogs';
import { Inspector } from './components/Inspector';
import { EmptyState, ErrorView, LoadingOverlay, Toast } from './components/Screens';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Toolbar, openPicker } from './components/Toolbar';
import { setPrefs, store, useStore } from './store';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function focusSearch() {
  // Focus synchronously when the box exists so keys typed right after "/" land in it.
  const el = document.getElementById('bs-search') as HTMLInputElement | null;
  if (el) {
    el.focus();
    el.select();
    return;
  }
  const s = store.get();
  if (!s.prefs.sidebar) setPrefs({ sidebar: true });
  store.set({ panel: 'search' });
  setTimeout(() => window.dispatchEvent(new Event('bs-focus-search')), 0);
}

/** Collects files from a drop, including folders (for multi-file ASC sets). */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const items = Array.from(dt.items ?? []);
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (entries.length && entries.some((e) => e.isDirectory)) {
    const walk = async (e: FileSystemEntry, depth: number): Promise<void> => {
      if (out.length > 64 || depth > 3) return;
      if (e.isFile) out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
      else if (e.isDirectory) {
        const reader = (e as FileSystemDirectoryEntry).createReader();
        const list = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const c of list) await walk(c, depth + 1);
      }
    };
    for (const e of entries) await walk(e, 0);
    return out;
  }
  return Array.from(dt.files ?? []);
}

export function App() {
  const phase = useStore(store, (s) => s.phase);
  const prefs = useStore(store, (s) => s.prefs);
  const dialog = useStore(store, (s) => s.dialog);
  const hasBoard = useStore(store, (s) => !!s.board);
  const [dragging, setDragging] = useState(false);

  // Theme + renderer preferences.
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    viewer.mirrorBottom = prefs.mirrorBottom;
    viewer.setOptions({
      light: prefs.theme === 'light',
      otherSide: prefs.otherSide,
      colorByNet: prefs.colorByNet,
      showPartLabels: prefs.showPartLabels,
      showPinLabels: prefs.showPinLabels,
      showNetLabels: prefs.showNetLabels,
      showRatsnest: prefs.showRatsnest,
      showVias: prefs.showVias,
      showTraces: prefs.showTraces,
    });
    viewer.updateRatsnest();
  }, [prefs]);

  // Drag & drop anywhere in the window.
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer) void openFiles(await filesFromDrop(e.dataTransfer));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openPicker();
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (isTyping(e) || store.get().dialog) return;
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
        return;
      }
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        forward();
        return;
      }
      if (mod || e.altKey) return;
      const s = store.get();
      const b = !!s.board;
      switch (e.key) {
        case '/':
          e.preventDefault();
          focusSearch();
          break;
        case '?':
          store.set({ dialog: 'help' });
          break;
        case 'Escape':
          clearSelection();
          break;
        case '[':
          setPrefs({ sidebar: !s.prefs.sidebar });
          break;
        case ']':
          setPrefs({ inspector: !s.prefs.inspector });
          break;
      }
      if (!b) return;
      switch (e.key) {
        case 'f':
        case 'F':
          viewer.fit();
          break;
        case 'z':
        case 'Z':
          focusSelection();
          break;
        case '+':
        case '=':
          viewer.zoomBy(1.5);
          break;
        case '-':
        case '_':
          viewer.zoomBy(1 / 1.5);
          break;
        case ' ':
          e.preventDefault();
          if (s.board!.model.caps.sides) viewer.setOptions({ side: viewer.opts.side === 1 ? 2 : 1 });
          break;
        case 'x':
        case 'X':
          viewer.toggleMirror();
          break;
        case 'g':
        case 'G':
          if (s.board!.model.caps.sides) setPrefs({ otherSide: s.prefs.otherSide === 'hide' ? 'ghost' : 'hide' });
          break;
        case 'r':
          viewer.rotate(90);
          break;
        case 'R':
          viewer.rotate(-90);
          break;
        case 'm':
        case 'M':
          store.set({ tool: s.tool === 'measure' ? 'select' : 'measure', measure: { a: null, b: null } });
          break;
        case 'v':
        case 'V':
          store.set({ tool: 'select' });
          break;
        case 'i':
        case 'I':
          store.set({ isolate: !s.isolate });
          break;
        case 'h':
        case 'H':
          store.set({ hideOtherNets: !s.hideOtherNets });
          break;
        case 't':
        case 'T':
          store.set({ dialog: 'tables' });
          break;
        case 'l':
        case 'L':
          (document.querySelector('[aria-label="Layers & display"]') as HTMLButtonElement | null)?.click();
          break;
        case 'ArrowLeft':
          viewer.panBy(80, 0);
          break;
        case 'ArrowRight':
          viewer.panBy(-80, 0);
          break;
        case 'ArrowUp':
          viewer.panBy(0, 80);
          break;
        case 'ArrowDown':
          viewer.panBy(0, -80);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class="h-full flex flex-col">
      <a href="#bs-search" class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:p-2 focus:bg-raised focus:rounded">
        Skip to search
      </a>
      <Toolbar />
      <div class="flex-1 flex min-h-0">
        {hasBoard && prefs.sidebar && <Sidebar />}
        <main class="flex-1 relative min-w-0" aria-label="Board">
          <BoardCanvas />
          {!hasBoard && phase !== 'error' && <EmptyState dragging={dragging} />}
          {hasBoard && dragging && (
            <div class="absolute inset-3 z-20 rounded-2xl dropzone-dash dropzone-active flex items-center justify-center text-[15px] font-medium pointer-events-none">Drop to open</div>
          )}
          <LoadingOverlay />
          <ErrorView />
        </main>
        {hasBoard && prefs.inspector && <Inspector />}
      </div>
      <StatusBar />
      <input
        id="bs-file-input"
        type="file"
        multiple
        class="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const files = Array.from(input.files ?? []);
          input.value = '';
          void openFiles(files);
        }}
      />
      {dialog === 'tables' && <TablesDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'help' && <HelpDialog />}
      <Toast />
    </div>
  );
}
