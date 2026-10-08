import type { ParseOptions } from '../formats/types';
import type { BoardModel, Diagnostic } from '../model/types';
import type { Scene } from '../scene/scene';
import ParseWorker from './parse.worker.ts?worker&inline';
import type { ParseRequest, Timings, WorkerMessage } from './protocol';

export type ParseResult =
  | { ok: true; model: BoardModel; scene: Scene; timings: Timings; mode: 'worker' | 'main-thread' }
  | { ok: false; diagnostics: Diagnostic[]; attempts: { formatId: string; confidence: number; error?: string }[]; cancelled?: boolean };

export interface ParseJob {
  promise: Promise<ParseResult>;
  cancel(): void;
}

let nextId = 1;
let workerBroken = false;

/**
 * Parses files in a dedicated worker (created from an inlined Blob, so it
 * works from file://). Cancelling terminates the worker. If workers are
 * unavailable the parse runs on the main thread after a yield.
 */
export function startParse(files: File[], options: ParseOptions, onProgress: (phase: string, fraction?: number) => void): ParseJob {
  const id = nextId++;
  let worker: Worker | null = null;
  let settle: ((r: ParseResult) => void) | null = null;
  let cancelled = false;

  const promise = new Promise<ParseResult>((resolve) => {
    settle = resolve;
    (async () => {
      onProgress('Reading file');
      const buffers = await Promise.all(files.map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })));
      if (cancelled) return;
      const req: ParseRequest = { type: 'parse', id, files: buffers, options };
      if (!workerBroken) {
        try {
          worker = new ParseWorker();
        } catch {
          workerBroken = true;
        }
      }
      if (worker) {
        const w = worker;
        w.onmessage = (e: MessageEvent<WorkerMessage>) => {
          const m = e.data;
          if (m.id !== id) return;
          if (m.type === 'progress') onProgress(m.phase, m.fraction);
          else {
            w.terminate();
            if (m.type === 'done') resolve({ ok: true, model: m.model, scene: m.scene, timings: m.timings, mode: 'worker' });
            else resolve({ ok: false, diagnostics: m.diagnostics, attempts: m.attempts });
          }
        };
        w.onerror = (ev) => {
          ev.preventDefault?.();
          w.terminate();
          workerBroken = true;
          // Fall back to the main thread with fresh buffers (the old ones may be detached).
          void runOnMain(req, files, resolve, onProgress);
        };
        w.postMessage(req, buffers.map((b) => b.buffer));
      } else {
        await runOnMain(req, files, resolve, onProgress);
      }
    })().catch((e) => resolve({ ok: false, diagnostics: [{ level: 'error', code: 'read', message: `Could not read the file: ${(e as Error).message}` }], attempts: [] }));
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      (worker as Worker | null)?.terminate();
      settle?.({ ok: false, diagnostics: [{ level: 'info', code: 'cancelled', message: 'Loading was cancelled.' }], attempts: [], cancelled: true });
    },
  };
}

async function runOnMain(req: ParseRequest, files: File[], resolve: (r: ParseResult) => void, onProgress: (phase: string, fraction?: number) => void) {
  onProgress('Parsing (main thread)');
  await new Promise((r) => setTimeout(r, 30));
  const { runParse } = await import('./run');
  const buffers = await Promise.all(files.map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })));
  runParse({ ...req, files: buffers }, (m) => {
    if (m.type === 'progress') onProgress(m.phase, m.fraction);
    else if (m.type === 'done') resolve({ ok: true, model: m.model, scene: m.scene, timings: m.timings, mode: 'main-thread' });
    else resolve({ ok: false, diagnostics: m.diagnostics, attempts: m.attempts });
  });
}
