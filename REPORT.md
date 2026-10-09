# BoardScope — release report (2026-10-09)

**Deliverable:** `dist/boardview.html`: one self-contained file, 383 KB (122 KB gzip),
zero external references. The build verifies this and fails otherwise. Build it with
`npm ci && npm run build`.

## Formats: what is actually verified

Verified = BoardScope output equals the compiled original reference parser
(OpenBoardView `cc76e69`, eagleview TVW reader from OBV PR #366) on the fixture, plus
integrity, fuzz and browser tests. See FORMAT_MATRIX.md for details.

| Format | Status | Fixture origin |
|---|---|---|
| TVW (Tebo-ICT View, standard header) | verified | synthetic, built from a real board and accepted by the reference reader; also checked locally on a real Lenovo X1 Carbon Gen9 board (arc slots and decal bodies fixed, see FORMAT_MATRIX.md) |
| BRD Test_Link (plain / obfuscated / Lenovo) | verified | synthetic, reference-validated |
| BRD2 / BRDOUT | verified | **real** (kicad-boardview, Glasgow) |
| BDV | verified | synthetic, reference-validated |
| BVR1 (BVRAW_FORMAT_1) | verified | synthetic, reference-validated |
| BVR3 (BVRAW_FORMAT_3) | verified | **real** (kicad-boardview, Glasgow) |
| FZ unencrypted; FZ RC6 with user key | verified | synthetic (generated test key) |
| GenCAD 1.4 | verified | **real** (two KiCad 10 exports) |
| ASC multi-file set | partial | synthetic, reference-validated |
| CAE (needs key) | partial | synthetic (test key) |
| CAD "###Panel Added" | partial | synthetic, reference-validated |
| CST | experimental | synthetic, reference-validated |
| XZZ (components need DES key) | experimental | synthetic (test key) |
| Allegro `.brd` database, PDF/RAR/7z/OLE/KiCad source | recognised with an explanation, not parsed | unit tests |

Not supported: Altium ASCII, IPC-D-356 (fixture present), `.bvr2`, TVW variants without
the standard header, FlexBV-only formats. No vendor decryption keys are included.

## Tests (all passing)

- Vitest: **143 tests** (plus opt-in checks on private boards via `BS_PRIVATE_FIXTURES`). Unit (camera transforms, I/O, ciphers incl. the DES FIPS vector, builder,
  search, export), 17 differential golden tests against the reference parsers, a cross-exporter
  geometry check (≤1.1 mil on 1,130+ pins, 0 net mismatches), 37 detection/diagnostic tests, and 18
  fuzz suites (truncation, flips, splices, extreme counts, random input) covering every fixture.
- Playwright on the built file via `file://`: **56 tests** across Chromium 156, Firefox 157 and
  WebKit 27.2. They cover the empty state, zero network requests (also with the browser set offline),
  real-board load in the worker, search → inspector, pin picking (top and mirrored bottom), history,
  sides/mirror/rotate/zoom/pan/fit, tables + CSV/JSON export, errors, the key-required message,
  every verified format, the multi-file ASC set, drag-and-drop, the Canvas 2D fallback, theme
  persistence (only `boardscope.prefs.v1` in localStorage), and laptop layout with no overflow.
  The 15 app tests also pass in the installed **Google Chrome 154** stable.
- Typecheck (TypeScript 6.0 strict) and ESLint (no eval/Function/innerHTML): clean.

## Browser compatibility

| Browser | Result |
|---|---|
| Chromium 156 (Playwright), Google Chrome 154 (installed) | all tests pass |
| Firefox 157 (Playwright) | all tests pass |
| WebKit 27.2 (Playwright; Safari's engine) | all tests pass |
| Safari.app, Microsoft Edge | **not run**. Safari automation needs "Allow Remote Automation" enabled by the user; Edge is not installed. Edge shares Chromium's engine; Safari shares WebKit's. |

## Performance (Apple M3 Pro)

- Node: 200k pins parse in 238 ms, index in 77–95 ms, search query 4.7 ms on average.
- Chromium (Metal) and WebKit (Apple GPU), 2× DPR: load of 200k pins in 371 ms (Chromium) and 379 ms (WebKit).
  Continuous pan/zoom stays at **60 FPS** (avg frame 16.7 ms = vsync, p95 ≤ 19 ms) for 10k–200k pins.
  CPU per frame is 1–2 ms.
- Firefox: 200k-pin load 406 ms; p95 frame interval ≤ 17 ms.

## Remaining gaps

- No redistributable real-world TVW, FZ, BDV, ASC, Test_Link, CAD, CST or XZZ files. These formats are
  verified only against reference-validated synthetic files built from a real board.
- Encrypted FZ, CAE and XZZ need user keys. XZZ part sides are not decoded (same as upstream).
- Not drawn: TVW copper pours, BVR3 relative outlines, GenCAD artwork.
- No side-by-side comparison mode. Recent files are kept per session only.
