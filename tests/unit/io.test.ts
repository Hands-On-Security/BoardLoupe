import { zlibSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { decodeBdv, encodeBdv } from '../../src/formats/asc';
import { brdSideFromTypeLayer, decodeBrdBytes } from '../../src/formats/brd';
import { FZ_KEY_PARITY, keyParityOk, parseKey44, rc6Stream } from '../../src/formats/fz';
import { TVW_SIGNATURE, tvwDecodeString, tvwEncodeString } from '../../src/formats/tvw';
import { parseXzzKey, xzzKeyParityOk } from '../../src/formats/xzz';
import { ByteReader, ParseError, entropy, indexOfAscii } from '../../src/io/bytes';
import { desBlock, desEcb, desSubkeys } from '../../src/io/des';
import { inflateZlib } from '../../src/io/inflate';
import { decodeText, splitLines, splitLinesObv, strtod, toInt, toNum } from '../../src/io/text';
import { testKey44 } from '../../tools/fixtures/writers';

describe('ByteReader', () => {
  test('reads little-endian values', () => {
    const r = new ByteReader(new Uint8Array([1, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0xff, 0xff, 0xff, 0xff]));
    expect(r.u8()).toBe(1);
    expect(r.u16()).toBe(0x1234);
    expect(r.u32()).toBe(0x12345678);
    expect(r.s32()).toBe(-1);
    expect(r.remaining).toBe(0);
  });
  test('throws ParseError with offset on truncation', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    r.u16();
    try {
      r.u32('thing');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).code).toBe('truncated');
      expect((e as ParseError).offset).toBe(2);
      expect((e as Error).message).toContain('thing');
    }
  });
  test('rejects negative and oversized skips and seeks', () => {
    const r = new ByteReader(new Uint8Array(4));
    expect(() => r.skip(5)).toThrow(ParseError);
    expect(() => r.skip(-1)).toThrow(ParseError);
    expect(() => r.seek(99)).toThrow(ParseError);
  });
  test('bool8 rejects values other than 0/1', () => {
    expect(() => new ByteReader(new Uint8Array([2])).bool8()).toThrow(/boolean/);
  });
  test('indexOfAscii and entropy', () => {
    const b = new TextEncoder().encode('xxCPadyy');
    expect(indexOfAscii(b, 'CPad')).toBe(2);
    expect(indexOfAscii(b, 'nope')).toBe(-1);
    expect(entropy(new Uint8Array(1000))).toBe(0);
    const rnd = new Uint8Array(65536).map((_, i) => (i * 2654435761) >>> 24);
    expect(entropy(rnd)).toBeGreaterThan(7.5);
  });
});

describe('text helpers', () => {
  test('splitLines keeps empty lines for exact line numbers', () => {
    expect(splitLines('a\r\nb\n\nc\rd')).toEqual(['a', 'b', '', 'c', 'd']);
  });
  test('splitLinesObv reproduces the reference stringfile() quirks', () => {
    expect(splitLinesObv('A\r\n\r\nB')).toEqual(['A', '\r', 'B']);
    expect(splitLinesObv('A\n\nB')).toEqual(['A', 'B']);
    expect(splitLinesObv('A\nB\n')).toEqual(['A', 'B']);
    expect(splitLinesObv('one')).toEqual(['one']);
  });
  test('decodeText handles UTF-8, BOM and Windows-1252 fallback', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).text).toBe('A');
    expect(decodeText(new TextEncoder().encode('Ω µ')).encoding).toBe('utf-8');
    const cp = decodeText(new Uint8Array([0x41, 0xb5, 0x80]));
    expect(cp.encoding).toBe('windows-1252');
    expect(cp.text).toBe('Aµ€');
  });
  test('strict number parsing', () => {
    expect(toNum('1.5e3')).toBe(1500);
    expect(toNum('-.5')).toBe(-0.5);
    expect(toNum('12abc')).toBeNaN();
    expect(toNum(undefined)).toBeNaN();
    expect(toInt('42')).toBe(42);
    expect(toInt('4.2')).toBeNaN();
    expect(strtod('  3.25,4', 0)).toEqual([3.25, 6]);
    expect(strtod('x', 0)[0]).toBeNaN();
  });
});

describe('decompression', () => {
  test('inflates zlib and ignores trailing bytes', () => {
    const data = new TextEncoder().encode('hello boardview '.repeat(100));
    const z = zlibSync(data);
    const withTrailer = new Uint8Array(z.length + 7);
    withTrailer.set(z);
    expect(inflateZlib(withTrailer, 1 << 20)).toEqual(data);
  });
  test('enforces the output limit (decompression bomb)', () => {
    const z = zlibSync(new Uint8Array(8 << 20));
    expect(() => inflateZlib(z, 1 << 20)).toThrow(/safety limit/);
  });
  test('rejects non-zlib data', () => {
    expect(() => inflateZlib(new Uint8Array([1, 2, 3, 4]), 100)).toThrow(ParseError);
  });
});

describe('ciphers', () => {
  test('DES matches the FIPS 46 worked example', () => {
    const keys = desSubkeys(0x13345779, 0x9bbcdff1);
    const [h, l] = desBlock(0x01234567, 0x89abcdef, keys, false);
    expect(h.toString(16)).toBe('85e81354');
    expect(l.toString(16)).toBe('f0ab405');
    expect(desBlock(h, l, keys, true)).toEqual([0x01234567, 0x89abcdef]);
  });
  test('DES ECB round trip on bytes', () => {
    const data = new Uint8Array(64).map((_, i) => i * 7);
    const enc = desEcb(data, 0x1f2e3c4b, 0x5a667788, false);
    expect(enc).not.toEqual(data);
    expect(desEcb(enc, 0x1f2e3c4b, 0x5a667788, true)).toEqual(data);
  });
  test('RC6 CFB stream round trip and key parity', () => {
    const key = testKey44(FZ_KEY_PARITY, 123);
    expect(keyParityOk(key, FZ_KEY_PARITY)).toBe(true);
    const bad = key.slice();
    bad[3] ^= 1;
    expect(keyParityOk(bad, FZ_KEY_PARITY)).toBe(false);
    const plain = new TextEncoder().encode('A!REFDES!...\r\nS!U1!...\r\n'.repeat(20));
    const c = rc6Stream(plain, key, true);
    expect(c).not.toEqual(plain);
    expect(rc6Stream(c, key)).toEqual(plain);
  });
  test('key text parsing', () => {
    const key = testKey44(FZ_KEY_PARITY, 9);
    expect(parseKey44(key.map((k) => '0x' + k.toString(16)).join(', '))).toEqual(key);
    expect(parseKey44('1 2 3')).toBeNull();
    expect(parseXzzKey('0x1F2E3C4B5A667788')).toEqual([0x1f2e3c4b, 0x5a667788]);
    expect(xzzKeyParityOk(0x1f2e3c4b, 0x5a667788)).toBe(true);
    expect(xzzKeyParityOk(0x1f2e3c4b, 0x5a667789)).toBe(false);
    expect(parseXzzKey('zz')).toBeNull();
  });
  test('Test_Link obfuscation decodes "str_"', () => {
    expect(new TextDecoder().decode(decodeBrdBytes(new Uint8Array([0x23, 0xe2, 0x63, 0x28])))).toBe('str_');
    expect(decodeBrdBytes(new Uint8Array([13, 10, 0]))).toEqual(new Uint8Array([13, 10, 0]));
  });
  test('Test_Link type/layer to side', () => {
    expect(brdSideFromTypeLayer(1)).toBe(1);
    expect(brdSideFromTypeLayer(5)).toBe(1);
    expect(brdSideFromTypeLayer(2)).toBe(2);
    expect(brdSideFromTypeLayer(10)).toBe(2);
    expect(brdSideFromTypeLayer(0)).toBe(3);
  });
  test('BDV cipher round trip and signature', () => {
    const t = new TextEncoder().encode('<<format.asc>>\r\nline two\r\n'.repeat(80));
    const e = encodeBdv(t);
    expect(new TextDecoder('latin1').decode(e.subarray(0, 14))).toBe('dd:1.3?,r?-=bb');
    expect(decodeBdv(e)).toEqual(t);
  });
  test('TVW header string cipher', () => {
    const sig = String.fromCharCode(...TVW_SIGNATURE.slice(1));
    expect(tvwDecodeString(sig)).toBe('Tebo-ictview files.');
    for (const s of ['Tebo-ictview files.', 'ABCxyz 0123456789', 'Lenovo NM-B501 rev 2']) expect(tvwDecodeString(tvwEncodeString(s))).toBe(s);
  });
});
