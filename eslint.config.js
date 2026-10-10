import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // src/vendor/** is third-party generated code (libarchive's Emscripten glue); lint only our own code.
  { ignores: ['dist/**', 'node_modules/**', 'tools/obv-harness/**', 'test-results/**', 'playwright-report/**', 'src/vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      // Security: no dynamic code execution anywhere.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  { files: ['**/*.{js,mjs}'], languageOptions: { globals: globals.node } },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // File contents must never reach the DOM as HTML.
      'no-restricted-properties': ['error', { property: 'innerHTML', message: 'Do not inject HTML; render text via Preact.' }, { property: 'outerHTML' }, { property: 'insertAdjacentHTML' }],
      'no-restricted-syntax': ['error', { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'No raw HTML.' }],
    },
  },
);
