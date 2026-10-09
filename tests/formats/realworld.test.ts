/**
 * Regression tests for dialects and file mixes found in a real repair corpus
 * (vendor files that cannot be redistributed; these are small hand-made
 * stand-ins with the same layout):
 *  - VayoPro-Test Expert ASC exports (as read by TSICT): short headers that
 *    fixed-count skipping (OpenBoardView) misreads, a non-numeric nail type
 *    column, uppercase file names, parts.asc with rotation and footprint.
 *  - Repair folders full of BIOS / EC dumps and viewer programs, and macOS
 *    ZIPs with __MACOSX metadata and ZIPs nested in ZIPs.
 */
import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { firmwareKind } from '../../src/formats/registry';
import type { InputFile } from '../../src/formats/types';
import { PINKIND_TESTPOINT, SIDE_BOTTOM, SIDE_TOP } from '../../src/model/types';
import { validateModel } from '../../src/model/validate';
import { DEFAULT_OPTIONS, parseFiles } from '../../src/formats/registry';
import { file, parseBytes } from '../helpers/load';

const crlf = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n') + '\r\n');
const JOB = 'JOBNAME: example.vayo              Export from VayoPro-Test Expert';

const VAYO = {
  'Format.asc': crlf([JOB, '2015/05/16 9:37:53                                         INCH units', '', '', '', '', '  X             Y             R           ', '  -1.0000       -1.0000       0.0000      ', '  -1.0000       2.0000        0.0000      ', '  3.0000        2.0000        0.0000      ', '  3.0000        -1.0000       0.0000      ', '  -1.0000       -1.0000       0.0000      ', '', '']),
  'PINS.asc': crlf([
    JOB,
    ' 2015/05/16 9:37:52                                        INCH units',
    '',
    '',
    '',
    '',
    '',
    'Pin       Name      X         Y         Layer     Net                             Nail(s)             ',
    'Part      C1      (B)',
    '1         1         0.5000    0.5000    2         VCC                               1,2',
    '2         2         0.5000    0.4000    2         GND                               3',
    'Part      U1      (T)',
    '1         1         1.0000    1.0000    1         VCC                               1',
    '2         2         1.1000    1.0000    1         SPI_CLK                           ',
  ]),
  'Nails.asc': crlf([
    JOB,
    'Total Nails QTY: 3',
    '2015/05/16 9:37:50                                         INCH units',
    '',
    '',
    'Nail    X          Y          Type   Grid    T/B    Net      Net Name                        TP/VTPVirtual Pin/Via      ',
    '$1      0.5000     0.5000     FPT    A1      (T)    #1       VCC                                  PIN C1.1  ',
    '$2      0.6000     0.5000     FPT    A1      (B)    #1       VCC                              TP  PIN TP1.1',
    '$3      0.5000     0.4000     FPT    A1      (B)    #2       GND                                  PIN C1.2  ',
  ]),
  'PARTS.asc': crlf([
    JOB,
    'Total Parts QTY: 2                  Selected Parts: 2',
    '2015/05/16 9:37:53                                         INCH units',
    '',
    '',
    "Part            X          Y          Rot         Grid    T/B    'Device'                                                    'Outline'",
    "C1              0.5000     0.4500     90.0000     A1      (B)    'CAP_0402'                                                  ,'CAP_0402'",
    "U1              1.0500     1.0000     45.0000     A1      (T)    '?'                                                         ,'QFN16_3X3'",
  ]),
  'NETS.asc': crlf([JOB, 'Net Listing      2  Nets       2015-5-16    9:37:51', '', '', '#1     (S)     VCC', 'C1.1', 'U1.1', '#2     (S)     GND', 'C1.2']),
  'tsict.inf': crlf(['TRUE', 'FALSE', 'TRUE', 'TRUE']),
};
const vayoFiles = (names = Object.keys(VAYO)): InputFile[] => names.map((n) => ({ name: n, bytes: VAYO[n as keyof typeof VAYO] }));

describe('ASC: VayoPro-Test Expert export (TSICT)', () => {
  const out = parseFiles(vayoFiles(), DEFAULT_OPTIONS);
  const m = out.model!;

  test('the whole set opens with every part, pin, nail and the closed outline', () => {
    expect(out.ok).toBe(true);
    expect(validateModel(m)).toEqual([]);
    expect(m.parts.name).toEqual(['C1', 'U1']); // the first part follows the header directly
    const nails = Array.from({ length: m.pins.count }, (_, i) => i).filter((i) => m.pins.kind[i] === PINKIND_TESTPOINT);
    expect(nails.length).toBe(3);
    expect(m.pins.count - nails.length).toBe(4);
    expect(m.outline.source).toBe('file');
    expect(m.outline.segs.length / 4).toBe(4); // all five corners kept
    expect(m.diagnostics.filter((d) => d.level === 'warning')).toEqual([]);
  });

  test('nails keep their side and net name despite the non-numeric type column', () => {
    const nail = (n: string) => Array.from({ length: m.pins.count }, (_, i) => i).find((i) => m.pins.kind[i] === PINKIND_TESTPOINT && m.pins.number[i] === n)!;
    expect(m.pins.side[nail('1')]).toBe(SIDE_TOP);
    expect(m.pins.side[nail('2')]).toBe(SIDE_BOTTOM);
    expect(m.nets.name[m.pins.net[nail('3')]]).toBe('GND');
    expect([...m.nets.name].sort()).toEqual(['GND', 'SPI_CLK', 'VCC']); // no "#1"-style ids
  });

  test('parts.asc adds rotation, placement and footprint', () => {
    expect(m.parts.rot[1]).toBe(45);
    expect(m.parts.footprint[1]).toBe('QFN16_3X3');
    expect(m.parts.footprint[0]).toBe('CAP_0402');
    expect(m.parts.attrs[0]).toBeNull(); // Device equals Outline: nothing extra
    expect(m.parts.attrs[1]).toBeNull(); // Device "?" is ignored
    expect(m.parts.x[0]).toBeCloseTo(0.5, 9);
  });

  test('announced counts are checked against what was read', () => {
    const bad = vayoFiles().map((f) => (f.name === 'Nails.asc' ? { ...f, bytes: VAYO['Nails.asc'].subarray(0, VAYO['Nails.asc'].length - 70) } : f));
    const r = parseFiles(bad, DEFAULT_OPTIONS);
    expect(r.model!.diagnostics.find((d) => d.code === 'asc.count.nails')?.message).toMatch(/announces 3 nails but 2/);
  });

  test('a single member of the set explains that all files are needed', () => {
    for (const n of ['Format.asc', 'PARTS.asc', 'NETS.asc', 'Nails.asc']) {
      const r = parseFiles(vayoFiles([n]), DEFAULT_OPTIONS);
      expect(r.ok, n).toBe(false);
      expect(r.diagnostics[0].code).toBe('asc.missing');
      expect(r.diagnostics[0].message).toContain(`Only ${n} was provided`);
    }
  });

  test('the set inside a macOS ZIP (with __MACOSX metadata) opens', () => {
    const entries: Record<string, Uint8Array> = {};
    for (const [n, b] of Object.entries(VAYO)) {
      entries[`board/${n}`] = b;
      entries[`__MACOSX/board/._${n}`] = new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]);
    }
    entries['board/.DS_Store'] = new Uint8Array(64);
    const r = parseBytes('board.zip', zipSync(entries));
    expect(r.ok).toBe(true);
    expect(r.model!.parts.count).toBe(2);
  });
});

describe('firmware, programs and archives in repair folders', () => {
  const descriptor = new Uint8Array(4096).fill(0xff);
  descriptor.set([0x5a, 0xa5, 0xf0, 0x0f], 0x10);
  const ec = new Uint8Array(1024);
  ec.set([0x5f, 0x45, 0x43, 0x01]);
  const exe = new Uint8Array(512);
  exe.set([0x4d, 0x5a, 0x90, 0x00]);
  const flash = new Uint8Array(65536).fill(0xff);
  flash.set([1, 2, 3, 4], 4092);

  test('BIOS, EC firmware, programs and flash dumps are named', () => {
    expect(firmwareKind(descriptor)).toMatch(/BIOS \/ SPI flash image/);
    expect(firmwareKind(ec)).toMatch(/embedded-controller/);
    expect(firmwareKind(exe)).toMatch(/Windows program/);
    expect(firmwareKind(flash)).toMatch(/flash \/ EEPROM/);
    expect(firmwareKind(file('fixtures/synthetic/glasgow.tvw').bytes)).toBeNull();
    const r = parseBytes('x270.bin', descriptor);
    expect(r.diagnostics[0].message).toMatch(/BIOS \/ SPI flash image.*not a boardview/);
  });

  test('a ZIP without a boardview lists what it holds, grouped and de-duplicated', () => {
    const inner = zipSync({ 'rt/MSVBVM50.DLL': exe, 'rt/readme.txt': new TextEncoder().encode('runtime') });
    const zip = zipSync({ 'TSICT/TSICT.exe': exe, 'TSICT/MSVBVM50.DLL': exe, 'TSICT/readme.txt': new TextEncoder().encode('readme'), 'TSICT/msvbvm50.zip': inner, '__MACOSX/TSICT/._TSICT.exe': new Uint8Array(8) });
    const r = parseBytes('TSICT ASUS.zip', zip);
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.level === 'error')!;
    expect(d.code).toBe('zip.noboard');
    expect(d.message).toContain('TSICT ASUS.zip contains no boardview');
    expect(d.message).toMatch(/Windows program or library: (TSICT\.exe, MSVBVM50\.DLL|MSVBVM50\.DLL, TSICT\.exe);/);
    expect(d.message.match(/MSVBVM50\.DLL/g)!.length).toBe(1);
    expect(d.message).not.toContain('._');
  });

  test('a boardview in a ZIP inside a ZIP is found', () => {
    const inner = zipSync({ 'glasgow.bdv': file('fixtures/synthetic/glasgow.bdv').bytes });
    const r = parseBytes('pack.zip', zipSync({ 'notes.txt': new TextEncoder().encode('x'), 'boards/glasgow.zip': inner }));
    expect(r.ok).toBe(true);
    expect(r.model!.source.formatId).toBe('bdv');
  });
});

describe('dropping a whole board folder', () => {
  const pdf = (name: string): InputFile => ({ name, bytes: new TextEncoder().encode('%PDF-1.6\n%âãÏÓ\n1 0 obj\n') });
  const bios = new Uint8Array(4096).fill(0xff);
  bios.set([0x5a, 0xa5, 0xf0, 0x0f], 0x10);
  const allegro = new Uint8Array(1024);
  allegro.set([0x04, 0x15, 0x13, 0x00]);
  allegro.set(new TextEncoder().encode('allv16-6'), 0xf8);

  test('without a boardview: one summary of everything, PDF boardview drawings named as such', () => {
    const r = parseFiles([pdf('NM-A531 schematic.pdf'), pdf('X260 NM-A531R10-SILK-BOT-BV.pdf'), { name: 'x260.BIN', bytes: bios }], DEFAULT_OPTIONS);
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.level === 'error')!;
    expect(d.code).toBe('noboard');
    expect(d.message).toContain('None of the 3 files contains a boardview');
    expect(d.message).toContain('boardview drawing as PDF (not boardview data): X260 NM-A531R10-SILK-BOT-BV.pdf');
    expect(d.message).toContain('BIOS / SPI flash image: x260.BIN');
    expect(d.message).not.toContain('ZIP archive');
  });

  test('an Allegro database next to a readable boardview does not block it', () => {
    const r = parseFiles([{ name: 'board.brd', bytes: allegro }, ...vayoFiles()], DEFAULT_OPTIONS);
    expect(r.ok).toBe(true);
    expect(r.model!.source.formatId).toBe('asc');
  });

  test('an Allegro database with only documents reports the Allegro conversion route', () => {
    const r = parseFiles([pdf('schematic.pdf'), { name: 'board.brd', bytes: allegro }], DEFAULT_OPTIONS);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((x) => x.level === 'error')!.code).toBe('unsupported.allegro');
  });

  test('a single PDF named like a boardview is explained as a drawing', () => {
    const r = parseFiles([pdf('BoardView PDF.pdf')], DEFAULT_OPTIONS);
    expect(r.diagnostics[0].message).toMatch(/boardview drawing saved as PDF/);
  });
});
