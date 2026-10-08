import type { BoardModel, Diagnostic, FormatStatus } from '../model/types';

export interface InputFile {
  name: string;
  bytes: Uint8Array;
}

/** Cheap, precomputed view of a file used by all detectors. */
export interface Sniff {
  name: string;
  ext: string;
  size: number;
  head: Uint8Array;
  /** First 256 KiB decoded as Latin-1 (byte-exact, never throws). */
  headText: string;
  /** Last 16 bytes. */
  tail: Uint8Array;
  isText: boolean;
}

export interface Detection {
  /** 0..1. ≥0.9 means a signature match; ≤0.3 means extension-only hint. */
  confidence: number;
  variant?: string;
  reason: string;
}

export interface ParseOptions {
  /** User-supplied FZ (ASUS) RC6 key: 44 32-bit words. */
  fzKey?: number[] | null;
  /** User-supplied CAE key (same cipher as FZ, different parity). */
  caeKey?: number[] | null;
  /** User-supplied XZZ DES key (16 hex digits). */
  xzzKey?: string | null;
  maxDecompressedBytes: number;
}

export interface ParseContext {
  file: InputFile;
  /** Other files opened together (e.g. pins.asc next to format.asc). */
  siblings: InputFile[];
  options: ParseOptions;
  detection: Detection;
  progress(phase: string, fraction?: number): void;
}

export interface FormatModule {
  id: string;
  name: string;
  /** Typical extensions, informational only. */
  extensions: string[];
  status: FormatStatus;
  /** One-line description shown in the format list. */
  summary: string;
  detect(s: Sniff, file: InputFile): Detection | null;
  /** Throws ParseError on failure. Returns a model (which may carry warnings). */
  parse(ctx: ParseContext): BoardModel;
}

export interface ParseOutcome {
  ok: boolean;
  model?: BoardModel;
  /** Format-level diagnostics (detection attempts, failures). */
  diagnostics: Diagnostic[];
  attempts: { formatId: string; confidence: number; error?: string }[];
}
