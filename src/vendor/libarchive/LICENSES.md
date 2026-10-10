# Vendored archive decoder licences

BoardScope bundles **libarchive.js** to open `.rar` and `.7z` archives directly
in the browser. The WebAssembly module (`wasm-base64.ts`) and the Emscripten
glue (`libarchive-glue.mjs`) come from that project; the WebAssembly is
**libarchive** compiled with the compression libraries it needs.

- **libarchive.js** (Emscripten glue, this wrapper) — MIT. See
  `LICENSE-libarchive.js.txt`.
- **libarchive** (the C library) — BSD 2-Clause.
  <https://github.com/libarchive/libarchive/blob/master/COPYING>
  Its RAR (RAR 1–4) and RAR5 readers are libarchive's own clean-room
  implementations (not derived from UnRAR), so they are redistributable.
- Compression libraries statically linked into the WebAssembly, each under its
  own permissive licence: **zlib** (zlib), **bzip2** (BSD-like), **liblzma/xz**
  (public domain / 0BSD), **zstd** (BSD/GPL dual → BSD), **lz4** (BSD).

## Supported archive variants

Read-only extraction of: **RAR** (RAR4 and RAR5, store and the standard
compressions) and **7-Zip** (`.7z`, with LZMA / LZMA2 / BZip2 / Deflate / store;
not AES-256-encrypted payloads without a key). ZIP is handled separately by a
small pure-JS reader (`fflate`) and does not use this module.

Encrypted archives (RAR with a password, 7z with header/content encryption)
report that a password is required; BoardScope does not prompt for archive
passwords.
