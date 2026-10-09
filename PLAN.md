# BoardScope — Plan

Single-file, offline boardview viewer. Source is modular TypeScript; `npm run build`
emits exactly one `dist/boardview.html`.

## Architecture decisions (ADR summary)

| Decision | Choice | Why |
|---|---|---|
| UI framework | Preact 10 + hooks | React API at ~4 KB gzip; keeps the bundle small |
| Styling | Tailwind v4 + CSS variables | Fast iteration, tiny purged CSS, theme tokens via vars |
| Icons | lucide-preact (tree-shaken) | ISC, inline SVG, no font payload |
| Bundler | Vite 8, single chunk, custom inliner (`tools/postbuild.mjs`) | No vulnerable/extra plugins; deterministic; verifies zero external refs |
| Parsing | Web Worker from an inlined Blob URL, main-thread fallback | Keeps UI responsive; works from `file://` |
| Decompression | fflate (MIT) with output-size cap | Small, sync, bomb-safe |
| Spatial index | flatbush (ISC) packed Hilbert R-tree | Fast static index for hit tests and culling |
| Renderer | WebGL2 instanced (pads, segments) + Canvas2D overlay (labels, highlights); full Canvas2D fallback | 60 FPS at 50k+ pins; text stays crisp |
| Model | Struct-of-arrays typed arrays, versioned schema | Transferable, compact, fast |
| Detection | Content-based detectors with confidence; extension only as tie-break hint | Extensions are not specs |
| Verification | Real fixtures where redistributable + synthetic fixtures cross-checked against the OpenBoardView/eagleview C++ reference parsers (differential goldens) | Honest proof of correctness |

## Milestones

- [x] M0 Research: OBV parsers, eagleview TVW (via OBV PR #366), kicad-boardview real fixtures, KiCad CLI for GenCAD
- [x] M1 Scaffold + model + registry + vertical slice (real BRD2 → render → select → search → single-file build)
- [x] M2 Parsers: TVW, BRD (Test_Link plain/obfuscated/Lenovo), BRD2, BDV, ASC, BVR1, BVR3, FZ (zlib + keyed RC6), CAE, GenCAD, CAD panel, CST, XZZ (keyed DES), Allegro diagnostic, ZIP container
- [x] M3 Reference harness (OBV C++ compiled from source) + 17 golden differential tests + fixture generators + provenance
- [x] M4 UX: explorer (search/parts/nets/file), inspector, tables + CSV/JSON export, minimap, layers, history, shortcuts, themes, measure, keys dialog
- [x] M5 Performance: 1k–200k pins; worker parse; WebGL2 instanced; 60 FPS at 200k pins (Chromium/WebKit, GPU)
- [x] M6 E2E on file:// in Chromium, Firefox, WebKit; no-network assertion; drag-drop; Canvas2D fallback; screenshots
- [x] M7 Docs: README, FORMAT_MATRIX.md, THIRD_PARTY_NOTICES.md, LICENSES/, fixtures/PROVENANCE.md

## Next (not done)

- Altium ASCII and IPC-D-356 parsers (fixture for IPC-D-356 already present)
- TVW decal outlines and copper pours; BVR3 relative outlines
- Side-by-side comparison of two boards
- Real-world fixtures for TVW/FZ/BDV once redistributable samples exist

## Acceptance criteria

- `dist/boardview.html` opens via double-click, no network requests, no external refs (verified by build script + e2e).
- Every format claimed "verified" has a fixture + golden test; "partial/experimental" clearly labelled in UI and docs.
- Unsupported/corrupt/encrypted files produce a precise diagnostic (format guess, reason, offset/line where possible).
- Typecheck, lint, unit, format, e2e all pass (or exceptions documented).
