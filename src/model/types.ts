/**
 * Normalized, format-independent board model.
 *
 * Struct-of-arrays layout: every table is a set of parallel typed arrays so a
 * board with 100k+ pins stays compact, can be transferred between the worker
 * and the UI thread without copying, and can be uploaded to the GPU directly.
 *
 * Coordinates are stored in the file's native length unit (see `units`).
 * World Y points up (CAD convention); parsers convert where needed.
 */

export const MODEL_SCHEMA = 'boardscope/board@1' as const;

/** Board side. Values are bit flags: BOTH = TOP | BOTTOM. */
export const SIDE_NONE = 0;
export const SIDE_TOP = 1;
export const SIDE_BOTTOM = 2;
export const SIDE_BOTH = 3;
export type Side = 0 | 1 | 2 | 3;

export const MOUNT_UNKNOWN = 0;
export const MOUNT_SMD = 1;
export const MOUNT_TH = 2;
export type Mount = 0 | 1 | 2;

export const SHAPE_DEFAULT = 0; // size/shape not given by the file
export const SHAPE_CIRCLE = 1;
export const SHAPE_RECT = 2;
export const SHAPE_ROUNDRECT = 3;
export const SHAPE_OBLONG = 4;
export type PadShape = 0 | 1 | 2 | 3 | 4;

export const PINKIND_PIN = 0; // component pin
export const PINKIND_TESTPOINT = 1; // test point / nail / probe pad not owned by a component
export type PinKind = 0 | 1;

/** Part flags. Mechanical: no electrical function (mounting hole, fiducial, standoff). */
export const PARTFLAG_MECHANICAL = 1;

export const NETFLAG_GROUND = 1;
export const NETFLAG_POWER = 2;
export const NETFLAG_NOCONNECT = 4;

/** Sentinel for "no probe number". */
export const NO_PROBE = -2147483648;

export type LengthUnit = 'mil' | 'inch' | 'mm' | 'um' | 'unknown';

export interface UnitInfo {
  unit: LengthUnit;
  /** Multiply a model coordinate by this to get millimetres; null when unknown. */
  toMm: number | null;
  /** True when the unit is a convention of the format rather than stated in the file. */
  assumed: boolean;
  note?: string;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type DiagnosticLevel = 'info' | 'warning' | 'error';

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  /** 1-based line for text formats, byte offset for binary formats. */
  line?: number;
  offset?: number;
  count?: number;
}

export interface SourceInfo {
  fileName: string;
  fileSize: number;
  formatId: string;
  formatName: string;
  variant: string | null;
  /** Detector confidence in [0, 1]. */
  confidence: number;
  status: FormatStatus;
  extraFiles: string[];
}

export type FormatStatus = 'verified' | 'partial' | 'experimental' | 'diagnostic';

export interface Capabilities {
  outline: 'file' | 'derived' | 'none';
  partBodies: 'file' | 'derived';
  padShapes: boolean;
  pinNames: boolean;
  netNames: boolean;
  sides: boolean;
  rotation: boolean;
  testpoints: boolean;
  vias: boolean;
  traces: boolean;
  values: boolean;
}

export interface Outline {
  /** Segments x1,y1,x2,y2 (flat). */
  segs: Float64Array;
  source: 'file' | 'derived' | 'none';
}

export interface Parts {
  count: number;
  name: string[];
  side: Uint8Array;
  mount: Uint8Array;
  /** PARTFLAG_* bits. */
  flags: Uint8Array;
  /** Placement origin; equals bbox centre when the file gives none. */
  x: Float64Array;
  y: Float64Array;
  originFromFile: Uint8Array;
  /** Degrees counter-clockwise; NaN when unknown. */
  rot: Float32Array;
  /** minX,minY,maxX,maxY per part (flat). */
  bbox: Float64Array;
  bboxFromFile: Uint8Array;
  pinStart: Uint32Array;
  pinCount: Uint32Array;
  value: (string | null)[];
  footprint: (string | null)[];
  /** Additional key/value attributes from the file (description, part number, …). */
  attrs: ([string, string][] | null)[];
  /** Body outline segments from the file (CSR into bodySegs, 4 numbers per segment). */
  bodyStart: Uint32Array;
  bodySegs: Float64Array;
}

export interface Pins {
  count: number;
  x: Float64Array;
  y: Float64Array;
  part: Int32Array;
  net: Int32Array;
  side: Uint8Array;
  kind: Uint8Array;
  number: string[];
  name: string[];
  shape: Uint8Array;
  w: Float32Array;
  h: Float32Array;
  rot: Float32Array;
  hole: Float32Array;
  probe: Int32Array;
}

export interface Nets {
  count: number;
  name: string[];
  flags: Uint8Array;
  pinStart: Uint32Array; // length count+1
  pinIndex: Uint32Array;
}

export interface Vias {
  count: number;
  x: Float64Array;
  y: Float64Array;
  d: Float32Array;
  net: Int32Array;
}

export interface Traces {
  count: number;
  /** x1,y1,x2,y2 per segment (flat). */
  segs: Float64Array;
  width: Float32Array;
  layer: Uint16Array;
  net: Int32Array;
}

export interface LayerInfo {
  id: number;
  name: string;
  kind: 'top' | 'bottom' | 'inner' | 'plane' | 'other';
}

export interface BoardModel {
  schema: typeof MODEL_SCHEMA;
  source: SourceInfo;
  units: UnitInfo;
  bounds: Bounds;
  outline: Outline;
  parts: Parts;
  pins: Pins;
  nets: Nets;
  vias: Vias;
  traces: Traces;
  layers: LayerInfo[];
  caps: Capabilities;
  metadata: [string, string][];
  diagnostics: Diagnostic[];
}

export function sideLabel(side: number): string {
  switch (side) {
    case SIDE_TOP:
      return 'Top';
    case SIDE_BOTTOM:
      return 'Bottom';
    case SIDE_BOTH:
      return 'Both';
    default:
      return 'Unknown';
  }
}

export function mountLabel(m: number): string {
  return m === MOUNT_SMD ? 'SMD' : m === MOUNT_TH ? 'Through-hole' : 'Unknown';
}

export function unitLabel(u: UnitInfo): string {
  const base = u.unit === 'unknown' ? 'raw units' : u.unit;
  return u.assumed && u.unit !== 'unknown' ? `${base} (assumed)` : base;
}

/** All typed-array buffers of a model, for zero-copy postMessage transfer. */
export function modelTransferables(m: BoardModel): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (o: object) => {
    for (const v of Object.values(o)) {
      if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    }
  };
  add(m.parts);
  add(m.pins);
  add(m.nets);
  add(m.vias);
  add(m.traces);
  add(m.outline);
  return [...out];
}
