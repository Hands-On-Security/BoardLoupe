/**
 * RAR/7z extraction (src/io/archive.ts) through the real vendored libarchive
 * WebAssembly. Runs in Node against the committed 7z fixture (no corpus
 * needed); RAR4 is additionally verified end-to-end in tests/e2e/archive.spec.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { archiveKind, expandOuterArchives, extractArchive } from '../../src/io/archive';
import { MAX_INPUT_BYTES } from '../../src/formats/limits';

const SEVENZIP = resolve(import.meta.dirname, '../../fixtures/real/archives/glasgow.7z');
const bytes = new Uint8Array(readFileSync(SEVENZIP));
const MB = 1024 * 1024;

describe('archiveKind', () => {
  test('detects 7z, rar, and rejects others', () => {
    expect(archiveKind(bytes)).toBe('7z');
    expect(archiveKind(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe('rar');
    expect(archiveKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // ZIP
    expect(archiveKind(new Uint8Array([0x00, 0x01]))).toBeNull();
  });
});

describe('extractArchive', () => {
  test('extracts the GenCAD member from a 7z', async () => {
    const files = await extractArchive(bytes, 512 * MB);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('glasgow-kicad10.cad');
    expect(files[0].bytes.length).toBe(933244);
    expect(new TextDecoder().decode(files[0].bytes.subarray(0, 7))).toBe('$HEADER');
  });

  test('rejects a non-archive', async () => {
    await expect(extractArchive(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 512 * MB)).rejects.toMatchObject({ code: 'archive' });
  });

  test('enforces the decompression-bomb limit', async () => {
    await expect(extractArchive(bytes, 1024)).rejects.toMatchObject({ code: 'archive-bomb' });
  });

  test('rejects an oversized container before reading it into memory', async () => {
    const archive = {
      name: 'huge.7z',
      size: MAX_INPUT_BYTES + 1,
      slice: () => new Blob([bytes.subarray(0, 8)]),
      arrayBuffer: () => { throw new Error('container was read'); },
    } as unknown as File;
    await expect(expandOuterArchives([archive], 512 * MB)).rejects.toMatchObject({ code: 'too-large' });
  });
});
