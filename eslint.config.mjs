// ESLint flat config for the Salesforce Toolkit extension.
//
// The extension is classic <script>-tag JS sharing one global scope per page.
// A file in a page can reference any top-level symbol declared by another file
// in the same page, so plain no-undef would fire thousands of false positives.
// A4: scripts/gen-globals.mjs walks each page's <script> list and writes
// eslint-globals.json ({ file → { name: 'readonly' } }); we feed that as
// per-file globals and turn no-undef ON — now it catches ONLY genuinely
// undeclared references (typo'd cross-file calls), which is the whole point.
// Re-run `node scripts/gen-globals.mjs` after adding a top-level symbol.
import js from '@eslint/js';
import { readFileSync } from 'node:fs';

const FILE_GLOBALS = JSON.parse(readFileSync(new URL('./eslint-globals.json', import.meta.url), 'utf8'));

// Browser + WebExtension + service-worker ambient globals the classic scripts
// use but never declare.
const AMBIENT = Object.fromEntries([
  'window', 'document', 'chrome', 'console', 'location', 'history', 'navigator',
  'fetch', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FileReader', 'FormData', 'TextEncoder', 'TextDecoder', 'atob', 'btoa',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'localStorage', 'sessionStorage', 'crypto', 'structuredClone', 'DOMParser', 'XMLHttpRequest',
  'indexedDB', 'IDBKeyRange',
  'CustomEvent', 'Event', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'alert', 'confirm', 'prompt', 'getComputedStyle', 'matchMedia', 'screen',
  'AbortController', 'AbortSignal', 'Image', 'Node', 'Element', 'HTMLElement',
  'trustedTypes', 'globalThis', 'importScripts', 'self', 'WebSocket', 'performance',
  'Range', 'getSelection', 'NodeFilter', 'DocumentFragment', 'HTMLInputElement', 'CSS',
].map(n => [n, 'readonly']));

// Per-file config objects: each declares that file's page-group globals so
// cross-file references resolve, then enables no-undef for it.
const perFileConfigs = Object.entries(FILE_GLOBALS).map(([file, names]) => ({
  files: [file],
  languageOptions: { globals: { ...AMBIENT, ...names } },
  rules: { 'no-undef': 'error' },
}));

export default [
  {
    ignores: ['node_modules/**', '_harness*', '_smoketest*', '*.min.js', 'eslint-globals.json',
      'Saleforce Toolkit/**',   // stale nested copy (June 2026) — not part of the build
      'dist/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
    },
    rules: {
      ...js.configs.recommended.rules,
      // Default off; the per-file configs below turn it ON for page-group files
      // with the right globals. Files not in a page (none today) stay lenient.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // Template-heavy UI code trips these stylistically, not dangerously.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      // The ones that catch real bugs:
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-cond-assign': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
    },
  },
  ...perFileConfigs,
  {
    files: ['**/*.mjs', 'test/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    // .mjs are real modules — their imports/exports are enough; keep no-undef
    // off here since the generated map targets the classic page scripts.
    rules: { 'no-undef': 'off' },
  },
];
