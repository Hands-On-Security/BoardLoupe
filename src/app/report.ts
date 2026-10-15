/**
 * Board analysis report: an A4-portrait, print-ready HTML document (header,
 * footer, logo, board view, highlighted nets with solder/probe points) that
 * the browser turns into a PDF via "Print → Save as PDF".
 *
 * The document is fully self-contained (images are data URIs), contains no
 * scripts, and every string that comes from the boardview file or the user is
 * HTML-escaped, so a hostile net or part name cannot inject markup.
 */
import { version } from '../../package.json';
import { solderPoints } from '../model/solder';
import { type BoardModel, NETFLAG_GROUND, NETFLAG_NOCONNECT, NETFLAG_POWER, sideLabel, unitLabel } from '../model/types';
import { DARK, LIGHT, type RGBA } from '../render/palette';
import { type Highlight, netHighlightColor } from '../render/style';
import type { Scene } from '../scene/scene';
import { BRAND_MARK_REPORT_SVG } from './brand';
import { HOS_LOGO } from './brand-logo';
import { formatBytes, formatLength } from './format';

export const APP_VERSION: string = version;
export const REPORT_URL = 'hos.direct/boardloupe';
/**
 * Shape of the board-view frame in the report: the A4 content width (210 mm
 * minus 2 × 13 mm margins) by 116 mm. The view is captured at exactly this
 * aspect so the frame is filled with board, not margins.
 */
export const REPORT_IMAGE_ASPECT = 184 / 116;
const REPORT_HREF = 'https://hos.direct/boardloupe';

export interface ReportOptions {
  title: string;
  notes: string;
  includeImage: boolean;
  /** Render the board image with the light (print-friendly) palette. */
  lightImage: boolean;
  includeMinimap: boolean;
  minimapCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  includeSolder: boolean;
  includeParts: boolean;
}

export interface ReportView {
  side: 1 | 2;
  mirror: boolean;
  rot: number;
  zoomPct: number;
  otherSide: 'ghost' | 'hide' | 'show';
}

export interface ReportImage {
  url: string;
  width: number;
  height: number;
}

interface ReportNet {
  name: string;
  color: RGBA;
  pins: number;
  kind: string;
  inGroup: boolean;
  parts: string[];
  moreParts: number;
  points: { label: string; reason: string; side: string }[];
}

interface ReportPart {
  name: string;
  value: string;
  footprint: string;
  side: string;
  pins: number;
}

export interface ReportData {
  title: string;
  notes: string;
  generated: Date;
  fileName: string;
  rows: [string, string][];
  view: string;
  image: ReportImage | null;
  nets: ReportNet[];
  parts: ReportPart[];
  includeSolder: boolean;
}

const MAX_NETS = 64;
const MAX_PARTS_PER_NET = 14;

function viewLabel(v: ReportView): string {
  const bits = [`${v.side === 2 ? 'Bottom' : 'Top'} side`];
  if (v.mirror) bits.push('mirrored');
  if (v.rot) bits.push(`rotated ${v.rot}°`);
  bits.push(`zoom ${v.zoomPct}%`);
  bits.push(v.otherSide === 'hide' ? 'other side hidden' : v.otherSide === 'show' ? 'other side shown' : 'other side ghosted');
  return bits.join(' · ');
}

/** Gathers everything the report shows from the model, scene and highlight. */
export function collectReport(m: BoardModel, s: Scene, h: Highlight, groupNets: number[], v: ReportView, o: ReportOptions, image: ReportImage | null): ReportData {
  const palette = !image || o.lightImage ? LIGHT : DARK;
  const b = m.bounds;
  const boardW = b.maxX - b.minX,
    boardH = b.maxY - b.minY;
  const rows: [string, string][] = [
    ['File', m.source.fileName],
    ['File size', formatBytes(m.source.fileSize)],
    ['Format', `${m.source.formatName}${m.source.variant ? ` (${m.source.variant})` : ''} — ${m.source.status}`],
    ['Units', unitLabel(m.units)],
    ['Board size', Number.isFinite(boardW) ? `${formatLength(boardW, m.units, true)} × ${formatLength(boardH, m.units, true)}` : 'unknown'],
    ['Contents', `${m.parts.count.toLocaleString('en')} parts · ${m.pins.count.toLocaleString('en')} pins · ${m.nets.count.toLocaleString('en')} nets${m.vias.count ? ` · ${m.vias.count.toLocaleString('en')} vias` : ''}`],
  ];
  if (m.layers.length) {
    const names = m.layers.map((l) => l.name);
    rows.push(['Layers', `${names.length}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` +${names.length - 8} more` : ''}`]);
  }
  rows.push(['View', viewLabel(v)]);

  const inGroup = new Set(groupNets);
  const nets: ReportNet[] = h.nets.slice(0, MAX_NETS).map((n) => {
    const f = m.nets.flags[n];
    const partSet = new Set<string>();
    for (let j = m.nets.pinStart[n]; j < m.nets.pinStart[n + 1]; j++) {
      const k = m.pins.part[m.nets.pinIndex[j]];
      if (k >= 0) partSet.add(m.parts.name[k]);
    }
    const allParts = [...partSet].sort((a, c) => a.localeCompare(c, 'en', { numeric: true }));
    const points: ReportNet['points'] = [];
    if (o.includeSolder) {
      // Vias have no name: list them once, with their count, at the rank of the best one.
      let vias = 0;
      for (let i = 0; i < m.vias.count; i++) if (m.vias.net[i] === n) vias++;
      let viaListed = false;
      for (const p of solderPoints(m, s.pinHW, s.pinHH, s.typicalPin, n, 40)) {
        if (points.length >= 4) break;
        if (p.kind === 'via') {
          if (viaListed) continue;
          viaListed = true;
          points.push({ label: vias === 1 ? '1 via' : `${vias} vias`, reason: 'often tented', side: '±' });
        } else points.push({ label: p.label, reason: p.reasons[0], side: p.side === 2 ? 'B' : p.side === 1 ? 'T' : '±' });
      }
    }
    return {
      name: m.nets.name[n] || '(unnamed net)',
      color: netHighlightColor(h, palette, n),
      pins: m.nets.pinStart[n + 1] - m.nets.pinStart[n],
      kind: f & NETFLAG_GROUND ? 'ground' : f & NETFLAG_POWER ? 'power' : f & NETFLAG_NOCONNECT ? 'no-connect' : 'signal',
      inGroup: inGroup.has(n),
      parts: allParts.slice(0, MAX_PARTS_PER_NET),
      moreParts: Math.max(0, allParts.length - MAX_PARTS_PER_NET),
      points,
    };
  });

  const partIdx = [...new Set([...(h.part >= 0 ? [h.part] : []), ...h.parts])];
  const parts: ReportPart[] = o.includeParts
    ? partIdx.map((k) => ({
        name: m.parts.name[k] || '(unnamed)',
        value: m.parts.value[k] ?? '',
        footprint: m.parts.footprint[k] ?? '',
        side: sideLabel(m.parts.side[k]),
        pins: m.parts.pinCount[k],
      }))
    : [];

  return {
    title: o.title.trim() || `${m.source.fileName} — board analysis`,
    notes: o.notes.trim(),
    generated: new Date(),
    fileName: m.source.fileName,
    rows,
    view: viewLabel(v),
    image: o.includeImage ? image : null,
    nets,
    parts,
    includeSolder: o.includeSolder,
  };
}

// --------------------------------------------------------------------------

/** Escapes text for HTML text and quoted-attribute contexts. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const css = (c: RGBA) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/**
 * Payload of a data:image URL (without the "data:" scheme), or '' for anything
 * else. Templates write the literal "data:" themselves, so the report can only
 * ever embed inline images — never fetch one.
 */
function dataImage(url: string): string {
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url.slice(5) : '';
}

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STYLE = `
@page { size: A4 portrait; margin: 11mm 13mm 12mm; }
@page { @bottom-right { content: counter(page) " / " counter(pages); font: 7.5pt -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #8a8a93; } }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: #e7e7ec; color: #19191c; font: 9.5pt/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: 210mm; min-height: 297mm; margin: 8mm auto; background: #fff; padding: 11mm 13mm 12mm; box-shadow: 0 1.5mm 6mm rgba(0,0,0,.18); }
table.page { width: 100%; border-collapse: collapse; }
table.page > thead > tr > td, table.page > tfoot > tr > td, table.page > tbody > tr > td { padding: 0; }
.hdr { display: flex; align-items: center; justify-content: space-between; padding-bottom: 3mm; margin-bottom: 5mm; border-bottom: 0.6mm solid #b1253d; }
.brand { display: flex; align-items: center; gap: 2.5mm; }
.brand b { font-size: 12pt; letter-spacing: -0.01em; }
.brand span { display: block; color: #56565e; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.08em; }
.hos { height: 8.5mm; }
.ftr { display: flex; justify-content: space-between; gap: 4mm; margin-top: 5mm; padding-top: 2.2mm; border-top: 0.25mm solid #d8d8dd; color: #8a8a93; font-size: 7.5pt; background: #fff; }
.ftr a { color: #b1253d; text-decoration: none; }
.ftr.fixed { display: none; }
h1 { font-size: 17pt; line-height: 1.2; margin: 0 0 1mm; letter-spacing: -0.015em; }
.sub { color: #56565e; margin: 0 0 5mm; }
h2 { font-size: 10.5pt; margin: 6mm 0 2.2mm; padding-bottom: 1mm; border-bottom: 0.25mm solid #e2e2e8; text-transform: uppercase; letter-spacing: 0.06em; color: #3a3a40; }
dl.meta { display: grid; grid-template-columns: 30mm 1fr; gap: 1.1mm 4mm; margin: 0; }
dl.meta dt { color: #56565e; }
dl.meta dd { margin: 0; word-break: break-word; }
.notes { border-left: 0.8mm solid #b1253d; background: #faf3f4; padding: 2.5mm 3.5mm; margin: 4mm 0 0; white-space: pre-wrap; }
figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
figure img { display: block; width: 100%; height: auto; aspect-ratio: 184 / 116; object-fit: contain; border: 0.25mm solid #d8d8dd; border-radius: 1mm; background: #f4f5f7; }
h2 { break-after: avoid; page-break-after: avoid; }
figcaption { color: #56565e; font-size: 8pt; margin-top: 1.5mm; }
table.data { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
table.data th { text-align: left; font-weight: 600; color: #56565e; border-bottom: 0.35mm solid #d8d8dd; padding: 1.4mm 2mm 1.4mm 0; }
table.data td { vertical-align: top; border-bottom: 0.2mm solid #ececf0; padding: 1.6mm 2mm 1.6mm 0; }
table.data tr { break-inside: avoid; page-break-inside: avoid; }
.sw { display: inline-block; width: 3.4mm; height: 3.4mm; border-radius: 0.8mm; border: 0.25mm solid rgba(0,0,0,.35); vertical-align: -0.6mm; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 8.3pt; }
.muted { color: #8a8a93; }
.tag { display: inline-block; font-size: 6.8pt; text-transform: uppercase; letter-spacing: 0.05em; color: #b1253d; border: 0.2mm solid #e7b9c1; border-radius: 0.8mm; padding: 0 1mm; margin-left: 1.2mm; vertical-align: 0.3mm; }
.pts { margin: 0; padding: 0; list-style: none; }
.pts li { white-space: nowrap; }
.empty { color: #8a8a93; font-style: italic; }
.fine { color: #8a8a93; font-size: 7.5pt; margin-top: 3mm; }
@media print {
  body { background: #fff; }
  .sheet { margin: 0; padding: 0; width: auto; min-height: 0; box-shadow: none; }
  /* The repeating table footer only reserves space; the visible footer is
     pinned to the bottom of every page. */
  .ftr.spacer { visibility: hidden; }
  .ftr.fixed { display: flex; position: fixed; left: 0; right: 0; bottom: 0; margin: 0; }
}
`;

/** The complete standalone report document. */
export function renderReportHtml(d: ReportData): string {
  const meta = d.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const generated = fmtDate(d.generated);
  const footer = `<span>Generated with BoardLoupe ${esc(APP_VERSION)} · a Hands-On Security tool · <a href="${REPORT_HREF}">${REPORT_URL}</a></span><span>${esc(d.fileName)} · ${esc(generated)}</span>`;
  const netRows = d.nets
    .map((n) => {
      const parts = n.parts.map(esc).join(', ') + (n.moreParts ? ` <span class="muted">+${n.moreParts} more</span>` : '');
      const pts = n.points.length
        ? `<ul class="pts">${n.points.map((p) => `<li><span class="mono">${esc(p.label)}</span> <span class="muted">${esc(p.reason)} · ${esc(p.side)}</span></li>`).join('')}</ul>`
        : '<span class="muted">—</span>';
      return `<tr><td><span class="sw" style="background:${css(n.color)}"></span></td><td><span class="mono">${esc(n.name)}</span>${n.inGroup ? '<span class="tag">group</span>' : ''}<div class="muted">${esc(n.kind)}</div></td><td>${n.pins}</td><td>${parts || '<span class="muted">—</span>'}</td>${d.includeSolder ? `<td>${pts}</td>` : ''}</tr>`;
    })
    .join('');
  const netsTable = d.nets.length
    ? `<table class="data"><thead><tr><th style="width:5mm"></th><th>Net</th><th style="width:10mm">Pins</th><th>Parts on net</th>${d.includeSolder ? '<th style="width:52mm">Best solder / probe points</th>' : ''}</tr></thead><tbody>${netRows}</tbody></table>`
    : '<p class="empty">No nets are highlighted.</p>';
  const partsTable = d.parts.length
    ? `<h2>Highlighted parts</h2><table class="data"><thead><tr><th>Ref</th><th>Value</th><th>Footprint</th><th style="width:16mm">Side</th><th style="width:10mm">Pins</th></tr></thead><tbody>${d.parts
        .map((p) => `<tr><td class="mono">${esc(p.name)}</td><td>${esc(p.value) || '<span class="muted">—</span>'}</td><td>${esc(p.footprint) || '<span class="muted">—</span>'}</td><td>${esc(p.side)}</td><td>${p.pins}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  const figure =
    d.image && dataImage(d.image.url)
    ? `<figure><h2>Board view</h2><img src="data:${dataImage(d.image.url)}" alt="Board view" width="${d.image.width}" height="${d.image.height}"><figcaption>${esc(d.view)}. Highlighted nets are drawn in the colours listed below.</figcaption></figure>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="BoardLoupe ${esc(APP_VERSION)} — Hands-On Security">
<title>${esc(d.title)} — BoardLoupe report</title>
<style>${STYLE}</style></head>
<body><div class="sheet"><div class="ftr fixed">${footer}</div><table class="page">
<thead><tr><td><div class="hdr"><div class="brand">${BRAND_MARK_REPORT_SVG}<div><b>BoardLoupe</b><span>Boardview analysis report</span></div></div><img class="hos" src="data:${dataImage(HOS_LOGO)}" alt="Hands-On Security"></div></td></tr></thead>
<tfoot><tr><td><div class="ftr spacer">${footer}</div></td></tr></tfoot>
<tbody><tr><td>
<h1>${esc(d.title)}</h1>
<p class="sub">${esc(d.fileName)} · generated ${esc(generated)}</p>
<h2>Board</h2><dl class="meta">${meta}</dl>
${d.notes ? `<div class="notes">${esc(d.notes)}</div>` : ''}
${figure}
<h2>Highlighted nets${d.nets.length ? ` (${d.nets.length})` : ''}</h2>
${netsTable}
${partsTable}
<p class="fine">${d.includeSolder ? 'Solder / probe points are ranked by accessibility: test points first, then through-holes, connectors and large pads; fine-pitch IC pads last. T/B = top/bottom side. ' : ''}Connectivity is taken from the net names in the boardview file. Generated offline — the file never left this computer.</p>
</td></tr></tbody></table></div></body></html>`;
}
