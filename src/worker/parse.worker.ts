/// <reference lib="webworker" />
import type { ParseRequest, WorkerMessage } from './protocol';
import { runParse } from './run';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<ParseRequest>) => {
  if (e.data?.type !== 'parse') return;
  try {
    runParse(e.data, (m: WorkerMessage, transfer?: ArrayBuffer[]) => ctx.postMessage(m, transfer ?? []));
  } catch (err) {
    ctx.postMessage({
      type: 'failed',
      id: e.data.id,
      diagnostics: [{ level: 'error', code: 'internal', message: `Internal error: ${(err as Error).message}` }],
      attempts: [],
    } satisfies WorkerMessage);
  }
};
