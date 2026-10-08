/**
 * "BRDOUT" / Toptest ASCII boardview (.brd), as written by Toptest, eagleview
 * and kicad-boardview.
 *
 * Reference: OpenBoardView FileFormats/BRD2File.cpp (MIT).
 *
 *   BRDOUT: nPoints maxX maxY      then nPoints "x y" outline vertices
 *   NETS: n                        "id name"
 *   PARTS: n                       "name x1 y1 x2 y2 firstPin side"   (side 1=top 2=bottom 0=both)
 *   PINS: n                        "x y netId side"
 *   NAILS: n                       "probe x y netId side"
 *
 * Bottom-side Y coordinates are stored mirrored (maxY - y) and are flipped
 * back here. Parts own the pins from their firstPin (0-based) up to the next
 * part's firstPin. A part none of whose pins lie on its own side is a
 * through-hole part visible from both sides.
 */
import { ParseError } from '../io/bytes';
import { decodeText, splitLines, Tokens } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, MOUNT_TH, PINKIND_TESTPOINT, SIDE_BOTH, SIDE_BOTTOM, SIDE_TOP, type Side } from '../model/types';
import { MIL } from './common';
import type { FormatModule } from './types';

function side012(v: number): Side {
  return v === 1 ? SIDE_TOP : v === 2 ? SIDE_BOTTOM : SIDE_BOTH;
}

export const brd2Format: FormatModule = {
  id: 'brd2-brdout',
  name: 'BoardView BRD2 (BRDOUT / Toptest)',
  extensions: ['brd', 'brd2'],
  status: 'verified',
  summary: 'ASCII "BRDOUT:/NETS:/PARTS:/PINS:/NAILS:" boardview (Toptest, KiCad exporter)',
  detect(s) {
    if (s.headText.includes('BRDOUT:') && s.headText.includes('NETS:')) return { confidence: 0.95, reason: 'Contains "BRDOUT:" and "NETS:" sections' };
    return null;
  },
  parse(ctx) {
    const { text } = decodeText(ctx.file.bytes);
    const lines = splitLines(text);
    const b = new BoardBuilder();
    b.units = MIL;

    let block = 0;
    let nFormat = 0,
      nNets = 0,
      nParts = 0,
      nPins = 0,
      nNails = 0;
    let maxX = 0,
      maxY = 0;
    const outline: number[] = [];
    const nets = new Map<number, string>();
    const parts: { name: string; x1: number; y1: number; x2: number; y2: number; first: number; side: Side; line: number }[] = [];
    const pins: { x: number; y: number; net: string; side: Side }[] = [];
    const nails: { probe: number; x: number; y: number; net: string; side: Side }[] = [];
    let missingNet = 0;
    let sawBrdout = false;

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li].trim();
      if (!raw) continue;
      const line = li + 1;
      const head = /^(BRDOUT|NETS|PARTS|PINS|NAILS):/.exec(raw);
      if (head) {
        const t = new Tokens(raw.slice(head[0].length));
        switch (head[1]) {
          case 'BRDOUT':
            block = 1;
            sawBrdout = true;
            nFormat = t.int();
            maxX = t.num();
            maxY = t.num();
            if (!Number.isFinite(maxY)) throw new ParseError('brd2.header', 'Malformed BRDOUT header (expected count, max X, max Y)', { line });
            break;
          case 'NETS':
            block = 2;
            nNets = t.int();
            break;
          case 'PARTS':
            block = 3;
            nParts = t.int();
            break;
          case 'PINS':
            block = 4;
            nPins = t.int();
            break;
          case 'NAILS':
            block = 5;
            nNails = t.int();
            break;
        }
        continue;
      }
      const t = new Tokens(raw);
      switch (block) {
        case 1: {
          const x = t.num(),
            y = t.num();
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            b.warn('brd2.format', 'Malformed outline vertex skipped', { line });
            break;
          }
          if (x > maxX || y > maxY) b.warn('brd2.outsidemax', 'Outline vertex lies outside the declared BRDOUT maximum', { line });
          outline.push(x, y);
          break;
        }
        case 2: {
          const id = t.int();
          const name = t.str();
          if (!Number.isFinite(id)) {
            b.warn('brd2.net', 'Malformed net line skipped', { line });
            break;
          }
          if (nets.has(id)) b.warn('brd2.netdup', `Duplicate net id ${id}; the later name wins`, { line });
          nets.set(id, name);
          break;
        }
        case 3: {
          const name = t.str();
          const x1 = t.num(),
            y1 = t.num(),
            x2 = t.num(),
            y2 = t.num(),
            first = t.int(),
            side = t.int();
          if (![x1, y1, x2, y2, first].every(Number.isFinite)) {
            b.warn('brd2.part', 'Malformed part line skipped', { line });
            break;
          }
          parts.push({ name, x1, y1, x2, y2, first, side: side012(side), line });
          break;
        }
        case 4: {
          const x = t.num(),
            y = t.num(),
            netId = t.int(),
            side = t.int();
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            b.warn('brd2.pin', 'Malformed pin line skipped', { line });
            break;
          }
          const net = nets.get(netId);
          if (net === undefined && netId !== 0) missingNet++;
          pins.push({ x, y, net: net ?? '', side: side012(side) });
          break;
        }
        case 5: {
          const probe = t.int(),
            x = t.num(),
            y = t.num(),
            netId = t.int(),
            side = t.int();
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            b.warn('brd2.nail', 'Malformed nail line skipped', { line });
            break;
          }
          const net = nets.get(netId);
          if (net === undefined) missingNet++;
          nails.push({ probe, x, y, net: net ?? '', side: side === 1 ? SIDE_TOP : SIDE_BOTTOM });
          break;
        }
      }
    }
    if (!sawBrdout) throw new ParseError('brd2.noheader', 'Missing BRDOUT header');
    if (missingNet) b.warn('brd2.missingnet', `${missingNet} pin/nail(s) reference undefined net ids; shown without a net`);

    const chk = (want: number, got: number, what: string) => {
      if (Number.isFinite(want) && want !== got) b.warn(`brd2.count.${what}`, `Header declares ${want} ${what}, file contains ${got}`);
    };
    chk(nFormat, outline.length / 2, 'outline points');
    chk(nNets, nets.size, 'nets');
    chk(nParts, parts.length, 'parts');
    chk(nPins, pins.length, 'pins');
    chk(nNails, nails.length, 'nails');

    // Un-mirror bottom-side coordinates.
    for (const p of pins) if (p.side !== SIDE_TOP) p.y = maxY - p.y;
    for (const n of nails) if (n.side !== SIDE_TOP) n.y = maxY - n.y;

    let cpi = 0;
    let badOrder = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const y1 = p.side === SIDE_BOTTOM ? maxY - p.y1 : p.y1;
      const y2 = p.side === SIDE_BOTTOM ? maxY - p.y2 : p.y2;
      const pei = i === parts.length - 1 ? pins.length : Math.min(pins.length, parts[i + 1].first);
      if (p.first !== cpi && p.first < pins.length) badOrder++;
      let sameSide = false;
      const from = cpi;
      while (cpi < pei) {
        const s = pins[cpi].side;
        if ((s === SIDE_TOP && p.side === SIDE_TOP) || (s === SIDE_BOTTOM && p.side === SIDE_BOTTOM)) sameSide = true;
        cpi++;
      }
      const isTH = !sameSide;
      const idx = b.addPart({
        name: p.name,
        side: isTH ? SIDE_BOTH : p.side,
        mount: isTH ? MOUNT_TH : MOUNT_SMD,
        bbox: [p.x1, y1, p.x2, y2],
      });
      for (let j = from; j < cpi; j++) {
        const pin = pins[j];
        b.addPin({ part: idx, x: pin.x, y: pin.y, net: pin.net, side: pin.side, number: String(j - from + 1) });
      }
    }
    if (badOrder) b.warn('brd2.firstpin', `${badOrder} part(s) have a first-pin index that does not follow the previous part`);
    for (; cpi < pins.length; cpi++) {
      const pin = pins[cpi];
      b.addPin({ part: -1, x: pin.x, y: pin.y, net: pin.net, side: pin.side });
    }
    for (const n of nails) {
      b.addPin({ part: -1, x: n.x, y: n.y, net: n.net, side: n.side, kind: PINKIND_TESTPOINT, number: String(n.probe), probe: n.probe });
    }
    b.addOutlinePolyline(outline, false);
    b.metadata.push(['Pin numbers', 'Positional (order within part; the format has no pin names)']);
    return b.finish({
      fileName: ctx.file.name,
      fileSize: ctx.file.bytes.length,
      formatId: this.id,
      formatName: this.name,
      variant: null,
      extraFiles: [],
    });
  },
};
