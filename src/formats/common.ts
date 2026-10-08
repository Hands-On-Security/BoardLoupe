import { latin1 } from '../io/bytes';
import type { UnitInfo } from '../model/types';
import type { InputFile, Sniff } from './types';

export const MIL: UnitInfo = { unit: 'mil', toMm: 0.0254, assumed: true, note: 'Format convention (thousandths of an inch); the file does not state units.' };
export const INCH: UnitInfo = { unit: 'inch', toMm: 25.4, assumed: true, note: 'Format convention (inches); the file does not state units.' };

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function baseName(name: string): string {
  const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return i >= 0 ? name.slice(i + 1) : name;
}

export function makeSniff(f: InputFile): Sniff {
  const head = f.bytes.subarray(0, Math.min(f.bytes.length, 256 * 1024));
  let ctrl = 0;
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) {
    const c = head[i];
    if (c < 9 || (c > 13 && c < 32) || c === 127) ctrl++;
  }
  return {
    name: f.name,
    ext: extOf(f.name),
    size: f.bytes.length,
    head,
    headText: latin1(head),
    tail: f.bytes.subarray(Math.max(0, f.bytes.length - 16)),
    isText: n > 0 && ctrl / n < 0.02,
  };
}

/** Simple progress throttle for long loops. */
export function ticker(total: number, cb: (f: number) => void, steps = 20) {
  const every = Math.max(1, Math.floor(total / steps));
  let next = every;
  return (i: number) => {
    if (i >= next) {
      next += every;
      cb(i / total);
    }
  };
}
