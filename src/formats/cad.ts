/**
 * "Panel" CAD boardview (.cad) with COMP / C_PIN / NET / N_VIA records.
 *
 * Reference: OpenBoardView CADFile.cpp (MIT). Several fields are unknown to
 * the reference; coordinates are inches (×1000 → mils in the reference).
 *
 *   COMP <type> <name> <nr> ? ? <x> <y> <side 1=top> ?
 *   C_PIN <type> <part[-pin]> <x> <y> ? ? ? ? <net>
 *   NET <type> <name>              (applies to following N_VIA lines)
 *   N_VIA <type> <x> <y> ? <side> ?
 */
import { ParseError } from '../io/bytes';
import { decodeText, splitLines, toNum } from '../io/text';
import { BoardBuilder } from '../model/builder';
import { MOUNT_SMD, PINKIND_TESTPOINT, SIDE_BOTTOM, SIDE_TOP } from '../model/types';
import { INCH } from './common';
import type { FormatModule } from './types';

const stripSlash = (n: string) => (n.includes('/') ? n.slice(1) : n);

export const cadPanelFormat: FormatModule = {
  id: 'cad-panel',
  name: 'CAD (COMP/C_PIN panel export)',
  extensions: ['cad'],
  status: 'partial',
  summary: 'Text CAD export with "###Panel Added" header and COMP/C_PIN/N_VIA records',
  detect(s) {
    if (s.headText.includes('###Panel Added') && s.headText.includes('C_PIN')) return { confidence: 0.93, reason: '"###Panel Added" header with C_PIN records' };
    return null;
  },
  parse(ctx) {
    const lines = splitLines(decodeText(ctx.file.bytes).text);
    const b = new BoardBuilder();
    b.units = INCH;
    const partByName = new Map<string, number>();
    let viaNet = '';
    let seen = 0;
    let missing = 0;
    const pinSeq = new Map<number, number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const t = line.split(/\s+/);
      const ln = i + 1;
      if (line.startsWith('COMP')) {
        seen++;
        const name = t[1] ?? '';
        const x = toNum(t[5]),
          y = toNum(t[6]);
        const side = t[7] === '1' ? SIDE_TOP : SIDE_BOTTOM;
        const idx = b.addPart({ name, side, mount: MOUNT_SMD, x: Number.isFinite(x) ? x : undefined, y: Number.isFinite(y) ? y : undefined });
        partByName.set(name, idx);
      } else if (line.startsWith('C_PIN')) {
        seen++;
        const ref = t[1] ?? '';
        const dash = ref.indexOf('-');
        const pname = dash >= 0 ? ref.slice(0, dash) : ref;
        const pinNo = dash >= 0 ? ref.slice(dash + 1) : '';
        const x = toNum(t[2]),
          y = toNum(t[3]);
        const net = stripSlash(t[8] ?? '');
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          b.warn('cad.pin', 'Malformed C_PIN line skipped', { line: ln });
          continue;
        }
        const p = partByName.get(pname);
        if (p === undefined) missing++;
        const k = (pinSeq.get(p ?? -1) ?? 0) + 1;
        pinSeq.set(p ?? -1, k);
        b.addPin({ part: p ?? -1, x, y, net, number: pinNo || String(k) });
      } else if (line.startsWith('NET ')) {
        seen++;
        viaNet = stripSlash(t[1] ?? '');
      } else if (line.startsWith('N_VIA')) {
        seen++;
        const x = toNum(t[1]),
          y = toNum(t[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          b.warn('cad.via', 'Malformed N_VIA line skipped', { line: ln });
          continue;
        }
        const side = toNum(t[4]) === 1 ? SIDE_TOP : SIDE_BOTTOM;
        b.addPin({ part: -1, x, y, net: viaNet, side, kind: PINKIND_TESTPOINT });
      }
    }
    if (!seen) throw new ParseError('cad.empty', 'No COMP/C_PIN records found');
    if (missing) b.warn('cad.unknownpart', `${missing} C_PIN record(s) reference an undefined COMP; shown as unowned`);
    return b.finish({ fileName: ctx.file.name, fileSize: ctx.file.bytes.length, formatId: this.id, formatName: this.name, variant: null, extraFiles: [] });
  },
};
