import { Inflate } from 'fflate';
import { ParseError } from './bytes';

/**
 * Inflates a zlib stream (RFC 1950) starting at `data[0]`, stopping at the end
 * of the deflate stream (trailing bytes are ignored, as zlib's inflate() does).
 * Output is capped at `maxOut` bytes to defeat decompression bombs.
 */
export function inflateZlib(data: Uint8Array, maxOut: number): Uint8Array {
  if (data.length < 2) throw new ParseError('zlib', 'Compressed block is too short');
  const cmf = data[0],
    flg = data[1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) {
    throw new ParseError('zlib', `Not a zlib stream (header ${cmf.toString(16)} ${flg.toString(16)})`);
  }
  if (flg & 0x20) throw new ParseError('zlib', 'zlib preset dictionaries are not supported');
  return inflateRaw(data.subarray(2), maxOut);
}

export function inflateRaw(data: Uint8Array, maxOut: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const inf = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > maxOut) {
      throw new ParseError('zlib-bomb', `Decompressed data exceeds the safety limit of ${Math.round(maxOut / 1048576)} MB`);
    }
    chunks.push(chunk);
    if (final) done = true;
  });
  const STEP = 1 << 16;
  try {
    for (let i = 0; i < data.length && !done; i += STEP) {
      const end = Math.min(data.length, i + STEP);
      inf.push(data.subarray(i, end), false);
    }
    if (!done) inf.push(new Uint8Array(0), true);
  } catch (e) {
    if (e instanceof ParseError) throw e;
    // fflate throws when garbage follows the end of stream in the final push;
    // treat that as success if we already received the final block.
    if (!done) throw new ParseError('zlib', `Corrupt compressed data: ${(e as Error).message}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
