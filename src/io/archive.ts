/**
 * RAR and 7-Zip extraction in the browser, via libarchive compiled to
 * WebAssembly (see src/vendor/libarchive/LICENSES.md). The WebAssembly is
 * inlined as base64 and instantiated lazily on the first RAR/7z file, so the
 * ~1 MB decoder costs nothing until it is needed and there is no network
 * request. ZIP stays on the small pure-JS path (fflate).
 */
import { ParseError } from './bytes';
import { MAX_INPUT_BYTES } from '../formats/limits';

export type ArchiveKind = 'rar' | '7z';

/** RAR ("Rar!\x1a\x07") or 7-Zip ("7z\xBC\xAF\x27\x1C") by magic, else null. */
export function archiveKind(b: Uint8Array): ArchiveKind | null {
  if (b.length >= 7 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1a && b[5] === 0x07) return 'rar';
  if (b.length >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) return '7z';
  return null;
}

interface LaModule {
  _malloc(n: number): number;
  _free(p: number): void;
  HEAPU8: Uint8Array;
  cwrap(name: string, ret: string | null, args: string[]): (...a: unknown[]) => number | string | null;
}

let modulePromise: Promise<LaModule> | null = null;

async function loadModule(): Promise<LaModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [{ default: factory }, { LIBARCHIVE_WASM_B64 }] = await Promise.all([import('../vendor/libarchive/libarchive-glue.mjs'), import('../vendor/libarchive/wasm-base64')]);
      const bin = atob(LIBARCHIVE_WASM_B64);
      const wasmBinary = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) wasmBinary[i] = bin.charCodeAt(i);
      return (await (factory as (o: unknown) => Promise<LaModule>)({ wasmBinary, print() {}, printErr() {}, locateFile: (p: string) => p })) as LaModule;
    })().catch((e) => {
      modulePromise = null;
      throw e;
    });
  }
  return modulePromise;
}

const AE_IFREG = 0o100000; // regular file

export interface ExtractedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Extracts every regular file from a RAR or 7z archive. Throws a ParseError on
 * an encrypted or damaged archive, or when the total expanded size exceeds
 * `maxTotal` (decompression-bomb guard).
 */
export async function extractArchive(bytes: Uint8Array, maxTotal: number): Promise<ExtractedFile[]> {
  const kind = archiveKind(bytes);
  if (!kind) throw new ParseError('archive', 'Not a RAR or 7z archive');
  if (bytes.length > MAX_INPUT_BYTES) throw new ParseError('too-large', `Archive is above the ${MAX_INPUT_BYTES / 1048576} MB input limit.`);
  const M = await loadModule();
  const open = M.cwrap('archive_open', 'number', ['number', 'number', 'string', 'string']) as (p: number, n: number, pass: string, loc: string) => number;
  const nextEntry = M.cwrap('get_next_entry', 'number', ['number']) as (a: number) => number;
  const entrySize = M.cwrap('archive_entry_size', 'number', ['number']) as (e: number) => number;
  const entryName = M.cwrap('archive_entry_pathname', 'string', ['number']) as (e: number) => string;
  const entryType = M.cwrap('archive_entry_filetype', 'number', ['number']) as (e: number) => number;
  const fileData = M.cwrap('get_filedata', 'number', ['number', 'number']) as (a: number, n: number) => number;
  const skip = M.cwrap('archive_read_data_skip', 'number', ['number']) as (a: number) => number;
  const closeArchive = M.cwrap('archive_close', null, ['number']) as (a: number) => void;
  const getError = M.cwrap('get_error', 'string', ['number']) as (a: number) => string;

  const filePtr = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, filePtr);
  const archive = open(filePtr, bytes.length, '', 'en_US.UTF-8');
  const out: ExtractedFile[] = [];
  let total = 0;
  try {
    if (!archive) throw new ParseError('archive', `The ${kind.toUpperCase()} archive could not be opened (damaged or an unsupported variant).`);
    for (let guard = 0; guard <= 100_000; guard++) {
      const entry = nextEntry(archive);
      if (!entry) break;
      if (guard === 100_000) throw new ParseError('archive-bomb', 'The archive contains more than 100,000 entries.');
      const isFile = (entryType(entry) & 0o170000) === AE_IFREG;
      const size = entrySize(entry);
      const name = entryName(entry) || `entry${out.length}`;
      if (!isFile || size <= 0) {
        skip(archive);
        continue;
      }
      total += size;
      if (total > maxTotal) throw new ParseError('archive-bomb', `The ${kind.toUpperCase()} archive expands beyond the ${Math.round(maxTotal / 1048576)} MB safety limit.`);
      const ptr = fileData(archive, size);
      if (ptr < 0) {
        const err = getError(archive) || '';
        if (/passphrase|encrypt|password/i.test(err)) throw new ParseError('archive-encrypted', `This ${kind.toUpperCase()} archive is password-protected. Extract it with the password first, then open the boardview inside.`);
        throw new ParseError('archive', `Could not read "${name}" from the ${kind.toUpperCase()} archive: ${err || 'unknown error'}.`);
      }
      out.push({ name, bytes: M.HEAPU8.slice(ptr, ptr + size) });
      M._free(ptr);
    }
  } finally {
    if (archive) closeArchive(archive);
    M._free(filePtr);
  }
  if (!out.length) throw new ParseError('archive-empty', `The ${kind.toUpperCase()} archive contains no files.`);
  return out;
}

/** macOS resource forks and Finder metadata that ride along in archives. */
const isJunkMember = (name: string) => name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name) || /(^|\/)\.DS_Store$/.test(name) || /(^|\/)Thumbs\.db$/i.test(name);

export interface OuterExpansion {
  files: File[];
  /** One info line per archive opened, for the diagnostics panel. */
  notes: string[];
}

/**
 * Expands any RAR or 7z archives among the chosen files into their member
 * files on the main thread (libarchive's WebAssembly cannot run in the inlined
 * IIFE worker). ZIPs and plain boardview files are passed through untouched —
 * the worker handles ZIP expansion. Member files keep the archive's base name
 * as a path prefix so the origin is visible in errors and the inspector.
 */
export async function expandOuterArchives(files: File[], maxTotal: number): Promise<OuterExpansion> {
  const notes: string[] = [];
  const out: File[] = [];
  for (const f of files) {
    const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
    const kind = archiveKind(head);
    if (!kind) {
      out.push(f);
      continue;
    }
    if (f.size > MAX_INPUT_BYTES) throw new ParseError('too-large', `${f.name} is above the ${MAX_INPUT_BYTES / 1048576} MB archive input limit.`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const members = (await extractArchive(bytes, maxTotal)).filter((m) => !isJunkMember(m.name));
    if (!members.length) throw new ParseError('archive-empty', `The ${kind.toUpperCase()} archive ${f.name} contains no files (apart from metadata).`);
    const base = f.name.replace(/\.(rar|7z)$/i, '');
    for (const m of members) {
      // Keep the archive-internal path (like ZIP expansion) so multi-file sets
      // and the inspector still see the original folder layout.
      out.push(new File([m.bytes as BlobPart], `${base}/${m.name}`, { lastModified: f.lastModified }));
    }
    notes.push(`Opened from ${kind.toUpperCase()} archive ${f.name} (${members.length} file${members.length > 1 ? 's' : ''})`);
  }
  return { files: out, notes };
}
