import { unzipSync } from 'fflate';
import { ParseError, entropy, hex, startsWithBytes } from '../io/bytes';
import type { Diagnostic } from '../model/types';
import { ascFormat, bdvFormat } from './asc';
import { brdFormat } from './brd';
import { brd2Format } from './brd2';
import { bvr1Format, bvr3Format } from './bvr';
import { cadPanelFormat } from './cad';
import { extOf, makeSniff } from './common';
import { cstFormat } from './cst';
import { caeFormat, fzFormat } from './fz';
import { gencadFormat } from './gencad';
import { tvwFormat } from './tvw';
import type { Detection, FormatModule, InputFile, ParseContext, ParseOptions, ParseOutcome, Sniff } from './types';
import { xzzFormat } from './xzz';

/** Allegro .brd: recognised so the user gets a precise explanation. */
const allegroFormat: FormatModule = {
  id: 'allegro',
  name: 'Cadence Allegro board database',
  extensions: ['brd'],
  status: 'diagnostic',
  summary: 'Binary Allegro design database — not a boardview; recognised with a clear message',
  detect(_s, f) {
    const b = f.bytes;
    if (b.length >= 0xfb) {
      const tag = String.fromCharCode(b[0xf8], b[0xf9], b[0xfa]);
      if (tag === 'all' || tag === 'vie') return { confidence: 0.9, reason: `Allegro database marker "${tag}" at 0xF8` };
    }
    return null;
  },
  parse() {
    throw new ParseError(
      'unsupported.allegro',
      'This is a binary Cadence Allegro board database (.brd), not a boardview. Its proprietary layout is not supported. Export a boardview (e.g. GenCAD or "Extracta"/FZ) from Allegro, or use Allegro Free Physical Viewer.',
    );
  },
};

export const FORMATS: FormatModule[] = [
  tvwFormat,
  brdFormat,
  brd2Format,
  bdvFormat,
  ascFormat,
  bvr1Format,
  bvr3Format,
  fzFormat,
  caeFormat,
  gencadFormat,
  cadPanelFormat,
  cstFormat,
  xzzFormat,
  allegroFormat,
];

export const DEFAULT_OPTIONS: ParseOptions = {
  maxDecompressedBytes: 512 * 1024 * 1024,
};

export { MAX_INPUT_BYTES } from './limits';
import { MAX_INPUT_BYTES } from './limits';

export interface Candidate {
  format: FormatModule;
  detection: Detection;
}

export function detectAll(file: InputFile, sniff: Sniff = makeSniff(file)): Candidate[] {
  const out: Candidate[] = [];
  for (const format of FORMATS) {
    let d: Detection | null;
    try {
      d = format.detect(sniff, file);
    } catch {
      d = null;
    }
    if (d) out.push({ format, detection: d });
  }
  // Highest confidence first; prefer a matching extension on ties.
  out.sort((a, b) => b.detection.confidence - a.detection.confidence || Number(b.format.extensions.includes(sniff.ext)) - Number(a.format.extensions.includes(sniff.ext)));
  return out;
}

/** Explains what a file is when no boardview format matched. */
export function describeUnknown(file: InputFile, sniff: Sniff): string {
  const b = file.bytes;
  const ext = sniff.ext ? `.${sniff.ext}` : '(no extension)';
  if (b.length === 0) return 'The file is empty.';
  if (startsWithBytes(b, [0x25, 0x50, 0x44, 0x46])) return 'This is a PDF document (probably a schematic), not a boardview.';
  if (startsWithBytes(b, [0x52, 0x61, 0x72, 0x21])) return 'This is a RAR archive. Extract it first and open the boardview file inside.';
  if (startsWithBytes(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'This is a 7-Zip archive. Extract it first and open the boardview file inside.';
  if (startsWithBytes(b, [0x1f, 0x8b])) return 'This is a gzip-compressed file. Decompress it first.';
  if (startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47]) || startsWithBytes(b, [0xff, 0xd8, 0xff])) return 'This is an image, not a boardview.';
  if (startsWithBytes(b, [0xd0, 0xcf, 0x11, 0xe0])) return 'This is an OLE compound document (e.g. Altium .PcbDoc, Excel/Word). Binary design databases are not boardviews and are not supported.';
  if (sniff.headText.startsWith('(kicad_pcb')) return 'This is a KiCad PCB design. Export it as GenCAD (File → Fabrication Outputs → GenCAD) or use the kicad-boardview exporter.';
  const e = entropy(b);
  const head = hex(b, 16);
  const kind = sniff.isText ? 'a text file' : e > 7.5 ? 'high-entropy binary data (encrypted or compressed)' : 'binary data';
  return `No supported boardview signature was found. The file (${ext}, ${b.length.toLocaleString()} bytes) contains ${kind}; first bytes: ${head}. Extensions alone do not identify a boardview dialect — this variant is not supported yet.`;
}

const BOARD_EXTS = new Set(['tvw', 'brd', 'bv', 'brd2', 'bdv', 'asc', 'bvr', 'bvr3', 'fz', 'cae', 'cad', 'gcd', 'gencad', 'cst', 'pcb']);

/** Expands ZIP archives into their members (bounded), leaves other files untouched. */
export function expandArchives(files: InputFile[], opts: ParseOptions, notes: Diagnostic[]): InputFile[] {
  const out: InputFile[] = [];
  for (const f of files) {
    if (!startsWithBytes(f.bytes, [0x50, 0x4b, 0x03, 0x04])) {
      out.push(f);
      continue;
    }
    let total = 0;
    let members: Record<string, Uint8Array>;
    try {
      members = unzipSync(f.bytes, {
        filter: (m) => {
          if (m.name.endsWith('/')) return false;
          total += m.originalSize;
          if (total > opts.maxDecompressedBytes) throw new ParseError('zip-bomb', 'ZIP archive expands beyond the safety limit');
          return BOARD_EXTS.has(extOf(m.name)) || m.originalSize < 64 * 1024 * 1024;
        },
      });
    } catch (e) {
      throw new ParseError('zip', `Could not read ZIP archive: ${(e as Error).message}`);
    }
    const names = Object.keys(members);
    if (!names.length) throw new ParseError('zip.empty', 'The ZIP archive contains no files');
    notes.push({ level: 'info', code: 'zip', message: `Opened from ZIP archive ${f.name} (${names.length} member${names.length > 1 ? 's' : ''})` });
    for (const n of names) out.push({ name: n, bytes: members[n] });
  }
  return out;
}

/**
 * Detects and parses the best candidate among the given files (the first file
 * is the one the user chose; others are siblings, e.g. an ASC set or archive
 * members). Falls back to lower-ranked detectors when a parser rejects the file.
 */
export function parseFiles(input: InputFile[], options: ParseOptions, progress: ParseContext['progress'] = () => {}): ParseOutcome {
  const diagnostics: Diagnostic[] = [];
  const attempts: ParseOutcome['attempts'] = [];
  if (!input.length) return { ok: false, diagnostics: [{ level: 'error', code: 'nofile', message: 'No file given' }], attempts };
  for (const f of input) {
    if (f.bytes.length > MAX_INPUT_BYTES) {
      return {
        ok: false,
        attempts,
        diagnostics: [{ level: 'error', code: 'too-large', message: `${f.name} is ${(f.bytes.length / 1048576).toFixed(0)} MB, above the ${MAX_INPUT_BYTES / 1048576} MB safety limit for a single boardview file.` }],
      };
    }
  }
  let files: InputFile[];
  try {
    progress('Reading archive');
    files = expandArchives(input, options, diagnostics);
  } catch (e) {
    return { ok: false, attempts, diagnostics: [{ level: 'error', code: (e as ParseError).code ?? 'zip', message: (e as Error).message }] };
  }

  // Rank every (file, format) pair; the user's primary file wins ties.
  const ranked: { file: InputFile; cand: Candidate; order: number }[] = [];
  files.forEach((file, order) => {
    for (const cand of detectAll(file)) ranked.push({ file, cand, order });
  });
  ranked.sort((a, b) => b.cand.detection.confidence - a.cand.detection.confidence || a.order - b.order);

  const tried = new Set<string>();
  for (const { file, cand } of ranked) {
    const key = `${file.name}\0${cand.format.id}`;
    if (tried.has(key)) continue;
    tried.add(key);
    // An ASC set is parsed once, from whichever member ranks first.
    if (cand.format.id === 'asc' && attempts.some((a) => a.formatId === 'asc')) continue;
    progress(`Parsing as ${cand.format.name}`);
    try {
      const model = cand.format.parse({
        file,
        siblings: files.filter((f) => f !== file),
        options,
        detection: cand.detection,
        progress,
      });
      model.source.confidence = cand.detection.confidence;
      model.source.status = cand.format.status;
      if (cand.detection.variant && !model.source.variant) model.source.variant = cand.detection.variant;
      attempts.push({ formatId: cand.format.id, confidence: cand.detection.confidence });
      model.diagnostics.unshift(
        { level: 'info', code: 'detect', message: `Detected ${cand.format.name}: ${cand.detection.reason} (confidence ${(cand.detection.confidence * 100).toFixed(0)}%)` },
        ...diagnostics,
        ...attempts
          .filter((a) => a.error)
          .map((a) => ({ level: 'warning' as const, code: 'fallback', message: `Tried ${FORMATS.find((f) => f.id === a.formatId)?.name ?? a.formatId} first: ${a.error}` })),
      );
      return { ok: true, model, diagnostics: model.diagnostics, attempts };
    } catch (e) {
      const err = e as ParseError;
      const loc = err.offset !== undefined ? ` (offset 0x${err.offset.toString(16)})` : err.line !== undefined ? ` (line ${err.line})` : '';
      attempts.push({ formatId: cand.format.id, confidence: cand.detection.confidence, error: err.message + (err.message.includes('offset 0x') ? '' : loc) });
      // A definite failure on a strong signature should not be masked by weak guesses.
      if (err.code === 'key-required' || err.code === 'key-invalid' || err.code === 'key-wrong' || err.code?.startsWith('unsupported.') || err.code === 'asc.missing') {
        return {
          ok: false,
          attempts,
          diagnostics: [...diagnostics, { level: 'error', code: err.code, message: err.message, offset: err.offset, line: err.line }],
        };
      }
      if (!(e instanceof ParseError)) {
        // Internal error: report it rather than silently trying something else.
        diagnostics.push({ level: 'error', code: 'internal', message: `Internal error in ${cand.format.name} parser: ${(e as Error).message}` });
      }
    }
  }

  if (!attempts.length) {
    const main = files[0];
    return { ok: false, attempts, diagnostics: [...diagnostics, { level: 'error', code: 'unrecognized', message: describeUnknown(main, makeSniff(main)) }] };
  }
  const best = attempts[0];
  const fmt = FORMATS.find((f) => f.id === best.formatId);
  return {
    ok: false,
    attempts,
    diagnostics: [
      ...diagnostics,
      { level: 'error', code: 'parse-failed', message: `The file looks like ${fmt?.name ?? best.formatId} but could not be read: ${best.error}` },
      ...attempts.slice(1).map((a) => ({ level: 'info' as const, code: 'attempt', message: `Also tried ${FORMATS.find((f) => f.id === a.formatId)?.name ?? a.formatId}: ${a.error}` })),
    ],
  };
}
