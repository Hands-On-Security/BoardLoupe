import type { ParseOptions } from '../formats/types';
import type { BoardModel, Diagnostic } from '../model/types';
import type { Scene } from '../scene/scene';

export interface ParseRequest {
  type: 'parse';
  id: number;
  files: { name: string; buffer: ArrayBuffer }[];
  options: ParseOptions;
}

export type WorkerMessage =
  | { type: 'progress'; id: number; phase: string; fraction?: number }
  | { type: 'done'; id: number; model: BoardModel; scene: Scene; timings: Timings }
  | { type: 'failed'; id: number; diagnostics: Diagnostic[]; attempts: { formatId: string; confidence: number; error?: string }[] };

export interface Timings {
  parseMs: number;
  sceneMs: number;
}
