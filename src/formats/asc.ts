/**
 * ASC boardview family:
 *  - multi-file ASCII set (format.asc, pins.asc, nails.asc …), and
 *  - BDV: the same three files concatenated with "<<name.asc>>" markers and a
 *    per-line additive byte cipher.
 *
 * Reference: OpenBoardView FileFormats/ASCFile.cpp and BDVFile.cpp (MIT).
 * Header lines are skipped by count exactly as the reference does (8 for
 * format/pins, 7 for nails) using the reference line splitting, so files that
 * load in OpenBoardView load identically here.
 *
 * Coordinates are inches (the reference multiplies by 1000 to get mils).
 */
import { ParseError, indexOfAscii } from '../io/bytes';
import { decodeText, splitLinesObv, strtod } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, PINKIND_TESTPOINT, SIDE_BOTTOM, SIDE_TOP } from '../model/types';
import { INCH, baseName } from './common';
import type { FormatModule, InputFile } from './types';

/** BDV de-obfuscation (exact port of decode_bdv). */
export function decodeBdv(src: Uint8Array): Uint8Array {
  const buf = new Uint8Array(src);
  let count = 0xa0;
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 13 && (i + 1 < n ? buf[i + 1] : 0) === 10) count++;
    const x = buf[i];
    if (!(x === 13 || x === 10 || x === 0)) buf[i] = (count - x) & 0xff;
    if (count > 285) count = 159;
  }
  return buf;
}

/**
 * Encoding is the same operation: x -> count - x is an involution and the
 * key schedule only depends on CR/LF positions, which are left untouched.
 * (Valid for printable text, which never maps onto CR, LF or NUL.)
 */
export const encodeBdv = decodeBdv;

/** Cursor over one line mimicking the reference READ_* macros. */
class Cur {
  p = 0;
  constructor(public s: string) {}
  private ws() {
    while (this.p < this.s.length && /\s/.test(this.s[this.p])) this.p++;
  }
  str(): string {
    this.ws();
    const a = this.p;
    while (this.p < this.s.length && !/\s/.test(this.s[this.p])) this.p++;
    const r = this.s.slice(a, this.p);
    this.p++;
    return r;
  }
  /** Reads until two consecutive whitespace characters (READ_STR2). */
  str2(): string {
    this.ws();
    const a = this.p;
    while (this.p + 1 < this.s.length && (!/\s/.test(this.s[this.p]) || !/\s/.test(this.s[this.p + 1]))) this.p++;
    if (this.p + 1 >= this.s.length) this.p = this.s.length;
    const r = this.s.slice(a, this.p);
    this.p++;
    return r;
  }
  num(): number {
    const [v, np] = strtod(this.s, this.p);
    this.p = np;
    return v;
  }
  int(): number {
    const [v, np] = strtod(this.s, this.p);
    this.p = np;
    return Number.isFinite(v) ? Math.trunc(v) : v;
  }
}

interface AscState {
  b: BoardBuilder;
  outline: number[];
  part: number;
  partSide: number;
  orphanPins: number;
}

function parseFormatLine(st: AscState, line: string, ln: number) {
  const c = new Cur(line);
  const x = c.num(),
    y = c.num();
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    st.b.warn('asc.format', 'Malformed outline line skipped', { line: ln });
    return;
  }
  st.outline.push(x, y);
}

function parsePinLine(st: AscState, line: string, ln: number, twoSpaceNames: boolean) {
  if (line.startsWith('Part')) {
    const c = new Cur(line.slice(4));
    const name = c.str();
    const loc = c.str();
    st.partSide = loc === '(T)' ? SIDE_TOP : SIDE_BOTTOM;
    st.part = st.b.addPart({ name, side: st.partSide as 1 | 2, mount: MOUNT_SMD });
    return;
  }
  const c = new Cur(line);
  const id = c.int();
  const name = twoSpaceNames ? c.str2() : c.str();
  const x = c.num(),
    y = c.num();
  c.int(); // layer
  const net = c.str();
  const probe = c.int();
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    st.b.warn('asc.pin', 'Malformed pin line skipped', { line: ln });
    return;
  }
  if (st.part < 0) st.orphanPins++;
  st.b.addPin({
    part: st.part,
    x,
    y,
    net,
    side: (st.part >= 0 ? st.partSide : 0) as 0 | 1 | 2,
    number: Number.isFinite(id) ? String(id) : '',
    name: name.trim(),
    probe: Number.isFinite(probe) ? probe : undefined,
  });
}

function parseNailLine(st: AscState, line: string, ln: number) {
  const c = new Cur(line.slice(1)); // first character is a marker
  const probe = c.int();
  const x = c.num(),
    y = c.num();
  c.int(); // type
  c.str(); // grid
  const loc = c.str();
  c.str(); // net id
  const net = c.str();
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    st.b.warn('asc.nail', 'Malformed nail line skipped', { line: ln });
    return;
  }
  st.b.addPin({
    part: -1,
    x,
    y,
    net,
    side: loc === '(T)' ? SIDE_TOP : SIDE_BOTTOM,
    kind: PINKIND_TESTPOINT,
    number: Number.isFinite(probe) ? String(probe) : '',
    probe: Number.isFinite(probe) ? probe : undefined,
  });
}

type Section = 'format' | 'pins' | 'nails';
const SKIP: Record<Section, number> = { format: 8, pins: 8, nails: 7 };

function runSection(st: AscState, lines: string[], from: number, to: number, sec: Section, twoSpace: boolean) {
  for (let i = from; i < to; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (sec === 'format') parseFormatLine(st, line, i + 1);
    else if (sec === 'pins') parsePinLine(st, line, i + 1, twoSpace);
    else parseNailLine(st, line, i + 1);
  }
}

function finishAsc(st: AscState, file: InputFile, id: string, name: string, variant: string, extra: string[]) {
  if (st.orphanPins) st.b.warn('asc.orphan', `${st.orphanPins} pin(s) appear before any "Part" line and are shown as unowned`);
  st.b.addOutlinePolyline(st.outline, false);
  st.b.units = INCH;
  return st.b.finish({ fileName: file.name, fileSize: file.bytes.length, formatId: id, formatName: name, variant, extraFiles: extra });
}

const BDV_SIG = 'dd:1.3?,r?-=bb';

export const bdvFormat: FormatModule = {
  id: 'bdv',
  name: 'BDV (HONHAN boardview)',
  extensions: ['bdv'],
  status: 'verified',
  summary: 'Obfuscated ASC set (format/pins/nails) in a single file',
  detect(s, f) {
    if (indexOfAscii(f.bytes, BDV_SIG, 0, Math.min(f.bytes.length, 4096)) >= 0) return { confidence: 0.96, variant: 'obfuscated', reason: 'Encoded "<<format.asc>>" signature' };
    if (s.headText.includes('<<format.asc>>') && s.headText.includes('<<pins.asc>>')) return { confidence: 0.9, variant: 'plain', reason: 'Plain "<<format.asc>>" / "<<pins.asc>>" sections' };
    return null;
  },
  parse(ctx) {
    const obf = indexOfAscii(ctx.file.bytes, BDV_SIG, 0, Math.min(ctx.file.bytes.length, 4096)) >= 0;
    const bytes = obf ? decodeBdv(ctx.file.bytes) : ctx.file.bytes;
    const { text } = decodeText(bytes);
    const lines = splitLinesObv(text);
    const st: AscState = { b: new BoardBuilder(), outline: [], part: -1, partSide: 0, orphanPins: 0 };
    let sec: Section | null = null;
    let found = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const m = /^<<(format|pins|nails)\.asc>>$/.exec(line);
      if (m) {
        sec = m[1] as Section;
        found++;
        i += SKIP[sec];
        continue;
      }
      if (/^<<.*>>$/.test(line)) {
        sec = null; // unknown embedded file (e.g. parts.asc) — not used by this format
        continue;
      }
      if (!sec) continue;
      if (sec === 'format') parseFormatLine(st, line, i + 1);
      else if (sec === 'pins') parsePinLine(st, line, i + 1, false);
      else parseNailLine(st, line, i + 1);
    }
    if (!found) throw new ParseError('bdv.nosections', obf ? 'Decoded BDV contains no <<…asc>> sections' : 'No <<format.asc>> sections found');
    return finishAsc(st, ctx.file, this.id, this.name, obf ? 'obfuscated' : 'plain', []);
  },
};

const ASC_NAMES = ['format.asc', 'pins.asc', 'nails.asc', 'parts.asc', 'nets.asc'];

export const ascFormat: FormatModule = {
  id: 'asc',
  name: 'ASC boardview set',
  extensions: ['asc'],
  status: 'partial',
  summary: 'Multi-file ASCII set (format.asc + pins.asc + nails.asc); open the files together',
  detect(s) {
    const n = baseName(s.name).toLowerCase();
    if (ASC_NAMES.includes(n)) return { confidence: 0.85, reason: `File name "${n}" belongs to an ASC boardview set` };
    if (s.ext === 'asc' && /^\s*Part\s+\S+\s+\((?:T|B)\)/m.test(s.headText)) return { confidence: 0.6, reason: 'ASC pins-style "Part … (T)/(B)" lines' };
    return null;
  },
  parse(ctx) {
    const all = [ctx.file, ...ctx.siblings];
    const find = (n: string) => all.find((f) => baseName(f.name).toLowerCase() === n);
    const fFormat = find('format.asc');
    const fPins = find('pins.asc') ?? (ctx.file.name.toLowerCase().endsWith('.asc') && !find('format.asc') ? ctx.file : undefined);
    const fNails = find('nails.asc');
    if (!fPins) {
      throw new ParseError(
        'asc.missing',
        'ASC boardviews consist of several files (format.asc, pins.asc, nails.asc). Select or drop all of them together — pins.asc is required.',
      );
    }
    const st: AscState = { b: new BoardBuilder(), outline: [], part: -1, partSide: 0, orphanPins: 0 };
    const used: string[] = [];
    const run = (f: InputFile | undefined, sec: Section) => {
      if (!f) {
        st.b.warn(`asc.missing.${sec}`, `${sec}.asc was not provided; ${sec === 'format' ? 'outline is derived' : 'test points are unavailable'}`);
        return;
      }
      used.push(f.name);
      const lines = splitLinesObv(decodeText(f.bytes).text);
      // The reference skips the first non-empty line plus N-1 following lines.
      let first = 0;
      while (first < lines.length && !lines[first].trim()) first++;
      runSection(st, lines, first + SKIP[sec], lines.length, sec, true);
    };
    run(fFormat, 'format');
    run(fPins, 'pins');
    run(fNails, 'nails');
    if (st.b.pinCount === 0 && st.b.partCount === 0) throw new ParseError('asc.empty', 'No parts or pins found in pins.asc');
    return finishAsc(st, ctx.file, this.id, this.name, 'multi-file', used.filter((n) => n !== ctx.file.name));
  },
};
