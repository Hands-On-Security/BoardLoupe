# Third-party notices

BoardScope is MIT-licensed (see `LICENSE`). The distributable `dist/boardview.html`
bundles the components below; their full licence texts are in `LICENSES/` and are
also embedded as a comment at the top of the built HTML file.

## Bundled into `dist/boardview.html`

| Component | Version | Licence | Used for |
|---|---|---|---|
| [Preact](https://github.com/preactjs/preact) | 10.29.8 | MIT | UI rendering |
| [lucide-preact](https://github.com/lucide-icons/lucide) | 1.53.0 | ISC | Inline SVG icons (only the icons used are bundled) |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | zlib/ZIP decompression (FZ/CAE containers, ZIP archives) |
| [libarchive.js](https://github.com/nika-begiashvili/libarchivejs) glue (`src/vendor/libarchive/`) | 2.0.2 | MIT | Emscripten wrapper that instantiates the libarchive WebAssembly |
| [libarchive](https://github.com/libarchive/libarchive) (compiled to WebAssembly) | 3.7.2 | BSD-2-Clause | RAR (`.rar`, clean-room RAR4/RAR5 readers, not UnRAR) and 7-Zip (`.7z`) extraction. Statically links zlib (zlib), bzip2 (BSD), liblzma/xz (0BSD), zstd (BSD), lz4 (BSD). See `src/vendor/libarchive/LICENSES.md`. |
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

No proprietary binaries were used or reverse-engineered for this project; no vendor
decryption keys are included. Test keys in `fixtures/manifest.json` are randomly
generated, parity-valid keys that only decrypt the synthetic test fixtures.

## Test-only material (not bundled)

| Material | Licence | Use |
|---|---|---|
| [kicad-boardview](https://github.com/whitequark/kicad-boardview) example files (Glasgow board `.brd`, `.bvr`, `.kicad_pcb`) | 0BSD | Real fixtures; source board for synthetic fixtures |
| KiCad 10.0.1 `kicad-cli` | GPL-3.0 (tool only) | Exported GenCAD from the 0BSD Glasgow design |
| OpenBoardView + utf8.h (Unlicense), mpc (BSD-2), ghc::filesystem (MIT) | various permissive | Compiled locally into `tools/obv-harness` to produce reference outputs (`fixtures/golden`); fetched by `tools/obv-harness/fetch.sh`, not committed |
| Playwright, Vitest, Vite, TypeScript, ESLint, tsx | Apache-2.0 / MIT | Build and test tooling |
