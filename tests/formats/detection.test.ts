import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { makeSniff } from '../../src/formats/common';
import { CAE_KEY_PARITY, FZ_KEY_PARITY, parseKey44 } from '../../src/formats/fz';
import { detectAll } from '../../src/formats/registry';
import type { ManifestEntry } from '../../tools/gen-fixtures';
import { testKey44 } from '../../tools/fixtures/writers';
import { ROOT, file, parse, parseBytes } from '../helpers/load';

const manifest: ManifestEntry[] = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/manifest.json'), 'utf8'));
const S = 'fixtures/synthetic/';

describe('content-based detection', () => {
  for (const e of manifest) {
    test(`${e.id} is detected as ${e.format}`, () => {
      const f = file(e.files[0]);
      const c = detectAll(f, makeSniff(f));
      expect(c[0]?.format.id).toBe(e.format);
    });
  }

  test('extension is not trusted: a TVW renamed to .brd is still TVW', () => {
    const f = file(S + 'glasgow.tvw', 'board.brd');
    const out = parse([]); // placeholder to keep helper import used
    void out;
    const r = parseBytes('board.brd', f.bytes);
    expect(r.ok).toBe(true);
    expect(r.model!.source.formatId).toBe('tvw');
  });

  test('a GenCAD file with a .brd name and a Test_Link file with a .bv name', () => {
    expect(parseBytes('x.brd', file('fixtures/real/glasgow/glasgow-kicad10.cad').bytes).model!.source.formatId).toBe('gencad');
    expect(parseBytes('x.bv', file(S + 'glasgow-testlink.brd').bytes).model!.source.formatId).toBe('brd-testlink');
  });
});

describe('diagnostics for unsupported or broken input', () => {
  const msg = (r: ReturnType<typeof parseBytes>) => r.diagnostics.map((d) => d.message).join(' | ');

  test('random binary data is reported as unrecognised with a byte preview', () => {
    const b = new Uint8Array(4096).map((_, i) => (i * 2654435761) >>> 24);
    const r = parseBytes('mystery.brd', b);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe('unrecognized');
    expect(msg(r)).toMatch(/first bytes/);
    expect(msg(r)).toMatch(/Extensions alone do not identify/);
  });

  test('empty file', () => {
    const r = parseBytes('empty.tvw', new Uint8Array(0));
    expect(r.ok).toBe(false);
    expect(msg(r)).toMatch(/empty|header/i);
  });

  test.each([
    ['schematic.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31], /PDF/],
    ['x.rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], /RAR/],
    ['x.gz', [0x1f, 0x8b, 8, 0], /gzip/],
    ['x.png', [0x89, 0x50, 0x4e, 0x47], /image/],
  ])('%s gets a specific explanation', (name, head, re) => {
    const b = new Uint8Array(64);
    b.set(head);
    expect(msg(parseBytes(name, b))).toMatch(re);
  });

  test('binary Allegro database is recognised, its release named, and the KiCad route explained', () => {
    const b = new Uint8Array(1024);
    b.set([0x04, 0x15, 0x13, 0x00]); // header magic 0x00131504 -> Allegro 16.6
    b.set(new TextEncoder().encode('allv16-612/7/'), 0xf8);
    const r = parseBytes('mainboard.brd', b);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe('unsupported.allegro');
    expect(msg(r)).toMatch(/Allegro 16\.6/);
    expect(msg(r)).toMatch(/kicad-cli pcb import "mainboard\.brd" -o board\.kicad_pcb/);
  });

  test('a KiCad board without footprints opens (with a warning) instead of being rejected', () => {
    const r = parseBytes('board.kicad_pcb', new TextEncoder().encode('(kicad_pcb (version 20221018) (generator pcbnew)\n)'));
    expect(r.ok).toBe(true);
    expect(r.model!.source.formatId).toBe('kicad');
    expect(r.model!.diagnostics.some((d) => d.code === 'kicad.empty')).toBe(true);
  });

  test('legacy (pre-v5) KiCad boards get a conversion hint', () => {
    const r = parseBytes('old.brd', new TextEncoder().encode('PCBNEW-BOARD Version 1 date 2014\n$GENERAL\n'));
    expect(r.ok).toBe(false);
    expect(msg(r)).toMatch(/legacy KiCad board/);
  });

  test('encrypted FZ without a key asks for one', () => {
    const r = parse(S + 'glasgow-rc6-testkey.fz');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe('key-required');
  });

  test('encrypted FZ with a parity-invalid key', () => {
    const k = testKey44(FZ_KEY_PARITY, 1);
    k[0] ^= 1;
    const r = parse(S + 'glasgow-rc6-testkey.fz', { fzKey: k });
    expect(r.diagnostics[0].code).toBe('key-invalid');
  });

  test('encrypted FZ with a valid but wrong key', () => {
    const r = parse(S + 'glasgow-rc6-testkey.fz', { fzKey: testKey44(FZ_KEY_PARITY, 777) });
    expect(r.diagnostics[0].code).toBe('key-wrong');
  });

  test('CAE key is separate from the FZ key', () => {
    const m = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/manifest.json'), 'utf8')) as ManifestEntry[];
    const caeKey = parseKey44(m.find((e) => e.id === 'syn-cae-rc6')!.key!);
    expect(parse(S + 'glasgow-rc6-testkey.cae', { fzKey: caeKey }).ok).toBe(false);
    expect(parse(S + 'glasgow-rc6-testkey.cae', { caeKey }).ok).toBe(true);
    void CAE_KEY_PARITY;
  });

  test('XZZ without key asks for one', () => {
    const r = parse(S + 'glasgow-testkey.pcb');
    expect(r.diagnostics[0].code).toBe('key-required');
  });

  test('ASC: format.asc alone explains the multi-file set', () => {
    const r = parse(S + 'asc/format.asc');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0].code).toBe('asc.missing');
  });

  test('ASC: pins.asc alone loads with warnings about missing members', () => {
    const r = parse(S + 'asc/pins.asc');
    expect(r.ok).toBe(true);
    expect(r.model!.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(['asc.missing.format', 'asc.missing.nails']));
  });

  test('truncated TVW reports the failing structure and offset', () => {
    const b = file(S + 'glasgow.tvw').bytes;
    const r = parseBytes('cut.tvw', b.subarray(0, Math.floor(b.length * 0.4)));
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.level === 'error')!;
    expect(d.message).toMatch(/Teboview|TVW/);
    expect(d.message).toMatch(/offset 0x[0-9a-f]+/);
  });
});

describe('containers', () => {
  test('a ZIP with a boardview inside is opened transparently', () => {
    const inner = file(S + 'glasgow.bdv').bytes;
    const zip = zipSync({ 'docs/readme.txt': new TextEncoder().encode('hello'), 'board/glasgow.bdv': inner });
    const r = parseBytes('download.zip', zip);
    expect(r.ok).toBe(true);
    expect(r.model!.source.formatId).toBe('bdv');
    expect(r.model!.diagnostics.some((d) => d.code === 'zip')).toBe(true);
  });
  test('an ASC set inside a ZIP', () => {
    const zip = zipSync({
      'asc/FORMAT.ASC': file(S + 'asc/format.asc').bytes,
      'asc/PINS.ASC': file(S + 'asc/pins.asc').bytes,
      'asc/NAILS.ASC': file(S + 'asc/nails.asc').bytes,
    });
    const r = parseBytes('asc.zip', zip);
    expect(r.ok).toBe(true);
    expect(r.model!.diagnostics.some((d) => d.code.startsWith('asc.missing'))).toBe(false);
  });
});
