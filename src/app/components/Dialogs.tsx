import { ArrowDownUp, Copy, Crosshair, Download, HelpCircle, KeyRound, Settings, Table2 } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { CAE_KEY_PARITY, FZ_KEY_PARITY, keyParityOk, parseKey44 } from '../../formats/fz';
import { FORMATS } from '../../formats/registry';
import { parseXzzKey, xzzKeyParityOk } from '../../formats/xzz';
import { type BoardModel, sideLabel, unitLabel } from '../../model/types';
import { modelToJson, toCsv } from '../export';
import { collator } from '../../search/search';
import { copyText, downloadText, selectNet, selectPart, selectPin } from '../actions';
import { saveKeys, setPrefs, store, useStore } from '../store';
import { Badge, Button, Dialog, Kbd, Toggle, cx } from './ui';
import { VirtualList } from './VirtualList';

function baseName(m: BoardModel) {
  return m.source.fileName.replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------- tables

type TableKind = 'parts' | 'nets' | 'pins';
interface Col {
  key: string;
  label: string;
  w: string;
  get: (i: number) => string | number;
  mono?: boolean;
  num?: boolean;
}

function columns(m: BoardModel, t: TableKind): Col[] {
  const pn = (n: number) => (n >= 0 ? m.nets.name[n] : '');
  if (t === 'parts')
    return [
      { key: 'name', label: 'Ref', w: '110px', get: (k) => m.parts.name[k], mono: true },
      { key: 'side', label: 'Side', w: '70px', get: (k) => sideLabel(m.parts.side[k]) },
      { key: 'pins', label: 'Pins', w: '60px', get: (k) => m.parts.pinCount[k], num: true },
      { key: 'value', label: 'Value', w: 'minmax(140px,1.4fr)', get: (k) => m.parts.value[k] ?? '' },
      { key: 'footprint', label: 'Footprint', w: 'minmax(120px,1fr)', get: (k) => m.parts.footprint[k] ?? '' },
      { key: 'x', label: 'X', w: '90px', get: (k) => +m.parts.x[k].toFixed(3), num: true },
      { key: 'y', label: 'Y', w: '90px', get: (k) => +m.parts.y[k].toFixed(3), num: true },
      { key: 'rot', label: 'Rot', w: '60px', get: (k) => (Number.isNaN(m.parts.rot[k]) ? '' : m.parts.rot[k]), num: true },
    ];
  if (t === 'nets')
    return [
      { key: 'name', label: 'Net', w: 'minmax(200px,2fr)', get: (n) => m.nets.name[n], mono: true },
      { key: 'pins', label: 'Pins', w: '80px', get: (n) => m.nets.pinStart[n + 1] - m.nets.pinStart[n], num: true },
      {
        key: 'parts',
        label: 'Parts',
        w: 'minmax(200px,3fr)',
        get: (n) => {
          const s = new Set<string>();
          for (let j = m.nets.pinStart[n]; j < m.nets.pinStart[n + 1] && s.size < 12; j++) {
            const k = m.pins.part[m.nets.pinIndex[j]];
            if (k >= 0) s.add(m.parts.name[k]);
          }
          return [...s].join(' ');
        },
      },
    ];
  return [
    { key: 'part', label: 'Part', w: '110px', get: (i) => (m.pins.part[i] >= 0 ? m.parts.name[m.pins.part[i]] : '(test point)'), mono: true },
    { key: 'number', label: 'Pin', w: '70px', get: (i) => m.pins.number[i], mono: true },
    { key: 'name', label: 'Name', w: '90px', get: (i) => m.pins.name[i], mono: true },
    { key: 'net', label: 'Net', w: 'minmax(160px,2fr)', get: (i) => pn(m.pins.net[i]), mono: true },
    { key: 'side', label: 'Side', w: '70px', get: (i) => sideLabel(m.pins.side[i]) },
    { key: 'x', label: 'X', w: '90px', get: (i) => +m.pins.x[i].toFixed(3), num: true },
    { key: 'y', label: 'Y', w: '90px', get: (i) => +m.pins.y[i].toFixed(3), num: true },
  ];
}

export function TablesDialog() {
  const board = useStore(store, (s) => s.board);
  const [tab, setTab] = useState<TableKind>('parts');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const m = board?.model;
  const cols = useMemo(() => (m ? columns(m, tab) : []), [m, tab]);
  const rows = useMemo(() => {
    if (!m) return [];
    const count = tab === 'parts' ? m.parts.count : tab === 'nets' ? m.nets.count : m.pins.count;
    const ql = q.trim().toLowerCase();
    const filterCols = cols.filter((c) => !c.num);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!ql || filterCols.some((c) => String(c.get(i)).toLowerCase().includes(ql))) out.push(i);
    }
    const col = cols.find((c) => c.key === sort.key) ?? cols[0];
    out.sort((a, b) => {
      const va = col.get(a),
        vb = col.get(b);
      const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb));
      return r * sort.dir;
    });
    return out;
  }, [m, tab, q, sort, cols]);
  if (!m) return null;
  const close = () => store.set({ dialog: null });
  const jump = (i: number) => {
    close();
    if (tab === 'parts') selectPart(i);
    else if (tab === 'nets') selectNet(i);
    else selectPin(i);
  };
  const exportCsv = () => downloadText(`${baseName(m)}-${tab}.csv`, toCsv(cols.map((c) => c.label), rows.map((i) => cols.map((c) => c.get(i)))), 'text/csv;charset=utf-8');
  const exportJson = () => downloadText(`${baseName(m)}.boardscope.json`, JSON.stringify(modelToJson(m), null, 1), 'application/json');
  const grid = cols.map((c) => c.w).join(' ') + ' 64px';
  return (
    <Dialog title="Tables & export" onClose={close} wide icon={<Table2 size={16} class="text-accent" />}>
      <div class="flex flex-col h-full">
        <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
          <div class="flex rounded-md border border-line2 p-0.5" role="tablist">
            {(['parts', 'nets', 'pins'] as TableKind[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                class={cx('h-7 px-3 rounded text-[12.5px] font-medium capitalize', tab === t ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}
                onClick={() => {
                  setTab(t);
                  setSort({ key: t === 'pins' ? 'part' : 'name', dir: 1 });
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder={`Filter ${tab}…`}
            aria-label={`Filter ${tab}`}
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            class="h-8 w-56 px-2.5 rounded-md bg-panel2 border border-line2 text-[13px] outline-none focus:border-accent"
          />
          <span class="text-[12px] text-faint tabular">{rows.length.toLocaleString()} rows</span>
          <span class="flex-1" />
          <Button onClick={exportCsv} title="Export the filtered table as CSV">
            <Download size={14} /> CSV
          </Button>
          <Button onClick={exportJson} title="Export the full normalized board model as JSON">
            <Download size={14} /> JSON (model)
          </Button>
        </div>
        <div class="grid text-[11px] uppercase tracking-wider text-faint font-semibold px-4 py-2 border-b border-line gap-2" style={{ gridTemplateColumns: grid }}>
          {cols.map((c) => (
            <button
              key={c.key}
              class={cx('flex items-center gap-1 text-left hover:text-fg', sort.key === c.key && 'text-fg', c.num && 'justify-end')}
              onClick={() => setSort({ key: c.key, dir: sort.key === c.key ? (-sort.dir as 1 | -1) : 1 })}
              aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
            >
              {c.label}
              {sort.key === c.key && <ArrowDownUp size={11} />}
            </button>
          ))}
          <span />
        </div>
        <VirtualList
          class="flex-1"
          count={rows.length}
          rowHeight={28}
          label={`${tab} table`}
          render={(r) => {
            const i = rows[r];
            return (
              <div class={cx('grid items-center h-full px-4 gap-2 text-[12.5px] group', r % 2 ? 'bg-panel2/50' : '')} style={{ gridTemplateColumns: grid }}>
                {cols.map((c) => (
                  <span key={c.key} class={cx('truncate', c.mono && 'font-mono text-[12px]', c.num && 'text-right tabular')} title={String(c.get(i))}>
                    {c.get(i)}
                  </span>
                ))}
                <span class="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                  <button class="p-1 rounded hover:bg-raised" title="Copy identifier" aria-label="Copy identifier" onClick={() => copyText(String(cols[0].get(i)) + (tab === 'pins' ? '.' + String(cols[1].get(i)) : ''))}>
                    <Copy size={13} />
                  </button>
                  <button class="p-1 rounded hover:bg-raised" title="Show on board" aria-label="Show on board" onClick={() => jump(i)}>
                    <Crosshair size={13} />
                  </button>
                </span>
              </div>
            );
          }}
        />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsDialog() {
  const prefs = useStore(store, (s) => s.prefs);
  const keys = useStore(store, (s) => s.keys);
  const [fz, setFz] = useState(keys.fz);
  const [cae, setCae] = useState(keys.cae);
  const [xzz, setXzz] = useState(keys.xzz);
  const [remember, setRemember] = useState(keys.remember);
  const close = () => store.set({ dialog: null });
  const fzOk = !fz.trim() ? null : (() => {
    const k = parseKey44(fz);
    return k ? keyParityOk(k, FZ_KEY_PARITY) : false;
  })();
  const caeOk = !cae.trim() ? null : (() => {
    const k = parseKey44(cae);
    return k ? keyParityOk(k, CAE_KEY_PARITY) : false;
  })();
  const xzzOk = !xzz.trim() ? null : (() => {
    const k = parseXzzKey(xzz);
    return k ? xzzKeyParityOk(k[0], k[1]) : false;
  })();
  const save = () => {
    const k = { fz: fz.trim(), cae: cae.trim(), xzz: xzz.trim(), remember };
    store.set({ keys: k });
    saveKeys(k);
    close();
  };
  const status = (ok: boolean | null) => (ok === null ? null : ok ? <Badge tone="ok">parity OK</Badge> : <Badge tone="err">invalid</Badge>);
  return (
    <Dialog title="Settings" onClose={close} icon={<Settings size={16} class="text-accent" />}>
      <div class="p-4 space-y-5">
        <section>
          <h3 class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1">Appearance</h3>
          <Toggle label="Light theme" checked={prefs.theme === 'light'} onChange={(v) => setPrefs({ theme: v ? 'light' : 'dark' })} />
          <Toggle label="Show minimap" checked={prefs.minimap} onChange={(v) => setPrefs({ minimap: v })} />
          <Toggle
            label="Force Canvas 2D renderer"
            hint="Use only if WebGL2 misbehaves on this machine. Slower on very large boards."
            checked={prefs.forceCanvas2d}
            onChange={(v) => setPrefs({ forceCanvas2d: v })}
          />
        </section>
        <section>
          <h3 class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1 flex items-center gap-1.5">
            <KeyRound size={12} /> Decryption keys
          </h3>
          <p class="text-[12px] text-muted mb-2 leading-relaxed">
            Some vendors encrypt their boardviews. BoardScope implements these ciphers but ships <strong>no keys</strong>. Only enter keys you are entitled to use. Keys never
            leave this browser.
          </p>
          <label class="block text-[12.5px] mt-2">
            <span class="flex items-center gap-2">FZ key (44 hex words) {status(fzOk)}</span>
            <textarea class="mt-1 w-full h-16 rounded-md bg-panel2 border border-line2 p-2 font-mono text-[11.5px] outline-none focus:border-accent" value={fz} onInput={(e) => setFz((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
          </label>
          <label class="block text-[12.5px] mt-2">
            <span class="flex items-center gap-2">CAE key (44 hex words) {status(caeOk)}</span>
            <textarea class="mt-1 w-full h-16 rounded-md bg-panel2 border border-line2 p-2 font-mono text-[11.5px] outline-none focus:border-accent" value={cae} onInput={(e) => setCae((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
          </label>
          <label class="block text-[12.5px] mt-2">
            <span class="flex items-center gap-2">XZZ key (16 hex digits) {status(xzzOk)}</span>
            <input class="mt-1 w-full h-8 rounded-md bg-panel2 border border-line2 px-2 font-mono text-[12px] outline-none focus:border-accent" value={xzz} onInput={(e) => setXzz((e.target as HTMLInputElement).value)} spellcheck={false} />
          </label>
          <div class="mt-2">
            <Toggle label="Remember keys in this browser" hint="Off by default: keys are kept in memory and forgotten when the page closes." checked={remember} onChange={setRemember} />
          </div>
        </section>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="solid" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- help

const SHORTCUTS: [string[], string][] = [
  [['Ctrl/⌘', 'O'], 'Open file'],
  [['/'], 'Search'],
  [['Ctrl/⌘', 'K'], 'Search'],
  [['F'], 'Fit board'],
  [['Z'], 'Focus selection'],
  [['+', '−'], 'Zoom in / out'],
  [['Space'], 'Toggle top / bottom side'],
  [['X'], 'Mirror view'],
  [['R'], 'Rotate 90°'],
  [['M'], 'Measure tool'],
  [['V'], 'Select tool'],
  [['L'], 'Layers & display'],
  [['I'], 'Isolate selection'],
  [['H'], 'Hide other nets'],
  [['Esc'], 'Clear selection / close'],
  [['Alt', '←'], 'Back in selection history'],
  [['Alt', '→'], 'Forward in history'],
  [['T'], 'Tables & export'],
  [['['], 'Toggle explorer'],
  [[']'], 'Toggle inspector'],
  [['Shift', 'click'], 'Add part / net to selection'],
  [['Double-click'], 'Zoom in at point'],
];

export function HelpDialog() {
  const board = useStore(store, (s) => s.board);
  const close = () => store.set({ dialog: null });
  return (
    <Dialog title="Help" onClose={close} icon={<HelpCircle size={16} class="text-accent" />}>
      <div class="p-4 grid md:grid-cols-2 gap-6">
        <section>
          <h3 class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-2">Keyboard & mouse</h3>
          <ul class="space-y-1.5">
            {SHORTCUTS.map(([k, d]) => (
              <li key={d + k.join()} class="flex items-center justify-between gap-3 text-[12.5px]">
                <span class="text-muted">{d}</span>
                <span class="flex gap-1">
                  {k.map((x) => (
                    <Kbd key={x}>{x}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p class="text-[12px] text-faint mt-3">Scroll or pinch to zoom at the cursor, drag to pan. Two-finger horizontal scroll pans.</p>
        </section>
        <section class="space-y-4 text-[12.5px] text-muted leading-relaxed">
          <div>
            <h3 class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-2">What you see</h3>
            <ul class="list-disc pl-4 space-y-1">
              <li>Pads, bodies and outline are drawn from the file. When a file lacks pad sizes or outlines, sizes are derived from pin spacing and outlines are shown dashed.</li>
              <li>Highlighting a net shows pins that share its name in the file. Air wires (optional) are inferred and dashed; they are not copper.</li>
              <li>Copper traces appear only for formats that store them (TVW, GenCAD routes).</li>
            </ul>
          </div>
          <div>
            <h3 class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-2">Formats</h3>
            <ul class="space-y-1">
              {FORMATS.map((f) => (
                <li key={f.id} class="flex gap-2">
                  <Badge tone={f.status === 'verified' ? 'ok' : f.status === 'diagnostic' ? 'neutral' : 'warn'}>{f.status}</Badge>
                  <span>
                    <span class="text-fg">{f.name}</span> — {f.summary}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {board && (
            <p>
              Current board units: <span class="text-fg">{unitLabel(board.model.units)}</span>
            </p>
          )}
          <p class="text-faint text-[11.5px]">BoardScope — single-file offline viewer. Parsers derived from OpenBoardView (MIT) and eagleview (MIT). See bundled notices in the source repository.</p>
        </section>
      </div>
    </Dialog>
  );
}
