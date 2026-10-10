# BoardScope — release report (2026-10-10)

**Deliverable:** `dist/boardview.html`: one self-contained file, ~620 KB (~216 KB gzip),
zero external references. The build verifies this and fails otherwise. Build it with
`npm ci && npm run build`.

BoardScope is published as a **Hands-On Security** tool (back-link `hos.direct/boardscope`),
built for the hardware-security classroom.

## Selection, bus tracing and solder points

- **Beacons.** A highlighted net, pin or component is drawn as a haloed pad with a minimum
  on-screen size, so it stays visible when the pad itself is sub-pixel on a zoomed-out board
  (WebGL2 adds a dedicated on-top emphasis pass; the Canvas 2D fallback does the same). This
  replaces the earlier thin-blue highlight that disappeared when zoomed out.
- **Multi-net bus colouring.** Selecting several nets (Shift-click) gives each a distinct
  high-contrast colour, so an SPI / LPC / eSPI bus can be followed across the board.
- **Solder / probe point finder.** The net and pin inspectors rank every point on a net by how
  practical it is to tap a wire onto — test points first, then through-holes, connectors and large
  pads, with fine-pitch IC pads last — each with its side, click-to-jump. (`src/model/solder.ts`.)
- **Side-consistent highlights.** Beacons follow the other-side setting exactly like the pads beneath
  them (ghosted or hidden), so a selected net never shows through a hidden side; an eye toggle / `G`
  shows only the current side.
- **Highlight groups.** `A` adds the selection to a persistent group whose nets stay lit in their own
  colours (with an on-board legend); groups can be saved by name in this browser and re-applied by
  net/part name.
- **Report (PDF).** `Ctrl/⌘+P` builds an A4-portrait report (header/footer, logos, file and board
  details, the current view at print resolution, highlighted nets with colours, parts and solder points,
  notes) for *Print → Save as PDF* or as a self-contained HTML download; plus PNG export with a legend.
  The report has no scripts, embeds only `data:` images and escapes all file-derived text (tested).

## New formats from the research corpus (2026-10-10)

Every format reader below is original code written from the corpus's format notes and checked on
its real samples (which cannot be redistributed); CI uses synthetic fixtures of the real Glasgow
board in each format (geometry within 0.75 mil of the source, fuzzing, browser tests).

- **Cadence Allegro `.brd`, natively (16.x and 17.x).** No Allegro, KiCad or conversion step: the
  record stream is walked directly (string table, keyed records, version-specific layouts). On three
  real boards it matches KiCad 10's own import exactly — X270 (16.6): 2,166 parts, 7,874 pins at
  identical positions, every net and drill, 5,850 vias, 45,602 trace segments; a 17.2 board: 8,437
  pins, every net and drill. Outline (OUTLINE / DESIGN_OUTLINE / user outline subclass) and copper
  layer names are read. Releases before 16 are recognised and explained.
- **Fabmaster FATF and FARC (`.faz`).** Placement (negate Y on the bottom, rotate clockwise) puts
  every one of 6,701 pins of a real FARC job on the job's own absolute positions; the FATF and FARC
  of the same Gigabyte board agree on all 12,226 pins, nets and pad extents. Copper, vias and test
  points are read.
- **GenCAM (IPC-2511) `.a3p`**, **Unisoft F2B** (MFC archive, BGA ball labels from the net
  dictionary), **BV databases** (a built-in Microsoft Jet reader, no Access/ODBC), **Mentor neutral
  files** (outline, bodies, pad shapes, vias, test access), **Gigabyte TVW** (password and shorter
  settings block), plus documented-layout readers for **TopTest numbered-section BRD**, **Allegro
  Extracta** text and **NBV**.
- Corpus run (`BS_RESEARCH`): every sample opens except encrypted FZ/CAE/XZZ files (need your key),
  an Allegro 15.5 board (pre-16 layout) and a GenCAD file that is truncated (now reported as such).

## Real-corpus validation (2026-10)

A repair corpus (ThinkPad X260/X270/X280/X390, Surface Pro 4; boardviews, schematics, BIOS/EC dumps)
was run through every parser, compared with OpenBoardView, KiCad 10.0.1 and an independent CAMCAD
conversion, rendered and inspected, and exercised feature by feature in the app (search, solder points,
highlight groups, sides, CSV, report, PNG) with zero console errors. Fixed or added as a result:
ASC records recognised by shape (the VayoPro/TSICT dialect lost parts, outline corners and nails and put
every nail on the wrong side with bogus nets; OpenBoardView crashes on it), `parts.asc` rotation and
footprints, a KiCad PCB reader (KiCad 5–10; opens Allegro/Altium/PADS/Eagle boards after a KiCad import),
named Allegro releases with a conversion command, recognition of BIOS/EC firmware, flash dumps and
programs, ZIP-in-ZIP and macOS metadata handling, archive summaries, a warning for KiCad GenCAD exports
with `${REFERENCE}` names, and collision-free part labels. Details: FORMAT_MATRIX.md, "Findings from a
real repair corpus".

## Formats: what is actually verified

Verified = BoardScope output equals the compiled original reference parser
(OpenBoardView `cc76e69`, eagleview TVW reader from OBV PR #366) on the fixture, plus
integrity, fuzz and browser tests. See FORMAT_MATRIX.md for details.

| Format | Status | Fixture origin |
|---|---|---|
| TVW (Tebo-ICT View, standard header; Gigabyte variant) | verified | synthetic, built from a real board and accepted by the reference reader; also checked locally on real Lenovo and Gigabyte boards |
| BRD Test_Link (plain / obfuscated / Lenovo) | verified | synthetic, reference-validated |
| BRD2 / BRDOUT | verified | **real** (kicad-boardview, Glasgow) |
| BDV | verified | synthetic, reference-validated |
| BVR1 (BVRAW_FORMAT_1) | verified | synthetic, reference-validated |
| BVR3 (BVRAW_FORMAT_3) | verified | **real** (kicad-boardview, Glasgow) |
| FZ unencrypted; FZ RC6 with user key | verified | synthetic (generated test key) |
| GenCAD 1.4 | verified | **real** (two KiCad 10 exports) |
| KiCad PCB (KiCad 5–10) | verified | **real** (Glasgow, checked pin by pin against KiCad's export) |
| Mentor neutral file / CAD "###Panel Added" | verified | synthetic, reference-validated; checked locally on real neutral files |
| Fabmaster FATF / FARC (`.faz`) | verified | synthetic (both encodings); checked locally on real jobs |
| GenCAM `.a3p` | verified | synthetic; checked locally on a real board |
| Unisoft F2B | verified | synthetic; checked locally on two real boards |
| BV database (Access / Jet) | verified | synthetic Jet 4 database; checked locally on real boards |
| Cadence Allegro `.brd` 16.x / 17.x | partial | synthetic 16.6 and 17.2; checked locally on three real boards against KiCad 10 |
| ASC multi-file set | partial | synthetic, reference-validated |
| CAE (needs key) | partial | synthetic (test key) |
| CST | experimental | synthetic, reference-validated |
| XZZ (components need DES key) | experimental | synthetic (test key) |
| TopTest numbered-section BRD, Allegro Extracta, NBV | experimental | written from the documented layouts; no real files |
| Allegro before 16, PDF/RAR/7z/OLE, firmware images | recognised with an explanation, not parsed | unit tests |

Not supported: Altium ASCII, IPC-D-356 (fixture present), `.bvr2`, TVW files without the
standard header, Allegro before 16, FlexBV-only formats. No vendor decryption keys are included.

## Tests (all passing)

- Vitest: **240 tests** (plus opt-in checks on private boards via `BS_PRIVATE_FIXTURES` and 72 corpus checks via `BS_RESEARCH`). Unit (camera transforms, I/O, ciphers incl. the DES FIPS vector, builder,
  search, export), 17 differential golden tests against the reference parsers, a cross-exporter
  geometry check (≤1.1 mil on 1,130+ pins, 0 net mismatches), 37 detection/diagnostic tests, and 18
  fuzz suites (truncation, flips, splices, extreme counts, random input) covering every fixture.
- Playwright on the built file via `file://`: **76 tests** across Chromium 156, Firefox 157 and
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

- No redistributable real-world TVW, FZ, BDV, ASC, Test_Link, CAD, CST, XZZ, Allegro, Fabmaster, GenCAM,
  F2B or BV files. These formats are tested in CI against synthetic files built from a real board; the
  real samples were checked locally.
- Encrypted FZ, CAE and XZZ need user keys. XZZ part sides are not decoded (same as upstream).
- Allegro: releases before 16 are not read; 17.x pad shapes are drawn as their copper box; copper zones
  and silkscreen are not read. TopTest numbered-section BRD, Extracta and NBV have no real sample.
- Not drawn: TVW copper pours, BVR3 relative outlines, GenCAD artwork.
- No side-by-side comparison mode. Recent files are kept per session only.
