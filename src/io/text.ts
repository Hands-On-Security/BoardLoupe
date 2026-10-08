/**
 * Text decoding and tokenizing helpers shared by the text-based parsers.
 */

let utf8Fatal: TextDecoder | null = null;
let cp1252: TextDecoder | null = null;

/**
 * Decodes bytes as UTF-8 when valid, otherwise as Windows-1252 (a superset of
 * Latin-1, which is what most boardview tools emit). Honours UTF-8/UTF-16 BOMs.
 * Never throws.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  try {
    utf8Fatal ??= new TextDecoder('utf-8', { fatal: true });
    return { text: utf8Fatal.decode(body), encoding: 'utf-8' };
  } catch {
    try {
      cp1252 ??= new TextDecoder('windows-1252');
      return { text: cp1252.decode(body), encoding: 'windows-1252' };
    } catch {
      let s = '';
      for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
      return { text: s, encoding: 'latin1' };
    }
  }
}

/** Splits on \r\n, \n or \r. Keeps empty lines (so line numbers are exact). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/**
 * Reproduces OpenBoardView's `stringfile()` line splitting exactly: a line
 * break followed by one more \r or \n is consumed as a single terminator, and
 * the first character of every new line is never inspected for a break. Some
 * formats (ASC/BDV) skip a fixed number of header lines, so matching the
 * reference splitting keeps us compatible with files that work in OBV.
 */
export function splitLinesObv(text: string): string[] {
  const lines: string[] = [];
  const n = text.length;
  let lineStart = 0;
  let s = 0;
  while (s < n) {
    const c = text.charCodeAt(s);
    if (c === 10 || c === 13) {
      lines.push(text.slice(lineStart, s));
      s++;
      if (s < n) {
        const d = text.charCodeAt(s);
        if (d === 13 || d === 10) s++;
      }
      if (s < n) {
        lineStart = s;
      } else {
        lineStart = -1;
      }
    }
    s++;
  }
  if (lineStart >= 0 && lineStart < n) lines.push(text.slice(lineStart));
  return lines;
}

const WS = /\s+/;

/** Whitespace tokenizer over a single line with typed accessors. */
export class Tokens {
  private t: string[];
  i = 0;
  constructor(line: string, sep: RegExp | string = WS) {
    const trimmed = line.trim();
    this.t = trimmed === '' ? [] : trimmed.split(sep);
  }
  get length() {
    return this.t.length;
  }
  get left() {
    return this.t.length - this.i;
  }
  peek(): string | undefined {
    return this.t[this.i];
  }
  str(): string {
    return this.t[this.i++] ?? '';
  }
  /** Remaining tokens joined by a single space. */
  rest(): string {
    const r = this.t.slice(this.i).join(' ');
    this.i = this.t.length;
    return r;
  }
  num(): number {
    return toNum(this.t[this.i++]);
  }
  int(): number {
    return toInt(this.t[this.i++]);
  }
}

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INT_RE = /^[+-]?\d+$/;

/** Strict decimal number parse; NaN for anything that is not a plain number. */
export function toNum(s: string | undefined): number {
  if (s === undefined || !NUM_RE.test(s)) return NaN;
  return Number(s);
}

/** Strict integer parse; NaN when not an integer literal. */
export function toInt(s: string | undefined): number {
  if (s === undefined || !INT_RE.test(s)) return NaN;
  return Number(s);
}

/**
 * C `strtod`-like prefix parse: returns the numeric prefix of `s` starting at
 * `pos` (after optional whitespace) and the position after it. Returns NaN
 * and the original position when no number is present.
 */
export function strtod(s: string, pos: number): [number, number] {
  let i = pos;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 64));
  if (!m) return [NaN, pos];
  return [Number(m[0]), i + m[0].length];
}
