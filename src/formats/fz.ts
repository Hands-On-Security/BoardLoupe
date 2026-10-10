/**
 * FZ boardview (ASUS / ASRock; Cadence Allegro "extracta" text inside zlib).
 *
 * Reference: OpenBoardView FZFile.cpp / CAEFile.cpp (MIT).
 *
 * Container:  [4 bytes][zlib content][zlib description][u32 LE trailer]
 *   trailer = description length + 8 (the reference's split() arithmetic).
 * Two variants exist:
 *   - unencrypted ("ASRock"): bytes 4..5 are a zlib header (78 9C / 78 DA);
 *   - encrypted ("ASUS"): the whole file is an RC6-based CFB stream cipher
 *     that needs a 44-word key. No key ships with this application; users may
 *     enter one they are entitled to use, and it is kept in memory only.
 * CAE files use the same container and cipher with a different key.
 *
 * Content lines are '!'-separated: "A!" lines start a table (REFDES, NET_NAME,
 * TESTVIA, …) and "S!" lines are rows. "UNIT:millimeters" switches units.
 */
import { ParseError } from '../io/bytes';
import { inflateZlib } from '../io/inflate';
import { decodeText, splitLinesObv } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, PINKIND_TESTPOINT, SHAPE_CIRCLE, SIDE_BOTTOM, SIDE_TOP } from '../model/types';
import { MIL } from './common';
import type { FormatModule, ParseContext } from './types';

export const FZ_KEY_PARITY = [0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1];
export const CAE_KEY_PARITY = [1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0];

export function keyParityOk(key: ArrayLike<number>, parity: number[]): boolean {
  if (key.length !== 44) return false;
  for (let i = 0; i < 44; i++) {
    let t = key[i] >>> 0;
    t ^= t >>> 16;
    t ^= t >>> 8;
    t ^= t >>> 4;
    t ^= t >>> 2;
    t ^= t >>> 1;
    if ((~t & 1) !== parity[i]) return false;
  }
  return true;
}

/** Parses a key typed by the user: 44 hex words separated by whitespace/commas (0x prefixes allowed). */
export function parseKey44(text: string): number[] | null {
  const words = text
    .split(/[\s,;]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/^0x/i, ''));
  if (words.length !== 44 || !words.every((w) => /^[0-9a-f]{1,8}$/i.test(w))) return null;
  return words.map((w) => parseInt(w, 16) >>> 0);
}

const rotl = (a: number, b: number) => ((a << (b & 31)) | (a >>> (32 - (b & 31)))) >>> 0;

/**
 * RC6-based CFB stream (port of FZFile::decode). `encrypt` produces the
 * ciphertext for a plaintext (used to build test fixtures only).
 */
export function rc6Stream(src: Uint8Array, key: ArrayLike<number>, encrypt = false): Uint8Array {
  const out = new Uint8Array(src.length);
  const k = Uint32Array.from(key as ArrayLike<number>);
  const r = 20;
  let A = 0,
    B = 0,
    C = 0,
    D = 0;
  const ibuf = new Uint8Array(16);
  for (let pos = 0; pos < src.length; pos++) {
    B = (B + k[0]) >>> 0;
    D = (D + k[1]) >>> 0;
    for (let i = 1; i <= r; i++) {
      const t = rotl(Math.imul(B, (2 * B + 1) >>> 0) >>> 0, 5);
      const u = rotl(Math.imul(D, (2 * D + 1) >>> 0) >>> 0, 5);
      A = (rotl((A ^ t) >>> 0, u) + k[2 * i]) >>> 0;
      C = (rotl((C ^ u) >>> 0, t) + k[2 * i + 1]) >>> 0;
      const tmp = A;
      A = B;
      B = C;
      C = D;
      D = tmp;
    }
    A = (A + k[2 * r + 2]) >>> 0;
    // (The reference also adds k[2r+3] to C here; C is overwritten below, so it is omitted.)
    const inByte = src[pos];
    const outByte = (inByte ^ (A & 0xff)) & 0xff;
    out[pos] = outByte;
    const cipherByte = encrypt ? outByte : inByte;
    ibuf.copyWithin(0, 1);
    ibuf[15] = cipherByte;
    A = (ibuf[0] | (ibuf[1] << 8) | (ibuf[2] << 16) | (ibuf[3] << 24)) >>> 0;
    B = (ibuf[4] | (ibuf[5] << 8) | (ibuf[6] << 16) | (ibuf[7] << 24)) >>> 0;
    C = (ibuf[8] | (ibuf[9] << 8) | (ibuf[10] << 16) | (ibuf[11] << 24)) >>> 0;
    D = (ibuf[12] | (ibuf[13] << 8) | (ibuf[14] << 16) | (ibuf[15] << 24)) >>> 0;
  }
  return out;
}

function hasZlibAt4(b: Uint8Array) {
  return b.length > 6 && b[4] === 0x78 && (b[5] === 0x9c || b[5] === 0xda || b[5] === 0x01 || b[5] === 0x5e);
}

/** Splits a (decrypted) FZ container into content and description zlib streams. */
export function splitFz(buf: Uint8Array, maxOut: number): { content: Uint8Array; descr: Uint8Array | null } {
  const n = buf.length;
  if (n < 12) throw new ParseError('fz.short', 'File too short to be an FZ container');
  const len = (buf[n - 4] | (buf[n - 3] << 8) | (buf[n - 2] << 16) | (buf[n - 1] << 24)) >>> 0;
  const content = inflateZlib(buf.subarray(4), maxOut);
  let descr: Uint8Array | null = null;
  if (len > 0 && len <= n) {
    const at = n - len + 4;
    if (at > 4 && at < n) {
      try {
        descr = inflateZlib(buf.subarray(at, n), maxOut);
      } catch {
        descr = null;
      }
    }
  }
  return { content, descr };
}

interface FzOpts {
  id: string;
  name: string;
  parity: number[];
  keyOf: (ctx: ParseContext) => number[] | null | undefined;
  keyLabel: string;
}

function parseFzContainer(o: FzOpts, ctx: ParseContext) {
  let buf = ctx.file.bytes;
  let variant = 'zlib (unencrypted)';
  if (!hasZlibAt4(buf)) {
    const key = o.keyOf(ctx);
    if (!key) {
      throw new ParseError(
        'key-required',
        `This ${o.keyLabel} file is encrypted. Its format is supported, but decryption needs a 44-word key that is not distributed with this viewer. ` +
          `If you are entitled to one, enter it under Settings → Decryption keys and open the file again.`,
      );
    }
    if (!keyParityOk(key, o.parity)) throw new ParseError('key-invalid', `The configured ${o.keyLabel} key fails its parity check (wrong key or typo).`);
    ctx.progress('Decrypting', 0);
    buf = rc6Stream(buf, key);
    if (!hasZlibAt4(buf)) throw new ParseError('key-wrong', `Decryption with the configured ${o.keyLabel} key did not produce a valid FZ container (wrong key for this file?).`);
    variant = 'RC6 encrypted';
  }
  ctx.progress('Decompressing');
  const { content, descr } = splitFz(buf, ctx.options.maxDecompressedBytes);
  return { content, descr, variant };
}

function graphicSegments(type: string, f: string[], offset: number): number[] {
  const x1 = Number(f[offset]), y1 = Number(f[offset + 1]), x2 = Number(f[offset + 2]), y2 = Number(f[offset + 3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return [];
  if (type === 'LINE') return [x1, y1, x2, y2];
  if (type === 'RECTANGLE') return [x1, y1, x2, y1, x2, y1, x2, y2, x2, y2, x1, y2, x1, y2, x1, y1];
  if (type !== 'ARC') return [];
  const cx = Number(f[offset + 4]), cy = Number(f[offset + 5]), r = Number(f[offset + 6]);
  if (![cx, cy, r].every(Number.isFinite) || r <= 0) return [];
  const clockwise = /CLOCKWISE/i.test(f[offset + 8] ?? '') && !/COUNTER/i.test(f[offset + 8] ?? '');
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  let sweep = Math.atan2(y2 - cy, x2 - cx) - a0;
  if (clockwise) { if (sweep >= 0) sweep -= 2 * Math.PI; }
  else if (sweep <= 0) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const out: number[] = [];
  let px = x1, py = y1;
  for (let i = 1; i <= steps; i++) {
    const a = a0 + sweep * i / steps;
    const x = i === steps ? x2 : cx + r * Math.cos(a), y = i === steps ? y2 : cy + r * Math.sin(a);
    out.push(px, py, x, y); px = x; py = y;
  }
  return out;
}

export function parseFzText(contentBytes: Uint8Array, descrBytes: Uint8Array | null, b: BoardBuilder) {
  // Some boards use ',' as the decimal separator (the reference replaces all commas).
  const text = decodeText(contentBytes).text.replace(/,/g, '.');
  const lines = splitLinesObv(text);
  let unitMm = false;
  let block = 0;
  const partIdx = new Map<string, number>();
  const bodies = new Map<number, Map<string, number[]>>();
  let unknownPart = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    if (line === 'UNIT:millimeters' || /^A!UNIT!millimeters!?$/i.test(line)) unitMm = true;
    if (line[0] === 'A') {
      const h = line.slice(2);
      block = h.startsWith('REFDES')
        ? 1
        : h.startsWith('NET_NAME')
          ? 2
          : h.startsWith('TESTVIA')
            ? 3
            : h.startsWith('GRAPHIC_DATA_NAME')
              ? 4
              : h.startsWith('CLASS')
                ? 5
                : h.startsWith('LOGOInfo')
                  ? 6
                  : h.startsWith('UnDrawSym')
                    ? 7
                    : -1;
      continue;
    }
    if (line[0] !== 'S') continue;
    const f = line.slice(2).split('!');
    const ln = li + 1;
    if (block === 1) {
      const [name = '', , symName = '', mirror = '', rotate = ''] = f.map((s) => s.trim());
      const rot = Number(rotate);
      const idx = b.addPart({
        name,
        side: mirror === 'YES' ? SIDE_BOTTOM : SIDE_TOP,
        mount: MOUNT_SMD,
        rot: rotate !== '' && Number.isFinite(rot) ? rot : undefined,
        footprint: symName || null,
      });
      partIdx.set(name, idx);
    } else if (block === 2) {
      const [net = '', ref = '', snum = '', pname = '', xs, ys, tp, rs] = f.map((s) => s.trim());
      const x = Number(xs),
        y = Number(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y) || xs === '' || ys === '') {
        b.warn('fz.pin', 'Malformed pin row skipped', { line: ln });
        continue;
      }
      const p = partIdx.get(ref);
      if (p === undefined) unknownPart++;
      // Variant B stores "0" in PIN_NUMBER and the ball name in PIN_NAME.
      const nameIsPos = snum.length <= 1 && (snum === '' || snum === '0');
      const r = Number(rs);
      b.addPin({
        part: p ?? -1,
        x,
        y,
        net,
        number: nameIsPos ? pname : snum,
        name: nameIsPos ? '' : pname,
        side: p !== undefined ? b.partInput(p).side : undefined,
        shape: Number.isFinite(r) && r > 0 ? SHAPE_CIRCLE : undefined,
        w: Number.isFinite(r) && r > 0 ? 2 * r : undefined,
        probe: tp !== undefined && /^\d+$/.test(tp) ? Number(tp) : undefined,
      });
    } else if (block === 3) {
      // Row starts with a "Y" flag column.
      const [, net = '', ref = '', pnum = '', , xs, ys, loc = ''] = f.map((s) => s.trim());
      const x = Number(xs),
        y = Number(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y) || xs === '' || ys === '') {
        b.warn('fz.via', 'Malformed test-via row skipped', { line: ln });
        continue;
      }
      b.addPin({ part: -1, x, y, net, side: loc === 'T' ? SIDE_TOP : SIDE_BOTTOM, kind: PINKIND_TESTPOINT, number: ref ? `${ref}${pnum ? '.' + pnum : ''}` : '' });
    } else if (block === 4) {
      const layer = f[12]?.trim().toUpperCase() ?? '';
      const p = partIdx.get(f[14]?.trim() ?? '');
      if (p === undefined || !/^(?:SILKSCREEN|ASSEMBLY|PLACE_BOUND)_(?:TOP|BOTTOM)$/.test(layer)) continue;
      const segments = graphicSegments(f[0]?.trim().toUpperCase(), f, 3);
      if (!segments.length) continue;
      let byLayer = bodies.get(p);
      if (!byLayer) bodies.set(p, (byLayer = new Map()));
      const body = byLayer.get(layer) ?? [];
      body.push(...segments);
      byLayer.set(layer, body);
    } else if (block === 5) {
      if (f[0]?.trim().toUpperCase() !== 'BOARD GEOMETRY' || f[1]?.trim().toUpperCase() !== 'OUTLINE') continue;
      const segments = graphicSegments(f[2]?.trim().toUpperCase(), f, 5);
      for (let i = 0; i + 3 < segments.length; i += 4) b.addOutlineSeg(segments[i], segments[i + 1], segments[i + 2], segments[i + 3]);
    }
  }
  for (const [p, byLayer] of bodies) {
    const side = b.partInput(p).side === SIDE_BOTTOM ? 'BOTTOM' : 'TOP';
    const body = byLayer.get(`SILKSCREEN_${side}`) ?? byLayer.get(`ASSEMBLY_${side}`) ?? byLayer.get(`PLACE_BOUND_${side}`);
    if (body?.length) b.partInput(p).body = body;
  }
  if (unknownPart) b.warn('fz.unknownpart', `${unknownPart} pin row(s) reference a REFDES that is not defined; shown as unowned`);

  // Description table: tab-separated "partno, description, qty, locations, partno2".
  if (descrBytes) {
    const dlines = splitLinesObv(decodeText(descrBytes).text);
    let applied = 0;
    for (let i = 2; i < dlines.length; i++) {
      const line = dlines[i].replace(/^[ \f\v\r\n]+/, '');
      if (!line || line[0] === 's') continue;
      const cols = line.split('\t');
      const [partno = '', desc = '', , locs = '', partno2 = ''] = cols;
      for (const loc of locs.split(/\s+/).filter(Boolean)) {
        const p = partIdx.get(loc);
        if (p === undefined) continue;
        const pi = b.partInput(p);
        pi.value = desc.trim() || null;
        pi.attrs = [
          ['Part number', partno.trim()],
          ...(partno2.trim() ? ([['Part number 2', partno2.trim()]] as [string, string][]) : []),
        ];
        applied++;
      }
    }
    if (applied) b.info('fz.descr', `Part descriptions applied to ${applied} part(s)`);
  }
  b.units = unitMm ? { unit: 'mm', toMm: 1, assumed: false, note: 'File declares UNIT:millimeters' } : MIL;
}

function makeFz(o: FzOpts & { ext: string; status: 'verified' | 'partial'; summary: string }): FormatModule {
  return {
    id: o.id,
    name: o.name,
    extensions: [o.ext],
    status: o.status,
    summary: o.summary,
    detect(s, f) {
      const isExt = s.ext === o.ext;
      if (hasZlibAt4(f.bytes) && isExt) return { confidence: 0.92, variant: 'zlib', reason: `.${o.ext} file with a zlib stream at offset 4` };
      if (hasZlibAt4(f.bytes) && o.id === 'fz') {
        // Unencrypted FZ without the extension: verify the trailer arithmetic.
        const n = f.bytes.length;
        const len = (f.bytes[n - 4] | (f.bytes[n - 3] << 8) | (f.bytes[n - 2] << 16) | (f.bytes[n - 1] << 24)) >>> 0;
        if (len > 8 && len < n) return { confidence: 0.55, variant: 'zlib', reason: 'zlib stream at offset 4 with an FZ-style trailer' };
      }
      if (isExt) return { confidence: 0.5, variant: 'encrypted', reason: `.${o.ext} extension (content is encrypted; signature cannot be checked without a key)` };
      return null;
    },
    parse(ctx) {
      const { content, descr, variant } = parseFzContainer(o, ctx);
      const b = new BoardBuilder();
      ctx.progress('Parsing');
      parseFzText(content, descr, b);
      if (b.partCount === 0 && b.pinCount === 0) throw new ParseError('fz.empty', 'Decompressed FZ content has no REFDES/NET_NAME tables');
      b.metadata.push(['Container', variant]);
      return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: o.id, formatName: o.name, variant, extraFiles: [] });
    },
  };
}

export const fzFormat = makeFz({
  id: 'fz',
  name: 'FZ (Allegro extracta, zlib/RC6)',
  ext: 'fz',
  status: 'verified',
  summary: 'ASUS/ASRock .fz; unencrypted works out of the box, encrypted needs a user key',
  parity: FZ_KEY_PARITY,
  keyOf: (c) => c.options.fzKey,
  keyLabel: 'FZ',
});

export const caeFormat = makeFz({
  id: 'cae',
  name: 'CAE (FZ-style, RC6)',
  ext: 'cae',
  status: 'partial',
  summary: 'Same container as FZ with a different key',
  parity: CAE_KEY_PARITY,
  keyOf: (c) => c.options.caeKey,
  keyLabel: 'CAE',
});
