import { ArrowDownUp, Copy, Crosshair, Download, HelpCircle, KeyRound, Settings, Table2, Trash2, Unlock, Upload } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { FORMATS } from '../../formats/registry';
import { type BoardModel, sideLabel, unitLabel } from '../../model/types';
import { modelToJson, toCsv } from '../export';
import { collator } from '../../search/search';
import { copyText, downloadText, selectNet, selectPart, selectPin } from '../actions';
import { HOS_URL, HosByline, HosLogo } from '../brand';
import { KEY_FORMATS, type KeyFormat, type KeyMap, cryptoAvailable, keyValid } from '../keystore';
import { importKeyfile, removeKeystore, saveKeystore, setSessionKeys, unlockKeystore } from '../keystore-actions';
import { setPrefs, store, useStore } from '../store';
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
  const close = () => store.set({ dialog: null });
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
        <Keystore />
        <div class="flex justify-end">
          <Button variant="solid" onClick={close}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Bring-your-own-key keystore: import, inspect, save (encrypted), unlock, remove. */
function Keystore() {
  const keys = useStore(store, (s) => s.keys);
  const ks = useStore(store, (s) => s.keystore);
  const [entry, setEntry] = useState<KeyMap>({});
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const canStore = cryptoAvailable();
  const loaded = KEY_FORMATS.filter((f) => keys[f.id]).length;

  const onImport = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setErr('');
    try {
      const warnings = importKeyfile(await file.text());
      setNotes(warnings);
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  const applyTyped = (fmt: KeyFormat, value: string) => {
    setEntry((e) => ({ ...e, [fmt]: value }));
  };
  const commit = (fmt: KeyFormat) => {
    const v = (entry[fmt] ?? '').trim();
    if (!v) return;
    if (!keyValid(fmt, v)) {
      setErr(`That ${fmt.toUpperCase()} key fails its format check (wrong key or a typo).`);
      return;
    }
    setErr('');
    setSessionKeys({ ...keys, [fmt]: v });
    setEntry((e) => ({ ...e, [fmt]: '' }));
  };
  const clearOne = (fmt: KeyFormat) => {
    const next = { ...keys };
    delete next[fmt];
    setSessionKeys(next);
  };
  const run = async (fn: () => Promise<void>, wrongMsg: string) => {
    setErr('');
    setBusy(true);
    try {
      await fn();
      setPass('');
    } catch (x) {
      setErr((x as Error).message === 'bad-passphrase' ? wrongMsg : (x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1 flex items-center gap-1.5">
        <KeyRound size={12} /> Decryption keys
      </h3>
      <p class="text-[12px] text-muted mb-2 leading-relaxed">
        Some vendors encrypt their boardviews. BoardScope implements these ciphers but ships <strong>no keys</strong>. Use only keys you are entitled to use. Keys stay in this
        browser; when saved they are encrypted with your passphrase, which is never stored.
      </p>

      {ks.present && !ks.unlocked ? (
        <div class="rounded-lg border border-line2 bg-panel2 p-3" data-testid="ks-locked">
          <div class="text-[12.5px] mb-2 flex items-center gap-1.5">
            <KeyRound size={13} class="text-accent" /> A passphrase-protected keystore is saved in this browser.
          </div>
          <div class="flex gap-2">
            <input
              type="password"
              data-testid="ks-passphrase"
              class="flex-1 h-8 rounded-md bg-panel border border-line2 px-2 text-[12px] outline-none focus:border-accent"
              placeholder="Passphrase"
              value={pass}
              onInput={(e) => setPass((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && pass && run(() => unlockKeystore(pass), 'Wrong passphrase.')}
            />
            <Button variant="solid" disabled={busy || !pass} onClick={() => run(() => unlockKeystore(pass), 'Wrong passphrase.')} data-testid="ks-unlock">
              <Unlock size={14} /> Unlock
            </Button>
          </div>
          <button class="mt-2 text-[11.5px] text-faint hover:text-err inline-flex items-center gap-1" onClick={removeKeystore} data-testid="ks-remove">
            <Trash2 size={11} /> Remove saved keys
          </button>
        </div>
      ) : (
        <div class="space-y-2" data-testid="ks-manage">
          {KEY_FORMATS.map((f) => {
            const have = !!keys[f.id];
            const typed = (entry[f.id] ?? '').trim();
            const typedOk = typed ? keyValid(f.id, typed) : null;
            return (
              <div key={f.id} class="flex items-center gap-2 text-[12.5px]">
                <span class="w-[92px] shrink-0">{f.label}</span>
                {have ? <Badge tone="ok">key loaded</Badge> : <Badge tone="neutral">not set</Badge>}
                <input
                  type="password"
                  data-testid={`ks-input-${f.id}`}
                  class="flex-1 h-7 rounded-md bg-panel2 border border-line2 px-2 font-mono text-[11.5px] outline-none focus:border-accent"
                  placeholder={`paste ${f.hint} to ${have ? 'replace' : 'set'}`}
                  value={entry[f.id] ?? ''}
                  onInput={(e) => applyTyped(f.id, (e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => e.key === 'Enter' && commit(f.id)}
                />
                {typed ? (
                  <Button variant="ghost" onClick={() => commit(f.id)} disabled={typedOk === false}>
                    Set
                  </Button>
                ) : have ? (
                  <button class="text-faint hover:text-err" title="Clear this key" onClick={() => clearOne(f.id)} data-testid={`ks-clear-${f.id}`}>
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            );
          })}

          <div class="flex flex-wrap items-center gap-2 pt-1">
            <label class="inline-flex">
              <input type="file" accept=".json,application/json" class="hidden" onChange={onImport} data-testid="ks-import-input" />
              <span class="cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-line2 px-2.5 h-8 text-[12.5px] hover:bg-raised" data-testid="ks-import">
                <Upload size={14} /> Import keyfile…
              </span>
            </label>
            <span class="text-[11px] text-faint">a JSON file of keys you created</span>
          </div>

          {loaded > 0 && (
            <div class="rounded-lg border border-line2 bg-panel2 p-3 mt-1">
              <div class="text-[12px] text-muted mb-2">
                Save {loaded} key{loaded > 1 ? 's' : ''} in this browser, encrypted with a passphrase.
              </div>
              {canStore ? (
                <div class="flex gap-2">
                  <input
                    type="password"
                    data-testid="ks-save-passphrase"
                    class="flex-1 h-8 rounded-md bg-panel border border-line2 px-2 text-[12px] outline-none focus:border-accent"
                    placeholder="Passphrase to protect the saved keys"
                    value={pass}
                    onInput={(e) => setPass((e.target as HTMLInputElement).value)}
                  />
                  <Button variant="solid" disabled={busy || pass.length < 4} onClick={() => run(() => saveKeystore(pass).then(() => void 0), '')} data-testid="ks-save">
                    Save
                  </Button>
                </div>
              ) : (
                <p class="text-[11.5px] text-warn">This browser has no Web Crypto here, so keys cannot be saved encrypted. They stay in memory for this session.</p>
              )}
              {ks.present && (
                <button class="mt-2 text-[11.5px] text-faint hover:text-err inline-flex items-center gap-1" onClick={removeKeystore} data-testid="ks-remove">
                  <Trash2 size={11} /> Remove saved keys from this browser
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {err && (
        <p class="text-[12px] text-err mt-2" data-testid="ks-error">
          {err}
        </p>
      )}
      {notes.length > 0 && (
        <ul class="text-[11.5px] text-warn mt-2 list-disc pl-4">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </section>
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
  [['G'], 'Show only this side / ghost the other'],
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
  [['A'], 'Add selection to highlight group'],
  [['Ctrl/⌘', 'P'], 'Report (A4 PDF)'],
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
          <div class="border-t border-line pt-3 flex flex-col gap-1.5">
            <a href={HOS_URL} target="_blank" rel="noopener noreferrer external" class="w-fit hover:opacity-80 transition-opacity">
              <HosLogo height={22} />
            </a>
            <p class="text-muted text-[11.5px]">
              BoardScope is a <a href={HOS_URL} target="_blank" rel="noopener noreferrer external" class="text-brand hover:underline font-medium">Hands-On Security</a> tool — practical
              hardware security training on real hardware. Used in class to find the TPM and better solder points where the same bus connects.
            </p>
            <HosByline class="text-[11px]" />
            <p class="text-faint text-[11px]">Single-file offline viewer. Parsers derived from OpenBoardView (MIT) and eagleview (MIT). See bundled notices in the source repository.</p>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
