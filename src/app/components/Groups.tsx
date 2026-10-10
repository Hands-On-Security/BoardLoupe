import { BookmarkPlus, ChevronDown, ChevronRight, Highlighter, ImageDown, Pin, Printer, Save, Trash2, X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { BoardModel } from '../../model/types';
import { DARK, LIGHT, type Palette, type RGBA } from '../../render/palette';
import { type Highlight, netHighlightColor } from '../../render/style';
import {
  addSelectionToGroup,
  applySavedGroup,
  clearGroup,
  deleteSavedGroup,
  downloadUrl,
  exportBaseName,
  highlightFor,
  removeNetFromGroup,
  removePartFromGroup,
  saveCurrentGroup,
  selectNet,
  selectPart,
  viewer,
} from '../actions';
import { REPORT_URL } from '../report';
import { store, toast, useStore } from '../store';
import { Button, IconButton, Kbd, SectionTitle, cx } from './ui';

const rgb = (c: RGBA) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/** Current effective highlight (group + selection), independent of isolate. */
function useEffectiveHighlight() {
  const board = useStore(store, (s) => s.board);
  const sel = useStore(store, (s) => s.sel);
  const group = useStore(store, (s) => s.group);
  const theme = useStore(store, (s) => s.prefs.theme);
  const m = board?.model ?? null;
  const h = highlightFor(sel, m, false, false, group);
  const pal = theme === 'light' ? LIGHT : DARK;
  return { m, h, group, sel, pal };
}

function Swatch({ c }: { c: RGBA }) {
  return <span class="w-3 h-3 rounded-[3px] shrink-0 border border-black/30" style={{ background: rgb(c) }} />;
}

// ------------------------------------------------------------------ panel

export function GroupsPanel() {
  const { m, h, group, sel, pal } = useEffectiveHighlight();
  const saved = useStore(store, (s) => s.savedGroups);
  const [name, setName] = useState('');
  if (!m) return <div class="p-4 text-[12.5px] text-faint">Open a boardview file to build highlight groups.</div>;
  const canAdd = sel.kind !== 'none' || sel.nets.length > 0 || sel.multi.length > 0;
  const empty = !group.nets.length && !group.parts.length;
  return (
    <div class="flex-1 overflow-auto scroll-thin pb-4" data-testid="groups-panel">
      <SectionTitle
        right={
          !empty && (
            <button class="text-[11px] text-muted hover:text-fg" onClick={clearGroup}>
              Clear
            </button>
          )
        }
      >
        Highlight group
      </SectionTitle>
      <p class="px-3 pb-2 text-[12px] text-muted leading-snug">
        Nets and parts in the group stay highlighted, each net in its own colour, while you keep exploring — e.g. follow a bus through series resistors and keep the
        whole path lit.
      </p>
      <div class="px-2.5 pb-2">
        <Button variant="solid" class="w-full justify-center" disabled={!canAdd} onClick={addSelectionToGroup} title="Add the current selection to the group (A)">
          <BookmarkPlus size={15} /> Add selection to group <Kbd>A</Kbd>
        </Button>
      </div>
      {empty ? (
        <p class="px-3 text-[12px] text-faint">The group is empty. Select a net, pin or part (Shift-click for several), then add it.</p>
      ) : (
        <ul class="px-1.5" aria-label="Group members">
          {group.nets.map((n) => (
            <li key={'n' + n} class="group flex items-center gap-2 h-7 px-2 rounded-md hover:bg-raised">
              <Swatch c={netHighlightColor(h, pal, n)} />
              <button class="flex-1 min-w-0 text-left font-mono text-[12px] text-fg truncate hover:underline" onClick={() => selectNet(n)} title="Select and focus this net">
                {m.nets.name[n] || '(unnamed net)'}
              </button>
              <span class="text-[11px] text-faint tabular">{m.nets.pinStart[n + 1] - m.nets.pinStart[n]}</span>
              <IconButton label="Remove from group" size="sm" class="opacity-60 group-hover:opacity-100" onClick={() => removeNetFromGroup(n)}>
                <X size={13} />
              </IconButton>
            </li>
          ))}
          {group.parts.map((k) => (
            <li key={'p' + k} class="group flex items-center gap-2 h-7 px-2 rounded-md hover:bg-raised">
              <span class="w-3 h-3 rounded-[3px] shrink-0 border border-part/60" />
              <button class="flex-1 min-w-0 text-left font-mono text-[12px] text-part truncate hover:underline" onClick={() => selectPart(k)} title="Select and focus this part">
                {m.parts.name[k] || '(unnamed)'}
              </button>
              <span class="text-[11px] text-faint tabular">{m.parts.pinCount[k]}</span>
              <IconButton label="Remove from group" size="sm" class="opacity-60 group-hover:opacity-100" onClick={() => removePartFromGroup(k)}>
                <X size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {!empty && (
        <form
          class="flex gap-1.5 px-2.5 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveCurrentGroup(name);
            setName('');
          }}
        >
          <input
            class="flex-1 min-w-0 h-8 rounded-md bg-panel2 border border-line2 px-2 text-[12.5px] outline-none focus:border-accent"
            placeholder="Name, e.g. TPM SPI bus"
            aria-label="Group name"
            value={name}
            maxLength={80}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <Button
            title="Save this group for later (kept in this browser)"
            onClick={() => {
              saveCurrentGroup(name);
              setName('');
            }}
          >
            <Save size={14} /> Save
          </Button>
        </form>
      )}

      <SectionTitle>Saved groups</SectionTitle>
      {saved.length === 0 ? (
        <p class="px-3 text-[12px] text-faint">Saved groups are kept in this browser and re-applied by net and part name.</p>
      ) : (
        <ul class="px-1.5 space-y-0.5" aria-label="Saved groups">
          {saved.map((g) => (
            <li key={g.id} class="flex items-center gap-1 px-2 py-1.5 rounded-md hover:bg-raised">
              <button class="flex-1 min-w-0 text-left" onClick={() => applySavedGroup(g.id)} title="Apply this group">
                <span class="block text-[12.5px] text-fg truncate">{g.name}</span>
                <span class={cx('block text-[11px] truncate', g.fileName === m.source.fileName ? 'text-faint' : 'text-warn')}>
                  {g.nets.length} net{g.nets.length !== 1 ? 's' : ''}
                  {g.parts.length ? ` · ${g.parts.length} part${g.parts.length !== 1 ? 's' : ''}` : ''} · {g.fileName}
                </span>
              </button>
              <IconButton label="Apply group" size="sm" onClick={() => applySavedGroup(g.id)}>
                <Pin size={13} />
              </IconButton>
              <IconButton label="Delete saved group" size="sm" onClick={() => deleteSavedGroup(g.id)}>
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Export</SectionTitle>
      <div class="px-2.5 flex flex-col gap-1.5">
        <Button onClick={() => store.set({ dialog: 'report' })} title="A4 report with the current view, board details and highlighted nets (Ctrl/⌘+P)">
          <Printer size={14} /> Report (PDF)…
        </Button>
        <Button onClick={saveViewPng} title="The current view as a PNG, with a legend of the highlighted nets">
          <ImageDown size={14} /> Save view as PNG
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ legend

/**
 * Floating legend on the board: which colour is which net, for every
 * highlighted net (group + selection). Shown when more than one net is lit or
 * a group exists, which is exactly when colours need explaining.
 */
export function HighlightLegend() {
  const { m, h, group, pal } = useEffectiveHighlight();
  const [open, setOpen] = useState(true);
  if (!m) return null;
  const show = h.nets.length > 1 || group.nets.length > 0 || group.parts.length > 0;
  if (!show) return null;
  const inGroup = new Set(group.nets);
  const selOnly = h.nets.some((n) => !inGroup.has(n));
  return (
    <div class="absolute left-3 top-3 z-10 w-[248px] max-w-[calc(100%-24px)] rounded-lg border border-line2 bg-panel/92 shadow-pop backdrop-blur-[2px]" data-testid="highlight-legend">
      <div class="flex items-center gap-1 h-8 pl-2 pr-1">
        <button class="flex items-center gap-1.5 flex-1 min-w-0 text-left text-[11px] font-semibold uppercase tracking-wider text-faint" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Highlighter size={12} /> Highlighted <span class="text-muted normal-case tracking-normal font-normal">({h.nets.length})</span>
        </button>
        {selOnly && (
          <IconButton label="Add selection to group" shortcut="A" size="sm" onClick={addSelectionToGroup}>
            <BookmarkPlus size={14} />
          </IconButton>
        )}
        <IconButton label="Report (PDF)" shortcut="Ctrl/⌘+P" size="sm" onClick={() => store.set({ dialog: 'report' })}>
          <Printer size={14} />
        </IconButton>
      </div>
      {open && (
        <ul class="max-h-[40vh] overflow-auto scroll-thin px-1 pb-1.5">
          {h.nets.map((n) => (
            <li key={n} class="group flex items-center gap-2 h-6 px-1.5 rounded hover:bg-raised">
              <Swatch c={netHighlightColor(h, pal, n)} />
              <button class="flex-1 min-w-0 text-left font-mono text-[11.5px] text-fg truncate" onClick={() => selectNet(n)} title={m.nets.name[n]}>
                {m.nets.name[n] || '(unnamed net)'}
              </button>
              {inGroup.has(n) ? (
                <button class="text-faint hover:text-fg opacity-70 group-hover:opacity-100" aria-label="Remove from group" title="In group — click to remove" onClick={() => removeNetFromGroup(n)}>
                  <Pin size={12} />
                </button>
              ) : (
                <span class="text-[10px] text-faint">sel</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ PNG

/** Legend + attribution drawn into exported images (top-left / bottom-right). */
function drawLegend(ctx: CanvasRenderingContext2D, dpr: number, m: BoardModel, h: Highlight, p: Palette, w: number, hgt: number) {
  const light = p.bg[0] > 128;
  const fg = light ? 'rgba(20,24,30,0.95)' : 'rgba(236,238,242,0.95)';
  const sub = light ? 'rgba(70,76,88,0.9)' : 'rgba(160,168,182,0.9)';
  const panel = light ? 'rgba(255,255,255,0.88)' : 'rgba(18,20,26,0.82)';
  const font = '-apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const s = dpr;
  ctx.save();
  // Footer attribution.
  ctx.font = `${11 * s}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  ctx.fillStyle = sub;
  ctx.fillText(`${m.source.fileName} · BoardLoupe · ${REPORT_URL}`, w - 10 * s, hgt - 10 * s);
  ctx.textAlign = 'left';
  if (!h.nets.length) {
    ctx.restore();
    return;
  }
  const max = 18;
  const rows = h.nets.slice(0, max);
  const lineH = 18 * s;
  ctx.font = `${12 * s}px ${mono}`;
  let tw = 0;
  for (const n of rows) tw = Math.max(tw, ctx.measureText(m.nets.name[n] || '(unnamed net)').width);
  const boxW = Math.min(w * 0.45, tw + 40 * s);
  const boxH = 26 * s + rows.length * lineH + (h.nets.length > max ? lineH : 0) + 6 * s;
  const x0 = 10 * s,
    y0 = 10 * s;
  ctx.fillStyle = panel;
  ctx.beginPath();
  ctx.roundRect(x0, y0, boxW, boxH, 6 * s);
  ctx.fill();
  ctx.fillStyle = sub;
  ctx.font = `600 ${10 * s}px ${font}`;
  ctx.fillText(`HIGHLIGHTED NETS (${h.nets.length})`, x0 + 10 * s, y0 + 17 * s);
  ctx.font = `${12 * s}px ${mono}`;
  rows.forEach((n, i) => {
    const y = y0 + 26 * s + i * lineH;
    const c = netHighlightColor(h, p, n);
    ctx.fillStyle = rgb(c);
    ctx.fillRect(x0 + 10 * s, y + 3 * s, 11 * s, 11 * s);
    ctx.fillStyle = fg;
    ctx.fillText(m.nets.name[n] || '(unnamed net)', x0 + 28 * s, y + 13 * s, boxW - 38 * s);
  });
  if (h.nets.length > max) {
    ctx.fillStyle = sub;
    ctx.fillText(`+${h.nets.length - max} more`, x0 + 28 * s, y0 + 26 * s + max * lineH + 13 * s);
  }
  ctx.restore();
}

/** Downloads the current view as a PNG with a net legend and attribution. */
export function saveViewPng() {
  const s = store.get();
  const m = s.board?.model;
  if (!m) return;
  const h = highlightFor(s.sel, m, false, false, s.group);
  const img = viewer.captureImage({ decorate: (ctx, w, hgt, dpr) => drawLegend(ctx, dpr, m, h, viewer.palette, w, hgt) });
  if (!img) {
    toast('Could not capture the view');
    return;
  }
  downloadUrl(`${exportBaseName(m)}-view.png`, img.url);
  toast('Saved view as PNG');
}
