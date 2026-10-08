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

- [x] M0 Research: OBV parsers, eagleview TVW, kicad-boardview fixtures, KiCad CLI available
- [ ] M1 Scaffold + model + registry + vertical slice (BRD2 real fixture → render → select → search → build)
- [ ] M2 Parsers: TVW, BRD(Test_Link, enc), BRD2, BDV, ASC, BVR1, BVR3, FZ(zlib + keyed RC6), GenCAD, CAD, CST, XZZ(keyed), Allegro diagnostic
- [ ] M3 Reference harness (OBV C++) + golden JSON + fixture generators + provenance manifest
- [ ] M4 UX: sidebar explorer, inspector, tables/export, minimap, layers, history, shortcuts, themes, measure
- [ ] M5 Performance: synthetic 1k/10k/50k/100k pins; bench parse/index/search/frame
- [ ] M6 E2E on file:// in Chromium, Firefox, WebKit; offline/no-network assertions; screenshots
- [ ] M7 Docs: README, FORMAT_MATRIX.md, THIRD_PARTY_NOTICES.md, fixtures provenance, final report

## Acceptance criteria

- `dist/boardview.html` opens via double-click, no network requests, no external refs (verified by build script + e2e).
- Every format claimed "verified" has a fixture + golden test; "partial/experimental" clearly labelled in UI and docs.
- Unsupported/corrupt/encrypted files produce a precise diagnostic (format guess, reason, offset/line where possible).
- Typecheck, lint, unit, format, e2e all pass (or exceptions documented).
