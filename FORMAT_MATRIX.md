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
| **Tebo-ICT View (TVW)**, standard header | `.tvw` | bytes 0–19 = `13` + ciphered `"Tebo-ictview files."` | **verified** | `glasgow.tvw` (synthetic, 6 layers incl. traces, drills, route outline with arc slots, empty through-layer, registries, decal outlines); also checked locally on a real Lenovo X1 Carbon Gen9 (NM-D341) board that cannot be redistributed | eagleview `TeboBoard` via OBV PR #366, with two corrections (below) | mil (1/100 mil fixed point) | No redistributable real TVW in the corpus. Gigabyte's writer (checked locally on a real H510M board: 2,159 parts, 8,415 pins, 39,874 copper segments) sets the header password and writes a 2-byte shorter settings block before the part table; the part table is then found by validation. Files without the standard header fail with "different Teboview variant" + offset. Copper pours (surfaces) are parsed but not drawn. Polygon pad shapes are drawn as their bounding rectangle. |
| **BRD Test_Link**, plain | `.brd`, `.bv` | text contains `str_length:` and `var_data:` | **verified** | `glasgow-testlink.brd` (synthetic) | OBV `BRDFile` | mil (assumed) | Pin numbers are positional (format has no pin names). |
| BRD Test_Link, obfuscated | `.brd` | starts with `23 E2 63 28` | **verified** | `glasgow-testlink-obfuscated.brd` (synthetic) | OBV `BRDFile` | mil (assumed) | as above |
| BRD Test_Link, Lenovo nail-net variant | `.brd` | as above; empty pin nets | **verified** | `glasgow-testlink-lenovo.brd` (synthetic) | OBV `BRDFile` | mil (assumed) | Nets resolved through nail probe numbers. |
| **BRD2 / BRDOUT** (Toptest, kicad-boardview, eagleview) | `.brd` | `BRDOUT:` and `NETS:` | **verified** | `glasgow-kicad-boardview.brd` (**real**) | OBV `BRD2File` | mil (assumed) | Positional pin numbers. Part boxes that systematically include silkscreen text are detected and replaced by pin extents (warning shown). |
| **TopTest BRD** (numbered sections) with optional `.con` | `.brd`, `.con` | marker lines `0 0 0 0` … `5 5 5 5` in order | experimental | inline test data written from the documented layout; no real file of this dialect is known | — | inch ×1000 (shown as mil) | Outline, parts (box from either corner order), pins (identity line `PART PIN`, `PART-PIN` or `PART.PIN`), test points; a same-stem `.con` adds parts, pins and points. The dialect stores no sides (all shown on top). Note that files labelled "TopTest" are usually BRDOUT (row above). **Unverified:** the corpus's TopTest/`.con` files are all BRDOUT (row above), and a 2026-10 search found no authentic file of this numbered-section dialect; its box-corner handling, the `.con` merge and the all-on-top assumption are unverified against real data. |
| **BDV** (obfuscated ASC set) | `.bdv` | `dd:1.3?,r?-=bb` (ciphered `<<format.asc>>`) or plain `<<format.asc>>`+`<<pins.asc>>` | **verified** | `glasgow.bdv` (synthetic) | OBV `BDVFile` | inch | Fixed header-line skipping as upstream (8/8/7 lines). |
| **ASC multi-file set** | `.asc` | file name `format/pins/nails/parts/nets.asc`, or `Part … (T)` lines | partial | `asc/*.asc` (synthetic, OBV layout); VayoPro-Test Expert layout as inline test data; checked locally on a real Microsoft Surface Pro 4 set (see below) | OBV `ASCFile` | inch | All files must be opened together (multi-select, folder drop or ZIP). Records are recognised by shape, not by fixed header line counts. `parts.asc` adds placement, rotation and footprint; `nets.asc` is redundant and not used. |
| **BVR (BVRAW_FORMAT_1)** | `.bvr` | `BVRAW_FORMAT_1` | **verified** | `glasgow-format1.bvr` (synthetic) | OBV `BVRFile` | inch | |
| **BVR3 (BVRAW_FORMAT_3)** | `.bvr` | `BVRAW_FORMAT_3` | **verified** | `glasgow-kicad-boardview.bvr` (**real**) | OBV `BVR3File` | mil (assumed) | Pad size from `PIN_RADIUS` (circular approximation). `PART_OUTLINE_RELATIVE`/`PIN_OUTLINE_RELATIVE` not drawn. |
| **FZ**, unencrypted (ASRock style) | `.fz` | zlib header at offset 4 | **verified** | `glasgow-zlib.fz` (synthetic) | OBV `FZFile` | mil, or mm with `UNIT:millimeters` | `GRAPHIC_DATA_NAME` yields assembly/silkscreen part bodies where supplied; `CLASS` BOARD GEOMETRY OUTLINE yields the file outline. The synthetic fixture has neither, so its outline is derived. |
| **FZ**, RC6-encrypted (ASUS style) | `.fz` | `.fz` + no zlib header (content encrypted) | **verified** with a user-supplied key | synthetic test key; two real encrypted boards opened locally with an ignored keyfile | OBV `FZFile` (RC6 CFB) | as above | **No vendor key is bundled.** Without a key: precise "key required" message. Wrong key: parity or "did not decrypt" message. |
| **CAE** (FZ container) | `.cae` | `.cae` + container checks | partial | synthetic test key; two real encrypted X399 boards opened locally | OBV `CAEFile` and local corpus | mils declared | User key required. `CLASS` BOARD GEOMETRY rows yield file outline (40/63 segments); `GRAPHIC_DATA_NAME` yields bodies for >99% of parts. These real files contain assembly/place-bound/silkscreen graphics but no net-associated copper routes. |
| **GenCAD 1.4** | `.cad`, `.gcd` | `$HEADER` + `GENCAD` | **verified** | `glasgow-kicad10.cad`, `glasgow-kicad10-flipped.cad` (**real**, KiCad 10) | OBV `GenCADFile` + spec; geometry cross-checked against kicad-boardview BRD2 (≤1 mil) | INCH/THOU/MM/MM100/USER* (declared) | Copper `$ROUTES` lines/vias shown; ARTWORK/MASK/TEXT ignored. Shape outlines are drawn as part bodies (may include silkscreen art). Reference rounding differs by ≤2.5 mil; BoardScope keeps full precision. |
| **Mentor Graphics neutral file**; CAD "###Panel Added" export (COMP/C_PIN) | `.neu`, `.cad`, `.fil` | `B_UNITS` + `COMP`/`BOARD`, or `###Panel Added` + `C_PIN` | **verified** | `glasgow-panel.cad` (synthetic, reference-validated); Mentor grammar as inline test data; checked locally on a real Vinafix neutral file (1,954 parts, 6,533 pins) and a public sample | OBV `CADFile` for COMP/C_PIN/NET; beyond it: units, board outline (`B_ATTR`), `GEOM` bodies, `PAD`/`P_SHAPE` pads and drills, `N_VIA` vias, `N_TEST` test access, unplated holes | `B_UNITS` (inch/mil/mm) | Bodies are placed by rotating counter-clockwise, then mirroring X on the bottom; this maps every `G_PIN` onto its `C_PIN` in the real files. |
| **GenCAM** (IPC-2511 1.x text) | `.a3p` | `$HEADER` + `GENCAM:` | **verified** | `glasgow.a3p` (synthetic: one pattern per component in its rotated/`MIRROR`ed frame, routes, vias, probes); grammar details as inline test data; checked locally on a real Compal LA-6841P `.a3p` (1,318 parts, 7,607 pins, 1,649 nets, 79k copper segments) | IPC-2511 statement grammar; placement checked against the file's own copper | `UNITS` (THOU, THOU10, INCH, MM, MM100, UM) | Placement: mirror X when `MIRROR`, rotate counter-clockwise, translate; on the real board this puts 70% of pins exactly on a route end or via of their own net (no other orientation comes close). Polygon pads are drawn as their bounding box. Multiple `BOARD`s in one file are shown together (each board's `OUTLINE` in shared absolute coordinates) — **this multi-board path is covered only by a synthetic two-board fixture**; no authentic multi-board GenCAM export was found in the corpus or publicly (2026-10), so single-board placement is real-verified but the panel case is not. |
| **Unisoft F2B** (MFC CArchive) | `.f2b` | archive version 6/8 + `CTraceList` class name at offset 24 | **verified** | `glasgow.f2b` (synthetic); checked locally on two real files (an NVIDIA VGA card, 404 parts / 10 copper layers; a laptop mainboard, 1,366 parts / 15 layers) | Layout from real files: every pin, component and dictionary entry resolves, declared pin counts agree | f32 resolution (units per inch) | Pins reference their component through MFC object references; negative pin numbers are keys of BGA ball labels in the net dictionary (they form proper ball grids); net key 0xFFFF is unconnected; owner-less pins are vias. No outline and no pad sizes are stored (outline derived, typical pad size). Fixture tooling holes far outside the board are left out with a note. |
| **BV database** (Microsoft Access / Jet) | `.bv` | `Standard Jet DB` at offset 4 | **verified** | `glasgow.bv` (synthetic Jet 4 database); checked locally on two real Apple iMac M38A databases (2,299 parts, 10,208 pins, 2,308 nails, 148-point outline; every table's row count equals its declared count) | Built-in Jet 3/4 reader (`src/io/mdb.ts`) — no ODBC, COM or Access needed | inch (convention) | Tables `Pin(Part,TB,Pin,Name,X,Y,Layer,Net)`, `Nail(…,TB,NetName)`, `Layout(X,Y,R,Group)`; `Layer` 0 = through-hole. Encrypted databases and long values on separate pages (memo/OLE) are not read. An Access file without a `Pin` table is reported with its table names. |
| **Fabmaster FATF** (`:FABMASTER FATF REV 11.x`) and **FARC** (`.far`, inside `.faz` ZIPs) | `.fatf`, `.fat`, `.far`, `.faz` | `:FABMASTER FATF REV` / `:SECTION FABMASTER` | **verified** | `glasgow.fatf`, `glasgow.far` (synthetic, every package in its part's rotated/mirrored frame); checked locally on two real Gigabyte `.faz` jobs (H61M, Z790M: the latter holds the same board as FATF *and* FARC) and a public FATF sample | Grammar from real jobs; placement checked against FARC `FABXYDATA` (6,701 absolute pin positions, all exact) and FATF `TEST_POINTS` | `:UNITS = 1/N INCH` (FATF), mil (FARC) | Parts are placed by negating local Y on the bottom side, then rotating clockwise. FATF and FARC of the same board agree on all 12,226 pins (≤0.1 mil), nets and pad extents. FARC names packages by their 8.3 outline file (`"ANDUAL-N.OTL"` for `USB_LANDUAL-N`); the part record carries both names. Copper tracks with nets, vias and test access are read; text and copper pours are not drawn. |
| **Allegro Extracta** text (`A!`/`J!`/`S!` rows) | `.txt`, `.cad`, `.fil` | `A!` header rows with `REFDES`/`NET_NAME`/`GRAPHIC_DATA_NAME` and `S!` data rows | experimental | inline test data written from the documented column names; no real export in the corpus | — | `J!` row (MILS, MILLIMETERS, MICRONS, INCHES) | Columns matched by name, tables in any order, quoted `!` kept. Components (mirror = bottom side), pins with nets and test access, outline (BOARD GEOMETRY / OUTLINE) and etch lines/arcs with nets, vias. Padstack shapes are not read. **Unverified:** Extracta output is generated on demand from a user-written command file, so no fixed sample is published; a corpus and web search (2026-10) found none. Column selection and placement are unverified against a real export. |
| **CST** (MFC CArchive) | `.cst` | `.cst` + `CPad` class record | experimental | `glasgow.cst` (synthetic) | OBV `CSTFile` | assumed mil (16-bit ints) | Record layout partly unknown upstream; no outline. |
| **XZZ PCB** | `.pcb` | `XZZPCB` (optionally XOR-masked via byte 0x10) | partial | synthetic test key; two real encrypted boards opened locally; RedmiBook layer file checked for routing | OBV `XZZPCBFile` and local corpus | raw/10000, treated as mil | DES-encrypted components need a separate user key (none bundled). Plaintext type `05` lines and type `01` arcs carry width, net and physical layer 1–16; type `02` vias carry net, diameter and layer span. RedmiBook: 37,948 copper lines, 4,342 vias, 16 layers; 176 outline and 22 silkscreen lines kept out of electrical traces. Component sides are not decoded. |
| Cadence **Allegro** `.brd` database | `.brd` | `all`/`vie`/`dbd` at 0xF8; release in header magic | partial (15.x–17.x) | real 15.5 with matching GenCAD export; three real 16/17 boards against KiCad 10 | 15.5: matching GenCAD; 16/17: KiCad import | 1/100 mil | 15.5: 1,945 parts, 8,468 pads, all pin nets equal to GenCAD, 8,394 pad centres within 0.05 mil; 74 asymmetric copper boxes differ from exported pin anchors. Reads 6 copper layers, 6,700 vias, 22,738 trace segments, detailed outline. 16.6: 2,166 parts and 7,874 pins at identical positions to KiCad, all nets/drills, 5,850 vias and 45,602 traces. 17.2: 8,437 pins at identical positions, all nets/drills, 6,035 vias and 69,232 of 69,285 traces. 17.x reads round/rect pad shape and copper bounding box. Pre-15 unsupported; other 15.x variants untested. Copper zones and silkscreen not read. |
| **KiCad PCB** | `.kicad_pcb` | `(kicad_pcb` | **verified** | `glasgow.kicad_pcb` (**real**, KiCad 7 file) checked pin by pin against KiCad's own GenCAD export; KiCad 5 and KiCad 10 syntax as inline test data; checked locally on a real Allegro 16.6 board imported by KiCad 10 (see below) | KiCad 10.0.1 exports | mm | Copper zones (pours) are not drawn. Pads without copper (solder-paste apertures) are not shown. Custom pad shapes are drawn as their anchor pad. |
| **NBV** (NexusBV export) | `.nbv` | `NBV 1.0\0\0` + zlib | experimental | inline test data written from the documented wire order (payloads 1–3); no real file is available | — | as stored (assumed mil; unconfirmed) | Components (reference, value, side), pins (position, pad radius, side, net, name) and outline-named graphic lines; every other field is skipped exactly by its documented size. Counts and string lengths are bounded. **Unverified:** a corpus and public code search (2026-10) found no `.nbv` sample, and `.nbv` is not in NexusBV's documented input-format list; the wire layout and units are unconfirmed against a real file. |
| ZIP archive | `.zip` | `PK\x03\x04` | supported container | unit tests | — | — | Members are expanded (size-limited) and detected normally; ASC sets inside ZIPs work, one level of ZIP-in-ZIP is followed, macOS `__MACOSX`/`.DS_Store` metadata is ignored. A ZIP without a boardview lists what it holds. |
| RAR / 7-Zip archive | `.rar`, `.7z` | `Rar!\x1a\x07` / `7z\xbc\xaf\x27\x1c` | supported container | real board in `glasgow.7z` (e2e + unit), upstream compressed RAR5 fixture (unit), real VinaFix RAR4 archives (local e2e) | libarchive 3.7.2 → WebAssembly | — | Lazy in-browser decoder; 400 MB input bound, 512 MB expanded bound. Password-protected archives report that a password is required. |
| PDF, gzip, images, OLE (Altium PcbDoc/Office), legacy KiCad (pre-5), BIOS/SPI flash images, EC firmware, flash dumps, programs | — | magic bytes / signatures | diagnostic | unit tests | — | — | Specific explanation of what the file is and what to do. |

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
3. **Drills.** Tool sizes are 1/100 mil like all coordinates; on that board they match the hole size
   stored in each pad record exactly (e.g. a 3.3 mm drill in a 6.0 mm GND screw pad). The drill
   table also repeats the hole of every through-hole pin (243 records there). BoardScope draws those
   as holes cut into the pads instead of as separate vias. Decal outlines of mechanical parts (part
   type 21) and fiducials (type 29) are keep-out circles larger than the copper, so they are drawn
   dashed.

### Findings from a real repair corpus (2026-10)

Checked locally on boardviews that cannot be redistributed (two ThinkPads, a Surface Pro 4), against
OpenBoardView, KiCad 10.0.1 and an independent CAMCAD conversion.

1. **ASC (VayoPro-Test Expert export, as read by TSICT).** Headers are shorter than the reference
   expects and the nail *type* column is text (`FPT`). Fixed-count header skipping dropped the first part,
   two outline corners and two nails; positional nail columns put every nail on the bottom side and used
   the net id (`#73`) as the net name, creating 897 bogus nets. OpenBoardView crashes (segfault) on the
   same set. Records are now recognised by shape: all 3,246 parts, 1,023 nails (632 top / 391 bottom),
   2,257 nets (= `nets.asc`) and the closed outline are read. `parts.asc` supplies rotation and footprint.
2. **GenCAD (CAMCAD, Lenovo X270).** Identical to OpenBoardView: 2,157 parts, 7,848 pins, no net
   differences. 29 BGA pins differ by 2.6 mil because the reference rounds placement and pad offsets to
   whole mils separately; BoardScope equals the hand computation from the raw records. Two SMD connectors
   with drilled pegs are marked "both sides" by the reference and kept on the bottom by BoardScope (the
   file's `TECHNOLOGY "SMD"`). `$BOARD` holds a drawing frame and hatching, not an outline, so the outline
   is derived (as in the reference).
3. **Allegro 16.6 (same X270 board) via KiCad.** `kicad-cli pcb import` → BoardScope's KiCad reader matches
   the independent CAMCAD GenCAD on all 7,848 pins (0.000 mil) and 1,566 nets, and adds the real board
   outline, part bodies, 45,602 copper segments and 525 pin-net assignments CAMCAD dropped.
   KiCad 10.0.1's own GenCAD and position-file exporters write `${REFERENCE}` instead of reference
   designators for such imports (KiCad gives each footprint a second, unresolved "Reference" property);
   BoardScope reads the real one and warns when it meets such a GenCAD file.

## Not supported (yet)

| Format | Why | Path forward |
|---|---|---|
| Altium **ASCII** PCB (`|KIND=Protel_Advanced_PCB`) | Not implemented in this release (OBV has `ADFile`). No redistributable fixture. | Add `src/formats/altium-ascii.ts` from OBV `ADFile.cpp` and a fixture. |
| Altium binary `.PcbDoc`, OrCAD, Mentor `.hkp`, ODB++, IPC-2581 | Design databases, not boardviews; complex or proprietary. | Import into KiCad 10 (Altium, PADS, Eagle, CADSTAR, Allegro) and open the `.kicad_pcb`, or export GenCAD. |
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
