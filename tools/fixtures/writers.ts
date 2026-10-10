/**
 * Fixture writers. Each one produces a file exactly as the corresponding
 * reference parser (OpenBoardView / eagleview) reads it. Generated fixtures
 * are fed to BOTH the reference C++ parser (tools/obv-harness) and
 * BoardScope's parser; the test-suite requires both to agree.
 */
import { zlibSync } from 'fflate';
import { encodeBdv } from '../../src/formats/asc';
import { rc6Stream } from '../../src/formats/fz';
import { tvwEncodeString } from '../../src/formats/tvw';
import { desEcb } from '../../src/io/des';
import type { SrcBoard, SrcPart } from './source';


const enc = new TextEncoder();
const CRLF = '\r\n';

export class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  len = 0;
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number) {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  bool(v: boolean) {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number) {
    this.grow(2);
    this.view.setUint16(this.len, v, true);
    this.len += 2;
    return this;
  }
  s16(v: number) {
    this.grow(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
    return this;
  }
  u32(v: number) {
    this.grow(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }
  s32(v: number) {
    this.grow(4);
    this.view.setInt32(this.len, v | 0, true);
    this.len += 4;
    return this;
  }
  f32(v: number) {
    this.grow(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }
  bytes(b: ArrayLike<number>) {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  zeros(n: number) {
    this.grow(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }
  str8(s: string) {
    const b = latin1Bytes(s);
    if (b.length > 255) throw new Error('string too long');
    this.u8(b.length);
    return this.bytes(b);
  }
  vec(x: number, y: number) {
    return this.s32(x).s32(y);
  }
  out(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function latin1Bytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

const tok = (s: string) => (s && !/\s/.test(s) ? s : s.replace(/\s+/g, '_') || '');
const inch = (mil: number) => (mil / 1000).toFixed(3);

// ------------------------------------------------------------------ BRD (Test_Link)

export function writeBrdTestLink(b: SrcBoard, opts: { obfuscate?: boolean; lenovoNets?: boolean } = {}): Uint8Array {
  const parts = b.parts.filter((p) => !/^TP\d+$/.test(p.name));
  const pins = parts.flatMap((p, i) => p.pins.map((pin) => ({ p, i, pin })));
  const nailByNet = new Map(b.nails.map((n) => [n.net, n]));
  const L: string[] = [];
  L.push('str_length:');
  L.push(`${parts.length} ${pins.length}`);
  L.push('var_data:');
  L.push(`${b.outline.length} ${parts.length} ${pins.length} ${b.nails.length}`);
  L.push('Format:');
  for (const [x, y] of b.outline) L.push(`${x} ${y}`);
  L.push('Parts:');
  let end = 0;
  for (const p of parts) {
    end += p.pins.length;
    const tl = p.th ? 0 : p.side === 'B' ? 10 : 5;
    L.push(`${tok(p.name)} ${tl} ${end}`);
  }
  L.push('Pins:');
  for (const { i, pin } of pins) {
    const nail = nailByNet.get(pin.net);
    // Lenovo variant: net omitted, resolved through the nail with the same probe number.
    if (opts.lenovoNets && nail && pin.net) L.push(`${pin.x} ${pin.y} ${nail.probe} ${i + 1}`);
    else L.push(`${pin.x} ${pin.y} ${nail ? nail.probe : -99} ${i + 1} ${tok(pin.net)}`);
  }
  L.push('Nails:');
  for (const n of b.nails) L.push(`${n.probe} ${n.x} ${n.y} ${n.side === 'T' ? 1 : 2} ${tok(n.net)}`);
  const text = enc.encode(L.join(CRLF) + CRLF);
  if (!opts.obfuscate) return text;
  // Inverse of ~rotl8(b, 2): e = rotr8(~b, 2).
  return text.map((c) => {
    if (c === 13 || c === 10 || c === 0) return c;
    const n = ~c & 0xff;
    return ((n >> 2) | (n << 6)) & 0xff;
  });
}

// ------------------------------------------------------------------ BRD2 (BRDOUT)

/** kicad-boardview style BRDOUT (bottom Y mirrored, firstPin indices). */
export function writeBrd2(b: SrcBoard): Uint8Array {
  const maxX = Math.max(...b.outline.map((p) => p[0])),
    maxY = Math.max(...b.outline.map((p) => p[1]));
  const netIds = new Map(b.nets.map((n, i) => [n, i + 1]));
  const L: string[] = ['0', `BRDOUT: ${b.outline.length + 1} ${maxX} ${maxY}`];
  for (const [x, y] of [...b.outline, b.outline[0]]) L.push(`${x} ${y}`);
  L.push('', `NETS: ${b.nets.length}`);
  for (const n of b.nets) L.push(`${netIds.get(n)} ${tok(n)}`);
  L.push('', `PARTS: ${b.parts.length}`);
  let first = 0;
  const my = (y: number, side: 'T' | 'B') => (side === 'B' ? maxY - y : y);
  for (const p of b.parts) {
    L.push(`${tok(p.name)} ${p.bbox[0]} ${my(p.bbox[1], p.side)} ${p.bbox[2]} ${my(p.bbox[3], p.side)} ${first} ${p.side === 'B' ? 2 : 1}`);
    first += p.pins.length;
  }
  L.push('', `PINS: ${first}`);
  for (const p of b.parts) for (const q of p.pins) L.push(`${q.x} ${my(q.y, q.side)} ${q.net ? netIds.get(q.net) : 0} ${q.side === 'B' ? 2 : 1}`);
  L.push('', `NAILS: ${b.nails.length}`);
  for (const n of b.nails) L.push(`${n.probe} ${n.x} ${my(n.y, n.side)} ${netIds.get(n.net) ?? 0} ${n.side === 'B' ? 2 : 1}`);
  return enc.encode(L.join('\n') + '\n');
}

// ------------------------------------------------------------------ BDV / ASC

const ASC_HEADER = (title: string, n: number) =>
  Array.from({ length: n }, (_, i) => (i === 0 ? `${title} -- BoardScope synthetic fixture (Glasgow, 0BSD)` : i === 1 ? 'Units: inch' : `Header line ${i + 1}`));

function ascFormat(b: SrcBoard): string[] {
  return b.outline.map(([x, y]) => `${inch(x)} ${inch(y)}`);
}
function ascPins(b: SrcBoard, twoSpace: boolean): string[] {
  const out: string[] = [];
  for (const p of b.parts) {
    out.push(`Part ${tok(p.name)} ${p.side === 'B' ? '(B)' : '(T)'}`);
    p.pins.forEach((pin, i) => {
      const name = tok(pin.name || String(i + 1));
      out.push(`${i + 1} ${name}${twoSpace ? '  ' : ' '}${inch(pin.x)} ${inch(pin.y)} ${p.side === 'B' ? 2 : 1} ${tok(pin.net) || 'NC'} ${i}`);
    });
  }
  return out;
}
function ascNails(b: SrcBoard): string[] {
  return b.nails.map((n, i) => `-${n.probe} ${inch(n.x)} ${inch(n.y)} 1 G${i} ${n.side === 'B' ? '(B)' : '(T)'} ${i + 1} ${tok(n.net)}`);
}

export function writeBdv(b: SrcBoard, obfuscate = true): Uint8Array {
  const L = [
    '<<format.asc>>',
    ...ASC_HEADER('format.asc', 8),
    ...ascFormat(b),
    '<<pins.asc>>',
    ...ASC_HEADER('pins.asc', 8),
    ...ascPins(b, false),
    '<<nails.asc>>',
    ...ASC_HEADER('nails.asc', 7),
    ...ascNails(b),
  ];
  const text = enc.encode(L.join(CRLF) + CRLF);
  return obfuscate ? encodeBdv(text) : text;
}

export function writeAscSet(b: SrcBoard): Record<string, Uint8Array> {
  return {
    'format.asc': enc.encode([...ASC_HEADER('FORMAT.ASC', 8), ...ascFormat(b)].join(CRLF) + CRLF),
    'pins.asc': enc.encode([...ASC_HEADER('PINS.ASC', 8), ...ascPins(b, true)].join(CRLF) + CRLF),
    'nails.asc': enc.encode([...ASC_HEADER('NAILS.ASC', 7), ...ascNails(b)].join(CRLF) + CRLF),
  };
}

// ------------------------------------------------------------------ BVR1

export function writeBvr1(b: SrcBoard): Uint8Array {
  const L = ['BVRAW_FORMAT_1', '<<Layout>>', 'X,Y'];
  for (const [x, y] of b.outline) L.push(`${inch(x)},${inch(y)}`);
  L.push('<<Pin>>', 'PART SIDE ID NAME X Y LAYER NET');
  for (const p of b.parts) p.pins.forEach((pin, i) => L.push(`${tok(p.name)} ${p.side === 'B' ? '(B)' : '(T)'} ${i + 1} ${tok(pin.name || String(i + 1))} ${inch(pin.x)} ${inch(pin.y)} ${p.side === 'B' ? 2 : 1} ${tok(pin.net) || 'NC'}`));
  L.push('<<Nail>>', 'PROBE X Y TYPE GRID SIDE NETID NET');
  b.nails.forEach((n, i) => L.push(`${n.probe}\t${inch(n.x)} ${inch(n.y)} 1 G${i} ${n.side === 'B' ? '(B)' : '(T)'} ${i + 1} ${tok(n.net)}`));
  return enc.encode(L.join(CRLF) + CRLF);
}

// ------------------------------------------------------------------ FZ / CAE

export function writeFz(b: SrcBoard, key?: number[]): Uint8Array {
  const L: string[] = [];
  L.push('A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!');
  for (const p of b.parts) L.push(`S!${p.name}!${p.th ? 'TH' : 'SMD'}!${p.footprint.replace(/!/g, '_')}!${p.side === 'B' ? 'YES' : 'NO'}!${p.rot}!`);
  L.push('A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!');
  for (const p of b.parts)
    p.pins.forEach((pin) => {
      // Variant B (BGA): PIN_NUMBER "0" and the ball name in PIN_NAME.
      const bga = /^[A-Z]{1,2}\d+$/.test(pin.number);
      L.push(`S!${pin.net}!${p.name}!${bga ? '0' : pin.number}!${bga ? pin.number : pin.name}!${pin.x.toFixed(2)}!${pin.y.toFixed(2)}!!${(Math.min(pin.w, pin.h) / 2).toFixed(3)}!`);
    });
  L.push('A!TESTVIA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!VIA_X!VIA_Y!TEST_POINT!RADIUS!');
  for (const n of b.nails) L.push(`S!Y!${n.net}!TP${n.probe}!1!1!${n.x}!${n.y}!${n.side}!10!`);
  const content = enc.encode(L.join('\r\n') + '\r\n');
  const D: string[] = ['Glasgow (BoardScope synthetic fixture)', 'PARTNUMBER\tDESCRIPTION\tQTY\tLOCATION\tPARTNUMBER2'];
  const byValue = new Map<string, string[]>();
  for (const p of b.parts) if (p.value) byValue.set(p.value, [...(byValue.get(p.value) ?? []), p.name]);
  let n = 0;
  for (const [v, locs] of byValue) D.push(`PN${String(++n).padStart(5, '0')}\t${v}\t${locs.length}\t${locs.join(' ')}\tALT${n}`);
  const descr = enc.encode(D.join('\r\n') + '\r\n');
  const zc = zlibSync(content, { level: 9 });
  const zd = zlibSync(descr, { level: 9 });
  // The first word is not interpreted by readers; vary it if the ciphertext
  // accidentally starts with a zlib header at offset 4 (readers would then
  // skip decryption).
  for (let salt = 0; salt < 64; salt++) {
    const w = new ByteWriter();
    w.u32(content.length + salt).bytes(zc).bytes(zd).u32(zd.length + 8);
    let out = w.out();
    if (!key) return out;
    out = rc6Stream(out, key, true);
    const looksZlib = out[4] === 0x78 && (out[5] === 0x9c || out[5] === 0xda || out[5] === 0x01 || out[5] === 0x5e);
    if (!looksZlib) return out;
  }
  throw new Error('could not produce an unambiguous ciphertext');
}

/** Deterministic test key satisfying a parity pattern (NOT a real vendor key). */
export function testKey44(parity: number[], seed: number): number[] {
  let s = seed >>> 0;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
  return parity.map((want) => {
    let w = next();
    let t = w;
    t ^= t >>> 16;
    t ^= t >>> 8;
    t ^= t >>> 4;
    t ^= t >>> 2;
    t ^= t >>> 1;
    if ((~t & 1) !== want) w ^= 1;
    return w >>> 0;
  });
}

// ------------------------------------------------------------------ CAD panel

export function writeCadPanel(b: SrcBoard): Uint8Array {
  const L = ['###Panel Added', '### BoardScope synthetic fixture (Glasgow, 0BSD)'];
  // The record keyword itself is the reference's "TYPE" field.
  b.parts.forEach((p, i) => L.push(`COMP ${tok(p.name)} ${i + 1} 0 0 ${inch(p.x)} ${inch(p.y)} ${p.side === 'B' ? 2 : 1} 0`));
  for (const p of b.parts) p.pins.forEach((pin, i) => L.push(`C_PIN ${tok(p.name)}-${tok(pin.number || String(i + 1))} ${inch(pin.x)} ${inch(pin.y)} 0 0 0 X /${tok(pin.net) || 'NC'}`));
  const viasByNet = new Map<string, typeof b.vias>();
  for (const v of b.vias) if (v.net) viasByNet.set(v.net, [...(viasByNet.get(v.net) ?? []), v]);
  for (const [net, vs] of viasByNet) {
    L.push(`NET /${tok(net)}`);
    vs.forEach((v, i) => L.push(`N_VIA ${inch(v.x)} ${inch(v.y)} X ${i % 2 ? 2 : 1} 0`));
  }
  return enc.encode(L.join(CRLF) + CRLF);
}

// ------------------------------------------------------------------ CST (MFC CArchive)

export function writeCst(b: SrcBoard): Uint8Array {
  const parts = b.parts;
  const nets = ['', ...b.nets];
  const netIdx = new Map(nets.map((n, i) => [n, i]));
  const w = new ByteWriter();
  w.s16(parts.length).u16(0xffff).u16(1).s16(7).bytes(latin1Bytes('CDevice'));
  parts.forEach((p, i) => {
    w.str8(p.name).zeros(4).u8(p.side === 'B' ? 0x01 : 0x0c).zeros(4);
    // Last two bytes of the final part record hold the net count.
    if (i === parts.length - 1) w.s16(nets.length);
    else w.u16(0x8001);
  });
  for (const n of nets) w.str8(n);
  w.zeros(6); // unknown gap before the next class record
  const pins = parts.flatMap((p, k) => p.pins.map((pin) => ({ k, pin })));
  w.s16(pins.length + b.nails.length).u16(0xffff).u16(1).s16(4).bytes(latin1Bytes('CPad'));
  for (const { k, pin } of pins) w.s16(k).s16(0).s16(netIdx.get(pin.net) ?? 0).s16(pin.x).s16(pin.y).s16(1).zeros(4);
  for (const n of b.nails) w.s16(-1).s16(n.probe).s16(netIdx.get(n.net) ?? 0).s16(n.x).s16(n.y).s16(2).zeros(4);
  return w.out();
}

// ------------------------------------------------------------------ XZZ

export const XZZ_TEST_KEY = '1F2E3C4B5A667788'; // parity-valid test key (bytes 0..6 even, byte 7 odd), not a vendor key

export function writeXzz(b: SrcBoard, xorKey = 0x5a): Uint8Array {
  const [kh, kl] = [parseInt(XZZ_TEST_KEY.slice(0, 8), 16) >>> 0, parseInt(XZZ_TEST_KEY.slice(8), 16) >>> 0];
  const S = 10000;
  const nets = b.nets;
  const netIdx = new Map(nets.map((n, i) => [n, i + 1]));
  const blocks = new ByteWriter();
  const block = (type: number, data: Uint8Array) => blocks.u8(type).u32(data.length).bytes(data);
  for (const [x1, y1, x2, y2] of b.outlineSegs) block(0x05, new ByteWriter().u32(28).u32(x1 * S).u32(y1 * S).u32(x2 * S).u32(y2 * S).u32(S).u32(0).out());
  for (const p of b.parts) {
    if (/^TP\d+$/.test(p.name)) continue;
    const pw = new ByteWriter();
    pw.u32(0); // part size placeholder
    pw.zeros(18);
    const group = latin1Bytes(p.footprint.slice(0, 40));
    pw.u32(group.length).bytes(group);
    pw.u8(0x06).zeros(30);
    const name = latin1Bytes(p.name);
    pw.u32(name.length).bytes(name);
    for (const pin of p.pins) {
      const body = new ByteWriter();
      body.zeros(4).u32(pin.x * S).u32(pin.y * S).zeros(8);
      const pn = latin1Bytes(pin.number);
      body.u32(pn.length).bytes(pn).zeros(32).u32(netIdx.get(pin.net) ?? 0).zeros(4);
      const bb = body.out();
      pw.u8(0x09).u32(bb.length).bytes(bb);
    }
    const pad = (8 - ((pw.len + 0) % 8)) % 8;
    pw.zeros(pad);
    const plain = pw.out();
    new DataView(plain.buffer).setUint32(0, plain.length - 4, true);
    block(0x07, desEcb(plain, kh, kl, false));
  }
  for (const n of b.nails) {
    const name = latin1Bytes(`TP${n.probe}`);
    block(0x09, new ByteWriter().u32(n.probe).u32(n.x * S).u32(n.y * S).zeros(8).u32(name.length).bytes(name).zeros(8).u32(netIdx.get(n.net) ?? 0).out());
  }
  const main = blocks.out();
  const netw = new ByteWriter();
  netw.u32(8 + 2).u32(0).bytes(latin1Bytes('NC'));
  for (const n of nets) {
    const nb = latin1Bytes(n);
    netw.u32(nb.length + 8).u32(netIdx.get(n)!).bytes(nb);
  }
  const netb = netw.out();
  const w = new ByteWriter();
  w.bytes(latin1Bytes('XZZPCB V1.0')).zeros(5); // 0x00..0x0F
  w.u8(0); // 0x10 xor key placeholder
  w.zeros(15); // ..0x1F
  const mainOff = 0x40;
  const netOff = mainOff + 4 + main.length;
  w.u32(mainOff - 0x20).u32(0).u32(netOff - 0x20).u32(0); // 0x20..0x2F
  w.zeros(mainOff - w.len);
  w.u32(main.length).bytes(main);
  w.u32(netb.length).bytes(netb);
  const out = w.out();
  if (xorKey) {
    for (let i = 0; i < out.length; i++) out[i] ^= xorKey;
  }
  return out;
}

// ------------------------------------------------------------------ TVW

function tvwObjectHeader(w: ByteWriter, kind: 1 | 3, name: string, type: number) {
  w.u32(kind).u32(2).u32(1).str8(name).str8(name.toLowerCase()).str8('C:\\boardscope\\fixture').u32(type).u32(0x00ffcc00).u32(0x0000ffff);
}

interface TvwPadDef {
  net: number;
  shape: number;
  x: number;
  y: number;
  hole: number;
}

function tvwLogic(
  w: ByteWriter,
  name: string,
  type: number,
  shapes: { type: number; sx: number; sy: number; turn: number }[],
  pads: TvwPadDef[],
  lines: { net: number; d: number; x1: number; y1: number; x2: number; y2: number }[],
  opts: { order2?: boolean; arcs?: boolean; extras?: boolean } = {},
) {
  tvwObjectHeader(w, 3, name, type);
  w.u32(shapes.length ? shapes.length + 10 : 0);
  for (const s of shapes) {
    w.u32(1).vec(s.sx, s.sy).u32(s.type);
    if (s.type === 0) w.vec(0, 0);
    else if (s.type === 1) w.f32(s.turn).s32(0);
    else if (s.type === 3) w.f32(s.turn).s32(Math.round(Math.min(s.sx, s.sy) * 0.25));
    else if (s.type === 5) {
      w.u32(0).str8('POLY_' + s.sx).vec(-s.sx / 2, -s.sy / 2).vec(s.sx / 2, s.sy / 2).u32(2);
      w.u32(2).s32(0).s32(0).s32(0).u32(4).vec(-s.sx / 2, -s.sy / 2).vec(s.sx / 2, -s.sy / 2).vec(s.sx / 2, s.sy / 2).vec(-s.sx / 2, s.sy / 2);
      w.u32(5).u32(1).u32(0).u32(0).vec(0, 0).vec(10, 10).s32(500);
    }
  }
  const writeLines = (ls: typeof lines) => {
    w.u32(ls.length);
    if (ls.length) {
      w.u32(0);
      for (const l of ls) w.s32(l.net).u32(l.d + 10).vec(l.x1, l.y1).vec(l.x2, l.y2);
    }
  };
  const writeArcs = (n: number) => {
    w.u32(n);
    if (n) {
      w.u32(0);
      for (let i = 0; i < n; i++) w.s32(-1).u32(10).vec(5000 + i * 100, 5000).s32(2000).f32(0).f32(90);
    }
  };
  if (shapes.length) {
    w.u32(opts.order2 ? 2 : 1).u32(0).u32(1);
    w.u32(pads.length);
    if (pads.length) {
      w.u32(2);
      pads.forEach((p, i) => {
        const tp = opts.extras && i % 17 === 3 ? 1 : 0;
        const exposed = !!(opts.extras && i % 5 === 1);
        w.s32(p.net).u32(p.shape + 10).vec(p.x, p.y).bool(exposed).bool(true).u8(tp);
        const something = !!(opts.extras && i % 7 === 2);
        w.bool(something);
        if (tp === 1) w.zeros(12);
        if (exposed || something) w.vec(p.x - 100, p.y - 100).vec(p.x + 100, p.y + 100);
        w.bool(p.hole > 0).u8(0);
        if (p.hole > 0) w.zeros(7).vec(p.hole, p.hole).u8(0);
      });
    }
    if (opts.order2) {
      writeLines([]);
      writeArcs(0);
    } else {
      writeLines(lines);
      writeArcs(opts.arcs ? 3 : 0);
    }
    // one surface with a void
    if (opts.extras) {
      w.u32(1).u32(2);
      w.s32(0).u32(4).vec(0, 0).vec(10000, 0).vec(10000, 10000).vec(0, 10000).s32(100).u32(1);
      w.u32(1).u32(3).vec(1000, 1000).vec(2000, 1000).vec(2000, 2000).u32(0);
    } else w.u32(0);
    if (opts.order2) {
      w.zeros(16);
      writeLines(lines);
      writeArcs(opts.arcs ? 2 : 0);
      w.u32(0);
    }
  }
  // unknown items
  if (opts.extras) {
    w.u32(1).u32(5).str8('ITEM').vec(1, 2).s32(0).s32(1).s32(2).s32(3).s32(0).s32(0).bool(false).bool(true).bool(false).s32(4).u32(0);
  } else w.u32(0).u32(0);
  w.u32(7);
  // test points
  const tps = opts.extras ? 2 : 0;
  w.u32(tps);
  for (let i = 0; i < tps; i++) w.bool(true).s32(1).s32(i * 8).s32(0).s32(0).vec(100 * i, 200).s32(0).bool(false).s32(0).s32(0).s32(i);
  w.u32(0).u32(4);
  for (let k = 0; k < 2; k++) {
    const n = opts.extras ? 1 : 0;
    w.u32(n).u32(0);
    for (let i = 0; i < n; i++) w.u32(1).u32(8).u32(0).vec(1, 1).vec(2, 2).vec(3, 3).bool(false).bool(false).bool(true).u32(7).s32(-1).bool(false).bool(false).bool(false).s32(0);
  }
  const ts = opts.extras ? 2 : 0;
  w.u32(ts).u32(opts.extras ? 1 : 0);
  for (let i = 0; i < ts; i++) w.u32(i).u32(i + 1).bool(i === 0);
  if (opts.extras) w.u32(0).u32(0).u32(0);
}

interface TvwArcSlot {
  net: number;
  tool: number;
  cx: number;
  cy: number;
  r: number;
  start: number;
  sweep: number;
}

function tvwThrough(
  w: ByteWriter,
  name: string,
  type: number,
  tools: number[],
  holes: { net: number; tool: number; x: number; y: number }[],
  slots: { net: number; tool: number; x1: number; y1: number; x2: number; y2: number }[],
  arcs: TvwArcSlot[] = [],
) {
  tvwObjectHeader(w, 1, name, type);
  w.u32(0).u32(0);
  if (!tools.length && !holes.length && !slots.length && !arcs.length) {
    w.u32(0); // empty through-layer
    return;
  }
  w.u32(tools.length + 1);
  for (const t of tools) w.bool(true).bool(false).u32(t).zeros(20).bytes([1, 2, 3]);
  w.u8(0).u32(holes.length + slots.length + arcs.length).u32(0).zeros(16);
  for (const h of holes) w.u8(0x08).s32(h.net).u32(h.tool).vec(h.x, h.y);
  // 0x0A: straight slot (begin, end, 0); 0x0B: arc slot (centre, radius, start°, sweep° as float32).
  for (const s of slots) w.u8(0x0a).s32(s.net).u32(s.tool).vec(s.x1, s.y1).vec(s.x2, s.y2).u32(0);
  for (const a of arcs) w.u8(0x0b).s32(a.net).u32(a.tool).vec(a.cx, a.cy).s32(a.r).f32(a.start).f32(a.sweep);
}

/** Decal-local outline that, placed like the reader places it, reproduces the part's world box. */
function localOutline(p: SrcPart, U: number): number[] {
  const [x0, y0, x1, y1] = p.bbox;
  const a = (-p.rot * Math.PI) / 180;
  const c = Math.round(Math.cos(a) * 1e9) / 1e9,
    s = Math.round(Math.sin(a) * 1e9) / 1e9;
  const out: number[] = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]) {
    // world_rel = M·R(rot)·local  ⇒  local = R(−rot)·M·world_rel (M = mirror X on the bottom side)
    let u = x - p.x;
    const v = y - p.y;
    if (p.side === 'B') u = -u;
    out.push(Math.round((u * c - v * s) * U), Math.round((u * s + v * c) * U));
  }
  return out;
}

/** A spot on the board far from every pin, for a circular route cutout. */
function freeSpot(b: SrcBoard): [number, number, number] {
  const xs = b.outline.map((p) => p[0]),
    ys = b.outline.map((p) => p[1]);
  const pins = b.parts.flatMap((p) => p.pins);
  let best: [number, number, number] = [0, 0, 0];
  for (let gx = 1; gx < 20; gx++)
    for (let gy = 1; gy < 12; gy++) {
      const x = Math.min(...xs) + ((Math.max(...xs) - Math.min(...xs)) * gx) / 20;
      const y = Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * gy) / 12;
      let d = Infinity;
      for (const q of pins) d = Math.min(d, Math.hypot(q.x - x, q.y - y));
      if (d > best[2]) best = [Math.round(x), Math.round(y), d];
    }
  return [best[0], best[1], Math.max(10, Math.min(60, Math.floor(best[2] * 0.5)))];
}

function tvwFixtureData(w: ByteWriter) {
  w.u32(1).zeros(24).bool(true).bool(false).bool(true);
  w.u32(2).bool(true).s32(5000).zeros(20).u32(0xff00ff).bool(false);
  w.u32(1).u32(3).vec(0, 0).vec(100, 100);
  w.u8(1).s32(2).s32(3).s32(4).s32(5);
}

/** `shortSettings`: the variant written by Gigabyte's exporter (password set, settings block 2 bytes shorter). */
export function writeTvw(b: SrcBoard, opts: { shortSettings?: boolean } = {}): Uint8Array {
  const U = 100; // raw units per mil
  const nets = b.nets;
  const netIdx = new Map(nets.map((n, i) => [n, i]));
  const shapes: { type: number; sx: number; sy: number; turn: number }[] = [];
  const shapeKey = new Map<string, number>();
  const shapeFor = (t: 'round' | 'rect' | 'roundrect', w: number, h: number) => {
    const type = t === 'round' ? 0 : t === 'roundrect' ? 3 : w === h && w > 40 ? 5 : 1;
    const key = `${type}:${w}:${h}`;
    let i = shapeKey.get(key);
    if (i === undefined) {
      i = shapes.length;
      shapes.push({ type, sx: w * U, sy: h * U, turn: 0 });
      shapeKey.set(key, i);
    }
    return i;
  };
  const top: TvwPadDef[] = [];
  const bot: TvwPadDef[] = [];
  const partPads = new Map<SrcPart, number[]>();
  for (const p of b.parts) {
    const list = p.side === 'B' ? bot : top;
    const idx: number[] = [];
    for (const pin of p.pins) {
      idx.push(list.length);
      list.push({ net: pin.net ? netIdx.get(pin.net)! : -1, shape: shapeFor(pin.shape, pin.w, pin.h), x: pin.x * U, y: pin.y * U, hole: pin.hole * U });
    }
    partPads.set(p, idx);
  }
  const lineShape = (wd: number) => shapeFor('round', wd, wd);
  const traceLines = (layer: 'T' | 'B' | 'I') =>
    b.traces.filter((t) => t.layer === layer).map((t) => ({ net: t.net ? netIdx.get(t.net)! : -1, d: lineShape(t.w), x1: t.x1 * U, y1: t.y1 * U, x2: t.x2 * U, y2: t.y2 * U }));
  const topLines = traceLines('T');
  const botLines = traceLines('B');
  const innerLines = traceLines('I');
  // tools
  const tools: number[] = [];
  const toolFor = (d: number) => {
    let i = tools.indexOf(d * U);
    if (i < 0) {
      i = tools.length;
      tools.push(d * U);
    }
    return i + 1;
  };
  const holes = b.vias.map((v) => ({ net: v.net ? netIdx.get(v.net)! : -1, tool: toolFor(v.d), x: v.x * U, y: v.y * U }));
  // Like real files, the drill table also lists the hole of every through-hole pin.
  for (const p of b.parts) for (const pin of p.pins) if (pin.hole > 0) holes.push({ net: pin.net ? netIdx.get(pin.net)! : -1, tool: toolFor(pin.hole), x: pin.x * U, y: pin.y * U });
  const routeTool = [10 * U];
  const slots = b.outlineSegs.map(([x1, y1, x2, y2]) => ({ net: -1, tool: 1, x1: x1 * U, y1: y1 * U, x2: x2 * U, y2: y2 * U }));
  // A circular cutout made of two arc slots that both start at 0° (one CCW, one CW).
  const [hx, hy, hr] = freeSpot(b);
  const arcSlots: TvwArcSlot[] = [
    { net: -1, tool: 1, cx: hx * U, cy: hy * U, r: hr * U, start: 0, sweep: 180 },
    { net: -1, tool: 1, cx: hx * U, cy: hy * U, r: hr * U, start: 0, sweep: -180 },
  ];

  const w = new ByteWriter();
  w.str8(tvwEncodeString('Tebo-ictview files.')).u32(1).str8(tvwEncodeString('BoardScope fixture')).str8(opts.shortSettings ? tvwEncodeString('secret') : '').str8(tvwEncodeString('2026-10-09')).zeros(3).u32(0).u32(0).u32(0);
  const LAYERS = 6;
  w.u32(LAYERS);
  tvwLogic(w, 'TOP', 1, shapes, top, topLines, { arcs: true, extras: true });
  tvwLogic(w, 'BOTTOM', 2, shapes, bot, botLines, { order2: true, arcs: true });
  w.u32(0); // Object::Detect skips zero dwords before an object
  tvwLogic(w, 'INNER1', 3, shapes, [], innerLines);
  tvwThrough(w, 'DRILL', 11, tools, holes, []);
  tvwThrough(w, 'OUTLINE', 12, routeTool, [], slots, arcSlots);
  tvwThrough(w, 'EMPTY', 11, [], [], []);
  w.zeros(16);
  w.u32(nets.length).u32(nets.length);
  for (const n of nets) w.str8(n);
  // probe registry
  w.u32(0).u32(0).u32(4).str8('Probes').u32(11811).u32(1);
  w.u32(1);
  w.bool(true).u32(15).str8('Spear_B_100 Mil').s32(7000).u32(0x12ccfc).s32(2000).u32(98).s32(3000).u32(5299).u32(0xffff).zeros(32);
  w.bool(true);
  tvwFixtureData(w);
  w.vec(1, 2).vec(3, 4).u32(1).u32(9).s32(1).vec(0, 0).vec(1, 1).s32(2).vec(2, 2).vec(3, 3);
  w.u32(0).bool(false).bool(true).bool(false).u8(0).s32(1).s32(2).s32(3).s32(1).vec(0, 0).vec(1, 1).s32(2).vec(0, 0).vec(1, 1);
  // fixture registry
  w.u32(0).u32(7874);
  for (let i = 0; i < 8; i++) w.str8(`Grid ${i}`);
  w.u32(3).str8('Top fixture').u32(0).u32(1).str8('Variant A').str8('A').bool(true).bool(false);
  tvwFixtureData(w);
  w.vec(100000, 80000);
  w.u32(3).str8('Bottom fixture').u32(0).u32(0).vec(100000, 80000);
  // mysterious block
  w.u32(50).u32(12452).vec(500000, 300000).u32(3).u32(1).bool(true).bool(false).u8(1).u8(2).zeros(16).bool(false).bool(true).bool(false).bool(false);
  if (!opts.shortSettings) w.bool(true).bool(false);
  w.u32(10000).u32(0).u32(0).u32(0).u8(0).u8(0);
  // parts
  const parts = b.parts;
  w.u32(parts.length).u32(0);
  // One decal per footprint (parts without a footprint get their own decal).
  const decalKey = (p: SrcPart) => p.footprint || `NOFP_${p.name}`;
  const decals: { name: string; outline: number[] }[] = [];
  const decalIdx = new Map<string, number>();
  for (const p of parts) {
    const k = decalKey(p);
    if (!decalIdx.has(k)) {
      decalIdx.set(k, decals.length);
      decals.push({ name: k, outline: localOutline(p, U) });
    }
  }
  parts.forEach((p, k) => {
    const [x0, y0, x1, y1] = p.bbox;
    // Real files store a part box that includes the refdes text: emulate an offset, enlarged box.
    w.str8(p.name).vec(x0 * U, y0 * U).vec((x1 + 60) * U, (y1 + 25) * U).vec(p.x * U, p.y * U).s32(p.rot).u32(decalIdx.get(decalKey(p))!);
    // Part type: 21 = mechanical (mounting holes), 29 = fiducial, as in real files.
    w.u32(/^MK\d/.test(p.name) ? 21 : /^FID\d/.test(p.name) ? 29 : /^C/.test(p.name) ? 5 : /^R/.test(p.name) ? 3 : /^J/.test(p.name) ? 17 : 0).u32(0).s32(500);
    const flag0 = k % 9 === 0;
    w.bool(flag0).str8(p.value.slice(0, 200)).str8('5%').str8('5%').str8(p.footprint.slice(0, 200));
    if (flag0) w.str8(`SN${k}`).u32(0);
    w.u32(p.pins.length).u32(p.side === 'B' ? 1 : 0).u32(0);
    const pads = partPads.get(p)!;
    p.pins.forEach((pin, i) => w.u32(pads[i] * 8).u32(0).u32(i + 1).str8(pin.number).u32(0));
  });
  // decals: name + local outline (used for part bodies)
  w.u32(3).u32(decals.length);
  decals.forEach((d, i) => {
    w.bool(true).str8(d.name.slice(0, 200)).u32(1).u32(2).u32(3).bool(false);
    w.bool(i === 0);
    if (i === 0) tvwLogic(w, 'DECAL_TOP', 1, [], [], []);
    w.bool(false).bool(false);
    w.bool(true).u32(2).s32(-1).u32(d.outline.length / 2);
    for (let v = 0; v < d.outline.length; v += 2) w.vec(d.outline[v], d.outline[v + 1]);
    w.u32(0).u32(0);
  });
  return w.out();
}

// ------------------------------------------------------------------ Fabmaster FATF / FARC

/**
 * A Fabmaster job of the board: one package per part, in the part's local
 * frame, so the reader's placement (negate Y on the bottom, rotate clockwise
 * in tenths of a degree) is exercised for every rotation and side.
 */
interface FabPkg {
  name: string;
  rot10: number;
  pins: { x: number; y: number; stack: number }[];
}
function fabJob(b: SrcBoard) {
  const nets = new Map(b.nets.map((n, i) => [n, i + 1]));
  const stacks = new Map<string, number>();
  const stackOf = (shape: string, w: number, h: number, hole: number) => {
    const k = `${shape}:${w}:${h}:${hole}`;
    return stacks.get(k) ?? (stacks.set(k, stacks.size + 1), stacks.size);
  };
  const viaStack = new Map<number, number>();
  for (const v of b.vias) if (!viaStack.has(v.d)) viaStack.set(v.d, stackOf('round', v.d, v.d, Math.max(1, Math.round(v.d / 2))));
  const pkgs: FabPkg[] = b.parts.map((p) => {
    // Fabmaster rotation: tenths of a degree clockwise. local = M · R(+θcw) · (abs − origin).
    const rot10 = ((Math.round(-p.rot) % 360) + 360) % 360 * 10;
    const a = (rot10 / 10) * (Math.PI / 180);
    const c = Math.cos(a),
      s = Math.sin(a);
    return {
      name: `PKG_${tok(p.name)}`,
      rot10,
      pins: p.pins.map((pin) => {
        const dx = pin.x - p.x,
          dy = pin.y - p.y;
        const lx = dx * c - dy * s,
          ly = dx * s + dy * c;
        // Pads are axis-aligned on the board: swap w/h in a quarter-turned frame.
        const q = rot10 === 900 || rot10 === 2700;
        const [w, h] = q ? [pin.h, pin.w] : [pin.w, pin.h];
        return { x: lx, y: p.side === 'B' ? -ly : ly, stack: stackOf(pin.shape === 'round' ? 'round' : 'rect', w, h, pin.hole) };
      }),
    };
  });
  return { nets, stacks, viaStack, pkgs };
}

const n5 = (mil: number) => String(Math.round(mil * 100)); // 1/100000 inch
const fq = (s: string) => `"${s.replace(/"/g, "'")}"`;

export function writeFatf(b: SrcBoard): Uint8Array {
  const { nets, stacks, viaStack, pkgs } = fabJob(b);
  const L: string[] = ['; ????????  FATF OUTPUT FILE  BoardScope synthetic fixture (Glasgow, 0BSD)', '', ':FABMASTER FATF REV 11.2;', '', ':UNITS = 1/100000 INCH;', '', ':BOARD_DATA', '1,JOB("GLASGOW",,01-01-2026,01-01-2026);'];
  const ring = [...b.outline, b.outline[0]];
  L.push(`2,CONTOUR (${ring.map(([x, y]) => `(${n5(x)},${n5(y)},0)`).join(',')});`, ':EOD', '', ':NOTRACE;', '', ':PARTS');
  b.parts.forEach((p, i) => L.push(`${i + 1},${fq(p.name)},${fq(`${p.footprint || 'PART'}|${p.value}`)},${fq(pkgs[i].name)},${n5(p.x)},${n5(p.y)},${pkgs[i].rot10},${p.side === 'B' ? 'B' : 'T'};`));
  L.push(':EOD', '', ':NETS');
  const members = new Map<string, string[]>();
  b.parts.forEach((p, i) => p.pins.forEach((pin, j) => pin.net && (members.get(pin.net) ?? members.set(pin.net, []).get(pin.net)!).push(`(${i + 1},${j + 1})`)));
  for (const [n, id] of nets) {
    const m = members.get(n) ?? [];
    L.push(`${id},${fq(n)},S,`);
    for (let k = 0; k < m.length; k += 8) L.push(`  ${k ? ' ' : '('}${m.slice(k, k + 8).join(',')}${k + 8 >= m.length ? ');' : ','}`);
    if (!m.length) L.push('  ();');
  }
  L.push(':EOD', '', ':PACKAGES');
  pkgs.forEach((pk, i) => {
    L.push(`;PACKAGE ${pk.name}`, `${i + 1},${fq(pk.name)},0,0,0,0`);
    L.push(` (PINS ${pk.pins.map((q, j) => `(${j + 1},${fq(b.parts[i].pins[j].number || String(j + 1))},${n5(q.x)},${n5(q.y)},${b.parts[i].th ? 'D' : 'T'})`).join('')})`);
    L.push(` (${pk.pins.map((q, j) => `${j + 1},PAD (${q.stack} ((${n5(q.x)},${n5(q.y)})))`).join('\n ')});`);
  });
  L.push(':EOD', '', ':PAD_SYMBOLS');
  for (const [k, id] of stacks) {
    const [shape, w, h] = k.split(':');
    L.push(shape === 'round' ? `${id},P_ROUND (${n5(+w)});` : `${id},P_BLOCK (${n5(-w / 2)},${n5(-h / 2)},${n5(+w / 2)},${n5(+h / 2)});`);
  }
  L.push(':EOD', '', ':PAD_STACKS');
  for (const [k, id] of stacks) L.push(`${id},"S${id}",${n5(+k.split(':')[3])},${+k.split(':')[3] ? 'P' : 'B'},((1,${id}));`);
  L.push(':EOD', '', ':LAYER_NAMES', '1,"COPPER___TOP",TOP,2,ELECTRICAL;', '2,"COPPERBOTTOM",BOTTOM,1,ELECTRICAL;', '3,"ETCH!INT1",TRANSPARENT,0,ELECTRICAL;', ':EOD', '', ':LAYER_SETS', '1,"ALL",(1,3,2);', ':EOD', '', ':LAYERS');
  for (const t of b.traces) L.push(`${nets.get(t.net) ?? 0},LAYER (${t.layer === 'T' ? 1 : t.layer === 'B' ? 2 : 3} (TRACK(${n5(t.w)}(${n5(t.x1)},${n5(t.y1)})(${n5(t.x2)},${n5(t.y2)}))));`);
  L.push(':EOD', '', ':PADS');
  for (const v of b.vias) L.push(`${nets.get(v.net) ?? 0},${viaStack.get(v.d)},((${n5(v.x)},${n5(v.y)}));`);
  L.push(':EOD', '', ':TEST_POINTS');
  b.nails.forEach((n, i) => {
    const p = b.parts.findIndex((q) => q.name === `TP${n.probe}`);
    L.push(`${i + 1}(${n5(n.x)},${n5(n.y)})${n.side},${p + 1},1;`);
  });
  L.push(':EOD', '', ':EOF', '');
  return enc.encode(L.join(CRLF));
}

const m2 = (mil: number) => (Math.round(mil * 100) / 100).toString();

export function writeFarc(b: SrcBoard): Uint8Array {
  const { nets, stacks, viaStack, pkgs } = fabJob(b);
  const L: string[] = [':SECTION FABMASTER 1', '{           - FARC ASCII File - V8.F.2 -         }', ':EOSECTION', '', ':SECTION JOBDATA 1', '"GLASGOW (BoardScope synthetic fixture, 0BSD)"', ':EOSECTION', ''];
  const ring = [...b.outline, b.outline[0]];
  L.push(':SECTION FORMAT 1', `((TRACK 0.01[](${ring.map(([x, y]) => `(${x} ${y})`).join('')})))`, ':EOSECTION', '', ':SECTION PARTS 1', `${b.parts.length}(`);
  // FARC names a package by its 8.3 outline file: keep only the last 8 characters.
  const file83 = (n: string) => n.slice(-8);
  b.parts.forEach((p, i) => L.push(`(${i + 1}${fq(p.name)}(${fq(`${p.footprint || 'PART'}|${p.value}`)}0 31 0[]())(${fq(pkgs[i].name)} ${fq(file83(pkgs[i].name))}[]())${p.x} ${p.y} ${pkgs[i].rot10}[${p.side === 'B' ? 'BOTTOM' : ''}]0 0 0 0 0 0 0)`));
  L.push(')', ':EOSECTION', '', ':SECTION NETS 1', `${nets.size}(`);
  const members = new Map<string, string[]>();
  b.parts.forEach((p, i) => p.pins.forEach((pin, j) => pin.net && (members.get(pin.net) ?? members.set(pin.net, []).get(pin.net)!).push(`(${i + 1} ${j + 1})`)));
  for (const [n, id] of nets) L.push(`(${id} ${id}${fq(n)}${(members.get(n) ?? []).length}[](${(members.get(n) ?? []).join('')}))`);
  L.push(')', ':EOSECTION', '', ':SECTION LAYER_NAMES 1', '((1"COPPER___TOP"TOP 2 ELECTRICAL)(2"COPPERBOTTOM"BOTTOM 1 ELECTRICAL)(3"ETCH!INT1"', 'TRANSPARENT 0 ELECTRICAL))', ':EOSECTION', '', ':SECTION LAYER_SETS 1', '((1"ALL"(1 3 2)))', ':EOSECTION', '', ':SECTION PAD_SYMBOLS 1', '(');
  for (const [k, id] of stacks) {
    const [shape, w, h] = k.split(':');
    L.push(shape === 'round' ? `(${id} ROUND ${w})` : `(${id} BLOCK(${-w / 2} ${-h / 2} ${+w / 2} ${+h / 2}))`);
  }
  L.push(')', ':EOSECTION', '', ':SECTION PAD_STACKS 1', `(${[...stacks].map(([k, id]) => `(${id} ${k.split(':')[3]}((1 ${id})))`).join('')})`, ':EOSECTION', '', ':SECTION TEST_POINTS 1', `${b.nails.length}(`);
  b.nails.forEach((n, i) => L.push(`(${i + 1}(${n.x} ${n.y})${n.side} ${b.parts.findIndex((q) => q.name === `TP${n.probe}`) + 1} 1)`));
  L.push(')', ':EOSECTION', '', ':SECTION PACKAGE 1', '(');
  pkgs.forEach((pk, i) => {
    const side = b.parts[i].th ? 'VIA' : 'TOP';
    L.push(`(${fq(file83(pk.name) + '.OTL')}(0 0 0 0 0 0)(0 0 0 0)`);
    L.push(`(${pk.pins.map((q, j) => `(${j + 1} ${m2(q.x)} ${m2(q.y)}${fq(b.parts[i].pins[j].number || String(j + 1))}[${side}])`).join('')})`);
    L.push(`(${pk.pins.map((q, j) => `(${j + 1} ${q.stack} 1((${m2(q.x)} ${m2(q.y)}[NF]))${q.stack})`).join('\n')}`, ')', '())');
  });
  L.push(')', ':EOSECTION', '', ':SECTION PADS 1', '(');
  for (const v of b.vias) L.push(`(${nets.get(v.net) ?? 0} ${viaStack.get(v.d)} 0((${v.x} ${v.y}[NF]))${viaStack.get(v.d)})`);
  L.push(')', ':EOSECTION', '', ':SECTION LAYERS 1', '(');
  for (const t of b.traces) L.push(`(${nets.get(t.net) ?? 0} ${t.layer === 'T' ? 1 : t.layer === 'B' ? 2 : 3}((TRACK ${t.w}[NF]((${t.x1} ${t.y1})(${t.x2} ${t.y2})))))`);
  L.push(')', ':EOSECTION', '', ':SECTION EOARCHIVE 1', ':EOSECTION', '');
  return enc.encode(L.join(CRLF));
}

// ------------------------------------------------------------------ GenCAM (IPC-2511)

/** GenCAM 1.5 text: one pattern per component in its local frame; bottom components MIRROR. */
export function writeGencam(b: SrcBoard): Uint8Array {
  const G = (kind: string) => `"(${kind}).GLASGOW"`;
  const ref = (kind: string, name: string) => `${G(kind)}.${gq(name)}`;
  const L: string[] = ['$HEADER', '  GENCAM: "1.5";', '  GENERATEDBY: "BoardScope fixture writer","1";', '  UNITS: THOU;', '  ANGLEUNITS: DEGREES;', '  ATTRIBUTE: "/GRA3/","PROJECT_NAME","Glasgow ""revC"" (0BSD)",;', '  BOARD: "GLASGOW","GLASGOW","GLASGOW","1";', '$ENDHEADER', ''];
  const prim: string[] = [];
  const shapeIds = new Map<string, string>();
  const shape = (round: boolean, w: number, h: number) => {
    const k = round ? `C${w}` : `R${w}x${h}`;
    if (!shapeIds.has(k)) {
      const id = `PAD${shapeIds.size + 1}`;
      shapeIds.set(k, id);
      prim.push(round ? `    CIRCLEDEF: "${id}",${w};` : `    RECTCORNERDEF: "${id}",(${-w / 2},${-h / 2}),(${w / 2},${h / 2});`);
    }
    return shapeIds.get(k)!;
  };
  const stacks: string[] = [];
  const stackIds = new Map<string, string>();
  const holes = new Set<number>();
  const stack = (round: boolean, w: number, h: number, hole: number) => {
    const k = `${round}:${w}:${h}:${hole}`;
    if (!stackIds.has(k)) {
      const id = `S${stackIds.size + 1}`;
      stackIds.set(k, id);
      const p = shape(round, w, h);
      stacks.push(`    PADSTACK: "${id}";`, `      PAD: ${ref('layers', 'TOP')},${ref('primitives', p)},,,,,(0,0),0;`, `      PAD: ${ref('layers', 'BOTTOM')},${ref('primitives', p)},,,,,(0,0),0;`);
      if (hole) {
        holes.add(hole);
        stacks.push(`      HOLEREF: ${ref('padstacks', `HOLE_${hole}`)},(0,0),0;`);
      }
    }
    return stackIds.get(k)!;
  };
  const widths = new Set(b.traces.map((t) => t.w));
  const pats: string[] = [];
  const comps: string[] = [];
  const pinName = new Map<string, string>();
  b.parts.forEach((p) => {
    const mirror = p.side === 'B';
    const a = (-p.rot * Math.PI) / 180;
    const quarter = Math.abs(Math.round(p.rot / 90)) % 2 === 1;
    pats.push(`    PATTERNDEF: ${gq('PAT_' + p.name)},;`);
    const used = new Set<string>();
    p.pins.forEach((pin, j) => {
      // local = M · R(−θ) · (pin − origin)
      const dx = pin.x - p.x,
        dy = pin.y - p.y;
      let lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (mirror) lx = -lx;
      let name = pin.number || String(j + 1);
      while (used.has(name)) name += "'";
      used.add(name);
      pinName.set(`${p.name}\u0000${j}`, name);
      const [w, h] = quarter ? [pin.h, pin.w] : [pin.w, pin.h];
      pats.push(`      PADSTACKREF: ${ref('padstacks', stack(pin.shape === 'round', w, h, pin.hole))},${gq(name)},(${+lx.toFixed(4)},${+ly.toFixed(4)}),0;`);
    });
    comps.push(
      `    COMPONENT: ${gq(p.name)},${ref('layers', mirror ? 'COMPONENT BOTTOM' : 'COMPONENT TOP')},(${p.x},${p.y}),${p.rot}${mirror ? ',MIRROR' : ''};`,
      `      ATTRIBUTE: "/GRA3/","BOM_Description",${gq(p.value)},;`,
      `      DEVICEREF: ${ref('devices', 'DEV_' + p.name)},ASSEMBLED,;`,
      `      PATTERNREF: ${ref('patterns', 'PAT_' + p.name)},;`,
    );
  });
  const viaStack = new Map<number, string>();
  for (const v of b.vias) if (!viaStack.has(v.d)) viaStack.set(v.d, stack(true, v.d, v.d, Math.max(1, Math.round(v.d / 2))));
  for (const h of holes) prim.push(`    CIRCLEDEF: "H${h}",${h};`);
  for (const w of widths) prim.push(`    LINEDESC: "LD_${w}",${w},ROUND,,SOLID,,,NONE,BOTH,,,;`);
  L.push('$PRIMITIVES', `  GROUP: ${G('primitives')};`, ...prim, '$ENDPRIMITIVES', '');
  L.push('$LAYERS', `  GROUP: ${G('layers')};`);
  for (const [n, side, kind] of [
    ['TOP', 'TOP', 'CONDUCTOR'],
    ['BOTTOM', 'BOTTOM', 'CONDUCTOR'],
    ['INNER', 'INTERNAL', 'CONDUCTOR'],
    ['COMPONENT TOP', 'TOP', 'COMPONENT'],
    ['COMPONENT BOTTOM', 'BOTTOM', 'COMPONENT'],
    ['PROBE TOP', 'TOP', 'PROBE'],
    ['PROBE BOTTOM', 'BOTTOM', 'PROBE'],
    ['BOARD OUTLINE', 'ALL', 'BOARDOUTLINE'],
  ])
    L.push(`    LAYERSINGLE: "${n}",${side},${kind},,,,,;`);
  L.push('$ENDLAYERS', '', '$PADSTACKS', `  GROUP: ${G('padstacks')};`);
  for (const h of holes) L.push(`    HOLEDEF: "HOLE_${h}",ELECTRICAL,${ref('primitives', 'H' + h)},,,,;`);
  L.push(...stacks, '$ENDPADSTACKS', '', '$PATTERNS', `  GROUP: ${G('patterns')};`, ...pats, '$ENDPATTERNS', '', '$DEVICES', `  GROUP: ${G('devices')};`);
  for (const p of b.parts) L.push(`    DEVICE: ${gq('DEV_' + p.name)},OTHER,,;`, `      PART: "glasgow",${gq(p.footprint || p.value || 'PART')},;`);
  L.push('$ENDDEVICES', '', '$COMPONENTS', `  GROUP: ${G('components')};`, ...comps, '$ENDCOMPONENTS', '', '$ROUTES', `  GROUP: ${G('routes')};`);
  const members = new Map<string, string[]>();
  b.parts.forEach((p) => p.pins.forEach((pin, j) => pin.net && (members.get(pin.net) ?? members.set(pin.net, []).get(pin.net)!).push(`      COMPPIN: ${ref('components', p.name)},${gq(pinName.get(`${p.name}\u0000${j}`)!)},,;`)));
  let vi = 0;
  for (const net of b.nets) {
    L.push(`    ROUTE: ${gq(net)},SIGNAL;`, ...(members.get(net) ?? []));
    for (const v of b.vias) if (v.net === net) L.push(`      VIA: "VIA${++vi}",${ref('padstacks', viaStack.get(v.d)!)},,,(${v.x},${v.y}),0;`);
    for (const t of b.traces)
      if (t.net === net)
        L.push(`      PATH: ${ref('layers', t.layer === 'T' ? 'TOP' : t.layer === 'B' ? 'BOTTOM' : 'INNER')},${ref('primitives', 'LD_' + t.w)},;`, `        POLYLINE: ${ref('primitives', 'LD_' + t.w)};`, `          STARTAT: (${t.x1},${t.y1});`, `          LINETO: (${t.x2},${t.y2});`);
  }
  L.push('$ENDROUTES', '', '$TESTCONNECTS', `  GROUP: ${G('testconnects')};`);
  b.nails.forEach((n, i) => L.push(`    TESTPROBE: "F${i + 1}",ICT,90,0,0,${ref('layers', n.side === 'B' ? 'PROBE BOTTOM' : 'PROBE TOP')},CROWN,MATING,(${n.x},${n.y});`, `      COMPPINREF: ${ref('components', `TP${n.probe}`)},${gq(pinName.get(`TP${n.probe}\u00000`) ?? '1')};`));
  L.push('$ENDTESTCONNECTS', '', '$BOARDS', '  BOARD: "GLASGOW";', '    THICKNESS: 62,@NULL@;', `    OUTLINE: "GLASGOW",${ref('layers', 'BOARD OUTLINE')},;`, '      POLYLINE: ;');
  const ring = [...b.outline, b.outline[0]];
  ring.forEach(([x, y], i) => L.push(`        ${i ? 'LINETO' : 'STARTAT'}: (${x},${y});`));
  L.push('$ENDBOARDS', '');
  return enc.encode(L.join(CRLF));
}
const gq = (s: string) => `"${s.replace(/"/g, '""')}"`;
