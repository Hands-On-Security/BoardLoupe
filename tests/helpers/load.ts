import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import type { InputFile, ParseOptions } from '../../src/formats/types';

export const ROOT = resolve(import.meta.dirname, '../..');

export function file(path: string, name = basename(path)): InputFile {
  const buf = readFileSync(resolve(ROOT, path));
  return { name, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
}

export function parse(paths: string | string[], opts: Partial<ParseOptions> = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((p) => file(p));
  return parseFiles(list, { ...DEFAULT_OPTIONS, ...opts });
}

export function parseBytes(name: string, bytes: Uint8Array, opts: Partial<ParseOptions> = {}) {
  return parseFiles([{ name, bytes }], { ...DEFAULT_OPTIONS, ...opts });
}
