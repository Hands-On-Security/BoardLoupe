import { parseKey44 } from '../formats/fz';
import { DEFAULT_OPTIONS } from '../formats/registry';
import type { ParseOptions } from '../formats/types';
import type { BoardModel } from '../model/types';
import type { Highlight } from '../render/style';
import { SearchIndex } from '../search/search';
import { type ParseJob, startParse } from '../worker/client';
import { EMPTY_GROUP, type HighlightGroup, NO_SEL, type SavedGroup, type Selection, historyGo, saveGroups, select, store, toast } from './store';
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
    group: EMPTY_GROUP,
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
  store.set({ board: null, phase: 'empty', error: null, sel: NO_SEL, history: [], historyPos: -1, loading: null, group: EMPTY_GROUP });
  viewer.setBoard(null, null);
}

export function highlightFor(sel: Selection, m: BoardModel | null, isolate: boolean, hideOtherNets: boolean, group: HighlightGroup = EMPTY_GROUP): Highlight {
  // Group nets come first so their bus colours stay stable as new nets are
  // selected on top of the group.
  const nets: number[] = [];
  const seen = new Set<number>();
  const addNet = (n: number) => {
    if (n >= 0 && !seen.has(n)) {
      seen.add(n);
      nets.push(n);
    }
  };
  for (const n of group.nets) addNet(n);
  for (const n of sel.nets) addNet(n);
  let part = -1,
    pin = -1;
  if (m) {
    if (sel.kind === 'part') part = sel.index;
    else if (sel.kind === 'pin') {
      pin = sel.index;
      addNet(m.pins.net[sel.index]);
    } else if (sel.kind === 'net') addNet(sel.index);
    else if (sel.kind === 'via') addNet(m.vias.net[sel.index]);
  }
  const parts = [...new Set([...group.parts, ...sel.multi])];
  return { part, pin, nets, parts, isolate, hideUnselectedNets: hideOtherNets };
}

export function syncHighlight() {
  const s = store.get();
  viewer.setHighlight(highlightFor(s.sel, s.board?.model ?? null, s.isolate, s.hideOtherNets, s.group));
}

store.subscribe(() => {
  const s = store.get();
  const key = `${s.sel.kind}:${s.sel.index}:${s.sel.multi.join(',')}:${s.sel.nets.join(',')}:${s.isolate}:${s.hideOtherNets}:${s.board?.id}:${s.group.nets.join(',')}:${s.group.parts.join(',')}`;
  if (key !== lastHlKey) {
    lastHlKey = key;
    syncHighlight();
  }
});
let lastHlKey = '';

// --- Highlight groups -----------------------------------------------------

/** Nets/parts implied by the current selection, merged into the group set. */
function groupWithSelection(): HighlightGroup {
  const s = store.get();
  const m = s.board?.model;
  const nets = new Set<number>(s.group.nets);
  const parts = new Set<number>(s.group.parts);
  const sel = s.sel;
  if (m) {
    for (const n of sel.nets) if (n >= 0) nets.add(n);
    for (const k of sel.multi) parts.add(k);
    if (sel.kind === 'net') nets.add(sel.index);
    else if (sel.kind === 'pin') {
      const n = m.pins.net[sel.index];
      if (n >= 0) nets.add(n);
    } else if (sel.kind === 'via') {
      const n = m.vias.net[sel.index];
      if (n >= 0) nets.add(n);
    } else if (sel.kind === 'part') parts.add(sel.index);
  }
  return { nets: [...nets], parts: [...parts] };
}

export function addSelectionToGroup() {
  const before = store.get().group;
  const g = groupWithSelection();
  if (g.nets.length === before.nets.length && g.parts.length === before.parts.length) {
    toast('Nothing new to add — select a net or part first');
    return;
  }
  store.set({ group: g });
  toast(`Highlight group: ${g.nets.length} net${g.nets.length !== 1 ? 's' : ''}, ${g.parts.length} part${g.parts.length !== 1 ? 's' : ''}`);
}

export function removeNetFromGroup(n: number) {
  const s = store.get();
  store.set({ group: { ...s.group, nets: s.group.nets.filter((x) => x !== n) } });
}
export function removePartFromGroup(k: number) {
  const s = store.get();
  store.set({ group: { ...s.group, parts: s.group.parts.filter((x) => x !== k) } });
}
export function clearGroup() {
  store.set({ group: { nets: [], parts: [] } });
}

export function saveCurrentGroup(name: string) {
  const s = store.get();
  const m = s.board?.model;
  if (!m) return;
  const netNames = s.group.nets.map((n) => m.nets.name[n]).filter(Boolean);
  const partNames = s.group.parts.map((k) => m.parts.name[k]).filter(Boolean);
  if (!netNames.length && !partNames.length) {
    toast('Add nets or parts to the group first');
    return;
  }
  const sg: SavedGroup = { id: Date.now(), name: name.trim() || `Group ${s.savedGroups.length + 1}`, created: Date.now(), fileName: m.source.fileName, nets: netNames, parts: partNames };
  const list = [sg, ...s.savedGroups].slice(0, 50);
  store.set({ savedGroups: list });
  saveGroups(list);
  toast(`Saved “${sg.name}”`);
}

export function applySavedGroup(id: number) {
  const s = store.get();
  const m = s.board?.model;
  if (!m) return;
  const sg = s.savedGroups.find((g) => g.id === id);
  if (!sg) return;
  const netIdx = new Map<string, number>();
  m.nets.name.forEach((nm, i) => netIdx.set(nm, i));
  const partIdx = new Map<string, number>();
  m.parts.name.forEach((nm, i) => partIdx.set(nm, i));
  const nets = sg.nets.map((nm) => netIdx.get(nm)).filter((v): v is number => v !== undefined);
  const parts = sg.parts.map((nm) => partIdx.get(nm)).filter((v): v is number => v !== undefined);
  store.set({ group: { nets, parts }, panel: 'groups' });
  const miss = sg.nets.length - nets.length + (sg.parts.length - parts.length);
  toast(`Applied “${sg.name}”${miss ? ` — ${miss} not on this board` : ''}`);
}

export function deleteSavedGroup(id: number) {
  const s = store.get();
  const list = s.savedGroups.filter((g) => g.id !== id);
  store.set({ savedGroups: list });
  saveGroups(list);
}

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

/** Downloads a data: URL (e.g. a captured PNG) under the given file name. */
export function downloadUrl(name: string, url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** File name stem for exports, derived from the open board's file name. */
export function exportBaseName(m: BoardModel): string {
  return m.source.fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'board';
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
