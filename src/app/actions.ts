import { parseKey44 } from '../formats/fz';
import { DEFAULT_OPTIONS } from '../formats/registry';
import type { ParseOptions } from '../formats/types';
import type { BoardModel } from '../model/types';
import type { Highlight } from '../render/style';
import { SearchIndex } from '../search/search';
import { type ParseJob, startParse } from '../worker/client';
import { NO_SEL, type Selection, historyGo, select, store, toast } from './store';
import { Viewer } from './viewer';

export const viewer = new Viewer();

let job: ParseJob | null = null;
let boardSeq = 0;

export function parseOptions(): ParseOptions {
  const k = store.get().keys;
  return {
    ...DEFAULT_OPTIONS,
    fzKey: k.fz ? parseKey44(k.fz) : null,
    caeKey: k.cae ? parseKey44(k.cae) : null,
    xzzKey: k.xzz ? k.xzz : null,
  };
}

export async function openFiles(files: File[]) {
  if (!files.length) return;
  job?.cancel();
  const name = files.length > 1 ? `${files[0].name} (+${files.length - 1})` : files[0].name;
  const started = performance.now();
  store.set({ phase: store.get().board ? 'ready' : 'loading', loading: { name, phase: 'Reading file', started } });
  const j = startParse(files, parseOptions(), (phase, fraction) => {
    const l = store.get().loading;
    if (l) store.set({ loading: { ...l, phase, fraction } });
  });
  job = j;
  const r = await j.promise;
  if (job !== j) return;
  job = null;
  if (!r.ok) {
    if (r.cancelled) {
      store.set({ loading: null, phase: store.get().board ? 'ready' : 'empty' });
      return;
    }
    store.set({ loading: null, error: { name, diagnostics: r.diagnostics, attempts: r.attempts }, phase: store.get().board ? 'ready' : 'error' });
    return;
  }
  const id = ++boardSeq;
  const board = {
    model: r.model,
    scene: r.scene,
    search: new SearchIndex(r.model),
    timings: { ...r.timings, totalMs: performance.now() - started, mode: r.mode },
    files,
    id,
  };
  const recent = [
    { id, name, format: r.model.source.formatName, parts: r.model.parts.count, pins: r.model.pins.count, files },
    ...store.get().recent.filter((e) => e.name !== name),
  ].slice(0, 8);
  store.set({
    board,
    phase: 'ready',
    loading: null,
    error: null,
    sel: NO_SEL,
    history: [],
    historyPos: -1,
    isolate: false,
    hideOtherNets: false,
    measure: { a: null, b: null },
    tool: 'select',
    searchText: '',
    recent,
  });
  viewer.setBoard(r.model, r.scene);
  syncHighlight();
  const errs = r.model.diagnostics.filter((d) => d.level === 'error').length;
  const warns = r.model.diagnostics.filter((d) => d.level === 'warning').length;
  if (errs || warns) toast(`Loaded with ${errs ? `${errs} error(s)` : ''}${errs && warns ? ', ' : ''}${warns ? `${warns} warning(s)` : ''} — see File info`);
}

export function cancelLoad() {
  job?.cancel();
}

export function closeBoard() {
  job?.cancel();
  store.set({ board: null, phase: 'empty', error: null, sel: NO_SEL, history: [], historyPos: -1, loading: null });
  viewer.setBoard(null, null);
}

export function highlightFor(sel: Selection, m: BoardModel | null, isolate: boolean, hideOtherNets: boolean): Highlight {
  const nets = new Set<number>(sel.nets);
  let part = -1,
    pin = -1;
  if (m) {
    if (sel.kind === 'part') part = sel.index;
    else if (sel.kind === 'pin') {
      pin = sel.index;
      const n = m.pins.net[sel.index];
      if (n >= 0) nets.add(n);
    } else if (sel.kind === 'net') nets.add(sel.index);
    else if (sel.kind === 'via') {
      const n = m.vias.net[sel.index];
      if (n >= 0) nets.add(n);
    }
  }
  return { part, pin, nets: [...nets], parts: sel.multi, isolate, hideUnselectedNets: hideOtherNets };
}

export function syncHighlight() {
  const s = store.get();
  viewer.setHighlight(highlightFor(s.sel, s.board?.model ?? null, s.isolate, s.hideOtherNets));
}

store.subscribe(() => {
  const s = store.get();
  const key = `${s.sel.kind}:${s.sel.index}:${s.sel.multi.join(',')}:${s.sel.nets.join(',')}:${s.isolate}:${s.hideOtherNets}:${s.board?.id}`;
  if (key !== lastHlKey) {
    lastHlKey = key;
    syncHighlight();
  }
});
let lastHlKey = '';

// --- Focus helpers --------------------------------------------------------

export function partBounds(k: number) {
  const b = store.get().board;
  if (!b) return null;
  const s = b.scene;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let j = s.bodyStart[k] * 4; j < s.bodyStart[k + 1] * 4; j += 2) {
    x0 = Math.min(x0, s.bodySegs[j]);
    x1 = Math.max(x1, s.bodySegs[j]);
    y0 = Math.min(y0, s.bodySegs[j + 1]);
    y1 = Math.max(y1, s.bodySegs[j + 1]);
  }
  return Number.isFinite(x0) ? { minX: x0, minY: y0, maxX: x1, maxY: y1 } : null;
}

export function netBounds(n: number) {
  const b = store.get().board;
  if (!b) return null;
  const m = b.model;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let j = m.nets.pinStart[n]; j < m.nets.pinStart[n + 1]; j++) {
    const p = m.nets.pinIndex[j];
    x0 = Math.min(x0, m.pins.x[p]);
    x1 = Math.max(x1, m.pins.x[p]);
    y0 = Math.min(y0, m.pins.y[p]);
    y1 = Math.max(y1, m.pins.y[p]);
  }
  return Number.isFinite(x0) ? { minX: x0, minY: y0, maxX: x1, maxY: y1 } : null;
}

/** Ensures the viewed side shows the given side (switching sides if needed). */
function showSide(side: number) {
  if ((side === 1 || side === 2) && viewer.opts.side !== side) viewer.setOptions({ side: side as 1 | 2 });
}

export function selectPart(k: number, focus = true, additive = false) {
  const s = store.get();
  if (additive) {
    const multi = s.sel.multi.includes(k) ? s.sel.multi.filter((x) => x !== k) : [...s.sel.multi, k];
    select({ ...s.sel, multi });
    return;
  }
  select({ kind: 'part', index: k, multi: [], nets: [] });
  if (focus) {
    const m = s.board?.model;
    if (m) showSide(m.parts.side[k]);
    const b = partBounds(k);
    if (b) viewer.focus(b, 40);
  }
}

export function selectPin(i: number, focus = true) {
  select({ kind: 'pin', index: i, multi: [], nets: [] });
  const m = store.get().board?.model;
  if (focus && m) {
    showSide(m.pins.side[i]);
    const r = Math.max(store.get().board!.scene.pinHW[i], store.get().board!.scene.pinHH[i]) * 8;
    viewer.focus({ minX: m.pins.x[i] - r, minY: m.pins.y[i] - r, maxX: m.pins.x[i] + r, maxY: m.pins.y[i] + r }, 40);
  }
}

export function selectNet(n: number, focus = true, additive = false) {
  const s = store.get();
  if (additive) {
    const nets = s.sel.nets.includes(n) ? s.sel.nets.filter((x) => x !== n) : [...s.sel.nets, n];
    select({ ...s.sel, nets });
    return;
  }
  select({ kind: 'net', index: n, multi: [], nets: [] });
  if (focus) {
    const b = netBounds(n);
    if (b) viewer.focus(b, 30);
  }
}

export function selectVia(i: number) {
  select({ kind: 'via', index: i, multi: [], nets: [] });
}

export function clearSelection() {
  const s = store.get();
  if (s.tool === 'measure' && (s.measure.a || s.measure.b)) {
    store.set({ measure: { a: null, b: null } });
    viewer.overlay = { measure: null };
    viewer.requestRender();
    return;
  }
  store.set({ isolate: false, hideOtherNets: false });
  select(NO_SEL);
}

export function focusSelection() {
  const s = store.get();
  const sel = s.sel;
  if (sel.kind === 'part') {
    const b = partBounds(sel.index);
    if (b) viewer.focus(b, 40);
  } else if (sel.kind === 'net') {
    const b = netBounds(sel.index);
    if (b) viewer.focus(b, 30);
  } else if (sel.kind === 'pin') selectPin(sel.index, true);
  else if (sel.multi.length) {
    const bs = sel.multi.map(partBounds).filter(Boolean) as NonNullable<ReturnType<typeof partBounds>>[];
    if (bs.length)
      viewer.focus({ minX: Math.min(...bs.map((b) => b.minX)), minY: Math.min(...bs.map((b) => b.minY)), maxX: Math.max(...bs.map((b) => b.maxX)), maxY: Math.max(...bs.map((b) => b.maxY)) }, 40);
  } else viewer.fit();
}

export function back() {
  if (historyGo(-1)) focusSelection();
}
export function forward() {
  if (historyGo(1)) focusSelection();
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied “${text.length > 40 ? text.slice(0, 40) + '…' : text}”`);
  } catch {
    // Clipboard API may be blocked on file://; fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Copied');
    } catch {
      toast('Copy failed');
    }
    ta.remove();
  }
}

export function downloadText(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
