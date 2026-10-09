# Format matrix

Detection is **by content**; the extension is only a tie-breaker. Every parser
returns structured diagnostics; unsupported or broken files get a precise
explanation (format guess, reason, byte offset or line).

**Status legend**

- **verified**: parser output equals the reference implementation's output
  (OpenBoardView/eagleview, compiled from source) on the listed fixtures, and the
  fixtures pass integrity, fuzz and end-to-end tests. "Real" means the fixture was
  produced by a third-party tool from a real board; "synthetic" means it was
  written by `tools/fixtures/writers.ts` from real board data and was accepted by
  the reference parser.
- **partial**: works on reference-validated fixtures, but parts of the format are
  unknown (fields documented as unknown upstream) or it needs extra input (all
  files of a set, a key).
- **experimental**: ported faithfully from the reference and fixture-tested, but
  the reference itself treats the format as partially understood.
- **diagnostic**: recognised so the user gets an explanation; not parsed.

| Format / variant | Ext. | Detection signature | Status | Fixtures (origin) | Reference | Units | Limitations |
|---|---|---|---|---|---|---|---|
| **Tebo-ICT View (TVW)**, standard header | `.tvw` | bytes 0–19 = `13` + ciphered `"Tebo-ictview files."` | **verified** | `glasgow.tvw` (synthetic, 6 layers incl. traces, drills, route outline with arc slots, empty through-layer, registries, decal outlines); also checked locally on a real Lenovo X1 Carbon Gen9 (NM-D341) board that cannot be redistributed | eagleview `TeboBoard` via OBV PR #366, with two corrections (below) | mil (1/100 mil fixed point) | No redistributable real TVW in the corpus. TVW files without the standard header, e.g. the Gigabyte layout described by other projects, fail with "different Teboview variant" + offset. Copper pours (surfaces) are parsed but not drawn. |
| **BRD Test_Link**, plain | `.brd`, `.bv` | text contains `str_length:` and `var_data:` | **verified** | `glasgow-testlink.brd` (synthetic) | OBV `BRDFile` | mil (assumed) | Pin numbers are positional (format has no pin names). |
| BRD Test_Link, obfuscated | `.brd` | starts with `23 E2 63 28` | **verified** | `glasgow-testlink-obfuscated.brd` (synthetic) | OBV `BRDFile` | mil (assumed) | as above |
| BRD Test_Link, Lenovo nail-net variant | `.brd` | as above; empty pin nets | **verified** | `glasgow-testlink-lenovo.brd` (synthetic) | OBV `BRDFile` | mil (assumed) | Nets resolved through nail probe numbers. |
| **BRD2 / BRDOUT** (Toptest, kicad-boardview, eagleview) | `.brd` | `BRDOUT:` and `NETS:` | **verified** | `glasgow-kicad-boardview.brd` (**real**) | OBV `BRD2File` | mil (assumed) | Positional pin numbers. Part boxes that systematically include silkscreen text are detected and replaced by pin extents (warning shown). |
| **BDV** (obfuscated ASC set) | `.bdv` | `dd:1.3?,r?-=bb` (ciphered `<<format.asc>>`) or plain `<<format.asc>>`+`<<pins.asc>>` | **verified** | `glasgow.bdv` (synthetic) | OBV `BDVFile` | inch | Fixed header-line skipping as upstream (8/8/7 lines). |
| **ASC multi-file set** | `.asc` | file name `format/pins/nails/parts/nets.asc`, or `Part … (T)` lines | partial | `asc/*.asc` (synthetic) | OBV `ASCFile` | inch | All files must be opened together (multi-select, folder drop or ZIP). `parts.asc`, `nets.asc` and `.bom` are not used (same as upstream). |
| **BVR (BVRAW_FORMAT_1)** | `.bvr` | `BVRAW_FORMAT_1` | **verified** | `glasgow-format1.bvr` (synthetic) | OBV `BVRFile` | inch | |
| **BVR3 (BVRAW_FORMAT_3)** | `.bvr` | `BVRAW_FORMAT_3` | **verified** | `glasgow-kicad-boardview.bvr` (**real**) | OBV `BVR3File` | mil (assumed) | Pad size from `PIN_RADIUS` (circular approximation). `PART_OUTLINE_RELATIVE`/`PIN_OUTLINE_RELATIVE` not drawn. |
| **FZ**, unencrypted (ASRock style) | `.fz` | zlib header at offset 4 | **verified** | `glasgow-zlib.fz` (synthetic) | OBV `FZFile` | mil, or mm with `UNIT:millimeters` | `GRAPHIC_DATA` (drawings) not used; outline is derived (dashed). |
| **FZ**, RC6-encrypted (ASUS style) | `.fz` | `.fz` + no zlib header (content encrypted) | **verified** with a user-supplied key | `glasgow-rc6-testkey.fz` (synthetic, generated test key) | OBV `FZFile` (RC6 CFB) | as above | **No vendor key is bundled.** Without a key: precise "key required" message. Wrong key: parity or "did not decrypt" message. |
| **CAE** (FZ container) | `.cae` | `.cae` + container checks | partial | `glasgow-rc6-testkey.cae` (synthetic, test key) | OBV `CAEFile` | as FZ | Needs a user key; real CAE content not available for testing. |
| **GenCAD 1.4** | `.cad`, `.gcd` | `$HEADER` + `GENCAD` | **verified** | `glasgow-kicad10.cad`, `glasgow-kicad10-flipped.cad` (**real**, KiCad 10) | OBV `GenCADFile` + spec; geometry cross-checked against kicad-boardview BRD2 (≤1 mil) | INCH/THOU/MM/MM100/USER* (declared) | Copper `$ROUTES` lines/vias shown; ARTWORK/MASK/TEXT ignored. Shape outlines are drawn as part bodies (may include silkscreen art). Reference rounding differs by ≤2.5 mil; BoardScope keeps full precision. |
| **CAD "###Panel Added"** (COMP/C_PIN) | `.cad` | `###Panel Added` + `C_PIN` | partial | `glasgow-panel.cad` (synthetic) | OBV `CADFile` | inch | Several fields unknown upstream; outline derived (dashed). |
| **CST** (MFC CArchive) | `.cst` | `.cst` + `CPad` class record | experimental | `glasgow.cst` (synthetic) | OBV `CSTFile` | assumed mil (16-bit ints) | Record layout partly unknown upstream; no outline. |
| **XZZ PCB** | `.pcb` | `XZZPCB` (optionally XOR-masked via byte 0x10) | experimental | `glasgow-testkey.pcb` (synthetic, test DES key) | OBV `XZZPCBFile` | raw/10000, treated as mil | Component records are DES-encrypted: **needs a user key** (none bundled). Sides are not decoded (all parts on top, like upstream). Diode-reading tables not used. |
| Cadence **Allegro** `.brd` database | `.brd` | `all`/`vie` at 0xF8 | diagnostic | (unit test) | OBV `BRDAllegroFile` | — | Explains that this is a design database and suggests exporting GenCAD/Extracta. |
| ZIP archive | `.zip` | `PK\x03\x04` | supported container | unit tests | — | — | Members are expanded (size-limited) and detected normally; ASC sets inside ZIPs work. |
| PDF, RAR, 7z, gzip, images, OLE (Altium PcbDoc/Office), KiCad `.kicad_pcb` | — | magic bytes | diagnostic | unit tests | — | — | Specific explanation of what the file is and what to do. |

### TVW: corrections relative to the reference implementation

Found on a real Lenovo X1 Carbon Gen9 (NM-D341) board and verified on all of its 2,115 parts:

1. **Route arc slots.** Drill records with code `0x0B` are arcs: centre, radius, then start and
   sweep angles as float32 degrees (negative = clockwise). The record has the same size as a straight
   `0x0A` slot. The reference reads them as lines, which draws stray diagonals across the board (to
   the origin when the start angle is 0°). BoardScope decodes them as arcs; the route outline then
   forms closed loops (419 segments, 0 open endpoints on that board).
2. **Part bodies.** The part record's box includes the reference-designator text and sits offset
   from the component for rotated parts (only 4 of 183 top-side 270° parts contained their own pins).
   BoardScope draws the decal outline instead, placed with the pad transform: rotate
   counter-clockwise by the part angle, then mirror X on the bottom side. This transform reproduces
   100% of the pads of all parts from their decals' local pads, and every pin then lies inside its
   part body.

## Not supported (yet)

| Format | Why | Path forward |
|---|---|---|
| Altium **ASCII** PCB (`|KIND=Protel_Advanced_PCB`) | Not implemented in this release (OBV has `ADFile`). No redistributable fixture. | Add `src/formats/altium-ascii.ts` from OBV `ADFile.cpp` and a fixture. |
| Altium binary `.PcbDoc`, OrCAD, Mentor `.hkp`, ODB++, IPC-2581 | Design databases, not boardviews; complex or proprietary. | Export GenCAD instead. |
| IPC-D-356 netlist | Not implemented; a real fixture (`glasgow-kicad10.d356`) is already in the repo. | Straightforward fixed-column parser. |
| `.bvr2`, other vendor `.bv` dialects | No public specification and no fixture. Content detection reports "unrecognised" with a byte preview. | Needs a fixture or documentation. |
| TVW variants without the standard header | Not documented in any open implementation used here. | Add a detector + parser module once a redistributable sample exists. |
| FlexBV-only formats | Closed source; not reverse-engineered for this project. | — |

## Verification summary (automated)

- `tests/formats/differential.test.ts`: 17 fixtures; BoardScope equals the compiled reference parser (parts, sides, pin positions ±1 unit, nets, pin numbers, test points, outline).
- `tests/formats/cross-format.test.ts`: the same real board via three exporters agrees to <1.1 mil on 1,130+ pins with zero net mismatches.
- `tests/formats/fuzz.test.ts`: truncation, byte flips, splices and extreme counts/offsets for every fixture, plus random input. No crashes or hangs; every successful parse passes integrity validation.
- `tests/formats/detection.test.ts`: detection by content (renamed extensions), key handling, multi-file ASC, ZIP, and diagnostics for unsupported inputs.
- `tests/e2e`: every verified format opens in Chromium, Firefox and WebKit from `file://`.
