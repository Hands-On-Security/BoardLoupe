/**
 * XZZ PCB (.pcb) boardview.
 *
 * Reference: OpenBoardView XZZPCBFile.cpp (MIT). The file is XOR-masked with
 * the byte at 0x10 up to the "v6v6555v6v6" marker; component records are
 * additionally DES-encrypted with a key that is not distributed with this
 * viewer (users may enter one under Settings). Copper lines/arcs, vias,
 * outline geometry, test pads and the net table are readable without the key.
 */
import { ByteReader, ParseError, indexOfAscii, latin1 } from '../io/bytes';
import { desEcb } from '../io/des';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, PINKIND_TESTPOINT, SIDE_TOP } from '../model/types';
import type { FormatModule } from './types';

const SCALE = 10000;
const XZZ_PARITY = [1, 1, 1, 1, 1, 1, 1, 0];

export function parseXzzKey(text: string | null | undefined): [number, number] | null {
  if (!text) return null;
  const h = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{16}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 8), 16) >>> 0, parseInt(h.slice(8), 16) >>> 0];
}

export function xzzKeyParityOk(hi: number, lo: number): boolean {
  for (let i = 0; i < 8; i++) {
    let t = (i < 4 ? lo >>> (8 * i) : hi >>> (8 * (i - 4))) & 0xff;
    t ^= t >> 4;
    t ^= t >> 2;
    t ^= t >> 1;
    if ((~t & 1) !== XZZ_PARITY[i]) return false;
  }
  return true;
}

function isXzz(b: Uint8Array): boolean {
  if (b.length < 6) return false;
  if (latin1(b.subarray(0, 6)) === 'XZZPCB') return true;
  if (b.length > 0x10 && b[0x10] !== 0) {
    const k = b[0x10];
    let s = '';
    for (let i = 0; i < 6; i++) s += String.fromCharCode(b[i] ^ k);
    return s === 'XZZPCB';
  }
  return false;
}

/** Flatten a counter-clockwise arc without changing a wraparound sweep. */
function arcSegments(out: number[], cx: number, cy: number, r: number, a0: number, a1: number) {
  while (a1 <= a0) a1 += 360;
  const n = Math.max(2, Math.min(360, Math.ceil((a1 - a0) / 10)));
  const d2r = Math.PI / 180;
  const s0 = a0 * d2r,
    step = ((a1 - a0) * d2r) / (n - 1);
  let px = cx + r * Math.cos(s0),
    py = cy + r * Math.sin(s0);
  for (let i = 1; i < n; i++) {
    const a = s0 + i * step;
    const x = cx + r * Math.cos(a),
      y = cy + r * Math.sin(a);
    out.push(px, py, x, y);
    px = x;
    py = y;
  }
}

export const xzzFormat: FormatModule = {
  id: 'xzz',
  name: 'XZZ PCB',
  extensions: ['pcb'],
  status: 'partial',
  summary: 'XZZ binary (XOR + DES): components, copper layers, vias and outline; components need a user-supplied key',
  detect(_s, f) {
    if (isXzz(f.bytes)) return { confidence: 0.95, reason: '"XZZPCB" signature (possibly XOR-masked)' };
    return null;
  },
  parse(ctx) {
    const buf = new Uint8Array(ctx.file.bytes);
    const marker = indexOfAscii(buf, 'v6v6555v6v6');
    if (buf.length < 0x30) throw new ParseError('xzz.short', 'File too short');
    if (buf[0x10] !== 0) {
      const k = buf[0x10];
      const end = marker >= 0 ? marker : buf.length;
      for (let i = 0; i < end; i++) buf[i] ^= k;
    }
    const r = new ByteReader(buf);
    r.seek(0x20);
    const mainStart = r.u32('main data offset') + 0x20;
    r.seek(0x28);
    const netStart = r.u32('net data offset') + 0x20;
    r.seek(mainStart);
    const mainSize = r.u32('main block size');
    r.seek(netStart);
    const netSize = r.u32('net block size');
    r.need(netSize, 'net block');

    const nets = new Map<number, string>();
    const nr = new ByteReader(buf, netStart + 4, netStart + 4 + netSize);
    while (nr.remaining > 0) {
      const size = nr.u32('net record size');
      const idx = nr.u32('net index');
      if (size < 8) throw new ParseError('xzz.net', `Invalid net record size ${size}`, { offset: nr.pos - 8 });
      nets.set(idx, latin1(nr.bytesN(size - 8, 'net name')));
    }

    const key = ctx.options.xzzKey ? parseXzzKey(ctx.options.xzzKey) : null;
    if (ctx.options.xzzKey && !key) throw new ParseError('key-invalid', 'The configured XZZ key is not 16 hexadecimal digits.');
    if (key && !xzzKeyParityOk(key[0], key[1])) throw new ParseError('key-invalid', 'The configured XZZ key fails its parity check.');

    const b = new BoardBuilder();
    b.units = { unit: 'mil', toMm: 0.0254, assumed: true, note: 'Raw units / 10000, treated as mils like the reference viewer' };
    const pins: { part: number; x: number; y: number; net: string; number: string; kind?: 0 | 1 }[] = [];
    const segs: number[] = [];
    let encryptedParts = 0;
    b.layers = Array.from({ length: 16 }, (_, id) => ({ id, name: id === 0 ? 'Top' : id === 15 ? 'Bottom' : `Inner ${id}`, kind: (id === 0 ? 'top' : id === 15 ? 'bottom' : 'inner') as 'top' | 'bottom' | 'inner' }));

    const br = new ByteReader(buf, mainStart + 4, Math.min(buf.length, mainStart + 4 + mainSize));
    if (mainStart + 4 + mainSize > buf.length) b.warn('xzz.mainsize', 'Main data block extends beyond end of file; truncated');
    const netName = (i: number) => {
      const n = nets.get(i) ?? '';
      return n === 'NC' || n === 'UNCONNECTED' ? '' : n;
    };
    while (br.remaining > 5) {
      const type = br.u8('block type');
      const size = br.u32('block size');
      const blk = br.bytesN(size, 'block');
      const d = new ByteReader(blk);
      if (type === 0x01 && size >= 24) {
        const layer = d.u32(),
          x = d.s32(),
          y = d.s32(),
          rad = d.s32(),
          a0 = d.s32(),
          a1 = d.s32();
        const width = size >= 28 ? d.u32() / SCALE : 0;
        const net = size >= 32 ? netName(d.u32()) : '';
        if (layer === 28 || (layer >= 1 && layer <= 16)) {
          const arc: number[] = [];
          arcSegments(arc, x / SCALE, y / SCALE, rad / SCALE, a0 / SCALE, a1 / SCALE);
          if (layer === 28) segs.push(...arc);
          else for (let j = 0; j < arc.length; j += 4) b.addTrace(arc[j], arc[j + 1], arc[j + 2], arc[j + 3], width, layer - 1, net);
        }
      } else if (type === 0x02 && size >= 28) {
        const x = d.s32() / SCALE, y = d.s32() / SCALE;
        const diameter = d.u32() / SCALE;
        d.skip(4, 'drill diameter');
        const layerFrom = d.u32(), layerTo = d.u32(), net = netName(d.u32());
        if (layerFrom >= 1 && layerFrom <= 16 && layerTo >= layerFrom && layerTo <= 16) b.addVia(x, y, diameter, net);
      } else if (type === 0x05 && size >= 28) {
        const layer = d.u32(),
          x1 = d.s32(),
          y1 = d.s32(),
          x2 = d.s32(),
          y2 = d.s32(),
          width = d.u32() / SCALE,
          net = netName(d.u32());
        if (layer === 28) segs.push(x1 / SCALE, y1 / SCALE, x2 / SCALE, y2 / SCALE);
        else if (layer >= 1 && layer <= 16) b.addTrace(x1 / SCALE, y1 / SCALE, x2 / SCALE, y2 / SCALE, width, layer - 1, net);
      } else if (type === 0x07) {
        if (!key) {
          encryptedParts++;
          continue;
        }
        const pb = desEcb(blk, key[0], key[1], true);
        const p = new ByteReader(pb);
        const partSize = p.u32('part size');
        p.skip(18, 'part header');
        const groupLen = p.u32('group name length');
        p.skip(groupLen, 'group name');
        if (p.u8('first sub-block') !== 0x06) throw new ParseError('xzz.part', 'Decrypted component record has an unexpected layout (wrong key?)', { offset: br.pos - size });
        p.skip(30, 'label block');
        const nameLen = p.u32('part name length');
        const name = latin1(p.bytesN(nameLen, 'part name'));
        const part = b.addPart({ name, side: SIDE_TOP, mount: MOUNT_SMD });
        const end = Math.min(pb.length, partSize + 4);
        while (p.pos < end) {
          const st = p.u8('sub-block type');
          if (st === 0x01 || st === 0x05 || st === 0x06) {
            p.skip(p.u32('sub-block size'), 'sub-block');
          } else if (st === 0x09) {
            const blockSize = p.u32('pin block size');
            const pinEnd = p.pos + blockSize;
            p.skip(4);
            const x = p.s32() / SCALE,
              y = p.s32() / SCALE;
            p.skip(8);
            const pnLen = p.u32('pin name length');
            const pname = latin1(p.bytesN(pnLen, 'pin name'));
            p.skip(32);
            const netIdx = p.u32('pin net');
            p.seek(Math.min(pinEnd, p.end));
            pins.push({ part, x, y, net: netName(netIdx), number: pname });
          }
        }
      } else if (type === 0x09) {
        d.skip(4);
        const x = d.s32() / SCALE,
          y = d.s32() / SCALE;
        d.skip(8);
        const nl = d.u32('pad name length');
        const name = latin1(d.bytesN(nl, 'pad name'));
        d.seek(blk.length - 4);
        const netIdx = d.u32('pad net');
        pins.push({ part: -1, x, y, net: netName(netIdx), number: name, kind: PINKIND_TESTPOINT });
      }
    }
    if (encryptedParts) {
      throw new ParseError(
        'key-required',
        `This XZZ file stores its ${encryptedParts} component records DES-encrypted. The format is understood, but a decryption key (not distributed with this viewer) is required. ` +
          `If you are entitled to one, enter it under Settings → Decryption keys.`,
      );
    }
    // Translate so the outline's minimum corner is the origin (reference behaviour).
    let tx = 0,
      ty = 0;
    if (segs.length) {
      tx = Infinity;
      ty = Infinity;
      for (let i = 0; i < segs.length; i += 2) {
        tx = Math.min(tx, segs[i]);
        ty = Math.min(ty, segs[i + 1]);
      }
    }
    for (let i = 0; i < segs.length; i += 4) b.addOutlineSeg(segs[i] - tx, segs[i + 1] - ty, segs[i + 2] - tx, segs[i + 3] - ty);
    for (const p of pins) b.addPin({ part: p.part, x: p.x - tx, y: p.y - ty, net: p.net, number: p.number, kind: p.kind, side: SIDE_TOP });
    b.caps.sides = false;
    b.metadata.push(['Sides', 'Not decoded for XZZ (all parts shown on top)']);
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: buf[0x10] ? 'xor-masked' : 'plain', extraFiles: [] });
  },
};
