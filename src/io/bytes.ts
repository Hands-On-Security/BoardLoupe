/** Error raised by parsers; carries a location for diagnostics. */
export class ParseError extends Error {
  code: string;
  offset?: number;
  line?: number;
  constructor(code: string, message: string, loc?: { offset?: number; line?: number }) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.offset = loc?.offset;
    this.line = loc?.line;
  }
}

/**
 * Little-endian binary cursor with strict bounds checking. Every read
 * validates the remaining length first, so truncated or hostile input yields a
 * ParseError with the failing offset instead of garbage or an exception from
 * DataView.
 */
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;
  readonly end: number;

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
    this.end = end;
  }

  get remaining() {
    return this.end - this.pos;
  }

  need(n: number, what = 'data') {
    if (n < 0 || this.pos + n > this.end) {
      throw new ParseError('truncated', `Unexpected end of file while reading ${what} (need ${n} bytes at offset 0x${this.pos.toString(16)}, ${this.remaining} left)`, {
        offset: this.pos,
      });
    }
  }

  seek(pos: number) {
    if (pos < 0 || pos > this.end) throw new ParseError('seek', `Seek outside of file to 0x${pos.toString(16)}`, { offset: pos });
    this.pos = pos;
  }

  skip(n: number, what = 'data') {
    this.need(n, what);
    this.pos += n;
  }

  u8(what = 'u8'): number {
    this.need(1, what);
    return this.bytes[this.pos++];
  }
  s8(what = 's8'): number {
    this.need(1, what);
    return this.view.getInt8(this.pos++);
  }
  u16(what = 'u16'): number {
    this.need(2, what);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  s16(what = 's16'): number {
    this.need(2, what);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(what = 'u32'): number {
    this.need(4, what);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  s32(what = 's32'): number {
    this.need(4, what);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(what = 'f32'): number {
    this.need(4, what);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytesN(n: number, what = 'bytes'): Uint8Array {
    this.need(n, what);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** Single-byte-length-prefixed string decoded as Latin-1 (byte-exact). */
  str8(what = 'string'): string {
    const n = this.u8(what + ' length');
    return latin1(this.bytesN(n, what));
  }
  /** Boolean byte that must be 0 or 1. */
  bool8(what = 'flag'): boolean {
    const at = this.pos;
    const v = this.u8(what);
    if (v > 1) throw new ParseError('bad-bool', `Expected boolean (0/1) for ${what} at offset 0x${at.toString(16)}, found ${v}`, { offset: at });
    return v === 1;
  }
  /** Asserts a structural constant; throws a ParseError describing the mismatch. */
  expect(actual: number, expected: number | ((v: number) => boolean), what: string, at = this.pos) {
    const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
    if (!ok) {
      throw new ParseError(
        'unexpected-value',
        `Unexpected ${what} near offset 0x${at.toString(16)}: got ${actual}${typeof expected === 'number' ? `, expected ${expected}` : ''}`,
        { offset: at },
      );
    }
  }
}

export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, Math.min(b.length, i + 4096))));
  return s;
}

/** Index of an ASCII needle in a byte buffer, or -1. */
export function indexOfAscii(hay: Uint8Array, needle: string, from = 0, to = hay.length): number {
  const n = needle.length;
  if (n === 0) return from;
  const first = needle.charCodeAt(0);
  const last = Math.min(to, hay.length) - n;
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let k = 1; k < n; k++) if (hay[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

export function startsWithBytes(hay: Uint8Array, bytes: ArrayLike<number>, at = 0): boolean {
  if (hay.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (hay[at + i] !== bytes[i]) return false;
  return true;
}

export function hex(b: Uint8Array, n = 16): string {
  return Array.from(b.subarray(0, n), (x) => x.toString(16).padStart(2, '0')).join(' ');
}

/** Shannon entropy in bits/byte of (a prefix of) a buffer; ~8 for encrypted/compressed data. */
export function entropy(b: Uint8Array, max = 65536): number {
  const n = Math.min(b.length, max);
  if (!n) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < n; i++) counts[b[i]]++;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    if (!counts[i]) continue;
    const p = counts[i] / n;
    e -= p * Math.log2(p);
  }
  return e;
}
