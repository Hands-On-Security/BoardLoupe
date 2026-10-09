/**
 * ASC boardview family:
 *  - multi-file ASCII set (format.asc, pins.asc, nails.asc …), and
 *  - BDV: the same three files concatenated with "<<name.asc>>" markers and a
 *    per-line additive byte cipher.
 *
 * Reference: OpenBoardView FileFormats/ASCFile.cpp and BDVFile.cpp (MIT).
 * The reference skips a fixed number of header lines (8 for format/pins, 7 for
 * nails) and reads columns positionally. Real exports differ: VayoPro-Test
 * Expert sets (as read by TSICT) have shorter headers and a non-numeric nail
 * type column, so fixed skipping drops the first outline corners, parts and
 * nails and shifts every nail's side and net. Records are therefore recognised
 * by shape (numeric outline rows, "Part" lines, integer-led pin rows,
 * marker-led nail rows); header text is skipped wherever it is. Files in the
 * reference layout load identically.
 *
 * parts.asc (VayoPro: name, X, Y, rotation, grid, side, 'Device', 'Outline')
 * adds placement, rotation and footprint when present. nets.asc is redundant
 * with the net names on pins and is not needed.
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

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
/** Outline row: two or three numbers and nothing else. */
const FORMAT_RE = new RegExp(`^(${NUM})\\s+(${NUM})(?:\\s+${NUM})?$`);
/** Pin row: starts with the integer pin id. */
const PIN_RE = /^\d+\s/;
/**
 * Nail row: optional marker character ("$", "-" …), probe number, X, Y, type
 * (numeric or e.g. "FPT"), grid, (T)/(B), net id, net name.
 */
const NAIL_RE = new RegExp(`^[^\\s\\d]?(\\d+)\\s+(${NUM})\\s+(${NUM})\\s+\\S+\\s+\\S+\\s+\\(([TB])\\)\\s+\\S+\\s+(\\S+)`);
/** parts.asc row (VayoPro): name, X, Y, rotation, grid, side, 'Device', 'Outline'. */
const PARTS_RE = new RegExp(`^(\\S+)\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+\\S+\\s+\\(([TB])\\)\\s+'([^']*)'\\s*,?\\s*'([^']*)'`);
const QTY_RE = /Total\s+(Nails|Parts)\s+QTY:\s*(\d+)/i;

interface PartInfo {
  x: number;
  y: number;
  rot: number;
  side: number;
  device: string;
  outline: string;
}

interface AscState {
  b: BoardBuilder;
  outline: number[];
  part: number;
  partSide: number;
  orphanPins: number;
  nails: number;
  /** Counts announced in headers ("Total Nails QTY: 1023"). */
  expected: { nails?: number; parts?: number };
  partInfo: Map<string, PartInfo> | null;
}

function newState(): AscState {
  return { b: new BoardBuilder(), outline: [], part: -1, partSide: 0, orphanPins: 0, nails: 0, expected: {}, partInfo: null };
}

/** Returns false when the line is not an outline row. */
function parseFormatLine(st: AscState, line: string): boolean {
  const m = FORMAT_RE.exec(line);
  if (!m) return false;
  st.outline.push(Number(m[1]), Number(m[2]));
  return true;
}

function parsePinLine(st: AscState, line: string, twoSpaceNames: boolean): boolean {
  if (/^Part\s/.test(line)) {
    const c = new Cur(line.slice(4));
    const name = c.str();
    const loc = c.str();
    st.partSide = loc === '(T)' ? SIDE_TOP : SIDE_BOTTOM;
    const info = st.partInfo?.get(name);
    st.part = st.b.addPart({
      name,
      side: st.partSide as 1 | 2,
      mount: MOUNT_SMD,
      ...(info
        ? {
            x: info.x,
            y: info.y,
            rot: info.rot,
            footprint: info.outline || null,
            attrs: info.device && info.device !== '?' && info.device !== info.outline ? [['Device', info.device]] : null,
          }
        : {}),
    });
    return true;
  }
  if (!PIN_RE.test(line)) return false;
  const c = new Cur(line);
  const id = c.int();
  const name = twoSpaceNames ? c.str2() : c.str();
  const x = c.num(),
    y = c.num();
  c.int(); // layer
  const net = c.str();
  const probe = c.int();
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
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
  return true;
}

function parseNailLine(st: AscState, line: string): boolean {
  const m = NAIL_RE.exec(line);
  if (!m) return false;
  const probe = Number(m[1]);
  st.nails++;
  st.b.addPin({
    part: -1,
    x: Number(m[2]),
    y: Number(m[3]),
    net: m[5],
    side: m[4] === 'T' ? SIDE_TOP : SIDE_BOTTOM,
    kind: PINKIND_TESTPOINT,
    number: String(probe),
    probe,
  });
  return true;
}

function parsePartsFile(st: AscState, text: string) {
  const info = new Map<string, PartInfo>();
  for (const raw of splitLinesObv(text)) {
    const line = raw.trim();
    const q = QTY_RE.exec(line);
    if (q && q[1].toLowerCase() === 'parts') st.expected.parts = Number(q[2]);
    const m = PARTS_RE.exec(line);
    if (!m) continue;
    info.set(m[1], { x: Number(m[2]), y: Number(m[3]), rot: Number(m[4]), side: m[5] === 'T' ? SIDE_TOP : SIDE_BOTTOM, device: m[6].trim(), outline: m[7].trim() });
  }
  st.partInfo = info.size ? info : null;
}

type Section = 'format' | 'pins' | 'nails';

/**
 * Parses one section. Lines that are not records of the section are header
 * text before the first record; after it they are reported as malformed.
 */
function runSection(st: AscState, lines: string[], from: number, to: number, sec: Section, twoSpace: boolean) {
  let started = false;
  for (let i = from; i < to; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const ok = sec === 'format' ? parseFormatLine(st, line) : sec === 'pins' ? parsePinLine(st, line, twoSpace) : parseNailLine(st, line);
    if (ok) {
      started = true;
      continue;
    }
    const q = QTY_RE.exec(line);
    if (q && q[1].toLowerCase() === 'nails') st.expected.nails = Number(q[2]);
    if (started) st.b.warn(`asc.${sec === 'format' ? 'format' : sec === 'pins' ? 'pin' : 'nail'}`, `Malformed ${sec === 'format' ? 'outline' : sec === 'pins' ? 'pin' : 'nail'} line skipped`, { line: i + 1 });
  }
}

function finishAsc(st: AscState, file: InputFile, id: string, name: string, variant: string, extra: string[], displayName = file.name) {
  if (st.orphanPins) st.b.warn('asc.orphan', `${st.orphanPins} pin(s) appear before any "Part" line and are shown as unowned`);
  if (st.expected.nails !== undefined && st.expected.nails !== st.nails)
    st.b.warn('asc.count.nails', `The nails file announces ${st.expected.nails} nails but ${st.nails} were read`);
  if (st.expected.parts !== undefined && st.expected.parts !== st.b.partCount)
    st.b.warn('asc.count.parts', `parts.asc announces ${st.expected.parts} parts but pins.asc defines ${st.b.partCount}`);
  st.b.addOutlinePolyline(st.outline, false);
  st.b.units = INCH;
  return st.b.finish({ fileName: displayName, fileSize: file.bytes.length, formatId: id, formatName: name, variant, extraFiles: extra });
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
    const st = newState();
    // Section boundaries: each "<<name.asc>>" marker starts a section that runs to the next marker.
    const marks: { i: number; sec: Section | null }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = /^<<(format|pins|nails)\.asc>>$/.exec(line);
      if (m) marks.push({ i, sec: m[1] as Section });
      else if (/^<<.*>>$/.test(line)) marks.push({ i, sec: null }); // e.g. parts.asc — not used by this format
    }
    const found = marks.filter((k) => k.sec).length;
    marks.forEach((k, j) => {
      if (k.sec) runSection(st, lines, k.i + 1, j + 1 < marks.length ? marks[j + 1].i : lines.length, k.sec, false);
    });
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
    const fParts = find('parts.asc');
    // A differently named pins file is accepted when its content has "Part … (T)/(B)" lines.
    const fPins = find('pins.asc') ?? all.find((f) => f.name.toLowerCase().endsWith('.asc') && !ASC_NAMES.includes(baseName(f.name).toLowerCase()) && looksLikePins(f));
    const fNails = find('nails.asc');
    if (!fPins) {
      const given = all.filter((f) => f.name.toLowerCase().endsWith('.asc')).map((f) => baseName(f.name));
      throw new ParseError(
        'asc.missing',
        `ASC boardviews consist of several files (format.asc, pins.asc, nails.asc, optionally parts.asc). ${given.length ? `Only ${given.join(', ')} ${given.length === 1 ? 'was' : 'were'} provided. ` : ''}Select or drop all of them together, the folder or a ZIP — pins.asc is required.`,
      );
    }
    const st = newState();
    const used: string[] = [];
    if (fParts) {
      used.push(fParts.name);
      parsePartsFile(st, decodeText(fParts.bytes).text);
    }
    const run = (f: InputFile | undefined, sec: Section) => {
      if (!f) {
        st.b.warn(`asc.missing.${sec}`, `${sec}.asc was not provided; ${sec === 'format' ? 'outline is derived' : 'test points are unavailable'}`);
        return;
      }
      used.push(f.name);
      const lines = splitLinesObv(decodeText(f.bytes).text);
      runSection(st, lines, 0, lines.length, sec, true);
    };
    run(fFormat, 'format');
    run(fPins, 'pins');
    run(fNails, 'nails');
    if (st.b.pinCount === 0 && st.b.partCount === 0) throw new ParseError('asc.empty', 'No parts or pins found in pins.asc');
    // A set has no single file name: name it after its folder (inside a ZIP) or the ZIP itself.
    const slash = ctx.file.name.lastIndexOf('/');
    const setName = slash > 0 ? ctx.file.name.slice(0, slash).split('/').pop()! : ctx.file.archive ? ctx.file.archive.replace(/\.zip$/i, '') : ctx.file.name;
    return finishAsc(st, ctx.file, this.id, this.name, st.partInfo ? 'multi-file with parts.asc' : 'multi-file', used.filter((n) => n !== ctx.file.name), setName);
  },
};

function looksLikePins(f: InputFile): boolean {
  const head = decodeText(f.bytes.subarray(0, 64 * 1024)).text;
  return /^\s*Part\s+\S+\s+\((?:T|B)\)/m.test(head);
}
