import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

// The production build emits one JS chunk + one CSS file which
// tools/postbuild.mjs inlines into dist/boardview.html.
export default defineConfig({
  base: './',
  plugins: [preact(), tailwindcss()],
  worker: { format: 'iife' },
  build: {
    outDir: 'dist/.build',
    emptyOutDir: true,
    target: ['chrome111', 'firefox115', 'safari16.4', 'edge111'],
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'app.js',
        assetFileNames: 'app[extname]',
      },
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/formats/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
