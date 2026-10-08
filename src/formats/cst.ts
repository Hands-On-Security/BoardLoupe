/**
 * CST boardview (.cst): binary MFC CArchive serialisation.
 *
 * Reference: OpenBoardView CSTFile.cpp (MIT). The reference itself documents
 * several fields as unknown; this port reproduces its record layout with
 * strict bounds checks. Coordinates are 16-bit integers in unknown units
 * (treated as mils like the reference). No outline is stored.
 */
import { ByteReader, ParseError, indexOfAscii } from '../io/bytes';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type Side } from '../model/types';
import type { FormatModule } from './types';

function cstr(b: Uint8Array): string {
  const z = b.indexOf(0);
  const s = z >= 0 ? b.subarray(0, z) : b;
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s[i]);
  return out;
}

export const cstFormat: FormatModule = {
  id: 'cst',
  name: 'CST (binary CArchive)',
  extensions: ['cst'],
  status: 'experimental',
  summary: 'Binary MFC archive with CPad records; partially understood',
  detect(s, f) {
    if (s.ext !== 'cst') return null;
    const cpad = indexOfAscii(f.bytes, 'CPad', 0, Math.min(f.bytes.length, 8 << 20));
    if (cpad > 8) return { confidence: 0.7, reason: '.cst file containing a CPad class record' };
    return { confidence: 0.3, reason: '.cst extension only' };
  },
  parse(ctx) {
    const bytes = ctx.file.bytes;
    const r = new ByteReader(bytes);
    const b = new BoardBuilder();
    b.units = { unit: 'mil', toMm: 0.0254, assumed: true, note: 'Unknown; 16-bit integer coordinates treated as mils' };
    const nParts = r.s16('part count');
    if (nParts < 0 || nParts > 100000) throw new ParseError('cst.parts', `Implausible part count ${nParts}`);
    r.skip(4, 'section signature');
    const nameLen = r.s16('section name length');
    if (nameLen < 0 || nameLen > 64) throw new ParseError('cst.section', `Implausible section name length ${nameLen}`, { offset: r.pos });
    r.skip(nameLen, 'section name');
    const partIdx: number[] = [];
    const partSide: Side[] = [];
    for (let i = 0; i < nParts; i++) {
      const len = r.u8('part name length');
      const name = cstr(r.bytesN(len, 'part name'));
      r.skip(4, 'part data');
      const layer = r.s8('part layer');
      const side: Side = layer === 0x0c ? SIDE_TOP : layer === 0x01 ? SIDE_BOTTOM : SIDE_BOTH;
      partIdx.push(b.addPart({ name, side, mount: MOUNT_SMD }));
      partSide.push(side);
      r.skip(6, 'part trailer');
    }
    r.seek(r.pos - 2);
    const nNets = r.s16('net count');
    if (nNets < 0) throw new ParseError('cst.nets', `Negative net count ${nNets}`, { offset: r.pos - 2 });
    const nets: string[] = [];
    for (let i = 0; i < nNets; i++) {
      const len = r.u8('net name length');
      nets.push(cstr(r.bytesN(len, 'net name')));
    }
    const cpad = indexOfAscii(bytes, 'CPad', r.pos);
    if (cpad < 0) throw new ParseError('cst.nocpad', 'CPad section not found', { offset: r.pos });
    r.seek(cpad - 8);
    const nPins = r.s16('pin count');
    if (nPins < 0) throw new ParseError('cst.pins', `Negative pin count ${nPins}`, { offset: cpad - 8 });
    r.skip(10, 'CPad header');
    let badNet = 0;
    for (let i = 0; i < nPins; i++) {
      const partId = r.s16('pin part');
      const probe = r.s16('pin probe');
      const netId = r.s16('pin net');
      const x = r.s16('pin x');
      const y = r.s16('pin y');
      r.s16('pin shape');
      r.skip(4, 'pin trailer');
      const part = partId >= 0 && partId < partIdx.length ? partIdx[partId] : -1;
      let net = '';
      if (netId >= 0 && netId < nets.length) net = nets[netId];
      else badNet++;
      b.addPin({ part, x, y, net, side: part >= 0 ? partSide[partId] : SIDE_BOTH, probe });
    }
    if (badNet) b.warn('cst.badnet', `${badNet} pin(s) reference an out-of-range net index`);
    b.warn('cst.experimental', 'CST support is experimental: several record fields are not understood and units are assumed.');
    return b.finish({ fileName: ctx.file.name, fileSize: bytes.length, formatId: this.id, formatName: this.name, variant: null, extraFiles: [] });
  },
};
