# Third-party notices

BoardLoupe is MIT-licensed (see `LICENSE`). The distributable `dist/boardloupe.html`
bundles the components below; their full licence texts are in `LICENSES/` and are
also embedded verbatim in a non-executable text block at the top of the built HTML file.

## Bundled into `dist/boardloupe.html`

| Component | Version | Licence | Used for |
|---|---|---|---|
| [Preact](https://github.com/preactjs/preact) | 10.29.8 | MIT | UI rendering |
| [lucide-preact](https://github.com/lucide-icons/lucide) | 1.53.0 | ISC | Inline SVG icons (only the icons used are bundled) |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | zlib/ZIP decompression (FZ/CAE containers, ZIP archives) |
| [libarchive.js](https://github.com/nika-begiashvili/libarchivejs) glue (`src/vendor/libarchive/`) | 2.0.2 | MIT | Emscripten wrapper that instantiates the libarchive WebAssembly |
| [libarchive](https://github.com/libarchive/libarchive) (compiled to WebAssembly) | 3.7.2 | BSD-style, including UC Regents code | RAR (`.rar`, libarchive's RAR4/RAR5 readers) and 7-Zip (`.7z`) extraction. See `src/vendor/libarchive/LICENSES.md`. |
| Archive decoder dependencies linked into the WebAssembly | OpenSSL 1.0.2s; liblzma from XZ Utils 5.2.11; zlib and bzip2 | OpenSSL/SSLeay; public domain; zlib; bzip2 | The [upstream build recipe](https://github.com/nika-begiashvili/libarchivejs/blob/v2.0.2/lib/tools/docker/Dockerfile) sources zlib 1.3 and bzip2 1.0.8, while the [link command](https://github.com/nika-begiashvili/libarchivejs/blob/v2.0.2/lib/tools/build.sh) also enables Emscripten's zlib and bzip2 ports. Their notices are in `LICENSES/` and embedded in the distributable. |
| [libarchive RAR5 test archive](https://github.com/libarchive/libarchive/blob/master/libarchive/test/test_read_format_rar5_compressed.rar.uu) | — | BSD-2-Clause | `fixtures/real/archives/rar5-compressed.rar`, decoded from the upstream uuencoded test fixture. |
| [flatbush](https://github.com/mourner/flatbush) | 4.6.2 | ISC | Static R-tree for hit testing and viewport culling |
| [flatqueue](https://github.com/mourner/flatqueue) | 3.1.0 | ISC | flatbush dependency |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 4.3.3 | MIT | Generated stylesheet (preflight + used utilities) |

## Format knowledge and ported parser logic

| Source | Licence | What was used |
|---|---|---|
| [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) `src/openboardview/FileFormats` (commit `cc76e69`) | MIT, © 2016 Chloridite and OpenBoardView contributors | Record layouts and semantics for BRD (Test_Link incl. obfuscation and Lenovo nail-net variant), BRD2/BRDOUT, BDV (cipher), ASC, BVR1, BVR3, FZ/CAE (RC6-CFB container, key parity), CAD panel, CST, XZZ (XOR/DES layout, key parity), GenCAD component transforms, Allegro signature. Re-implemented in TypeScript with bounds checking. |
| [eagleview](https://github.com/nitrocaster/eagleview) `TeboBoard.cpp/.hpp` | MIT, © 2019–2020 Pavel Kovalenko | Tebo-ICT View (TVW) structure: header cipher, logic/through layers, shapes, pads, lines, arcs, surfaces, drill tables, probe/fixture registries, parts, pins, decals. |
| OpenBoardView PR #366 (`TVWFile.cpp`, "MARCEBELE") | MIT | TVW → boardview mapping (pin handle / 8, route-layer outline with stray-segment filter) and the empty through-layer fix. |
| GenCAD 1.4 specification (Mitron/Cadence, public) | — | GenCAD grammar and units. |
| FIPS PUB 46-3 (DES) | public standard | `src/io/des.ts` written from the standard; verified with the FIPS worked example. |

The distributable contains no proprietary viewer binaries or vendor decryption keys.
Format behavior was also studied using locally analyzed reference software; that software
is not distributed with BoardLoupe. Test keys in `fixtures/manifest.json` are randomly
generated, parity-valid keys that only decrypt the synthetic test fixtures.

Archive decoder acknowledgments required by the OpenSSL 1.0.2s and original SSLeay licences:

> This product includes software developed by the OpenSSL Project for use in the OpenSSL Toolkit (http://www.openssl.org/).

> This product includes cryptographic software written by Eric Young (eay@cryptsoft.com).

## Test-only material (not bundled)

| Material | Licence | Use |
|---|---|---|
| [kicad-boardview](https://github.com/whitequark/kicad-boardview) example files (Glasgow board `.brd`, `.bvr`, `.kicad_pcb`) | 0BSD | Real fixtures; source board for synthetic fixtures |
| KiCad 10.0.1 `kicad-cli` | GPL-3.0 (tool only) | Exported GenCAD from the 0BSD Glasgow design |
| OpenBoardView + utf8.h (Unlicense), mpc (BSD-2), ghc::filesystem (MIT) | various permissive | Compiled locally into `tools/obv-harness` to produce reference outputs (`fixtures/golden`); fetched by `tools/obv-harness/fetch.sh`, not committed |
| Playwright, Vitest, Vite, TypeScript, ESLint, tsx | Apache-2.0 / MIT | Build and test tooling |
