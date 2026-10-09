/**
 * Robustness: truncated, bit-flipped, spliced and random inputs must never
 * crash the parsers (only ParseErrors, reported as diagnostics), never hang,
 * and anything that does parse must still satisfy model integrity.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseKey44 } from '../../src/formats/fz';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import { validateModel } from '../../src/model/validate';
import { buildScene } from '../../src/scene/scene';
import type { ManifestEntry } from '../../tools/gen-fixtures';
import { rng } from '../../tools/fixtures/source';
import { ROOT, file } from '../helpers/load';

const manifest: ManifestEntry[] = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/manifest.json'), 'utf8'));
const ITER = Number(process.env.FUZZ_ITER ?? 40);

function run(name: string, bytes: Uint8Array, e?: ManifestEntry) {
  const opts = { ...DEFAULT_OPTIONS, maxDecompressedBytes: 64 << 20 };
  if (e?.key && e.format === 'fz') opts.fzKey = parseKey44(e.key);
  if (e?.key && e.format === 'cae') opts.caeKey = parseKey44(e.key);
  if (e?.key && e.format === 'xzz') opts.xzzKey = e.key;
  const t0 = performance.now();
  const out = parseFiles([{ name, bytes }], opts);
  const dt = performance.now() - t0;
  expect(dt, `${name} took ${dt.toFixed(0)} ms`).toBeLessThan(5000);
  expect(out.diagnostics.some((d) => d.code === 'internal'), JSON.stringify(out.diagnostics.filter((d) => d.code === 'internal'))).toBe(false);
  if (out.ok) {
    expect(validateModel(out.model!)).toEqual([]);
    buildScene(out.model!); // must not throw either
  } else expect(out.diagnostics.length).toBeGreaterThan(0);
}

describe('fuzz: mutated fixtures', () => {
  for (const e of manifest) {
    if (e.format === 'asc') continue; // multi-file set: covered by its members below
    test(e.id, () => {
      const src = file(e.files[0]).bytes;
      const r = rng(e.id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
      const name = e.files[0].split('/').pop()!;
      for (let i = 0; i < ITER; i++) {
        const mode = i % 4;
        let b: Uint8Array;
        if (mode === 0) b = src.subarray(0, Math.floor(r() * src.length)); // truncation
        else if (mode === 1) {
          b = new Uint8Array(src); // random byte flips
          const n = 1 + Math.floor(r() * 24);
          for (let k = 0; k < n; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
        } else if (mode === 2) {
          // splice a random chunk elsewhere (shifts every later offset)
          const a = Math.floor(r() * src.length),
            len = Math.floor(r() * 512);
          const at = Math.floor(r() * src.length);
          b = new Uint8Array([...src.subarray(0, at), ...src.subarray(a, a + len), ...src.subarray(at)]);
        } else {
          // overwrite 4-byte fields with extreme values (counts/offsets)
          b = new Uint8Array(src);
          const dv = new DataView(b.buffer);
          for (let k = 0; k < 6; k++) {
            const at = Math.floor(r() * (b.length - 4));
            dv.setUint32(at, [0xffffffff, 0x7fffffff, 0x80000000, 0x0fffffff, 0][k % 5], true);
          }
        }
        run(name, b, e);
      }
    });
  }
  test('ASC members', () => {
    for (const n of ['format.asc', 'pins.asc', 'nails.asc']) {
      const src = file('fixtures/synthetic/asc/' + n).bytes;
      const r = rng(n.length);
      for (let i = 0; i < ITER; i++) run(n, src.subarray(0, Math.floor(r() * src.length)));
    }
  });
});

describe('fuzz: random input', () => {
  test('random buffers with boardview-like names and headers', () => {
    const r = rng(42);
    const names = ['a.tvw', 'a.brd', 'a.bdv', 'a.fz', 'a.cad', 'a.bvr', 'a.cst', 'a.pcb', 'a.asc', 'a.zip'];
    const heads = [
      [0x13, ...Array.from('O95w-28ps49m 02v9o.', (c) => c.charCodeAt(0))],
      Array.from('str_length:\nvar_data:\n', (c) => c.charCodeAt(0)),
      Array.from('BRDOUT: 4 100 100\nNETS: 1\n', (c) => c.charCodeAt(0)),
      Array.from('$HEADER\nGENCAD 1.4\n', (c) => c.charCodeAt(0)),
      Array.from('BVRAW_FORMAT_3\nPART_NAME', (c) => c.charCodeAt(0)),
      [0x50, 0x4b, 0x03, 0x04],
      Array.from('XZZPCB', (c) => c.charCodeAt(0)),
    ];
    for (let i = 0; i < ITER * 3; i++) {
      const n = Math.floor(r() * 4096);
      const b = new Uint8Array(n).map(() => Math.floor(r() * 256));
      const h = heads[i % heads.length];
      b.set(h.slice(0, Math.min(h.length, n)));
      run(names[i % names.length], b);
    }
  });
});
