import { parseFiles } from '../formats/registry';
import { modelTransferables } from '../model/types';
import { buildScene, sceneTransferables } from '../scene/scene';
import type { ParseRequest, WorkerMessage } from './protocol';

/** Shared by the worker and the main-thread fallback. */
export function runParse(req: ParseRequest, post: (m: WorkerMessage, transfer?: ArrayBuffer[]) => void) {
  const t0 = performance.now();
  let lastPost = 0;
  const progress = (phase: string, fraction?: number) => {
    const now = performance.now();
    if (fraction !== undefined && now - lastPost < 50) return;
    lastPost = now;
    post({ type: 'progress', id: req.id, phase, fraction });
  };
  const files = req.files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.buffer) }));
  const out = parseFiles(files, req.options, progress);
  if (!out.ok || !out.model) {
    post({ type: 'failed', id: req.id, diagnostics: out.diagnostics, attempts: out.attempts });
    return;
  }
  const t1 = performance.now();
  progress('Building spatial index');
  const scene = buildScene(out.model);
  const t2 = performance.now();
  post({ type: 'done', id: req.id, model: out.model, scene, timings: { parseMs: t1 - t0, sceneMs: t2 - t1 } }, [...modelTransferables(out.model), ...sceneTransferables(scene)]);
}
