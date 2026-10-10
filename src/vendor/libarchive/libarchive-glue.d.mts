/** Minimal types for the vendored libarchive.js Emscripten glue (see LICENSES.md). */
export interface LibarchiveModule {
  _malloc(n: number): number;
  _free(p: number): void;
  HEAPU8: Uint8Array;
  cwrap(name: string, ret: string | null, args: string[]): (...a: unknown[]) => number | string | null;
  [k: string]: unknown;
}

/** Emscripten MODULARIZE factory: resolves once the WebAssembly is instantiated. */
declare function createLibarchive(moduleArg?: Record<string, unknown>): Promise<LibarchiveModule>;
export default createLibarchive;
