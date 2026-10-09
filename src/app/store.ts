import { useEffect, useRef, useState } from 'preact/hooks';
import type { BoardModel, Diagnostic } from '../model/types';
import type { Scene } from '../scene/scene';
import { SearchIndex } from '../search/search';
import type { Timings } from '../worker/protocol';

type Fn = () => void;

export interface Store<T> {
  get(): T;
  set(p: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: Fn): () => void;
}

export function createStore<T extends object>(init: T): Store<T> {
  let state = init;
  const ls = new Set<Fn>();
  return {
    get: () => state,
    set(p) {
      const patch = typeof p === 'function' ? p(state) : p;
      state = { ...state, ...patch };
      ls.forEach((f) => f());
    },
    subscribe(fn) {
      ls.add(fn);
      return () => ls.delete(fn);
    },
  };
}

/** Subscribes a component to a slice of a store (re-renders only when it changes, shallowly). */
export function useStore<T extends object, U>(store: Store<T>, sel: (s: T) => U): U {
  const [, force] = useState(0);
  const selRef = useRef(sel);
  selRef.current = sel;
  const val = sel(store.get());
  const valRef = useRef(val);
  valRef.current = val;
  useEffect(
    () =>
      store.subscribe(() => {
        const next = selRef.current(store.get());
        if (!shallowEqual(next, valRef.current)) force((n) => n + 1);
      }),
    [store],
  );
  return val;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object),
    kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

// ---------------------------------------------------------------------------

export type SelKind = 'none' | 'part' | 'pin' | 'net' | 'via';

export interface Selection {
  kind: SelKind;
  index: number;
  /** Extra parts selected with Shift/Cmd-click. */
  multi: number[];
  /** Extra nets highlighted with Shift/Cmd-click. */
  nets: number[];
}

export const NO_SEL: Selection = { kind: 'none', index: -1, multi: [], nets: [] };

/** A persistent highlight group: nets and parts kept lit while you explore. */
export interface HighlightGroup {
  nets: number[];
  parts: number[];
}

export const EMPTY_GROUP: HighlightGroup = { nets: [], parts: [] };

/** A named group saved for later use, by name so it can survive reloads. */
export interface SavedGroup {
  id: number;
  name: string;
  created: number;
  fileName: string;
  nets: string[];
  parts: string[];
}

export interface LoadedBoard {
  model: BoardModel;
  scene: Scene;
  search: SearchIndex;
  timings: Timings & { totalMs: number; mode: string };
  files: File[];
  id: number;
}

export interface RecentEntry {
  id: number;
  name: string;
  format: string;
  parts: number;
  pins: number;
  files: File[];
}

export type Panel = 'search' | 'parts' | 'nets' | 'groups' | 'info';
export type Dialog = null | 'tables' | 'settings' | 'help' | 'report';

export interface Prefs {
  theme: 'dark' | 'light';
  otherSide: 'ghost' | 'hide' | 'show';
  mirrorBottom: boolean;
  colorByNet: boolean;
  showPartLabels: boolean;
  showPinLabels: boolean;
  showNetLabels: boolean;
  showRatsnest: boolean;
  showVias: boolean;
  showTraces: boolean;
  sidebar: boolean;
  inspector: boolean;
  minimap: boolean;
  forceCanvas2d: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  otherSide: 'ghost',
  mirrorBottom: true,
  colorByNet: false,
  showPartLabels: true,
  showPinLabels: true,
  showNetLabels: true,
  showRatsnest: false,
  showVias: true,
  showTraces: false,
  sidebar: true,
  inspector: true,
  minimap: true,
  forceCanvas2d: false,
};

export interface Keys {
  fz: string;
  cae: string;
  xzz: string;
  remember: boolean;
}

export interface AppState {
  phase: 'empty' | 'loading' | 'ready' | 'error';
  loading: { name: string; phase: string; fraction?: number; started: number } | null;
  error: { name: string; diagnostics: Diagnostic[]; attempts: { formatId: string; confidence: number; error?: string }[] } | null;
  board: LoadedBoard | null;
  recent: RecentEntry[];
  sel: Selection;
  history: Selection[];
  historyPos: number;
  isolate: boolean;
  hideOtherNets: boolean;
  /** Persistent highlight group (board-specific indices). */
  group: HighlightGroup;
  /** Named groups saved for later use (resolved by name on apply). */
  savedGroups: SavedGroup[];
  panel: Panel;
  dialog: Dialog;
  tool: 'select' | 'measure';
  measure: { a: [number, number] | null; b: [number, number] | null };
  searchText: string;
  prefs: Prefs;
  keys: Keys;
  toast: { text: string; id: number } | null;
}

const PREFS_KEY = 'boardscope.prefs.v1';
const KEYS_KEY = 'boardscope.keys.v1';
const GROUPS_KEY = 'boardscope.groups.v1';

function loadGroups(): SavedGroup[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveGroups(list: SavedGroup[]) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — saved groups stay in memory for this session */
  }
}

function loadJSON<T>(key: string, def: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return def;
    return { ...def, ...JSON.parse(raw) };
  } catch {
    return def;
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode / file:// policy) — preferences stay in memory */
  }
}

export function saveKeys(k: Keys) {
  try {
    if (k.remember) localStorage.setItem(KEYS_KEY, JSON.stringify(k));
    else localStorage.removeItem(KEYS_KEY);
  } catch {
    /* ignore */
  }
}

export const store = createStore<AppState>({
  phase: 'empty',
  loading: null,
  error: null,
  board: null,
  recent: [],
  sel: NO_SEL,
  history: [],
  historyPos: -1,
  isolate: false,
  hideOtherNets: false,
  group: EMPTY_GROUP,
  savedGroups: loadGroups(),
  panel: 'search',
  dialog: null,
  tool: 'select',
  measure: { a: null, b: null },
  searchText: '',
  prefs: loadJSON(PREFS_KEY, DEFAULT_PREFS), // dark by default; light is a saved preference
  keys: loadJSON(KEYS_KEY, { fz: '', cae: '', xzz: '', remember: false }),
  toast: null,
});

export function setPrefs(p: Partial<Prefs>) {
  store.set((s) => ({ prefs: { ...s.prefs, ...p } }));
  savePrefs(store.get().prefs);
}

let toastId = 0;
export function toast(text: string) {
  const id = ++toastId;
  store.set({ toast: { text, id } });
  setTimeout(() => {
    if (store.get().toast?.id === id) store.set({ toast: null });
  }, 2600);
}

function sameSel(a: Selection, b: Selection) {
  return a.kind === b.kind && a.index === b.index && a.multi.join() === b.multi.join() && a.nets.join() === b.nets.join();
}

/** Selects and records the selection in back/forward history. */
export function select(sel: Selection) {
  const s = store.get();
  if (sameSel(sel, s.sel)) return;
  let history = s.history.slice(0, s.historyPos + 1);
  if (sel.kind !== 'none') {
    history.push(sel);
    if (history.length > 200) history = history.slice(history.length - 200);
  }
  store.set({ sel, history, historyPos: sel.kind !== 'none' ? history.length - 1 : s.historyPos });
}

export function historyGo(delta: number) {
  const s = store.get();
  const pos = s.historyPos + delta;
  if (pos < 0 || pos >= s.history.length) return false;
  store.set({ historyPos: pos, sel: s.history[pos] });
  return true;
}
