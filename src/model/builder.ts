import {
  type BoardModel,
  type Bounds,
  type Capabilities,
  type Diagnostic,
  type DiagnosticLevel,
  type LayerInfo,
  type Mount,
  type PadShape,
  type PinKind,
  type Side,
  type SourceInfo,
  type UnitInfo,
  MODEL_SCHEMA,
  MOUNT_UNKNOWN,
  NETFLAG_GROUND,
  NETFLAG_NOCONNECT,
  NETFLAG_POWER,
  NO_PROBE,
  PINKIND_PIN,
  SHAPE_DEFAULT,
  SIDE_NONE,
} from './types';
import { validateModel } from './validate';

export interface PartInput {
  name: string;
  side?: Side;
  mount?: Mount;
  x?: number;
  y?: number;
  rot?: number;
  bbox?: [number, number, number, number] | null;
  value?: string | null;
  footprint?: string | null;
  attrs?: [string, string][] | null;
  /** Body outline segments (x1,y1,x2,y2 flat) from the file. */
  body?: number[] | null;
}

export interface PinInput {
  part: number;
  x: number;
  y: number;
  net?: string | null;
  number?: string;
  name?: string;
  side?: Side;
  kind?: PinKind;
  shape?: PadShape;
  w?: number;
  h?: number;
  rot?: number;
  hole?: number;
  probe?: number;
}

const GROUND_RE = /^(?:[A-Z0-9]*_)?(?:GND|GROUND|VSS|AGND|DGND|PGND|SGND|CGND|EARTH)(?:_[A-Z0-9_]*)?\d*$/i;
const POWER_RE = /^(?:\+|PP\d|PPV|PPBUS|VCC|VDD|VBAT|VIN|VBUS|VREF|VCORE|VCCIO|VPP|AVDD|DVDD|P\d+V\d*)/i;
const NC_RE = /^(?:NC|N\/C|N\.C\.|NOCONNECT|NO_CONNECT|UNCONNECTED.*|NC_.*|NET_NC)$/i;

export function classifyNet(name: string): number {
  let f = 0;
  if (!name) return 0;
  if (GROUND_RE.test(name)) f |= NETFLAG_GROUND;
  else if (POWER_RE.test(name)) f |= NETFLAG_POWER;
  if (NC_RE.test(name)) f |= NETFLAG_NOCONNECT;
  return f;
}

class Grow {
  // Minimal growable numeric column (avoids boxing in plain arrays for huge boards).
  data: Float64Array;
  length = 0;
  constructor(cap = 1024) {
    this.data = new Float64Array(cap);
  }
  push(v: number) {
    if (this.length === this.data.length) {
      const n = new Float64Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    this.data[this.length++] = v;
  }
  view(): Float64Array {
    return this.data.subarray(0, this.length);
  }
}

/**
 * Incrementally assembles a BoardModel. Parsers only describe what the file
 * says; the builder derives indexes, grouping, bounding boxes and flags, and
 * runs referential-integrity validation.
 */
export class BoardBuilder {
  private diags = new Map<string, Diagnostic>();
  private netIndex = new Map<string, number>();
  private netNames: string[] = [];

  private parts: PartInput[] = [];
  private pinPart: number[] = [];
  private pinX = new Grow();
  private pinY = new Grow();
  private pinNet: number[] = [];
  private pinSide: number[] = [];
  private pinKind: number[] = [];
  private pinNumber: string[] = [];
  private pinName: string[] = [];
  private pinShape: number[] = [];
  private pinW: number[] = [];
  private pinH: number[] = [];
  private pinRot: number[] = [];
  private pinHole: number[] = [];
  private pinProbe: number[] = [];

  private outline = new Grow(256);
  private viaX = new Grow(64);
  private viaY = new Grow(64);
  private viaD: number[] = [];
  private viaNet: number[] = [];
  private traceSegs = new Grow(256);
  private traceW: number[] = [];
  private traceLayer: number[] = [];
  private traceNet: number[] = [];

  units: UnitInfo = { unit: 'unknown', toMm: null, assumed: true };
  layers: LayerInfo[] = [];
  metadata: [string, string][] = [];
  caps: Partial<Capabilities> = {};
  /** When true the builder synthesises a rectangle outline if the file has none. */
  deriveOutline = true;

  get pinCount() {
    return this.pinPart.length;
  }
  get partCount() {
    return this.parts.length;
  }

  diag(level: DiagnosticLevel, code: string, message: string, loc?: { line?: number; offset?: number }) {
    // Aggregate repeated diagnostics by code so a malformed 100k-line file
    // yields one entry with a count instead of 100k entries.
    const prev = this.diags.get(code);
    if (prev) {
      prev.count = (prev.count ?? 1) + 1;
      return;
    }
    this.diags.set(code, { level, code, message, ...loc, count: 1 });
  }
  warn(code: string, message: string, loc?: { line?: number; offset?: number }) {
    this.diag('warning', code, message, loc);
  }
  info(code: string, message: string) {
    this.diag('info', code, message);
  }

  net(name: string | null | undefined): number {
    if (name == null || name === '') return -1;
    let i = this.netIndex.get(name);
    if (i === undefined) {
      i = this.netNames.length;
      this.netNames.push(name);
      this.netIndex.set(name, i);
    }
    return i;
  }

  addPart(p: PartInput): number {
    this.parts.push(p);
    return this.parts.length - 1;
  }

  partInput(i: number): PartInput {
    return this.parts[i];
  }

  addPin(p: PinInput): number {
    this.pinPart.push(p.part);
    this.pinX.push(p.x);
    this.pinY.push(p.y);
    this.pinNet.push(this.net(p.net));
    this.pinSide.push(p.side ?? (p.part >= 0 ? (this.parts[p.part]?.side ?? SIDE_NONE) : SIDE_NONE));
    this.pinKind.push(p.kind ?? PINKIND_PIN);
    this.pinNumber.push(p.number ?? '');
    this.pinName.push(p.name ?? '');
    this.pinShape.push(p.shape ?? SHAPE_DEFAULT);
    this.pinW.push(p.w ?? 0);
    this.pinH.push(p.h ?? p.w ?? 0);
    this.pinRot.push(p.rot ?? 0);
    this.pinHole.push(p.hole ?? 0);
    this.pinProbe.push(p.probe ?? NO_PROBE);
    return this.pinPart.length - 1;
  }

  addOutlineSeg(x1: number, y1: number, x2: number, y2: number) {
    if (![x1, y1, x2, y2].every(Number.isFinite)) {
      this.warn('outline.nonfinite', 'Outline segment with non-finite coordinates ignored');
      return;
    }
    if (x1 === x2 && y1 === y2) return;
    this.outline.push(x1);
    this.outline.push(y1);
    this.outline.push(x2);
    this.outline.push(y2);
  }

  /** Adds a polyline of [x0,y0,x1,y1,…]; closes it when `closed`. */
  addOutlinePolyline(pts: ArrayLike<number>, closed: boolean) {
    const n = Math.floor(pts.length / 2);
    for (let i = 0; i + 1 < n; i++) this.addOutlineSeg(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3]);
    if (closed && n > 2) this.addOutlineSeg(pts[2 * n - 2], pts[2 * n - 1], pts[0], pts[1]);
  }

  get outlineSegCount() {
    return this.outline.length / 4;
  }

  addVia(x: number, y: number, d: number, net: string | null) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.warn('via.nonfinite', 'Via with non-finite coordinates ignored');
      return;
    }
    this.viaX.push(x);
    this.viaY.push(y);
    this.viaD.push(Number.isFinite(d) && d > 0 ? d : 0);
    this.viaNet.push(this.net(net));
  }

  addTrace(x1: number, y1: number, x2: number, y2: number, width: number, layer: number, net: string | null) {
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    this.traceSegs.push(x1);
    this.traceSegs.push(y1);
    this.traceSegs.push(x2);
    this.traceSegs.push(y2);
    this.traceW.push(Number.isFinite(width) && width > 0 ? width : 0);
    this.traceLayer.push(layer);
    this.traceNet.push(this.net(net));
  }

  finish(source: Omit<SourceInfo, 'confidence' | 'status'> & Partial<Pick<SourceInfo, 'confidence' | 'status'>>): BoardModel {
    const nParts = this.parts.length;
    let nPinsIn = this.pinPart.length;

    // Drop pins with non-finite coordinates (reported, never silent).
    const keep: number[] = [];
    let dropped = 0;
    const px = this.pinX.view();
    const py = this.pinY.view();
    for (let i = 0; i < nPinsIn; i++) {
      if (Number.isFinite(px[i]) && Number.isFinite(py[i])) keep.push(i);
      else dropped++;
    }
    if (dropped) this.diag('warning', 'pin.nonfinite', `${dropped} pin(s) had non-finite coordinates and were skipped`);
    nPinsIn = keep.length;

    // Invalid part references become unowned pins (reported).
    let badRef = 0;
    for (const i of keep) {
      const p = this.pinPart[i];
      if (p >= nParts || (p < 0 && p !== -1) || !Number.isInteger(p)) {
        this.pinPart[i] = -1;
        badRef++;
      }
    }
    if (badRef) this.diag('warning', 'pin.badpart', `${badRef} pin(s) referenced a non-existent part and are shown as unowned`);

    // Stable counting sort of pins by owning part; unowned pins go last.
    const counts = new Uint32Array(nParts + 1);
    for (const i of keep) {
      const p = this.pinPart[i];
      counts[p < 0 ? nParts : p]++;
    }
    const start = new Uint32Array(nParts + 2);
    for (let k = 0; k <= nParts; k++) start[k + 1] = start[k] + counts[k];
    const cursor = start.slice(0, nParts + 1);
    const order = new Uint32Array(nPinsIn);
    for (const i of keep) {
      const p = this.pinPart[i];
      order[cursor[p < 0 ? nParts : p]++] = i;
    }

    const N = nPinsIn;
    const pins = {
      count: N,
      x: new Float64Array(N),
      y: new Float64Array(N),
      part: new Int32Array(N),
      net: new Int32Array(N),
      side: new Uint8Array(N),
      kind: new Uint8Array(N),
      number: new Array<string>(N),
      name: new Array<string>(N),
      shape: new Uint8Array(N),
      w: new Float32Array(N),
      h: new Float32Array(N),
      rot: new Float32Array(N),
      hole: new Float32Array(N),
      probe: new Int32Array(N),
    };
    for (let j = 0; j < N; j++) {
      const i = order[j];
      pins.x[j] = px[i];
      pins.y[j] = py[i];
      pins.part[j] = this.pinPart[i];
      pins.net[j] = this.pinNet[i];
      pins.side[j] = this.pinSide[i];
      pins.kind[j] = this.pinKind[i];
      pins.number[j] = this.pinNumber[i];
      pins.name[j] = this.pinName[i];
      pins.shape[j] = this.pinShape[i];
      pins.w[j] = Number.isFinite(this.pinW[i]) && this.pinW[i] > 0 ? this.pinW[i] : 0;
      pins.h[j] = Number.isFinite(this.pinH[i]) && this.pinH[i] > 0 ? this.pinH[i] : 0;
      pins.rot[j] = Number.isFinite(this.pinRot[i]) ? this.pinRot[i] : 0;
      pins.hole[j] = Number.isFinite(this.pinHole[i]) && this.pinHole[i] > 0 ? this.pinHole[i] : 0;
      pins.probe[j] = this.pinProbe[i];
    }

    // Parts.
    const P = nParts;
    const bodyCounts: number[] = [];
    const parts = {
      count: P,
      name: new Array<string>(P),
      side: new Uint8Array(P),
      mount: new Uint8Array(P),
      x: new Float64Array(P),
      y: new Float64Array(P),
      originFromFile: new Uint8Array(P),
      rot: new Float32Array(P),
      bbox: new Float64Array(P * 4),
      bboxFromFile: new Uint8Array(P),
      pinStart: new Uint32Array(P),
      pinCount: new Uint32Array(P),
      value: new Array<string | null>(P),
      footprint: new Array<string | null>(P),
      attrs: new Array<[string, string][] | null>(P),
      bodyStart: new Uint32Array(P + 1),
      bodySegs: new Float64Array(0),
    };
    let geomless = 0;
    for (let k = 0; k < P; k++) {
      const p = this.parts[k];
      parts.name[k] = p.name ?? '';
      parts.side[k] = p.side ?? SIDE_NONE;
      parts.mount[k] = p.mount ?? MOUNT_UNKNOWN;
      parts.rot[k] = p.rot !== undefined && Number.isFinite(p.rot) ? p.rot : NaN;
      parts.pinStart[k] = start[k];
      parts.pinCount[k] = counts[k];
      parts.value[k] = p.value ?? null;
      parts.footprint[k] = p.footprint ?? null;
      parts.attrs[k] = p.attrs && p.attrs.length ? p.attrs : null;
      const body = p.body && p.body.length >= 4 && p.body.every(Number.isFinite) ? p.body : null;
      bodyCounts.push(body ? body.length - (body.length % 4) : 0);

      let b: [number, number, number, number] | null = null;
      if (p.bbox && p.bbox.every(Number.isFinite)) {
        const [a, c, d, e] = p.bbox;
        b = [Math.min(a, d), Math.min(c, e), Math.max(a, d), Math.max(c, e)];
        parts.bboxFromFile[k] = 1;
      } else if (counts[k] > 0) {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let j = start[k]; j < start[k] + counts[k]; j++) {
          const hw = pins.w[j] / 2,
            hh = pins.h[j] / 2;
          const r = Math.max(hw, hh);
          x0 = Math.min(x0, pins.x[j] - r);
          y0 = Math.min(y0, pins.y[j] - r);
          x1 = Math.max(x1, pins.x[j] + r);
          y1 = Math.max(y1, pins.y[j] + r);
        }
        b = [x0, y0, x1, y1];
      } else if (body) {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let i = 0; i + 1 < body.length; i += 2) {
          x0 = Math.min(x0, body[i]);
          x1 = Math.max(x1, body[i]);
          y0 = Math.min(y0, body[i + 1]);
          y1 = Math.max(y1, body[i + 1]);
        }
        b = [x0, y0, x1, y1];
      } else if (p.x !== undefined && p.y !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        b = [p.x, p.y, p.x, p.y];
      }
      if (!b) {
        geomless++;
        b = [NaN, NaN, NaN, NaN];
      }
      parts.bbox.set(b, k * 4);
      if (p.x !== undefined && p.y !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        parts.x[k] = p.x;
        parts.y[k] = p.y;
        parts.originFromFile[k] = 1;
      } else {
        parts.x[k] = (b[0] + b[2]) / 2;
        parts.y[k] = (b[1] + b[3]) / 2;
      }
    }
    // Plausibility of file-supplied part boxes. Some exporters write boxes that
    // include silkscreen text (many times larger than the part). When that is
    // systematic, the boxes are ignored in favour of pin extents (reported).
    {
      let checked = 0,
        bad = 0;
      const pinExt = (k: number) => {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (let j = start[k]; j < start[k] + counts[k]; j++) {
          x0 = Math.min(x0, pins.x[j]);
          x1 = Math.max(x1, pins.x[j]);
          y0 = Math.min(y0, pins.y[j]);
          y1 = Math.max(y1, pins.y[j]);
        }
        return [x0, y0, x1, y1];
      };
      for (let k = 0; k < P; k++) {
        if (!parts.bboxFromFile[k] || counts[k] < 2) continue;
        const [x0, y0, x1, y1] = pinExt(k);
        const pw = x1 - x0,
          ph = y1 - y0;
        const s = Math.max(pw, ph);
        const fw = parts.bbox[4 * k + 2] - parts.bbox[4 * k],
          fh = parts.bbox[4 * k + 3] - parts.bbox[4 * k + 1];
        checked++;
        if (fw > 3 * (pw + s) || fh > 3 * (ph + s)) bad++;
      }
      if (checked >= 5 && bad / checked > 0.3) {
        let replaced = 0;
        for (let k = 0; k < P; k++) {
          if (!parts.bboxFromFile[k] || counts[k] < 1) continue;
          let [x0, y0, x1, y1] = pinExt(k);
          for (let j = start[k]; j < start[k] + counts[k]; j++) {
            const r = Math.max(pins.w[j], pins.h[j]) / 2;
            x0 = Math.min(x0, pins.x[j] - r);
            x1 = Math.max(x1, pins.x[j] + r);
            y0 = Math.min(y0, pins.y[j] - r);
            y1 = Math.max(y1, pins.y[j] + r);
          }
          parts.bbox.set([x0, y0, x1, y1], 4 * k);
          parts.bboxFromFile[k] = 0;
          if (!this.parts[k].x || !Number.isFinite(this.parts[k].x!)) {
            parts.x[k] = (x0 + x1) / 2;
            parts.y[k] = (y0 + y1) / 2;
          }
          replaced++;
        }
        this.diag(
          'warning',
          'bbox.unreliable',
          `${bad} of ${checked} part boxes in the file are far larger than their pins (probably including silkscreen text); part outlines are derived from pin positions instead (${replaced} parts).`,
        );
      }
    }
    if (geomless) this.diag('warning', 'part.nogeometry', `${geomless} part(s) have no pins and no position; they are listed but not drawn`);

    // Body outline CSR.
    let acc = 0;
    for (let k = 0; k < P; k++) {
      parts.bodyStart[k] = acc / 4;
      acc += bodyCounts[k];
    }
    parts.bodyStart[P] = acc / 4;
    if (acc > 0) {
      parts.bodySegs = new Float64Array(acc);
      let o = 0;
      for (let k = 0; k < P; k++) {
        const body = this.parts[k].body;
        if (bodyCounts[k]) {
          parts.bodySegs.set(body!.slice(0, bodyCounts[k]), o);
          o += bodyCounts[k];
        }
      }
    }

    // Nets (CSR of member pins).
    const M = this.netNames.length;
    const netCounts = new Uint32Array(M);
    for (let j = 0; j < N; j++) if (pins.net[j] >= 0) netCounts[pins.net[j]]++;
    const netStart = new Uint32Array(M + 1);
    for (let k = 0; k < M; k++) netStart[k + 1] = netStart[k] + netCounts[k];
    const netPins = new Uint32Array(netStart[M]);
    const ncur = netStart.slice(0, M);
    for (let j = 0; j < N; j++) {
      const n = pins.net[j];
      if (n >= 0) netPins[ncur[n]++] = j;
    }
    const nets = {
      count: M,
      name: this.netNames.slice(),
      flags: new Uint8Array(M),
      pinStart: netStart,
      pinIndex: netPins,
    };
    for (let k = 0; k < M; k++) nets.flags[k] = classifyNet(nets.name[k]);

    const vias = {
      count: this.viaD.length,
      x: this.viaX.view().slice(),
      y: this.viaY.view().slice(),
      d: Float32Array.from(this.viaD),
      net: Int32Array.from(this.viaNet),
    };
    const traces = {
      count: this.traceW.length,
      segs: this.traceSegs.view().slice(),
      width: Float32Array.from(this.traceW),
      layer: Uint16Array.from(this.traceLayer),
      net: Int32Array.from(this.traceNet),
    };

    // Bounds of everything drawable.
    const bb: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const grow = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < bb.minX) bb.minX = x;
      if (y < bb.minY) bb.minY = y;
      if (x > bb.maxX) bb.maxX = x;
      if (y > bb.maxY) bb.maxY = y;
    };
    for (let j = 0; j < N; j++) grow(pins.x[j], pins.y[j]);
    for (let i = 0; i < vias.count; i++) grow(vias.x[i], vias.y[i]);
    let outlineSegs = this.outline.view().slice();
    let outlineSource: 'file' | 'derived' | 'none' = outlineSegs.length ? 'file' : 'none';
    // Part boxes supplied by some exporters include silkscreen text and can be
    // far larger than the board; they only define the extent when there is no
    // outline to rely on.
    if (!outlineSegs.length || !N) {
      for (let k = 0; k < P; k++) {
        grow(parts.bbox[4 * k], parts.bbox[4 * k + 1]);
        grow(parts.bbox[4 * k + 2], parts.bbox[4 * k + 3]);
      }
    }
    const contentBounds = { ...bb };
    for (let i = 0; i < outlineSegs.length; i += 2) grow(outlineSegs[i], outlineSegs[i + 1]);
    for (let i = 0; i < traces.segs.length; i += 2) grow(traces.segs[i], traces.segs[i + 1]);

    if (!outlineSegs.length && this.deriveOutline && Number.isFinite(contentBounds.minX)) {
      const w = contentBounds.maxX - contentBounds.minX;
      const h = contentBounds.maxY - contentBounds.minY;
      const m = Math.max(w, h) * 0.02 || 1;
      const x0 = contentBounds.minX - m,
        y0 = contentBounds.minY - m,
        x1 = contentBounds.maxX + m,
        y1 = contentBounds.maxY + m;
      outlineSegs = Float64Array.from([x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0]);
      outlineSource = 'derived';
      grow(x0, y0);
      grow(x1, y1);
      this.info('outline.derived', 'The file has no board outline; a bounding rectangle around the parts is shown (dashed).');
    }
    if (!Number.isFinite(bb.minX)) {
      bb.minX = 0;
      bb.minY = 0;
      bb.maxX = 1;
      bb.maxY = 1;
    }

    const hasNames = pins.name.some((s, i) => s !== '' && s !== pins.number[i]);
    const caps: Capabilities = {
      outline: outlineSource,
      partBodies: parts.bodySegs.length ? 'file' : 'derived',
      padShapes: pins.shape.some((s) => s !== SHAPE_DEFAULT),
      pinNames: hasNames,
      netNames: M > 0,
      sides: parts.side.some((s) => s !== SIDE_NONE),
      rotation: parts.rot.some((r) => !Number.isNaN(r)),
      testpoints: pins.kind.some((k) => k !== PINKIND_PIN),
      vias: vias.count > 0,
      traces: traces.count > 0,
      values: parts.value.some((v) => !!v),
      ...this.caps,
    };

    const model: BoardModel = {
      schema: MODEL_SCHEMA,
      source: { confidence: 1, status: 'verified', ...source },
      units: this.units,
      bounds: bb,
      outline: { segs: outlineSegs, source: outlineSource },
      parts,
      pins,
      nets,
      vias,
      traces,
      layers: this.layers,
      caps,
      metadata: this.metadata,
      diagnostics: [],
    };
    const problems = validateModel(model);
    for (const p of problems) this.diag('error', 'integrity', p);
    model.diagnostics = [...this.diags.values()];
    return model;
  }
}
