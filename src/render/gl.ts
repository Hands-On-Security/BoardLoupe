import type { BoardModel } from '../model/types';
import { SHAPE_CIRCLE, SHAPE_DEFAULT, SHAPE_OBLONG, SHAPE_RECT, SHAPE_ROUNDRECT, SIDE_BOTH } from '../model/types';
import type { Scene } from '../scene/scene';
import { viewMatrix } from './camera';
import type { FrameInput, Renderer } from './renderer';
import type { Colors } from './style';

/*
 * WebGL2 renderer. Two instanced programs:
 *  - "pad": an SDF quad per pad/via (circle, rect, round-rect, oblong, ring)
 *  - "seg": an anti-aliased capsule per line segment (outline, bodies, copper, air wires)
 * Static geometry is uploaded once per board; colours are re-uploaded only on
 * selection changes; hover is a uniform; pan/zoom only change uniforms.
 */

const PAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_center;
layout(location=2) in vec2 a_half;
layout(location=3) in float a_rot;
layout(location=4) in float a_shape;
layout(location=5) in float a_side;
layout(location=6) in vec4 a_color;
layout(location=7) in float a_hole;
layout(location=8) in float a_emph;
uniform mat3 u_view;
uniform vec2 u_viewport;
uniform float u_side;
uniform float u_pass;
uniform float u_ghost;
uniform int u_hover;
uniform float u_minPx;
uniform float u_scale;
uniform float u_holePass;
uniform float u_emphPass;
uniform float u_emphMinPx;
uniform float u_haloPx;
out vec2 v_local;
out vec2 v_half;
flat out float v_shape;
out vec4 v_color;
flat out float v_hover;
flat out float v_hole;
void main() {
  bool other = (a_side == 1.0 && u_side == 2.0) || (a_side == 2.0 && u_side == 1.0);
  bool draw = (u_pass == 0.0) ? other : !other;
  // Hole pass: drills go through the board, so every drilled pad is drawn.
  if (u_holePass > 0.5) draw = a_hole > 0.0;
  // Emphasis pass: only highlighted pads, drawn on top with a halo.
  if (u_emphPass > 0.5) draw = a_emph > 0.5;
  if (!draw || a_color.a == 0.0 || (other && u_ghost == 0.0 && u_holePass < 0.5)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v_hole = a_hole * u_scale;
  vec2 halfPx = max(a_half * u_scale, vec2(u_minPx));
  // Emphasised pads never shrink below a legible size, so a highlighted net
  // stays visible however far out the board is zoomed.
  if (u_emphPass > 0.5) halfPx = max(halfPx, vec2(u_emphMinPx));
  float expand = (u_emphPass > 0.5) ? (u_haloPx + 1.5) : 1.5;
  vec2 local = a_corner * (halfPx + expand);
  float r = radians(a_rot);
  float c = cos(r), s = sin(r);
  vec2 w = vec2(local.x * c - local.y * s, local.x * s + local.y * c) / u_scale;
  vec3 p = u_view * vec3(a_center + w, 1.0);
  gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
  v_local = local;
  v_half = halfPx;
  v_shape = a_shape;
  v_hover = (gl_InstanceID == u_hover) ? 1.0 : 0.0;
  v_color = vec4(a_color.rgb, a_color.a * (other ? u_ghost : 1.0));
}`;

const PAD_FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_half;
flat in float v_shape;
in vec4 v_color;
flat in float v_hover;
flat in float v_hole;
uniform vec3 u_hoverColor;
uniform vec3 u_holeColor;
uniform vec3 u_holeEdge;
uniform vec3 u_haloColor;
uniform float u_holeOnly;
uniform float u_emphPass;
uniform float u_haloPx;
out vec4 o;
float box(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float shapeSdf(vec2 p, vec2 b, float shape) {
  float m = min(b.x, b.y);
  if (shape < 1.5) return length(p) - m;                         // default / circle
  else if (shape < 2.5) return box(p, b);                        // rect
  else if (shape < 3.5) { float r = 0.35 * m; return box(p, b - r) - r; }  // round rect
  else if (shape < 4.5) return box(p, b - m) - m;                // oblong
  else { float R = m; return abs(length(p) - R * 0.72) - R * 0.28; }       // ring
}
void main() {
  vec2 p = v_local;
  if (u_emphPass > 0.5) {
    // Bright halo ring hugging the pad plus a solid fill: a beacon that reads
    // at any zoom. Fill uses the selection colour; the ring uses u_haloColor.
    float d = shapeSdf(p, v_half, v_shape);
    float fill = clamp(0.5 - d, 0.0, 1.0);
    float halo = (1.0 - smoothstep(0.0, u_haloPx, d)) * step(-0.5, d);
    // v_color.a carries the side-visibility factor (full on this side, u_ghost
    // on the other, 0 when hidden) so a beacon never shows through a hidden side.
    float a = max(fill, halo * 0.92) * v_color.a;
    if (a <= 0.0) discard;
    vec3 col = mix(u_haloColor, v_color.rgb, clamp(fill * 2.0, 0.0, 1.0));
    o = vec4(col * a, a);
    return;
  }
  if (u_holeOnly > 0.5) {
    // Drawn after all pads so overlapping copper never hides a drill.
    if (v_hole <= 0.75) discard;
    float hd0 = length(p) - v_hole;
    float cov = clamp(0.5 - hd0 + 1.2, 0.0, 1.0);
    if (cov <= 0.0) discard;
    float inHole0 = clamp(0.5 - hd0, 0.0, 1.0);
    float rim0 = 1.0 - smoothstep(0.0, 1.1, abs(hd0 + 0.6));
    vec3 hc = mix(u_holeColor, u_holeEdge, rim0 * 0.85);
    float al = max(inHole0, rim0 * 0.85) * cov;
    o = vec4(hc * al, al);
    return;
  }
  vec2 b = v_half;
  float m = min(b.x, b.y);
  float d;
  if (v_shape < 0.5 || v_shape > 0.5 && v_shape < 1.5) d = length(p) - m;           // default / circle
  else if (v_shape < 2.5) d = box(p, b);                                            // rect
  else if (v_shape < 3.5) { float r = 0.35 * m; d = box(p, b - r) - r; }            // round rect
  else if (v_shape < 4.5) { d = box(p, b - m) - m; }                                // oblong
  else { float R = m; d = abs(length(p) - R * 0.72) - R * 0.28; }                   // ring (via)
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.0) discard;
  vec3 col = v_color.rgb;
  // Subtle darker rim gives pads definition on dense boards.
  float rim = smoothstep(-1.6, -0.4, d);
  col = mix(col, col * 0.62, rim * step(2.5, m));
  if (v_hover > 0.5) {
    float ring = smoothstep(-2.5, -1.0, d);
    col = mix(col + 0.25, u_hoverColor, ring);
  }
  // Drill hole (file size) cut into the pad, with a thin dark edge.
  if (v_hole > 0.75) {
    float hd = length(p) - v_hole;
    float inHole = clamp(0.5 - hd, 0.0, 1.0);
    col = mix(col, u_holeColor, inHole);
    // 1 px neutral rim at the drill wall: visible on copper and for
    // non-plated holes whose drill fills the whole pad.
    float rim = 1.0 - smoothstep(0.0, 1.1, abs(hd + 0.6));
    col = mix(col, u_holeEdge, rim * 0.85);
  }
  float alpha = v_color.a * a;
  o = vec4(col * alpha, alpha);
}`;

const SEG_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_seg;
layout(location=2) in float a_width;
layout(location=3) in float a_side;
layout(location=4) in float a_layer;
layout(location=5) in vec4 a_color;
layout(location=6) in float a_dist;
uniform mat3 u_view;
uniform vec2 u_viewport;
uniform float u_side;
uniform float u_pass;
uniform float u_ghost;
uniform float u_scale;
uniform float u_minWidth;
uniform uint u_layerMask;
uniform float u_widthScale;
out float v_along;
out float v_across;
out float v_len;
out float v_hw;
out vec4 v_color;
out float v_dist;
void main() {
  bool other = (a_side == 1.0 && u_side == 2.0) || (a_side == 2.0 && u_side == 1.0);
  bool draw = (u_pass == 0.0) ? other : !other;
  bool layerOff = a_layer >= 0.0 && ((u_layerMask >> (uint(a_layer) & 31u)) & 1u) == 0u;
  if (!draw || layerOff || a_color.a == 0.0 || (other && u_ghost == 0.0)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 p0 = (u_view * vec3(a_seg.xy, 1.0)).xy;
  vec2 p1 = (u_view * vec3(a_seg.zw, 1.0)).xy;
  float w = a_width < 0.0 ? -a_width * u_widthScale : a_width * u_scale;
  w = max(w, u_minWidth);
  vec2 dir = p1 - p0;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float hw = w * 0.5 + 1.0;
  float along = mix(-hw, len + hw, a_corner.x);
  vec2 pos = p0 + dir * along + n * a_corner.y * hw;
  gl_Position = vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0);
  v_along = along;
  v_across = a_corner.y * hw;
  v_len = len;
  v_hw = w * 0.5;
  v_dist = a_dist * u_scale + along;
  v_color = vec4(a_color.rgb, a_color.a * (other ? u_ghost : 1.0));
}`;

const SEG_FS = `#version 300 es
precision highp float;
in float v_along;
in float v_across;
in float v_len;
in float v_hw;
in vec4 v_color;
in float v_dist;
uniform float u_dash;
out vec4 o;
void main() {
  float dx = max(max(-v_along, v_along - v_len), 0.0);
  float d = length(vec2(dx, v_across)) - v_hw;
  float a = clamp(0.5 - d, 0.0, 1.0) * clamp(v_hw + 0.5, 0.0, 1.0);
  // Dash phase follows the distance along the whole polyline (a_dist), so
  // outlines made of many short segments still show a dash pattern.
  if (u_dash > 0.0 && mod(v_dist, u_dash * 2.0) > u_dash) discard;
  if (a <= 0.0) discard;
  float alpha = v_color.a * a;
  o = vec4(v_color.rgb * alpha, alpha);
}`;

/**
 * Distance (world units) from the start of each polyline to each segment's
 * start; a polyline continues while a segment starts where the previous one
 * ended. Drives continuous dash patterns.
 */
function cumulativeDistance(seg: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const continues = i > 0 && Math.abs(seg[4 * i] - seg[4 * i - 2]) < 1e-3 && Math.abs(seg[4 * i + 1] - seg[4 * i - 1]) < 1e-3;
    if (!continues) acc = 0;
    out[i] = acc;
    acc += Math.hypot(seg[4 * i + 2] - seg[4 * i], seg[4 * i + 3] - seg[4 * i + 1]);
  }
  return out;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  return p;
}

interface PadBatch {
  vao: WebGLVertexArrayObject;
  count: number;
  colorBuf: WebGLBuffer;
  emphBuf: WebGLBuffer;
}
interface SegBatch {
  vao: WebGLVertexArrayObject;
  count: number;
  colorBuf: WebGLBuffer;
  bufs: WebGLBuffer[];
}

export class GLRenderer implements Renderer {
  readonly kind = 'webgl2' as const;
  private gl: WebGL2RenderingContext;
  private padProg: WebGLProgram;
  private segProg: WebGLProgram;
  private quad: WebGLBuffer;
  private segQuad: WebGLBuffer;
  private pads: PadBatch | null = null;
  private vias: PadBatch | null = null;
  private bodies: SegBatch | null = null;
  private outline: SegBatch | null = null;
  private traces: SegBatch | null = null;
  private rats: SegBatch | null = null;
  private bodySegPart: Uint32Array = new Uint32Array(0);
  private bodiesDashed: SegBatch | null = null;
  private dashedSegPart: Uint32Array = new Uint32Array(0);
  private model: BoardModel | null = null;
  private scene: Scene | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private su: Record<string, WebGLUniformLocation | null> = {};
  private cssW = 1;
  private cssH = 1;
  private allBufs: WebGLBuffer[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.padProg = compile(gl, PAD_VS, PAD_FS);
    this.segProg = compile(gl, SEG_VS, SEG_FS);
    for (const n of ['u_view', 'u_viewport', 'u_side', 'u_pass', 'u_ghost', 'u_hover', 'u_minPx', 'u_scale', 'u_hoverColor', 'u_holeColor', 'u_holeEdge', 'u_haloColor', 'u_holeOnly', 'u_holePass', 'u_emphPass', 'u_emphMinPx', 'u_haloPx']) this.u[n] = gl.getUniformLocation(this.padProg, n);
    for (const n of ['u_view', 'u_viewport', 'u_side', 'u_pass', 'u_ghost', 'u_scale', 'u_minWidth', 'u_layerMask', 'u_widthScale', 'u_dash']) this.su[n] = gl.getUniformLocation(this.segProg, n);
    this.quad = this.buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.segQuad = this.buf(new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]));
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  }

  private buf(data: ArrayBufferView, usage: number = WebGL2RenderingContext.STATIC_DRAW): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.allBufs.push(b);
    return b;
  }

  private attrib(loc: number, buf: WebGLBuffer, size: number, type: number, normalized = false, divisor = 1) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
    gl.vertexAttribDivisor(loc, divisor);
  }

  private makePads(center: Float32Array, half: Float32Array, rot: Float32Array, shape: Float32Array, side: Float32Array, count: number, hole?: Float32Array): PadBatch {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.attrib(0, this.quad, 2, gl.FLOAT, false, 0);
    this.attrib(1, this.buf(center), 2, gl.FLOAT);
    this.attrib(2, this.buf(half), 2, gl.FLOAT);
    this.attrib(3, this.buf(rot), 1, gl.FLOAT);
    this.attrib(4, this.buf(shape), 1, gl.FLOAT);
    this.attrib(5, this.buf(side), 1, gl.FLOAT);
    const colorBuf = this.buf(new Uint8Array(count * 4), gl.DYNAMIC_DRAW);
    this.attrib(6, colorBuf, 4, gl.UNSIGNED_BYTE, true);
    this.attrib(7, this.buf(hole ?? new Float32Array(count)), 1, gl.FLOAT);
    // Not normalised: a raw 0/1 byte converts to 0.0/1.0 for the float attribute.
    const emphBuf = this.buf(new Uint8Array(count), gl.DYNAMIC_DRAW);
    this.attrib(8, emphBuf, 1, gl.UNSIGNED_BYTE, false);
    gl.bindVertexArray(null);
    return { vao, count, colorBuf, emphBuf };
  }

  private makeSegs(seg: Float32Array, width: Float32Array, side: Float32Array, layer: Float32Array, count: number, color?: Uint8Array, dist?: Float32Array): SegBatch {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.attrib(0, this.segQuad, 2, gl.FLOAT, false, 0);
    const b1 = this.buf(seg),
      b2 = this.buf(width),
      b3 = this.buf(side),
      b4 = this.buf(layer);
    this.attrib(1, b1, 4, gl.FLOAT);
    this.attrib(2, b2, 1, gl.FLOAT);
    this.attrib(3, b3, 1, gl.FLOAT);
    this.attrib(4, b4, 1, gl.FLOAT);
    const colorBuf = this.buf(color ?? new Uint8Array(count * 4), gl.DYNAMIC_DRAW);
    this.attrib(5, colorBuf, 4, gl.UNSIGNED_BYTE, true);
    const b6 = this.buf(dist ?? cumulativeDistance(seg, count));
    this.attrib(6, b6, 1, gl.FLOAT);
    gl.bindVertexArray(null);
    return { vao, count, colorBuf, bufs: [b1, b2, b3, b4, colorBuf, b6] };
  }

  setScene(m: BoardModel, s: Scene) {
    this.disposeBatches();
    this.model = m;
    this.scene = s;
    const ox = s.originX,
      oy = s.originY;
    const { pins, parts, vias, traces } = m;

    // Pads
    const n = pins.count;
    const center = new Float32Array(n * 2),
      half = new Float32Array(n * 2),
      rot = new Float32Array(n),
      shape = new Float32Array(n),
      side = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      center[2 * i] = pins.x[i] - ox;
      center[2 * i + 1] = pins.y[i] - oy;
      half[2 * i] = s.pinHW[i];
      half[2 * i + 1] = s.pinHH[i];
      rot[i] = pins.rot[i];
      const sh = pins.shape[i];
      shape[i] = sh === SHAPE_DEFAULT ? 0 : sh === SHAPE_CIRCLE ? 1 : sh === SHAPE_RECT ? 2 : sh === SHAPE_ROUNDRECT ? 3 : sh === SHAPE_OBLONG ? 4 : 1;
      side[i] = pins.side[i] || SIDE_BOTH;
    }
    // Drill radius, never larger than the pad (a hole cannot exceed its copper).
    const hole = new Float32Array(n);
    for (let i = 0; i < n; i++) if (pins.hole[i] > 0) hole[i] = Math.min(pins.hole[i] / 2, Math.min(s.pinHW[i], s.pinHH[i]));
    this.pads = this.makePads(center, half, rot, shape, side, n, hole);

    // Vias (rings)
    if (vias.count) {
      const c = new Float32Array(vias.count * 2),
        h = new Float32Array(vias.count * 2),
        r = new Float32Array(vias.count),
        sh = new Float32Array(vias.count).fill(5),
        sd = new Float32Array(vias.count).fill(SIDE_BOTH);
      for (let i = 0; i < vias.count; i++) {
        c[2 * i] = vias.x[i] - ox;
        c[2 * i + 1] = vias.y[i] - oy;
        const rr = vias.d[i] > 0 ? vias.d[i] / 2 : s.typicalPin * 0.6;
        h[2 * i] = rr;
        h[2 * i + 1] = rr;
      }
      this.vias = this.makePads(c, h, r, sh, sd, vias.count);
    }

    // Part bodies (1.25 px lines, side per part). Mechanical parts (mounting
    // holes, fiducials) go into a separate batch drawn dashed: their outline is
    // a keep-out, not copper or a hole.
    for (const dashed of [0, 1]) {
      const list: [number, number][] = []; // [segment, part]
      for (let k = 0; k < parts.count; k++) if (s.bodyDashed[k] === dashed) for (let j = s.bodyStart[k]; j < s.bodyStart[k + 1]; j++) list.push([j, k]);
      const nb = list.length;
      if (!nb) continue;
      const bseg = new Float32Array(nb * 4),
        bw = new Float32Array(nb).fill(dashed ? -1 : -1.25),
        bside = new Float32Array(nb),
        blayer = new Float32Array(nb).fill(-1);
      const segPart = new Uint32Array(nb);
      list.forEach(([j, k], i) => {
        segPart[i] = k;
        bside[i] = parts.side[k] || SIDE_BOTH;
        bseg[4 * i] = s.bodySegs[4 * j] - ox;
        bseg[4 * i + 1] = s.bodySegs[4 * j + 1] - oy;
        bseg[4 * i + 2] = s.bodySegs[4 * j + 2] - ox;
        bseg[4 * i + 3] = s.bodySegs[4 * j + 3] - oy;
      });
      const batch = this.makeSegs(bseg, bw, bside, blayer, nb);
      if (dashed) {
        this.bodiesDashed = batch;
        this.dashedSegPart = segPart;
      } else {
        this.bodies = batch;
        this.bodySegPart = segPart;
      }
    }

    // Outline
    const no = m.outline.segs.length / 4;
    if (no) {
      const os = new Float32Array(no * 4);
      for (let j = 0; j < no; j++) {
        os[4 * j] = m.outline.segs[4 * j] - ox;
        os[4 * j + 1] = m.outline.segs[4 * j + 1] - oy;
        os[4 * j + 2] = m.outline.segs[4 * j + 2] - ox;
        os[4 * j + 3] = m.outline.segs[4 * j + 3] - oy;
      }
      this.outline = this.makeSegs(os, new Float32Array(no).fill(-1.6), new Float32Array(no).fill(SIDE_BOTH), new Float32Array(no).fill(-1), no);
    }

    // Copper traces (real geometry from the file)
    if (traces.count) {
      const ts = new Float32Array(traces.count * 4);
      for (let j = 0; j < traces.count; j++) {
        ts[4 * j] = traces.segs[4 * j] - ox;
        ts[4 * j + 1] = traces.segs[4 * j + 1] - oy;
        ts[4 * j + 2] = traces.segs[4 * j + 2] - ox;
        ts[4 * j + 3] = traces.segs[4 * j + 3] - oy;
      }
      const tw = new Float32Array(traces.count);
      for (let j = 0; j < traces.count; j++) tw[j] = traces.width[j] > 0 ? traces.width[j] : -1;
      const tl = Float32Array.from(traces.layer);
      const tside = new Float32Array(traces.count).fill(SIDE_BOTH);
      this.traces = this.makeSegs(ts, tw, tside, tl, traces.count);
    }
  }

  setColors(c: Colors) {
    const gl = this.gl;
    if (this.pads && this.pads.count) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pads.colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, c.pin, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pads.emphBuf);
      gl.bufferData(gl.ARRAY_BUFFER, c.pinEmph, gl.DYNAMIC_DRAW);
    }
    if (this.vias) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vias.colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, c.via, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vias.emphBuf);
      gl.bufferData(gl.ARRAY_BUFFER, c.viaEmph, gl.DYNAMIC_DRAW);
    }
    for (const [batch, segPart] of [
      [this.bodies, this.bodySegPart],
      [this.bodiesDashed, this.dashedSegPart],
    ] as const) {
      if (!batch) continue;
      const nb = batch.count;
      const bc = new Uint8Array(nb * 4);
      for (let j = 0; j < nb; j++) {
        const k = segPart[j];
        bc[4 * j] = c.part[4 * k];
        bc[4 * j + 1] = c.part[4 * k + 1];
        bc[4 * j + 2] = c.part[4 * k + 2];
        bc[4 * j + 3] = c.part[4 * k + 3];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, bc, gl.DYNAMIC_DRAW);
    }
    if (this.traces) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.traces.colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, c.trace, gl.DYNAMIC_DRAW);
    }
  }

  setRatsnest(segs: Float64Array | null) {
    if (this.rats) {
      this.freeSeg(this.rats);
      this.rats = null;
    }
    if (!segs || !segs.length || !this.scene) return;
    const n = segs.length / 4;
    const s = new Float32Array(n * 4);
    for (let j = 0; j < n; j++) {
      s[4 * j] = segs[4 * j] - this.scene.originX;
      s[4 * j + 1] = segs[4 * j + 1] - this.scene.originY;
      s[4 * j + 2] = segs[4 * j + 2] - this.scene.originX;
      s[4 * j + 3] = segs[4 * j + 3] - this.scene.originY;
    }
    this.rats = this.makeSegs(s, new Float32Array(n).fill(-1.2), new Float32Array(n).fill(SIDE_BOTH), new Float32Array(n).fill(-1), n, new Uint8Array(n * 4).fill(255));
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    const w = Math.max(1, Math.round(cssW * dpr)),
      h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(f: FrameInput) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const { view, opts, palette } = f;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = palette.bg;
    gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.model || !this.scene) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // View matrix in CSS px with the scene origin folded in.
    const m = viewMatrix(view);
    const ox = this.scene.originX,
      oy = this.scene.originY;
    const mat = new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[0] * ox + m[2] * oy + m[4], m[1] * ox + m[3] * oy + m[5], 1]);
    const ghost = opts.otherSide === 'hide' ? 0 : opts.otherSide === 'show' ? 1 : 0.22;
    const side = opts.side;

    const segUniforms = (minWidth: number, dash = 0, mask = 0xffffffff) => {
      gl.useProgram(this.segProg);
      gl.uniformMatrix3fv(this.su.u_view, false, mat);
      gl.uniform2f(this.su.u_viewport, this.cssW, this.cssH);
      gl.uniform1f(this.su.u_side, side);
      gl.uniform1f(this.su.u_ghost, ghost);
      gl.uniform1f(this.su.u_scale, view.scale);
      gl.uniform1f(this.su.u_minWidth, minWidth);
      gl.uniform1ui(this.su.u_layerMask, mask >>> 0);
      gl.uniform1f(this.su.u_widthScale, 1);
      gl.uniform1f(this.su.u_dash, dash);
    };
    const drawSegs = (b: SegBatch | null, pass: number) => {
      if (!b || !b.count) return;
      gl.uniform1f(this.su.u_pass, pass);
      gl.bindVertexArray(b.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
    };
    const padUniforms = (hover: number) => {
      gl.useProgram(this.padProg);
      gl.uniformMatrix3fv(this.u.u_view, false, mat);
      gl.uniform2f(this.u.u_viewport, this.cssW, this.cssH);
      gl.uniform1f(this.u.u_side, side);
      gl.uniform1f(this.u.u_ghost, ghost);
      gl.uniform1i(this.u.u_hover, hover);
      gl.uniform1f(this.u.u_minPx, 0.75);
      gl.uniform1f(this.u.u_scale, view.scale);
      const hc = opts.light ? [0, 0, 0] : [1, 1, 1];
      gl.uniform3f(this.u.u_hoverColor, hc[0], hc[1], hc[2]);
      gl.uniform3f(this.u.u_holeColor, palette.bg[0] / 255, palette.bg[1] / 255, palette.bg[2] / 255);
      gl.uniform3f(this.u.u_holeEdge, palette.holeEdge[0] / 255, palette.holeEdge[1] / 255, palette.holeEdge[2] / 255);
      gl.uniform3f(this.u.u_haloColor, palette.highlightHalo[0] / 255, palette.highlightHalo[1] / 255, palette.highlightHalo[2] / 255);
      gl.uniform1f(this.u.u_holeOnly, 0);
      gl.uniform1f(this.u.u_holePass, 0);
      gl.uniform1f(this.u.u_emphPass, 0);
      gl.uniform1f(this.u.u_emphMinPx, 4.5);
      gl.uniform1f(this.u.u_haloPx, 2.6);
    };
    const drawPads = (b: PadBatch | null, pass: number) => {
      if (!b || !b.count) return;
      gl.uniform1f(this.u.u_pass, pass);
      gl.bindVertexArray(b.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
    };

    // 1. Other side (ghosted), then 2. this side.
    for (const pass of [0, 1]) {
      if (opts.showTraces && this.traces) {
        segUniforms(0.6, 0, opts.traceLayerMask);
        drawSegs(this.traces, pass);
      }
      if (opts.showVias && this.vias && pass === 1) {
        padUniforms(f.hover.via);
        drawPads(this.vias, 1);
      }
      if (opts.showBodies && this.bodies) {
        segUniforms(1);
        drawSegs(this.bodies, pass);
      }
      if (opts.showBodies && this.bodiesDashed) {
        segUniforms(1, 4);
        drawSegs(this.bodiesDashed, pass);
      }
      if (opts.showPins && this.pads) {
        padUniforms(f.hover.pin);
        drawPads(this.pads, pass);
      }
    }
    // Emphasis beacons: highlighted pads/vias on top, with a halo and a minimum
    // on-screen size, so a selected net or part reads at any zoom level.
    if (opts.showVias && this.vias) {
      padUniforms(-1);
      gl.uniform1f(this.u.u_emphPass, 1);
      drawPads(this.vias, 1);
    }
    if (opts.showPins && this.pads) {
      padUniforms(-1);
      gl.uniform1f(this.u.u_emphPass, 1);
      drawPads(this.pads, 1);
    }
    if (opts.showPins && this.pads) {
      padUniforms(-1);
      gl.uniform1f(this.u.u_holeOnly, 1);
      gl.uniform1f(this.u.u_holePass, 1);
      drawPads(this.pads, 1);
    }
    if (opts.showOutline && this.outline) {
      segUniforms(1, this.model.outline.source === 'derived' ? 6 : 0);
      // colour is constant: set through a generic attribute-less path by re-uploading once
      this.ensureOutlineColor(this.model.outline.source === 'derived' ? palette.outlineDerived : palette.outline);
      drawSegs(this.outline, 1);
    }
    if (this.rats) {
      segUniforms(1, 5);
      this.ensureRatsColor(palette.ratsnest);
      drawSegs(this.rats, 1);
    }
    gl.bindVertexArray(null);
  }

  private outlineColorKey = '';
  private ensureOutlineColor(c: number[]) {
    const key = c.join(',');
    if (!this.outline || key === this.outlineColorKey) return;
    this.outlineColorKey = key;
    const n = this.outline.count;
    const a = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) a.set(c, 4 * i);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.outline.colorBuf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, a, this.gl.DYNAMIC_DRAW);
  }
  private ratsColorKey = '';
  private ensureRatsColor(c: number[]) {
    if (!this.rats) return;
    const key = c.join(',') + ':' + this.rats.count;
    if (key === this.ratsColorKey) return;
    this.ratsColorKey = key;
    const a = new Uint8Array(this.rats.count * 4);
    for (let i = 0; i < this.rats.count; i++) a.set(c, 4 * i);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.rats.colorBuf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, a, this.gl.DYNAMIC_DRAW);
  }

  private freeSeg(b: SegBatch) {
    this.gl.deleteVertexArray(b.vao);
    for (const x of b.bufs) this.gl.deleteBuffer(x);
    this.allBufs = this.allBufs.filter((x) => !b.bufs.includes(x));
    this.ratsColorKey = '';
  }

  private disposeBatches() {
    const gl = this.gl;
    for (const b of [this.pads, this.vias, this.bodies, this.bodiesDashed, this.outline, this.traces, this.rats]) if (b) gl.deleteVertexArray(b.vao);
    for (const b of this.allBufs) if (b !== this.quad && b !== this.segQuad) gl.deleteBuffer(b);
    this.allBufs = [this.quad, this.segQuad];
    this.pads = this.vias = null;
    this.bodies = this.bodiesDashed = this.outline = this.traces = this.rats = null;
    this.outlineColorKey = '';
    this.ratsColorKey = '';
  }

  dispose() {
    this.disposeBatches();
    this.gl.deleteProgram(this.padProg);
    this.gl.deleteProgram(this.segProg);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
