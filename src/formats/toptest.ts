/**
 * TopTest numbered-section BRD (and its same-stem .con companion).
 *
 * Plain text split by six marker lines, exactly "0 0 0 0" … "5 5 5 5", in
 * order. Coordinates are decimal text in inches (×1000 = mils):
 *
 *   0 → 1  board outline, one "x y" vertex per line
 *   1 → 2  parts: a reference line, then "x1 y1 x2 y2" (any corner order)
 *   2 → 3  reserved (not used)
 *   3 → 4  pins, three lines each: identity ("PART PIN", "PART-PIN" or "PART.PIN"),
 *          "x y", net
 *   4 → 5  test / via points, four lines each: "x y", (ignored), net, kind/label
 *
 * A .con file with the same stem adds parts, pins and points (sections 1→2,
 * 3→4, 4→5); the outline comes from the .brd. No real file of this dialect
 * is available, so malformed records are skipped and counted.
 */
import { ParseError } from '../io/bytes';
import { decodeText, splitLines, toNum } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, PINKIND_TESTPOINT, SIDE_TOP } from '../model/types';
import { baseName } from './common';
import type { FormatModule, InputFile } from './types';

const MARKER = /^([0-5]) \1 \1 \1$/;

/** Splits into the five sections between the markers; null when the markers are missing or out of order. */
function sections(text: string): string[][] | null {
  const lines = splitLines(text).map((l) => l.trim());
  const at: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]);
    if (m && Number(m[1]) === at.length) at.push(i);
  }
  if (at.length !== 6) return null;
  return Array.from({ length: 5 }, (_, s) => lines.slice(at[s] + 1, at[s + 1]).filter((l) => l !== ''));
}

const xy = (line: string): [number, number] | null => {
  const t = line.split(/[\s,]+/).filter(Boolean);
  if (t.length < 2) return null;
  const x = toNum(t[0]),
    y = toNum(t[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x * 1000, y * 1000] : null;
};

/** "PART PIN", "PART-PIN" or "PART.PIN" → [part, pin]. */
function identity(line: string): [string, string] {
  const t = line.split(/\s+/).filter(Boolean);
  if (t.length >= 2) return [t[0], t.slice(1).join(' ')];
  const m = /^(.+?)[.\-:](\w+)$/.exec(line);
  return m ? [m[1], m[2]] : [line, ''];
}

interface Parsed {
  outline: number[];
  parts: { name: string; box: [number, number, number, number] }[];
  pins: { part: string; pin: string; x: number; y: number; net: string }[];
  points: { x: number; y: number; net: string; label: string }[];
  skipped: number;
}

function parseSections(s: string[][]): Parsed {
  const out: Parsed = { outline: [], parts: [], pins: [], points: [], skipped: 0 };
  for (const l of s[0]) {
    const p = xy(l);
    if (p) out.outline.push(p[0], p[1]);
    else out.skipped++;
  }
  for (let i = 0; i + 1 < s[1].length; i += 2) {
    const t = s[1][i + 1].split(/[\s,]+/).map(toNum);
    if (t.length < 4 || !t.slice(0, 4).every(Number.isFinite)) {
      out.skipped++;
      continue;
    }
    out.parts.push({ name: s[1][i], box: [Math.min(t[0], t[2]) * 1000, Math.min(t[1], t[3]) * 1000, Math.max(t[0], t[2]) * 1000, Math.max(t[1], t[3]) * 1000] });
  }
  for (let i = 0; i + 2 < s[3].length; i += 3) {
    const p = xy(s[3][i + 1]);
    if (!p) {
      out.skipped++;
      continue;
    }
    const [part, pin] = identity(s[3][i]);
    out.pins.push({ part, pin, x: p[0], y: p[1], net: s[3][i + 2] });
  }
  for (let i = 0; i + 3 < s[4].length; i += 4) {
    const p = xy(s[4][i]);
    if (!p) {
      out.skipped++;
      continue;
    }
    out.points.push({ x: p[0], y: p[1], net: s[4][i + 2], label: s[4][i + 3] });
  }
  return out;
}

const stem = (name: string) => baseName(name).replace(/\.[^.]+$/, '').toLowerCase();

export const toptestFormat: FormatModule = {
  id: 'toptest',
  name: 'TopTest BRD (numbered sections)',
  extensions: ['brd', 'con'],
  status: 'experimental',
  summary: 'TopTest text BRD split by "0 0 0 0" … "5 5 5 5" marker lines, with an optional same-stem .con file',
  detect(s) {
    const h = s.headText;
    // The .brd is the main file; a .con alone still opens.
    if (/^\s*0 0 0 0\s*$/m.test(h) && /^\s*1 1 1 1\s*$/m.test(h)) return { confidence: s.ext === 'con' ? 0.8 : 0.85, reason: 'Numbered section markers "0 0 0 0" and "1 1 1 1"' };
    return null;
  },
  parse(ctx) {
    const main = sections(decodeText(ctx.file.bytes).text);
    if (!main) throw new ParseError('toptest.markers', 'The section markers "0 0 0 0" … "5 5 5 5" are missing or out of order');
    const parsed = parseSections(main);
    // A same-stem .con companion merges parts, pins and points.
    const companion = /\.con$/i.test(ctx.file.name) ? undefined : ctx.siblings.find((f: InputFile) => stem(f.name) === stem(ctx.file.name) && /\.con$/i.test(f.name));
    const extra: string[] = [];
    if (companion) {
      const s = sections(decodeText(companion.bytes).text);
      if (s) {
        const c = parseSections(s);
        parsed.parts.push(...c.parts);
        parsed.pins.push(...c.pins);
        parsed.points.push(...c.points);
        parsed.skipped += c.skipped;
        extra.push(companion.name);
      }
    }
    const b = new BoardBuilder();
    b.units = { unit: 'mil', toMm: 0.0254, assumed: true, note: 'TopTest coordinates are inches; shown ×1000 as mils.' };
    if (parsed.outline.length >= 6) b.addOutlinePolyline(parsed.outline, true);
    const partIndex = new Map<string, number>();
    for (const p of parsed.parts) {
      if (partIndex.has(p.name)) continue;
      partIndex.set(p.name, b.addPart({ name: p.name, side: SIDE_TOP, mount: MOUNT_SMD, bbox: p.box }));
    }
    let orphan = 0;
    for (const q of parsed.pins) {
      let pi = partIndex.get(q.part);
      if (pi === undefined) {
        orphan++;
        pi = b.addPart({ name: q.part, side: SIDE_TOP, mount: MOUNT_SMD });
        partIndex.set(q.part, pi);
      }
      b.addPin({ part: pi, x: q.x, y: q.y, number: q.pin, net: q.net || null });
    }
    parsed.points.forEach((t, i) => b.addPin({ part: -1, x: t.x, y: t.y, kind: PINKIND_TESTPOINT, side: SIDE_TOP, number: t.label || String(i + 1), probe: i + 1, net: t.net || null }));
    if (!b.partCount && !parsed.points.length) throw new ParseError('toptest.empty', 'The file has section markers but no parts, pins or test points');
    if (parsed.skipped) b.warn('toptest.skipped', `${parsed.skipped} malformed record(s) were skipped`);
    if (orphan) b.info('toptest.orphan', `${orphan} part(s) are only named by their pins`);
    b.info('toptest.sides', 'This TopTest dialect does not record sides; everything is shown on the top');
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: companion ? 'with .con' : null, extraFiles: extra });
  },
};

/** Internals for tests. */
export const _toptest = { sections, identity };
