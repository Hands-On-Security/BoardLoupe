/**
 * Ranks the physical points on a net by how practical they are to probe or
 * solder a wire to — the core "find a better tap point on the same bus"
 * workflow (e.g. reaching an SPI/LPC net at a test point or a resistor end
 * instead of a fine-pitch BGA ball).
 *
 * Pure model + scene geometry; no rendering state. Deterministic ordering.
 */
import type { BoardModel } from './types';
import { MOUNT_TH, PINKIND_TESTPOINT } from './types';

export interface SolderPoint {
  kind: 'pin' | 'via';
  index: number;
  /** Component.pin, test-point name, or "Via" — for display. */
  label: string;
  part: number; // owning part, or -1
  side: number;
  score: number;
  reasons: string[];
}

const TESTPOINT_RE = /^(T(B_)?)?TP[\d_]|^TP\d|^E\d|^MP\d|^TB_TP/i;
const CONNECTOR_RE = /^(J|CN|CON|P)\d/i;
const PASSIVE_RE = /^(R|C|L|FB|F|D|Z)\d/i;

/** True for refdes that denote an accessible test pad / mount point. */
function isTestpointName(name: string): boolean {
  return TESTPOINT_RE.test(name);
}

/**
 * Scores every pin and via on net `n`, best first. Pad half-sizes and the
 * typical pin come from the scene so size can be judged even when the file
 * omits pad sizes.
 */
export function solderPoints(m: BoardModel, pinHW: Float32Array, pinHH: Float32Array, typicalPin: number, n: number, limit = 80): SolderPoint[] {
  if (n < 0 || n >= m.nets.count) return [];
  const { pins, parts, nets, vias } = m;
  const out: SolderPoint[] = [];

  for (let j = nets.pinStart[n]; j < nets.pinStart[n + 1]; j++) {
    const i = nets.pinIndex[j];
    const k = pins.part[i];
    const pname = k >= 0 ? parts.name[k] : '';
    const reasons: string[] = [];
    let s = 0;

    const tp = pins.kind[i] === PINKIND_TESTPOINT || isTestpointName(pname);
    const th = pins.hole[i] > 0 || (k >= 0 && parts.mount[k] === MOUNT_TH);
    const conn = CONNECTOR_RE.test(pname);
    const passive = PASSIVE_RE.test(pname) && k >= 0 && parts.pinCount[k] <= 3;
    const finePitch = k >= 0 && parts.pinCount[k] >= 24;

    if (tp) {
      s += 100;
      reasons.push('test point');
    }
    if (th) {
      s += 45;
      reasons.push('through-hole');
    }
    if (conn) {
      s += th ? 24 : 12;
      reasons.push('connector');
    } else if (passive) {
      s += 16;
      reasons.push('passive terminal');
    }
    // Larger pads are easier to land on; smaller fine-pitch pads harder.
    const sizeFactor = Math.max(pinHW[i], pinHH[i]) / (typicalPin || 1);
    s += Math.max(-10, Math.min(30, (sizeFactor - 1) * 12));
    if (finePitch && sizeFactor < 1.1) {
      s -= 22;
      reasons.push('fine pitch');
    }
    if (!reasons.length) reasons.push(sizeFactor >= 1.3 ? 'large pad' : 'component pad');

    // Single-pin parts (test pads, mounting holes) are named by their refdes alone.
    const label = k >= 0 ? (parts.pinCount[k] === 1 || !pins.number[i] ? pname : `${pname}.${pins.number[i]}`) : `TP ${pins.number[i] || i}`;
    out.push({ kind: 'pin', index: i, label, part: k, side: pins.side[i], score: Math.round(s), reasons });
  }

  for (let i = 0; i < vias.count; i++) {
    if (vias.net[i] !== n) continue;
    // Vias are usually tented (under solder mask), so a resistor terminal of
    // similar size is the easier tap; they still beat fine-pitch IC pads.
    out.push({ kind: 'via', index: i, label: `Via ${i + 1}`, part: -1, side: 3, score: 14, reasons: ['via'] });
  }

  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, 'en', { numeric: true }));
  return out.slice(0, limit);
}
