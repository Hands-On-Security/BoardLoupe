# Vendored archive decoder licences

BoardLoupe bundles **libarchive.js** to open `.rar` and `.7z` archives directly
in the browser. The WebAssembly module (`wasm-base64.ts`) and the Emscripten
glue (`libarchive-glue.mjs`) come from that project; the WebAssembly is
**libarchive** compiled with the compression libraries it needs.

- **libarchive.js** (Emscripten glue, this wrapper) — MIT. See
  `LICENSE-libarchive.js.txt`.
- **libarchive** (the C library) — BSD-style, including UC Regents code. See
  `LICENSES/libarchive-3.7.2.txt` and `LICENSES/libarchive-uc-regents.txt`.
  Its RAR readers are libarchive implementations, not UnRAR code.
- The [upstream build recipe](https://github.com/nika-begiashvili/libarchivejs/blob/v2.0.2/lib/tools/docker/Dockerfile)
  and [link command](https://github.com/nika-begiashvili/libarchivejs/blob/v2.0.2/lib/tools/build.sh)
  include **OpenSSL 1.0.2s** (OpenSSL/SSLeay), **liblzma from XZ Utils 5.2.11**
  (public domain), and **zlib** and **bzip2** (the recipe sources 1.3 and 1.0.8;
  Emscripten's ports are also enabled by the link command).
  The vendored WebAssembly matches the upstream v2.0.2 binary by SHA-256
  (`8a66066ed3ea1e6db0469ec752d8fca888a6bf737c6cff21fdbcb62241a72424`).
  The corresponding texts in `LICENSES/` are embedded in `dist/boardloupe.html`.

## Supported archive variants

Read-only extraction of: **RAR** (RAR4 and RAR5, store and the standard
compressions) and **7-Zip** (`.7z`, with LZMA / LZMA2 / BZip2 / Deflate / store;
not AES-256-encrypted payloads without a key). ZIP is handled separately by a
small pure-JS reader (`fflate`) and does not use this module.

Encrypted archives (RAR with a password, 7z with header/content encryption)
report that a password is required; BoardLoupe does not prompt for archive
passwords.
