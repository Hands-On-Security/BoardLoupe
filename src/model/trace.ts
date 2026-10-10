/**
 * Trace a signal through series parts.
 *
 * Starting from a net, step across two-terminal series parts (series
 * resistors, inductors, ferrite beads, 0-ohm links) to the net on their other
 * pin, and keep going. This follows a bus or signal from an IC pin out to a
 * connector or test point through the passives in its path.
 *
 * Handling of the awkward cases:
 *  - Branches: a net may feed several series parts; every continuation is
 *    followed and recorded as a separate edge (`branched` is set).
 *  - Cycles: each net is expanded once; an edge back to an already-seen net is
 *    still recorded but not re-expanded, so loops terminate.
 *  - Ambiguity / power rails: a two-pin part whose other pin sits on a power or
 *    ground net (a decoupling cap, a pull-up) is a stub, not a series element,
 *    so that continuation is not followed and the rail is never expanded.
 *  - Runaway: total nets and per-net fan-out are capped (`truncated`).
 */
import type { BoardModel } from './types';
import { NETFLAG_GROUND, NETFLAG_POWER } from './types';

export interface TraceEdge {
  /** Net stepped from and net stepped to. */
  from: number;
  to: number;
  /** The two-terminal part crossed, and its two pins. */
  part: number;
  fromPin: number;
  toPin: number;
}

export interface TraceResult {
  start: number;
  /** Every net reached, including the start. */
  nets: number[];
  /** Every series part crossed. */
  parts: number[];
  edges: TraceEdge[];
  /** A net fed more than one series part somewhere. */
  branched: boolean;
  /** The trace hit a size or fan-out limit. */
  truncated: boolean;
}

export interface TraceOptions {
  /** Maximum distinct nets to visit. */
  maxNets?: number;
  /** Maximum continuations followed from a single net (ambiguity guard). */
  maxFanout?: number;
  /** Also step across any two-pin part, not only R/L/FB-style refdes. */
  anyTwoPin?: boolean;
}

const isRail = (m: BoardModel, net: number) => net >= 0 && (m.nets.flags[net] & (NETFLAG_GROUND | NETFLAG_POWER)) !== 0;

/** Refdes prefixes of parts that pass a signal straight through (series elements). */
const SERIES_RE = /^(R|L|FB|F|FE|BE|JP|LK|E|Z|RL)\d/i;

/** A two-terminal part that carries a signal from one pin to the other. */
function seriesParts(m: BoardModel, anyTwoPin: boolean) {
  return (part: number) => part >= 0 && m.parts.pinCount[part] === 2 && (anyTwoPin || SERIES_RE.test(m.parts.name[part]));
}

export function traceSeries(m: BoardModel, start: number, opts: TraceOptions = {}): TraceResult {
  const maxNets = opts.maxNets ?? 400;
  const maxFanout = opts.maxFanout ?? 32;
  const isSeries = seriesParts(m, !!opts.anyTwoPin);
  const { nets, pins, parts } = m;
  const res: TraceResult = { start, nets: [], parts: [], edges: [], branched: false, truncated: false };
  if (start < 0 || start >= nets.count) return res;

  const visited = new Set<number>([start]);
  const partsSeen = new Set<number>();
  // A rail chosen as the start is traced (the user asked for it), but rails
  // reached along the way are not expanded, to avoid pulling in the whole board.
  const queue: number[] = [start];
  while (queue.length) {
    const net = queue.shift()!;
    // Collect the series parts that touch this net.
    const conts: { part: number; fromPin: number; toPin: number; toNet: number }[] = [];
    for (let j = nets.pinStart[net]; j < nets.pinStart[net + 1]; j++) {
      const pin = nets.pinIndex[j];
      const part = pins.part[pin];
      if (!isSeries(part) || partsSeen.has(part)) continue; // don't cross a part twice
      // The part's other terminal (a series part has exactly two pins).
      const base = parts.pinStart[part];
      const toPin = base === pin ? base + 1 : base;
      const toNet = pins.net[toPin];
      if (toNet < 0 || toNet === net) continue; // unconnected or both pins on this net
      if (isRail(m, toNet)) continue; // a stub to power/ground, not a pass-through
      conts.push({ part, fromPin: pin, toPin, toNet });
    }
    if (conts.length > 1) res.branched = true;
    let fan = 0;
    for (const c of conts) {
      if (fan++ >= maxFanout) {
        res.truncated = true;
        break;
      }
      res.edges.push({ from: net, to: c.toNet, part: c.part, fromPin: c.fromPin, toPin: c.toPin });
      partsSeen.add(c.part);
      if (!visited.has(c.toNet)) {
        if (visited.size >= maxNets) {
          res.truncated = true;
          continue;
        }
        visited.add(c.toNet);
        queue.push(c.toNet);
      }
    }
  }
  res.nets = [...visited];
  res.parts = [...partsSeen];
  return res;
}
