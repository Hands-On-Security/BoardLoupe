/**
 * Regenerates the synthetic fixtures (fixtures/synthetic) and the manifest.
 *   npm run fixtures
 * Then `npm run goldens` (needs a C++ toolchain) refreshes the reference
 * parser outputs in fixtures/golden.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAE_KEY_PARITY, FZ_KEY_PARITY } from '../src/formats/fz';
import { loadSource } from './fixtures/source';
import { XZZ_TEST_KEY, testKey44, writeAscSet, writeBdv, writeBrdTestLink, writeBv, writeBvr1, writeCadPanel, writeCst, writeF2b, writeFarc, writeFatf, writeFz, writeGencam, writeTvw, writeXzz } from './fixtures/writers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = (p: string, data: Uint8Array) => {
  const f = resolve(root, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, data);
};

export interface ManifestEntry {
  id: string;
  files: string[];
  format: string; // BoardScope format id
  obv: string | null; // reference harness format name (null: no reference available)
  key?: string; // test key for encrypted fixtures
  origin: 'real' | 'synthetic';
  provenance: string;
  license: string;
}

const SRC = 'Derived from the Glasgow board (whitequark/Glasgow via kicad-boardview example, 0BSD) exported by KiCad 10.0.1 to GenCAD; written by tools/fixtures/writers.ts following the reference parser.';
const fzKey = testKey44(FZ_KEY_PARITY, 0xb0a2d5c0);
const caeKey = testKey44(CAE_KEY_PARITY, 0x5c09e000);
const hexKey = (k: number[]) => k.map((w) => w.toString(16).padStart(8, '0')).join(' ');

const b = loadSource(root);
const S = 'fixtures/synthetic/';
out(S + 'glasgow-testlink.brd', writeBrdTestLink(b));
out(S + 'glasgow-testlink-obfuscated.brd', writeBrdTestLink(b, { obfuscate: true }));
out(S + 'glasgow-testlink-lenovo.brd', writeBrdTestLink(b, { lenovoNets: true }));
out(S + 'glasgow.bdv', writeBdv(b));
for (const [n, d] of Object.entries(writeAscSet(b))) out(S + 'asc/' + n, d);
out(S + 'glasgow-format1.bvr', writeBvr1(b));
out(S + 'glasgow-zlib.fz', writeFz(b));
out(S + 'glasgow-rc6-testkey.fz', writeFz(b, fzKey));
out(S + 'glasgow-rc6-testkey.cae', writeFz(b, caeKey));
out(S + 'glasgow-panel.cad', writeCadPanel(b));
out(S + 'glasgow.cst', writeCst(b));
out(S + 'glasgow-testkey.pcb', writeXzz(b));
out(S + 'glasgow.tvw', writeTvw(b));
out(S + 'glasgow.fatf', writeFatf(b));
out(S + 'glasgow.far', writeFarc(b));
out(S + 'glasgow.a3p', writeGencam(b));
out(S + 'glasgow.f2b', writeF2b(b));
out(S + 'glasgow.bv', writeBv(b));

const R = 'fixtures/real/glasgow/';
const REAL_PROV = 'Glasgow interface explorer board; file shipped in whitequark/kicad-boardview (commit da24793, 0BSD), produced by its pcbnew exporter.';
const KICAD_PROV = 'Exported with `kicad-cli pcb export gencad` (KiCad 10.0.1) from fixtures/real/glasgow/glasgow.kicad_pcb (kicad-boardview example, 0BSD).';
const manifest: ManifestEntry[] = [
  { id: 'real-brd2-kicad-boardview', files: [R + 'glasgow-kicad-boardview.brd'], format: 'brd2-brdout', obv: 'brd2', origin: 'real', provenance: REAL_PROV, license: '0BSD' },
  { id: 'real-bvr3-kicad-boardview', files: [R + 'glasgow-kicad-boardview.bvr'], format: 'bvr3', obv: 'bvr3', origin: 'real', provenance: REAL_PROV, license: '0BSD' },
  { id: 'real-gencad-kicad10', files: [R + 'glasgow-kicad10.cad'], format: 'gencad', obv: 'gencad', origin: 'real', provenance: KICAD_PROV, license: '0BSD' },
  {
    id: 'real-gencad-kicad10-flipped',
    files: [R + 'glasgow-kicad10-flipped.cad'],
    format: 'gencad',
    obv: 'gencad',
    origin: 'real',
    provenance: KICAD_PROV.replace('gencad`', 'gencad --flip-bottom-pads --unique-pins`'),
    license: '0BSD',
  },
  { id: 'syn-testlink', files: [S + 'glasgow-testlink.brd'], format: 'brd-testlink', obv: 'brd', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-testlink-obfuscated', files: [S + 'glasgow-testlink-obfuscated.brd'], format: 'brd-testlink', obv: 'brd', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-testlink-lenovo', files: [S + 'glasgow-testlink-lenovo.brd'], format: 'brd-testlink', obv: 'brd', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-bdv', files: [S + 'glasgow.bdv'], format: 'bdv', obv: 'bdv', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-asc', files: [S + 'asc/pins.asc', S + 'asc/format.asc', S + 'asc/nails.asc'], format: 'asc', obv: 'asc', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-bvr1', files: [S + 'glasgow-format1.bvr'], format: 'bvr1', obv: 'bvr', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-fz-zlib', files: [S + 'glasgow-zlib.fz'], format: 'fz', obv: 'fz', key: hexKey(fzKey), origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-fz-rc6', files: [S + 'glasgow-rc6-testkey.fz'], format: 'fz', obv: 'fz', key: hexKey(fzKey), origin: 'synthetic', provenance: SRC + ' Encrypted with a generated TEST key (not a vendor key).', license: '0BSD' },
  { id: 'syn-cae-rc6', files: [S + 'glasgow-rc6-testkey.cae'], format: 'cae', obv: 'cae', key: hexKey(caeKey), origin: 'synthetic', provenance: SRC + ' Encrypted with a generated TEST key (not a vendor key).', license: '0BSD' },
  { id: 'syn-cad-panel', files: [S + 'glasgow-panel.cad'], format: 'cad-panel', obv: 'cad', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-cst', files: [S + 'glasgow.cst'], format: 'cst', obv: 'cst', origin: 'synthetic', provenance: SRC, license: '0BSD' },
  { id: 'syn-xzz', files: [S + 'glasgow-testkey.pcb'], format: 'xzz', obv: 'xzz', key: XZZ_TEST_KEY, origin: 'synthetic', provenance: SRC + ' Component records DES-encrypted with a generated TEST key.', license: '0BSD' },
  { id: 'syn-fatf', files: [S + 'glasgow.fatf'], format: 'fabmaster', obv: null, origin: 'synthetic', provenance: SRC.replace('following the reference parser', 'following the Fabmaster FATF grammar of real jobs'), license: '0BSD' },
  { id: 'syn-farc', files: [S + 'glasgow.far'], format: 'fabmaster', obv: null, origin: 'synthetic', provenance: SRC.replace('following the reference parser', 'following the Fabmaster FARC grammar of real jobs'), license: '0BSD' },
  { id: 'syn-gencam', files: [S + 'glasgow.a3p'], format: 'gencam', obv: null, origin: 'synthetic', provenance: SRC.replace('following the reference parser', 'following IPC-2511 GenCAM 1.5 as written by real test-engineering exports'), license: '0BSD' },
  { id: 'syn-f2b', files: [S + 'glasgow.f2b'], format: 'f2b', obv: null, origin: 'synthetic', provenance: SRC.replace('following the reference parser', 'following the Unisoft F2B archive layout of real files (MFC objects, pin labels in the net dictionary)'), license: '0BSD' },
  { id: 'syn-bv', files: [S + 'glasgow.bv'], format: 'bv', obv: null, origin: 'synthetic', provenance: SRC.replace('following the reference parser', 'as a Jet 4 (Access) database with the Pin/Nail/Layout tables of real BV files'), license: '0BSD' },
  { id: 'syn-tvw', files: [S + 'glasgow.tvw'], format: 'tvw', obv: 'tvw', origin: 'synthetic', provenance: SRC + ' Includes copper traces, vias, route-layer outline, probe/fixture registries and an empty through-layer.', license: '0BSD' },
];
writeFileSync(resolve(root, 'fixtures/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length} manifest entries`);
