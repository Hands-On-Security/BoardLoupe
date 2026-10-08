import type { BoardModel } from '../model/types';
import { NETFLAG_NOCONNECT } from '../model/types';

export const RATSNEST_MAX_PINS = 4000;

/**
 * Minimum spanning tree over a net's pins (Prim, O(n²)). These "air wires"
 * are INFERRED connectivity for orientation only — they are drawn dashed and
 * never represent routed copper. Nets marked no-connect get none.
 */
export function ratsnest(m: BoardModel, nets: number[]): { segs: Float64Array; skipped: number[] } {
  const out: number[] = [];
  const skipped: number[] = [];
  for (const n of nets) {
    if (n < 0 || n >= m.nets.count || m.nets.flags[n] & NETFLAG_NOCONNECT) continue;
    const a = m.nets.pinStart[n],
      b = m.nets.pinStart[n + 1];
    const k = b - a;
    if (k < 2) continue;
    if (k > RATSNEST_MAX_PINS) {
      skipped.push(n);
      continue;
    }
    const xs = new Float64Array(k),
      ys = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      const p = m.nets.pinIndex[a + i];
      xs[i] = m.pins.x[p];
      ys[i] = m.pins.y[p];
    }
    const inTree = new Uint8Array(k);
    const dist = new Float64Array(k).fill(Infinity);
    const from = new Int32Array(k).fill(-1);
    dist[0] = 0;
    for (let it = 0; it < k; it++) {
      let u = -1,
        best = Infinity;
      for (let i = 0; i < k; i++)
        if (!inTree[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      if (u < 0) break;
      inTree[u] = 1;
      if (from[u] >= 0) out.push(xs[from[u]], ys[from[u]], xs[u], ys[u]);
      for (let i = 0; i < k; i++) {
        if (inTree[i]) continue;
        const d = (xs[i] - xs[u]) ** 2 + (ys[i] - ys[u]) ** 2;
        if (d < dist[i]) {
          dist[i] = d;
          from[i] = u;
        }
      }
    }
  }
  return { segs: Float64Array.from(out), skipped };
}
