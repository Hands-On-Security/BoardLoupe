/**
 * "Test_Link" ASCII boardview (.brd / .bv), optionally byte-obfuscated.
 *
 * Reference: OpenBoardView FileFormats/BRDFile.cpp (MIT).
 *
 *   str_length: …          (ignored)
 *   var_data: nFormat nParts nPins nNails
 *   Format:                outline vertices "x y"
 *   Parts: | Pins1:        "name typeLayer endOfPins"
 *   Pins:  | Pins2:        "x y probe part(1-based) net"
 *   Nails:                 "probe x y side(1=top) net"
 *
 * Obfuscated files start with 23 E2 63 28 ("str_" encoded); each byte except
 * CR/LF/NUL is decoded as ~rotl8(b, 2).
 */
import { ParseError, startsWithBytes } from '../io/bytes';
import { decodeText, splitLines, Tokens } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, MOUNT_TH, PINKIND_TESTPOINT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type Side } from '../model/types';
import { MIL } from './common';
import type { FormatModule } from './types';

const ENCODED_HEADER = [0x23, 0xe2, 0x63, 0x28];

export function decodeBrdBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 13 || b === 10 || b === 0) out[i] = b;
    else out[i] = ~(((b << 2) & 0xff) | (b >> 6)) & 0xff;
  }
  return out;
}

/** Test_Link "type and layer" field → side (OBV semantics). */
export function brdSideFromTypeLayer(t: number): Side {
  if (t === 1 || (t >= 4 && t < 8)) return SIDE_TOP;
  if (t === 2 || t >= 8) return SIDE_BOTTOM;
  return SIDE_BOTH;
}

export const brdFormat: FormatModule = {
  id: 'brd-testlink',
  name: 'BoardView BRD (Test_Link)',
  extensions: ['brd', 'bv'],
  status: 'verified',
  summary: 'ASCII "str_length/var_data" boardview, plain or byte-obfuscated',
  detect(s) {
    if (startsWithBytes(s.head, ENCODED_HEADER)) return { confidence: 0.97, variant: 'obfuscated', reason: 'Obfuscated Test_Link header (23 E2 63 28)' };
    if (s.headText.includes('str_length:') && s.headText.includes('var_data:'))
      return { confidence: 0.95, variant: 'plain', reason: 'Contains "str_length:" and "var_data:" sections' };
    return null;
  },
  parse(ctx) {
    let bytes = ctx.file.bytes;
    const encoded = startsWithBytes(bytes, ENCODED_HEADER);
    if (encoded) bytes = decodeBrdBytes(bytes);
    const { text } = decodeText(bytes);
    const lines = splitLines(text);
    const b = new BoardBuilder();
    b.units = MIL;

    let block = 0;
    let nFormat = -1,
      nParts = -1,
      nPins = -1,
      nNails = -1;
    const outline: number[] = [];
    const parts: number[] = [];
    let pinsSeen = 0;
    const nails: { probe: number; x: number; y: number; side: Side; net: string; line: number }[] = [];
    const pins: { x: number; y: number; probe: number; part: number; net: string; line: number }[] = [];
    let sawHeader = false;

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li].trim();
      if (!raw) continue;
      const line = li + 1;
      switch (raw) {
        case 'str_length:':
          block = 1;
          sawHeader = true;
          continue;
        case 'var_data:':
          block = 2;
          sawHeader = true;
          continue;
        case 'Format:':
        case 'format:':
          block = 3;
          continue;
        case 'Parts:':
        case 'Pins1:':
          block = 4;
          continue;
        case 'Pins:':
        case 'Pins2:':
          block = 5;
          continue;
        case 'Nails:':
          block = 6;
          continue;
      }
      const t = new Tokens(raw);
      switch (block) {
        case 2: {
          nFormat = t.int();
          nParts = t.int();
          nPins = t.int();
          nNails = t.int();
          if ([nFormat, nParts, nPins, nNails].some((v) => !(v >= 0))) {
            b.warn('brd.vardata', `Malformed var_data counts: "${raw}"`, { line });
          }
          break;
        }
        case 3: {
          const x = t.num(),
            y = t.num();
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            b.warn('brd.format', 'Malformed outline vertex line skipped', { line });
            break;
          }
          outline.push(x, y);
          break;
        }
        case 4: {
          const name = t.str();
          const tl = t.int();
          t.int(); // end_of_pins: redundant, pins carry their own part reference
          if (!Number.isFinite(tl)) {
            b.warn('brd.part', 'Malformed part line (bad type/layer) — treated as both sides', { line });
          }
          const side = brdSideFromTypeLayer(Number.isFinite(tl) ? tl : 0);
          parts.push(
            b.addPart({
              name,
              side,
              mount: Number.isFinite(tl) ? (tl & 0xc ? MOUNT_SMD : MOUNT_TH) : undefined,
            }),
          );
          break;
        }
        case 5: {
          const x = t.num(),
            y = t.num(),
            probe = t.int(),
            part = t.int();
          const net = t.left ? t.str() : '';
          if (![x, y, part].every(Number.isFinite)) {
            b.warn('brd.pin', 'Malformed pin line skipped', { line });
            break;
          }
          pins.push({ x, y, probe, part, net, line });
          pinsSeen++;
          break;
        }
        case 6: {
          const probe = t.int(),
            x = t.num(),
            y = t.num(),
            side = t.int();
          const net = t.left ? t.str() : '';
          if (![x, y].every(Number.isFinite)) {
            b.warn('brd.nail', 'Malformed nail line skipped', { line });
            break;
          }
          nails.push({ probe, x, y, side: side === 1 ? SIDE_TOP : SIDE_BOTTOM, net, line });
          break;
        }
      }
    }
    if (!sawHeader && block === 0) throw new ParseError('brd.empty', 'No Test_Link sections found');

    // Lenovo variant: pins without a net name take the net of the nail with the same probe number.
    const nailNet = new Map<number, string>();
    for (const n of nails) nailNet.set(n.probe, n.net);
    let fromNail = 0;
    const seqInPart = new Map<number, number>();
    for (const p of pins) {
      let net = p.net;
      if (net === '' && nailNet.has(p.probe)) {
        net = nailNet.get(p.probe)!;
        fromNail++;
      }
      const partIdx = p.part - 1;
      if (partIdx < 0 || partIdx >= parts.length) {
        b.warn('brd.pinpart', `Pin references part ${p.part}, but only ${parts.length} parts are defined`, { line: p.line });
      }
      const k = (seqInPart.get(partIdx) ?? 0) + 1;
      seqInPart.set(partIdx, k);
      b.addPin({
        part: partIdx >= 0 && partIdx < parts.length ? parts[partIdx] : -1,
        x: p.x,
        y: p.y,
        net,
        number: String(k),
        probe: Number.isFinite(p.probe) ? p.probe : undefined,
      });
    }
    if (fromNail) b.info('brd.lenovo', `${fromNail} pin net name(s) resolved through nail probe numbers (Lenovo variant).`);
    for (const n of nails) {
      b.addPin({ part: -1, x: n.x, y: n.y, net: n.net, side: n.side, kind: PINKIND_TESTPOINT, number: String(n.probe), probe: n.probe });
    }
    b.addOutlinePolyline(outline, false);

    const chk = (want: number, got: number, what: string) => {
      if (want >= 0 && want !== got) b.warn(`brd.count.${what}`, `var_data declares ${want} ${what}, file contains ${got}`);
    };
    chk(nFormat, outline.length / 2, 'outline points');
    chk(nParts, parts.length, 'parts');
    chk(nPins, pinsSeen, 'pins');
    chk(nNails, nails.length, 'nails');
    b.metadata.push(['Pin numbers', 'Positional (order within part; the format has no pin names)']);
    if (encoded) b.metadata.push(['Encoding', 'Obfuscated Test_Link (decoded)']);

    if (parts.length === 0 && pinsSeen === 0) throw new ParseError('brd.nodata', 'The file has Test_Link headers but no parts or pins');
    return b.finish({
      fileName: ctx.file.name,
      fileSize: ctx.file.bytes.length,
      formatId: this.id,
      formatName: this.name,
      variant: encoded ? 'obfuscated' : 'plain',
      extraFiles: [],
    });
  },
};

